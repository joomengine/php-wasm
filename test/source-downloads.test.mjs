import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const common = fileURLToPath(new URL('../build/common.sh', import.meta.url));
const routes = new Map(), requests = new Map();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let directory, certificate, archive, digest, server, baseURL, sequence = 0;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'php-wasm-download-test-'));
  certificate = path.join(directory, 'certificate.pem');
  const key = path.join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  await mkdir(path.join(directory, 'package'));
  await writeFile(path.join(directory, 'package', 'source.txt'), 'verified source\n');
  const tar = path.join(directory, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', tar, '-C', directory, 'package']);
  archive = await readFile(tar);
  digest = sha256(archive);
  server = https.createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    const count = (requests.get(request.url) ?? 0) + 1;
    requests.set(request.url, count);
    const actions = routes.get(request.url);
    const action = actions?.[Math.min(count - 1, actions.length - 1)] ?? 404;
    if (typeof action === 'function') return action(request, response);
    if (typeof action === 'number') {
      response.writeHead(action);
      return response.end('fixture HTTP failure');
    }
    if (action === 'partial') {
      response.writeHead(200, { 'Content-Length': archive.length });
      response.write(archive.subarray(0, Math.floor(archive.length / 2)));
      return setTimeout(() => response.destroy(), 10);
    }
    response.end(action === 'valid' ? archive : action);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `https://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(actions, expectedDigest = digest) {
  const id = ++sequence;
  const root = path.join(directory, `case-${id}`), build = path.join(root, 'build');
  await mkdir(path.join(build, 'downloads'), { recursive: true });
  const urls = actions.map((responses, index) => {
    const route = `/case-${id}/source-${index}`;
    routes.set(route, responses);
    return `${baseURL}${route}`;
  });
  await writeFile(path.join(root, 'versions.json'), JSON.stringify({ libraries: {
    fixture: { url: urls[0], fallbackUrls: urls.slice(1), sha256: expectedDigest }
  } }));
  return {
    urls, cache: path.join(build, 'downloads', `${expectedDigest}.tar`),
    source: path.join(build, 'sources', 'fixture'),
    count(index) { return requests.get(new URL(urls[index]).pathname) ?? 0; },
    async run() {
      try {
        // The conditional deliberately suppresses implicit Bash errexit in
        // fetch_source, so every error still has to propagate explicitly.
        const result = await execute('bash', ['-c', `
          set -euo pipefail
          ROOT=$FIXTURE_ROOT
          BUILD=$FIXTURE_BUILD
          source "$COMMON_SH"
          if fetch_source .libraries.fixture "$SOURCES/fixture"; then
            printf 'FETCH_OK\\n'
          else
            exit "$?"
          fi
        `], { timeout: 30_000, env: { ...process.env,
          FIXTURE_ROOT: root, FIXTURE_BUILD: build, COMMON_SH: common,
          CURL_CA_BUNDLE: certificate, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
          HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' }
        });
        return { ...result, code: 0 };
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    },
    async assertSuccess(result) {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(sha256(await readFile(this.cache)), expectedDigest);
      assert.equal(await readFile(path.join(this.source, 'source.txt'), 'utf8'), 'verified source\n');
      assert.ok(existsSync(path.join(this.source, '.source-ready')));
      assert.deepEqual((await readdir(path.dirname(this.cache))).filter(name => name.includes('.part.')), []);
    },
    async assertFailure(result) {
      assert.notEqual(result.code, 0);
      assert.ok(!existsSync(this.cache), 'failed or unverified download entered the cache');
      assert.ok(!existsSync(path.join(this.source, '.source-ready')), 'failure marked source ready');
      assert.deepEqual(await readdir(path.dirname(this.cache)), []);
    }
  };
}

test('retries HTTP 504 and logs the source key and URL', async () => {
  const f = await fixture([[504, 'valid']]);
  const result = await f.run();
  await f.assertSuccess(result);
  assert.equal(f.count(0), 2);
  assert.ok(result.stdout.includes(`Downloading .libraries.fixture from ${f.urls[0]}`));
});

test('retries a truncated transfer without appending partial bytes', async () => {
  const f = await fixture([['partial', 'valid']]);
  await f.assertSuccess(await f.run());
  assert.equal(f.count(0), 2);
});

test('exhausts bounded primary retries then uses the verified fallback', async () => {
  const f = await fixture([[504], ['valid']]);
  await f.assertSuccess(await f.run());
  assert.equal(f.count(0), 4);
  assert.equal(f.count(1), 1);
});

test('rejects wrong content before cache promotion and tries the fallback', async () => {
  const f = await fixture([['wrong bytes'], ['valid']]);
  routes.set(new URL(f.urls[1]).pathname, [(_request, response) => {
    assert.ok(!existsSync(f.cache), 'unverified primary bytes were cached');
    response.end(archive);
  }]);
  const result = await f.run();
  await f.assertSuccess(result);
  assert.equal(f.count(0), 1);
  assert.equal(f.count(1), 1);
  assert.match(result.stderr, /SHA-256 mismatch/);
});

test('refuses all mismatched mirrors without a cache or ready marker', async () => {
  const f = await fixture([['wrong primary'], ['wrong mirror']]);
  await f.assertFailure(await f.run());
  assert.equal(f.count(0), 1);
  assert.equal(f.count(1), 1);
});

test('permanent transport failure propagates through a conditional caller', async () => {
  const f = await fixture([[504]]);
  await f.assertFailure(await f.run());
  assert.equal(f.count(0), 4);
});

test('repairs a corrupt cache entry instead of repeatedly trusting it', async () => {
  const f = await fixture([['valid']]);
  await writeFile(f.cache, 'corrupt cached download');
  const result = await f.run();
  await f.assertSuccess(result);
  assert.equal(f.count(0), 1);
  assert.match(result.stderr, /Discarding corrupt cached archive/);
});

test('reuses a verified cached archive without network requests', async () => {
  const f = await fixture([[504]]);
  await writeFile(f.cache, archive);
  await f.assertSuccess(await f.run());
  assert.equal(f.count(0), 0);
});

test('an extraction error never writes the source-ready marker', async () => {
  const bytes = Buffer.from('checksum-correct but not a tar archive');
  const f = await fixture([[bytes]], sha256(bytes));
  const result = await f.run();
  assert.notEqual(result.code, 0);
  assert.ok(!existsSync(path.join(f.source, '.source-ready')));
  assert.equal(sha256(await readFile(f.cache)), sha256(bytes));
});

test('catalog validation rejects non-HTTPS and malformed fallback lists', async () => {
  const root = path.join(directory, 'catalog');
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(new URL('../scripts/catalog.mjs', import.meta.url), path.join(root, 'scripts', 'catalog.mjs'));
  const catalog = JSON.parse(await readFile(new URL('../versions.json', import.meta.url), 'utf8'));
  for (const fallbackUrls of ['https://example.invalid/source.tar', ['http://example.invalid/source.tar']]) {
    catalog.libraries.zlib.fallbackUrls = fallbackUrls;
    await writeFile(path.join(root, 'versions.json'), JSON.stringify(catalog));
    await assert.rejects(execute(process.execPath, [path.join(root, 'scripts', 'catalog.mjs')]));
  }
});
