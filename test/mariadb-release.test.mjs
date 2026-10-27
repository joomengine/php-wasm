import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyBridge, verifyNativeSource } from '../scripts/prepare-mariadb-tests.mjs';

test('MariaDB test release rejects altered bytes, missing files and wrong source identity', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mariadb-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = { version: '0.1.0', protocolVersion: 1, commit: '1'.repeat(40) };
  const files = {};
  for (const name of ['src/index.mjs', 'native/pdo_mariadb_wasm.c', 'native/config.m4', 'native/php_pdo_mariadb_wasm.h', 'vendor/lite4mariadb/index.mjs', 'vendor/lite4mariadb/lite4mariadb.wasm', 'vendor/lite4mariadb/COPYING']) {
    const bytes = Buffer.from(name);
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), bytes);
    files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  }
  const manifest = { schemaVersion: 1, bridgeVersion: source.version, protocolVersion: 1, sourceCommit: source.commit, phpDriver: { module: 'pdo_mariadb_wasm', pdoName: 'mysql' }, files };
  await writeFile(path.join(dir, 'bridge-manifest.json'), JSON.stringify(manifest));
  assert.equal((await verifyBridge(dir, source)).sourceCommit, source.commit);
  await assert.rejects(verifyBridge(dir, { ...source, commit: '2'.repeat(40) }));
  await writeFile(path.join(dir, 'src/index.mjs'), 'tampered');
  await assert.rejects(verifyBridge(dir, source), /inventory mismatch/);
  await rm(path.join(dir, 'src/index.mjs'));
  await assert.rejects(verifyBridge(dir, source), /Incomplete bridge archive/);
});

test('release parity permits an unbuilt source but rejects partial or changed native sources', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mariadb-source-parity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = path.join(dir, 'release'), source = path.join(dir, 'custom-build/sources/pdo_mariadb_wasm');
  await mkdir(path.join(release, 'native'), { recursive: true });
  for (const name of ['config.m4', 'pdo_mariadb_wasm.c', 'php_pdo_mariadb_wasm.h']) {
    await writeFile(path.join(release, 'native', name), name);
  }
  await verifyNativeSource(release, source);
  await mkdir(path.join(source, 'native'), { recursive: true });
  await assert.rejects(verifyNativeSource(release, source), { code: 'ENOENT' });
  for (const name of ['config.m4', 'pdo_mariadb_wasm.c', 'php_pdo_mariadb_wasm.h']) {
    await copyFile(path.join(release, 'native', name), path.join(source, 'native', name));
  }
  await verifyNativeSource(release, source);
  await writeFile(path.join(source, 'native/php_pdo_mariadb_wasm.h'), 'changed source');
  await assert.rejects(verifyNativeSource(release, source), /Compiled source differs/);
  await rm(path.join(source, 'native/php_pdo_mariadb_wasm.h'));
  await assert.rejects(verifyNativeSource(release, source), { code: 'ENOENT' });
});
