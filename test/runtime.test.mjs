import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPHP } from '../src/index.mjs';
import { decode, directEngineOptions, encode, engineOptions, headerValues, installFixtures, phpVersion } from './helpers.mjs';

test(`PHP ${phpVersion}: real WebAssembly runtime`, { timeout: 180_000 }, async t => {
  const php = await createPHP(await engineOptions());
  t.after(() => php.close());
  await installFixtures(php);

  await t.test('CLI exposes actual CLI SAPI, argument boundaries, stdin and stderr', async () => {
    const result = await php.run({ script: '/workspace/cli.php', args: ['value with spaces', '--example=two', '"literal"', 'üñîçødé'], stdin: encode('line one\nline two\0tail') });
    assert.equal(result.exitCode, 0);
    assert.equal(decode(result.stderr), 'cli diagnostic\n');
    const info = JSON.parse(decode(result.stdout));
    assert.equal(info.sapi, 'cli');
    assert.ok(info.version.startsWith(`${phpVersion}.`), info.version);
    assert.deepEqual(info.args, ['/workspace/cli.php', 'value with spaces', '--example=two', '"literal"', 'üñîçødé']);
    assert.equal(info.argc, 5);
    assert.equal(info.cwd, '/workspace');
    assert.equal(info.stdin, 'line one\nline two\0tail');
    const extensions = new Set(info.extensions.map(name => name.toLowerCase()));
    for (const extension of ['bcmath', 'ctype', 'date', 'dom', 'exif', 'fileinfo', 'filter', 'gd', 'hash', 'iconv', 'intl', 'json', 'libxml', 'mbstring', 'openssl', 'pcre', 'pdo', 'session', 'simplexml', 'spl', 'tokenizer', 'xml', 'xmlreader', 'xmlwriter', 'zip', 'zlib']) {
      assert.ok(extensions.has(extension), `Missing native extension: ${extension}`);
    }
  });

  await t.test('repeated CLI invocations do not leak standard stream file descriptors', async () => {
    await php.fs.writeFile('/workspace/descriptors.php', '<?php $count = 0; for ($fd = 3; $fd < 64; $fd++) { $stream = @fopen("php://fd/" . $fd, "r"); if ($stream !== false) { $count++; fclose($stream); } } echo $count;');
    await php.run({ script: '/workspace/descriptors.php' });
    const counts = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await php.run({ script: '/workspace/descriptors.php' });
      assert.equal(result.exitCode, 0, decode(result.stderr));
      counts.push(Number(decode(result.stdout)));
    }
    assert.ok(Number.isInteger(counts[0]) && counts[0] < 16, `Unexpected number of open file descriptors: ${counts[0]}`);
    assert.deepEqual(counts, Array(5).fill(counts[0]));
  });

  await t.test('HTTP populates PHP input and preserves repeated response headers', async () => {
    const body = encode('name=Joomla+WASM&items%5B%5D=one&items%5B%5D=two');
    const response = await php.request({ script: '/workspace/request.php', url: 'https://playground.example/article?search=one+two&n=7', method: 'POST', headers: [['content-type', 'application/x-www-form-urlencoded'], ['cookie', 'session=abc; preference=dark'], ['x-test', 'incoming']], body });
    assert.equal(response.exitCode, 0);
    assert.equal(response.status, 201);
    assert.deepEqual(headerValues(response, 'x-request-method'), ['POST']);
    assert.equal(headerValues(response, 'set-cookie').length, 2);
    const result = JSON.parse(decode(response.body));
    assert.equal(result.sapi, 'cgi-fcgi');
    assert.deepEqual(result.get, { search: 'one two', n: '7' });
    assert.deepEqual(result.post, { name: 'Joomla WASM', items: ['one', 'two'] });
    assert.deepEqual(result.cookies, { session: 'abc', preference: 'dark' });
    assert.equal(result.method, 'POST');
    assert.equal(result.uri, '/article?search=one+two&n=7');
    assert.equal(result.host, 'playground.example');
    assert.equal(result.header, 'incoming');
    assert.equal(result.content_type, 'application/x-www-form-urlencoded');
    assert.equal(Number(result.content_length), body.byteLength);
  });

  await t.test('binary request and response bodies are lossless', async () => {
    const body = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);
    const response = await php.request({ script: '/workspace/binary.php', url: 'http://localhost/binary', method: 'POST', headers: [['content-type', 'application/octet-stream']], body });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, body);
  });

  await t.test('multipart file uploads populate $_FILES and can be moved into the workspace', async () => {
    await php.fs.writeFile('/workspace/upload.php', `<?php
$file = $_FILES['upload'];
$accepted = is_uploaded_file($file['tmp_name']);
$moved = move_uploaded_file($file['tmp_name'], '/workspace/uploaded.bin');
header('Content-Type: application/json');
echo json_encode(['name' => $file['name'], 'type' => $file['type'], 'size' => $file['size'], 'error' => $file['error'], 'accepted' => $accepted, 'moved' => $moved, 'title' => $_POST['title']], JSON_THROW_ON_ERROR);`);
    const boundary = 'php-wasm-integration-boundary';
    const prefix = encode(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nExtension upload\r\n--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="payload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const bytes = Uint8Array.of(0, 255, 127, 128);
    const suffix = encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(prefix.length + bytes.length + suffix.length);
    body.set(prefix);
    body.set(bytes, prefix.length);
    body.set(suffix, prefix.length + bytes.length);
    const response = await php.request({ script: '/workspace/upload.php', url: 'http://localhost/upload', method: 'POST', headers: [['content-type', `multipart/form-data; boundary=${boundary}`]], body });
    assert.equal(response.exitCode, 0, decode(response.stderr));
    assert.deepEqual(JSON.parse(decode(response.body)), { name: 'payload.bin', type: 'application/octet-stream', size: bytes.length, error: 0, accepted: true, moved: true, title: 'Extension upload' });
    assert.deepEqual(await php.fs.readFile('/workspace/uploaded.bin'), bytes);
  });

  await t.test('HEAD runs PHP and sends headers with no response body', async () => {
    await php.fs.writeFile('/workspace/head.php', '<?php header("X-Executed: yes"); echo "must be omitted";');
    const response = await php.request({ script: '/workspace/head.php', url: 'http://localhost/head', method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.deepEqual(headerValues(response, 'x-executed'), ['yes']);
    assert.equal(response.body.byteLength, 0);
  });

  await t.test('nested document roots expose correct CGI script paths', async () => {
    await php.fs.mkdir('/workspace/site', { recursive: true });
    await php.fs.writeFile('/workspace/site/index.php', '<?php echo json_encode([$_SERVER["DOCUMENT_ROOT"], $_SERVER["SCRIPT_NAME"], $_SERVER["PHP_SELF"], $_SERVER["SCRIPT_FILENAME"], $_SERVER["REQUEST_URI"]]);');
    const response = await php.request({ script: '/workspace/site/index.php', documentRoot: '/workspace/site', url: 'http://localhost/article?view=full' });
    assert.equal(response.exitCode, 0);
    assert.deepEqual(JSON.parse(decode(response.body)), ['/workspace/site', '/index.php', '/index.php', '/workspace/site/index.php', '/article?view=full']);
    await assert.rejects(async () => php.request({ script: '/workspace/request.php', documentRoot: '/workspace/site', url: 'http://localhost/' }), error => error.code === 'INVALID_ARGUMENT');
  });

  await t.test('request state and CLI state do not leak across invocations', async () => {
    const response = await php.request({ script: '/workspace/request.php', url: 'http://localhost/clean' });
    const result = JSON.parse(decode(response.body));
    assert.equal(result.method, 'GET');
    assert.deepEqual(result.get, []);
    assert.deepEqual(result.post, []);
    assert.deepEqual(result.cookies, []);
    assert.equal(result.header, null);
    const cli = JSON.parse(decode((await php.run({ script: '/workspace/cli.php' })).stdout));
    assert.equal(cli.sapi, 'cli');
    assert.deepEqual(cli.args, ['/workspace/cli.php']);
    assert.equal(cli.stdin, '');
  });

  await t.test('per-invocation environment, ini settings and working directory are restored', async () => {
    await php.fs.mkdir('/workspace/alternate', { recursive: true });
    await php.fs.writeFile('/workspace/config.php', '<?php echo json_encode([getenv("ONE_REQUEST_ONLY"), ini_get("precision"), getcwd()]);');
    const baseline = JSON.parse(decode((await php.run({ script: '/workspace/config.php' })).stdout));
    const configured = JSON.parse(decode((await php.run({ script: '/workspace/config.php', cwd: '/workspace/alternate', env: { ONE_REQUEST_ONLY: 'configured value' }, ini: { precision: 7 } })).stdout));
    assert.deepEqual(configured, ['configured value', '7', '/workspace/alternate']);
    const restored = JSON.parse(decode((await php.run({ script: '/workspace/config.php' })).stdout));
    assert.deepEqual(restored, baseline);
    await php.fs.writeFile('/workspace/putenv.php', '<?php putenv("ONE_REQUEST_ONLY=changed by PHP"); echo getenv("ONE_REQUEST_ONLY");');
    assert.equal(decode((await php.run({ script: '/workspace/putenv.php' })).stdout), 'changed by PHP');
    assert.deepEqual(JSON.parse(decode((await php.run({ script: '/workspace/config.php' })).stdout)), baseline);
  });

  await t.test('CLI standard stream descriptors remain usable across request shutdown', async () => {
    await php.fs.writeFile('/workspace/streams.php', '<?php fwrite(STDOUT, "out:" . stream_get_contents(STDIN)); fwrite(STDERR, "err");');
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await php.run({ script: '/workspace/streams.php', stdin: encode(`input${attempt}`) });
      assert.equal(result.exitCode, 0);
      assert.equal(decode(result.stdout), `out:input${attempt}`);
      assert.equal(decode(result.stderr), 'err');
    }
  });

  await t.test('large fwrite output preserves every byte and separate stderr', async () => {
    await php.fs.writeFile('/workspace/large-stream.php', '<?php $pattern = ""; for ($i = 0; $i < 256; $i++) $pattern .= chr($i); fwrite(STDOUT, str_repeat($pattern, 1024)); fwrite(STDERR, "stream stderr\\0done");');
    const result = await php.run({ script: '/workspace/large-stream.php' });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 256));
    assert.equal(decode(result.stderr), 'stream stderr\0done');
  });

  await t.test('sessions survive separate requests when callers return the cookie', async () => {
    const first = await php.request({ script: '/workspace/session.php', url: 'http://localhost/session' });
    assert.equal(JSON.parse(decode(first.body)).count, 1);
    const sessionCookie = headerValues(first, 'set-cookie').find(value => value.startsWith('PHPSESSID='));
    assert.ok(sessionCookie, 'PHP must return its session cookie');
    const second = await php.request({ script: '/workspace/session.php', url: 'http://localhost/session', headers: [['cookie', sessionCookie.split(';')[0]]] });
    assert.equal(JSON.parse(decode(second.body)).count, 2);
  });

  await t.test('exit and fatal errors do not poison subsequent requests', async () => {
    const exited = await php.run({ script: '/workspace/exit.php' });
    assert.equal(exited.exitCode, 23);
    assert.equal(decode(exited.stdout), 'before exit\n');
    const fatal = await php.run({ script: '/workspace/fatal.php', ini: { display_errors: 'stderr' } });
    assert.notEqual(fatal.exitCode, 0);
    assert.match(decode(fatal.stderr), /intentional fixture failure/);
    await php.fs.writeFile('/workspace/parse.php', '<?php this is not valid PHP !!!');
    const parse = await php.run({ script: '/workspace/parse.php', ini: { display_errors: 'stderr' } });
    assert.notEqual(parse.exitCode, 0);
    assert.match(decode(parse.stderr), /parse error|syntax error/i);
    const healthy = await php.run({ script: '/workspace/cli.php' });
    assert.equal(healthy.exitCode, 0);
    assert.equal(JSON.parse(decode(healthy.stdout)).sapi, 'cli');
  });

  await t.test('shutdown exit codes and fatal errors are recovered on the next invocation', async () => {
    await php.fs.writeFile('/workspace/shutdown-exit.php', '<?php register_shutdown_function(function () { exit(7); }); echo "shutdown pending";');
    const exited = await php.run({ script: '/workspace/shutdown-exit.php' });
    assert.equal(exited.exitCode, 7);
    assert.equal(decode(exited.stdout), 'shutdown pending');
    await php.fs.writeFile('/workspace/shutdown-fatal.php', '<?php register_shutdown_function(function () { throw new RuntimeException("shutdown failed intentionally"); });');
    const failed = await php.run({ script: '/workspace/shutdown-fatal.php', ini: { display_errors: 'stderr' } });
    assert.notEqual(failed.exitCode, 0);
    assert.match(decode(failed.stderr), /shutdown failed intentionally/);
    const missing = await php.run({ script: '/workspace/does-not-exist.php', ini: { display_errors: 'stderr' } });
    assert.notEqual(missing.exitCode, 0);
    const healthy = await php.run({ script: '/workspace/cli.php' });
    assert.equal(healthy.exitCode, 0);
    assert.equal(JSON.parse(decode(healthy.stdout)).sapi, 'cli');
  });

  await t.test('PHP Fibers suspend and resume with PHP stack state intact', async () => {
    await php.fs.writeFile('/workspace/fiber.php', `<?php
$fiber = new Fiber(function (int $input): int {
  $next = Fiber::suspend($input + 1);
  return $next * 2;
});

$start = $fiber->start(20);
$suspended = $fiber->isSuspended();
$fiber->resume(21);
echo json_encode([$start, $suspended, $fiber->getReturn(), $fiber->isTerminated()], JSON_THROW_ON_ERROR);`);
    const result = await php.run({ script: '/workspace/fiber.php' });
    assert.equal(result.exitCode, 0, decode(result.stderr));
    assert.deepEqual(JSON.parse(decode(result.stdout)), [21, true, 42, true]);
  });

  await t.test('native extensions perform useful operations', async () => {
    await php.fs.writeFile('/workspace/extensions.php', `<?php
$document = new DOMDocument(); $document->loadXML('<root><child>Joomla</child></root>');
$zip = new ZipArchive();
if ($zip->open('/workspace/extension-check.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) throw new Exception('zip create failed');
$zip->addFromString('hello.txt', 'extension payload'); $zip->close();
$zip->open('/workspace/extension-check.zip'); $zipValue = $zip->getFromName('hello.txt'); $zip->close();
$image = imagecreatetruecolor(2, 3); $size = [imagesx($image), imagesy($image)];
ob_start(); imagepng($image); $png = ob_get_clean();
echo json_encode([
  'dom' => $document->getElementsByTagName('child')[0]->textContent,
  'mbstring' => mb_strtoupper('über', 'UTF-8'),
  'intl' => Normalizer::normalize("e\\u{0301}", Normalizer::FORM_C),
  'zip' => $zipValue, 'zlib' => gzdecode(gzencode('compressed text')),
  'openssl' => openssl_digest('abc', 'sha256'), 'gd' => $size, 'png' => bin2hex(substr($png, 0, 8)),
  'iconv' => bin2hex(iconv('UTF-8', 'ISO-8859-1', 'é')),
  'locale' => (new IntlDateFormatter('en_US', IntlDateFormatter::MEDIUM, IntlDateFormatter::NONE, 'UTC'))->format(0),
  'random' => strlen(random_bytes(32)), 'bcmath' => bcadd('99999999999999999999', '1'),
], JSON_THROW_ON_ERROR);`);
    const result = await php.run({ script: '/workspace/extensions.php' });
    assert.equal(result.exitCode, 0, decode(result.stderr));
    assert.deepEqual(JSON.parse(decode(result.stdout)), { dom: 'Joomla', mbstring: 'ÜBER', intl: 'é', zip: 'extension payload', zlib: 'compressed text', openssl: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', gd: [2, 3], png: '89504e470d0a1a0a', iconv: 'e9', locale: 'Jan 1, 1970', random: 32, bcmath: '100000000000000000000' });
  });

  await t.test('filesystem binary operations and serialized concurrent execution', async () => {
    await php.fs.mkdir('/workspace/data/nested', { recursive: true });
    const bytes = Uint8Array.from([0, 255, 128, 10, 13]);
    await php.fs.writeFile('/workspace/data/nested/payload.bin', bytes);
    assert.deepEqual(await php.fs.readFile('/workspace/data/nested/payload.bin'), bytes);
    assert.equal((await php.fs.stat('/workspace/data/nested/payload.bin')).size, bytes.length);
    assert.ok((await php.fs.readdir('/workspace/data/nested')).includes('payload.bin'));
    await php.fs.writeFile('/workspace/counter.txt', '0');
    await php.fs.writeFile('/workspace/increment.php', '<?php $n = (int)file_get_contents("/workspace/counter.txt") + 1; file_put_contents("/workspace/counter.txt", (string)$n); echo $n;');
    const values = await Promise.all(Array.from({ length: 10 }, () => php.run({ script: '/workspace/increment.php' })));
    assert.deepEqual(values.map(value => Number(decode(value.stdout))), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(decode(await php.fs.readFile('/workspace/counter.txt')), '10');
    await php.fs.unlink('/workspace/data/nested/payload.bin');
    await assert.rejects(php.fs.readFile('/workspace/data/nested/payload.bin'), error => error.code === 'FILESYSTEM_ERROR');
  });

  await t.test('public filesystem rejects paths outside its workspace', async () => {
    for (const path of ['/tmp/file', '/workspace/../tmp/file', '/workspace-other/file', '/workspace/file\0.php']) {
      await assert.rejects(async () => php.fs.writeFile(path, 'must not write'), error => ['INVALID_ARGUMENT', 'PATH_OUTSIDE_WORKSPACE'].includes(error.code), path);
    }
    await php.fs.writeFile('/workspace/symlink.php', '<?php symlink("/tmp", "/workspace/escape");');
    assert.equal((await php.run({ script: '/workspace/symlink.php' })).exitCode, 0);
    await assert.rejects(async () => php.fs.writeFile('/workspace/escape/file', 'must not write'), error => error.code === 'PATH_OUTSIDE_WORKSPACE');
    await php.fs.writeFile('/workspace/nested-links.php', '<?php symlink("/tmp/not-created", "/workspace/dangling"); symlink("/workspace/dangling", "/workspace/chain"); symlink("/workspace/data", "/workspace/safe-alias");');
    assert.equal((await php.run({ script: '/workspace/nested-links.php' })).exitCode, 0);
    for (const path of ['/workspace/dangling/file', '/workspace/chain/file']) {
      await assert.rejects(async () => php.fs.writeFile(path, 'must not write'), error => error.code === 'PATH_OUTSIDE_WORKSPACE', path);
    }
    await php.fs.writeFile('/workspace/safe-alias/allowed.txt', 'inside workspace');
    assert.equal(decode(await php.fs.readFile('/workspace/data/allowed.txt')), 'inside workspace');
  });

  await t.test('HTTP header validation rejects newline injection', async () => {
    await assert.rejects(async () => php.request({ script: '/workspace/request.php', url: 'http://localhost/', headers: [['X-Test', 'safe\r\nInjected: value']] }), error => error.code === 'INVALID_ARGUMENT');
  });

  await t.test('mixed HTTP, CLI and fatal invocations repeatedly reset PHP declarations and globals', async () => {
    await php.fs.writeFile('/workspace/reset.php', `<?php
class PerRequestState { public string $value = 'fresh'; }
function invocationCount(): int { static $count = 0; return ++$count; }
$allocation = str_repeat('x', 65536);
echo json_encode([PHP_SAPI, getenv('RUN_INDEX'), invocationCount(), (new PerRequestState())->value, strlen($allocation)], JSON_THROW_ON_ERROR);`);
    for (let index = 0; index < 15; index++) {
      const cli = await php.run({ script: '/workspace/reset.php', env: { RUN_INDEX: String(index) } });
      assert.equal(cli.exitCode, 0, decode(cli.stderr));
      assert.deepEqual(JSON.parse(decode(cli.stdout)), ['cli', String(index), 1, 'fresh', 65536]);
      const http = await php.request({ script: '/workspace/reset.php', url: `http://localhost/reset?n=${index}`, env: { RUN_INDEX: String(index) } });
      assert.equal(http.exitCode, 0, decode(http.stderr));
      assert.deepEqual(JSON.parse(decode(http.body)), ['cgi-fcgi', String(index), 1, 'fresh', 65536]);
      assert.notEqual((await php.run({ script: '/workspace/fatal.php', ini: { display_errors: 'stderr' } })).exitCode, 0);
    }
  });
});

test('PHP can await asynchronous host bridge calls without blocking or deadlocking', { timeout: 60_000 }, async () => {
  let php;
  php = await createPHP({ ...await engineOptions(), hostCalls: {
    double: async payload => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return JSON.stringify({ result: JSON.parse(payload).value * 2 });
    },
    reentry: async () => {
      const codes = [];
      try { await php.fs.readFile('/workspace/bridge.php'); }
      catch (error) { codes.push(error.code); }
      try { await php.close(); }
      catch (error) { codes.push(error.code); }
      if (codes.length !== 2) throw new Error('Runtime allowed a deadlocking reentrant host call');
      return JSON.stringify({ codes });
    },
    rejected: async () => { throw new Error('expected host failure'); },
  } });
  try {
    await php.fs.writeFile('/workspace/bridge.php', `<?php
$double = json_decode(php_wasm_host_call('double', json_encode(['value' => 21])), true, 512, JSON_THROW_ON_ERROR);
$reentry = json_decode(php_wasm_host_call('reentry', '{}'), true, 512, JSON_THROW_ON_ERROR);
try { php_wasm_host_call('rejected', '{}'); }
catch (Throwable $error) { $failure = $error->getMessage(); }
$fiber = new Fiber(function () {
  $first = json_decode(php_wasm_host_call('double', '{"value":10}'), true, 512, JSON_THROW_ON_ERROR);
  $resumed = Fiber::suspend($first['result']);
  return json_decode(php_wasm_host_call('double', json_encode(['value' => $resumed])), true, 512, JSON_THROW_ON_ERROR)['result'];
});
$suspended = $fiber->start();
$fiber->resume(21);
echo json_encode([$double, $reentry, $failure, [$suspended, $fiber->getReturn()]], JSON_THROW_ON_ERROR);`);
    const result = await php.run({ script: '/workspace/bridge.php' });
    assert.equal(result.exitCode, 0, decode(result.stderr));
    assert.deepEqual(JSON.parse(decode(result.stdout)), [{ result: 42 }, { codes: ['REENTRANT_CALL', 'REENTRANT_CALL'] }, 'expected host failure', [20, 42]]);
    const repeated = await php.run({ script: '/workspace/bridge.php' });
    assert.equal(repeated.exitCode, 0, decode(repeated.stderr));
  } finally { await php.close(); }
});

