import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readCatalog } from '../scripts/catalog.mjs';
import { createManifest, mariaDBDriverDescriptor } from '../scripts/manifest.mjs';
import { databaseEnvironments, expectedDatabaseReceipt, verifyDatabaseReceipts } from '../scripts/database-test-receipt.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('manifest requires driver provenance bound to the exact compiled artifacts', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'php-wasm-manifest-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = await readCatalog();
  const minor = Object.keys(catalog.php)[0];
  const enginePath = path.join(directory, 'php', minor);
  await mkdir(enginePath, { recursive: true });
  // Structural fixtures only: this suite verifies build metadata, not execution.
  const module = Buffer.from('export default function fixture() {}\n');
  const wasm = Buffer.from('0061736d01000000', 'hex');
  await writeFile(path.join(enginePath, 'php.mjs'), module);
  await writeFile(path.join(enginePath, 'php.wasm'), wasm);
  const create = () => createManifest({ directory, versions: [minor] });
  await assert.rejects(create, { code: 'ENOENT' });
  const driver = mariaDBDriverDescriptor(catalog);
  const marker = {
    bridgeVersion: driver.version,
    protocolVersion: driver.protocolVersion,
    source: driver.source,
    moduleSha256: hash(module),
    wasmSha256: hash(wasm),
  };
  const save = value => writeFile(path.join(enginePath, 'mariadb-driver.json'), JSON.stringify(value));
  await save(marker);
  const manifest = await create();
  assert.deepEqual(manifest.engines[minor].extensions.pdo_mariadb_wasm, driver);
  for (const mutation of [
    { moduleSha256: '0'.repeat(64) },
    { wasmSha256: '0'.repeat(64) },
    { bridgeVersion: '999.0.0' },
    { protocolVersion: 2 },
    { source: { ...marker.source, commit: '0'.repeat(40) } },
  ]) {
    await save({ ...marker, ...mutation });
    await assert.rejects(create, /MariaDB driver build metadata does not match/);
  }
});

test('release receipts require matching combined database tests in all environments', async () => {
  const catalog = await readCatalog();
  const minor = Object.keys(catalog.php)[0];
  const manifest = { runtimeVersion: '1.0.0', engines: { [minor]: {
    phpVersion: catalog.php[minor].version,
    module: { url: 'fixture.mjs', sha256: '1'.repeat(64) },
    wasm: { url: 'fixture.wasm', sha256: '2'.repeat(64) },
    extensions: { pdo_mariadb_wasm: mariaDBDriverDescriptor(catalog) },
  } } };
  const context = { catalog, minor, manifest, commit: '3'.repeat(40) };
  const receipts = databaseEnvironments.map(environment => expectedDatabaseReceipt({ ...context, environment }));
  verifyDatabaseReceipts(receipts, context);
  assert.throws(() => verifyDatabaseReceipts(receipts.slice(1), context), /all real MariaDB environments must pass/);
  for (const mutate of [
    receipt => { receipt.engine.wasm.sha256 = '4'.repeat(64); },
    receipt => { receipt.commit = '5'.repeat(40); },
    receipt => { receipt.bridge.runtimeArchive.sha256 = '6'.repeat(64); },
    receipt => { receipt.bridge.sourceCommit = '7'.repeat(40); },
    receipt => { receipt.environment = 'node'; },
  ]) {
    const changed = receipts.map(receipt => structuredClone(receipt));
    mutate(changed[1]);
    assert.throws(() => verifyDatabaseReceipts(changed, context), /missing or mismatched MariaDB chromium verification/);
  }
});
