import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const extensionScript = fileURLToPath(new URL('../build/extension.sh', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'php-wasm-extension-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const driver = path.join(root, 'bridge'), php = path.join(root, 'php');
  await mkdir(path.join(root, 'build'));
  await mkdir(path.join(driver, 'native'), { recursive: true });
  await mkdir(path.join(php, 'ext'), { recursive: true });
  await copyFile(extensionScript, path.join(root, 'build/extension.sh'));
  const entry = { version: '0.1.0', protocolVersion: 1,
    repository: 'https://github.com/joomengine/mariadb-wasm-bridge.git', commit: 'a'.repeat(40) };
  await writeFile(path.join(root, 'versions.json'), JSON.stringify({ extensions: { pdo_mariadb_wasm: entry } }));
  await writeFile(path.join(driver, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  for (const name of ['config.m4', 'pdo_mariadb_wasm.c', 'php_pdo_mariadb_wasm.h']) {
    await writeFile(path.join(driver, 'native', name), `fixture ${name}\n`);
  }
  await writeFile(path.join(driver, 'LICENSE'), 'fixture license\n');
  await writeFile(path.join(driver, 'NOTICE'), 'fixture notice\n');
  await writeFile(path.join(php, '.source-ready'), 'upstream-source-fingerprint\n');
  await writeFile(path.join(php, 'buildconf'), '#!/bin/sh\ntest "$1" = --force || exit 2\nprintf "buildconf\\n" >> buildconf-calls\n', { mode: 0o755 });
  return {
    root, driver, php, entry,
    async run(script) {
      return execute('bash', ['-c', `set -euo pipefail\nsource "$ROOT/build/extension.sh"\n${script}`], {
        env: { ...process.env, ROOT: root, DRIVER: driver, PHP_SOURCE: php }, timeout: 10_000,
      });
    },
  };
}

test('driver fingerprint includes staged bytes and rejects incompatible bridge versions', async t => {
  const f = await fixture(t);
  const first = (await f.run('pdo_mariadb_fingerprint "$DRIVER"')).stdout.trim();
  assert.match(first, /^[a-f0-9]{64}$/);
  await writeFile(path.join(f.driver, 'native/pdo_mariadb_wasm.c'), 'changed source\n');
  const changed = (await f.run('pdo_mariadb_fingerprint "$DRIVER"')).stdout.trim();
  assert.notEqual(changed, first);
  await writeFile(path.join(f.driver, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  await assert.rejects(f.run('pdo_mariadb_fingerprint "$DRIVER"'), error => {
    assert.match(error.stderr, /source version 0\.2\.0 does not match 0\.1\.0/);
    return true;
  });
});

test('incomplete source cannot produce a valid extension fingerprint', async t => {
  const f = await fixture(t);
  await rm(path.join(f.driver, 'native/config.m4'));
  // A conditional caller suppresses implicit errexit; failure must still propagate.
  await assert.rejects(f.run('if pdo_mariadb_fingerprint "$DRIVER"; then exit 0; else exit "$?"; fi'));
});

test('driver staging regenerates configure once and replaces obsolete extension files', async t => {
  const f = await fixture(t);
  const stage = 'fingerprint=$(pdo_mariadb_fingerprint "$DRIVER"); stage_pdo_mariadb "$PHP_SOURCE" "$DRIVER" "$fingerprint"';
  await f.run(stage);
  assert.equal(await readFile(path.join(f.php, 'ext/pdo_mariadb_wasm/pdo_mariadb_wasm.c'), 'utf8'), 'fixture pdo_mariadb_wasm.c\n');
  assert.equal(await readFile(path.join(f.php, '.source-ready'), 'utf8'), 'upstream-source-fingerprint\n');
  await f.run(stage);
  assert.equal(await readFile(path.join(f.php, 'buildconf-calls'), 'utf8'), 'buildconf\n');
  await writeFile(path.join(f.php, 'ext/pdo_mariadb_wasm/obsolete.o'), 'old object');
  await writeFile(path.join(f.driver, 'native/pdo_mariadb_wasm.c'), 'new driver\n');
  await f.run(stage);
  await assert.rejects(readFile(path.join(f.php, 'ext/pdo_mariadb_wasm/obsolete.o')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.php, 'buildconf-calls'), 'utf8'), 'buildconf\nbuildconf\n');
});

test('failed configure regeneration invalidates both source and driver success markers', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.php, '.pdo-mariadb-staged'), 'old-driver\n');
  await writeFile(path.join(f.php, 'buildconf'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  await assert.rejects(f.run('if stage_pdo_mariadb "$PHP_SOURCE" "$DRIVER" new-driver; then exit 0; else exit "$?"; fi'), { code: 7 });
  await assert.rejects(readFile(path.join(f.php, '.source-ready')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.php, '.pdo-mariadb-staged')), { code: 'ENOENT' });
});