test('asset integrity mismatch fails before PHP executes', { timeout: 60_000 }, async () => {
  const options = await directEngineOptions();
  options.engine.wasm.sha256 = '0'.repeat(64);
  await assert.rejects(createPHP(options), error => error.code === 'INTEGRITY_MISMATCH');
});

test('closing PHP standard streams does not break the next CLI invocation', { timeout: 60_000 }, async () => {
  const php = await createPHP(await engineOptions());
  try {
    await php.fs.writeFile('/workspace/close-streams.php', '<?php fclose(STDIN); fclose(STDOUT); fclose(STDERR);');
    assert.equal((await php.run({ script: '/workspace/close-streams.php' })).exitCode, 0);
    await php.fs.writeFile('/workspace/streams.php', '<?php fwrite(STDOUT, stream_get_contents(STDIN)); fwrite(STDERR, "still open");');
    const result = await php.run({ script: '/workspace/streams.php', stdin: encode('new input') });
    assert.equal(result.exitCode, 0);
    assert.equal(decode(result.stdout), 'new input');
    assert.equal(decode(result.stderr), 'still open');
  } finally { await php.close(); }
});

test('close drains accepted work, rejects new work and releases the worker', { timeout: 60_000 }, async () => {
  const php = await createPHP(await engineOptions());
  try {
    await php.fs.writeFile('/workspace/count.txt', '0');
    await php.fs.writeFile('/workspace/count.php', '<?php $value = (int)file_get_contents("/workspace/count.txt") + 1; file_put_contents("/workspace/count.txt", (string)$value); echo $value;');
    const accepted = Array.from({ length: 5 }, () => php.run({ script: '/workspace/count.php' }));
    const closing = php.close();
    await assert.rejects(async () => php.run({ script: '/workspace/count.php' }), error => error.code === 'CLOSED');
    await assert.rejects(async () => php.fs.readFile('/workspace/count.txt'), error => error.code === 'CLOSED');
    assert.deepEqual((await Promise.all(accepted)).map(result => Number(decode(result.stdout))), [1, 2, 3, 4, 5]);
    await closing;
    await php.close();
  } finally { await php.close(); }
});

