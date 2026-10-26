import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPHP } from '../src/index.mjs';
import { decode, encode, engineOptions, headerValues, installFixtures, phpVersion } from './helpers.mjs';

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

  await t.test('HEAD runs PHP and sends headers with no response body', async () => {
    await php.fs.writeFile('/workspace/head.php', '<?php header("X-Executed: yes"); echo "must be omitted";');
    const response = await php.request({ script: '/workspace/head.php', url: 'http://localhost/head', method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.deepEqual(headerValues(response, 'x-executed'), ['yes']);
    assert.equal(response.body.byteLength, 0);
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
echo json_encode([
  'dom' => $document->getElementsByTagName('child')[0]->textContent,
  'mbstring' => mb_strtoupper('über', 'UTF-8'),
  'intl' => Normalizer::normalize("e\\u{0301}", Normalizer::FORM_C),
  'zip' => $zipValue, 'zlib' => gzdecode(gzencode('compressed text')),
  'openssl' => openssl_digest('abc', 'sha256'), 'gd' => $size,
  'random' => strlen(random_bytes(32)), 'bcmath' => bcadd('99999999999999999999', '1'),
], JSON_THROW_ON_ERROR);`);
    const result = await php.run({ script: '/workspace/extensions.php' });
    assert.equal(result.exitCode, 0, decode(result.stderr));
    assert.deepEqual(JSON.parse(decode(result.stdout)), { dom: 'Joomla', mbstring: 'ÜBER', intl: 'é', zip: 'extension payload', zlib: 'compressed text', openssl: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', gd: [2, 3], random: 32, bcmath: '100000000000000000000' });
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
  });

  await t.test('HTTP header validation rejects newline injection', async () => {
    await assert.rejects(async () => php.request({ script: '/workspace/request.php', url: 'http://localhost/', headers: [['X-Test', 'safe\r\nInjected: value']] }), error => error.code === 'INVALID_ARGUMENT');
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
      try { await php.fs.readFile('/workspace/bridge.php'); }
      catch (error) { return JSON.stringify({ code: error.code }); }
      throw new Error('Runtime allowed a deadlocking reentrant host call');
    },
    rejected: async () => { throw new Error('expected host failure'); },
  } });
  try {
    await php.fs.writeFile('/workspace/bridge.php', `<?php
$double = json_decode(php_wasm_host_call('double', json_encode(['value' => 21])), true, 512, JSON_THROW_ON_ERROR);
$reentry = json_decode(php_wasm_host_call('reentry', '{}'), true, 512, JSON_THROW_ON_ERROR);
try { php_wasm_host_call('rejected', '{}'); }
catch (Throwable $error) { $failure = $error->getMessage(); }
echo json_encode([$double, $reentry, $failure], JSON_THROW_ON_ERROR);`);
    const result = await php.run({ script: '/workspace/bridge.php' });
    assert.equal(result.exitCode, 0, decode(result.stderr));
    assert.deepEqual(JSON.parse(decode(result.stdout)), [{ result: 42 }, { code: 'REENTRANT_CALL' }, 'expected host failure']);
    const repeated = await php.run({ script: '/workspace/bridge.php' });
    assert.equal(repeated.exitCode, 0, decode(repeated.stderr));
  } finally { await php.close(); }
});

test('asset integrity mismatch fails before PHP executes', { timeout: 60_000 }, async () => {
  const options = await engineOptions(undefined, { manifest: false });
  options.engine.wasm.sha256 = '0'.repeat(64);
  await assert.rejects(createPHP(options), error => error.code === 'INTEGRITY_MISMATCH');
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