test('request and queue limits reject excess work without poisoning the runtime', { timeout: 60_000 }, async () => {
  const php = await createPHP({ ...await engineOptions(), maxRequestBytes: 4096, maxQueuedRequests: 1 });
  try {
    await assert.rejects(async () => php.fs.writeFile('/workspace/large.bin', new Uint8Array(8192)), error => error.code === 'REQUEST_LIMIT');
    await php.fs.writeFile('/workspace/ok.php', '<?php echo "ok";');
    const accepted = php.run({ script: '/workspace/ok.php' });
    await assert.rejects(async () => php.run({ script: '/workspace/ok.php' }), error => error.code === 'QUEUE_LIMIT');
    assert.equal(decode((await accepted).stdout), 'ok');
    assert.equal(decode((await php.run({ script: '/workspace/ok.php' })).stdout), 'ok');
  } finally { await php.close(); }
});

test('unbounded PHP output is stopped and the worker cannot be reused', { timeout: 60_000 }, async () => {
  const php = await createPHP({ ...await engineOptions(), maxOutputBytes: 4096 });
  try {
    await php.fs.writeFile('/workspace/output.php', '<?php while (true) { echo str_repeat("x", 1024); }');
    await assert.rejects(php.run({ script: '/workspace/output.php' }), error => error.code === 'OUTPUT_LIMIT');
    await assert.rejects(php.fs.readFile('/workspace/output.php'), error => error.code === 'CLOSED');
  } finally { await php.close(); }
});

test('timed-out PHP is terminated and close is idempotent', { timeout: 60_000 }, async () => {
  const php = await createPHP({ ...await engineOptions(), timeoutMs: 2_000 });
  try {
    await php.fs.writeFile('/workspace/timeout.php', '<?php while (true) {}');
    await assert.rejects(php.run({ script: '/workspace/timeout.php' }), error => error.code === 'TIMEOUT');
    await assert.rejects(php.run({ script: '/workspace/timeout.php' }), error => error.code === 'CLOSED');
  } finally {
    await php.close();
    await php.close();
  }
});
