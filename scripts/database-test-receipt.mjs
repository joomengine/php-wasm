import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCatalog, root } from './catalog.mjs';
import { createManifest } from './manifest.mjs';
import { verifyBridge } from './prepare-mariadb-tests.mjs';

export const databaseEnvironments = ['node', 'chromium', 'firefox'];
export const verificationSuites = ['node', 'chromium', 'firefox', ...databaseEnvironments.map(environment => `mariadb-${environment}`)];
const startedEngines = new Map();
const engineIdentity = engine => ({ phpVersion: engine.phpVersion, module: engine.module.sha256, wasm: engine.wasm.sha256 });

export function sourceCommit() {
  const commit = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('An exact source commit is required');
  return commit;
}

export function databaseReceiptPath(minor, environment) {
  if (!/^\d+\.\d+$/.test(minor) || !databaseEnvironments.includes(environment)) {
    throw new Error('Database verification requires a PHP minor and node, chromium, or firefox');
  }
  return path.join(root, 'dist', `database-verification-${minor}-${environment}.json`);
}

export function expectedDatabaseReceipt({ minor, environment, manifest, commit, catalog }) {
  const driver = catalog.extensions.pdo_mariadb_wasm;
  return {
    schemaVersion: 1,
    commit,
    runtimeVersion: manifest.runtimeVersion,
    phpMinor: minor,
    engine: manifest.engines[minor],
    environment,
    bridge: {
      version: driver.version,
      protocolVersion: driver.protocolVersion,
      sourceCommit: driver.commit,
      runtimeArchive: { url: driver.runtimeArchive.url, sha256: driver.runtimeArchive.sha256 },
    },
  };
}

// Tests clear before any work and record after every assertion succeeds. A
// failed rerun therefore cannot reuse an older success receipt.
export async function clearDatabaseReceipt(environment) {
  await rm(databaseReceiptPath(process.env.PHP_WASM_VERSION ?? '8.4', environment), { force: true });
  startedEngines.delete(environment);
  // Capture the exact test-engine overrides before execution. Regenerating the
  // release manifest afterwards must not silently certify different bytes.
  const { directEngineOptions } = await import('../test/helpers.mjs');
  const { engine } = await directEngineOptions();
  startedEngines.set(environment, engineIdentity(engine));
}

export async function recordDatabaseReceipt(environment) {
  const minor = process.env.PHP_WASM_VERSION ?? '8.4';
  const filename = databaseReceiptPath(minor, environment);
  const catalog = await readCatalog();
  const directory = path.resolve(root, process.env.PHP_WASM_MARIADB_DIR ?? '.build/mariadb-bridge');
  await verifyBridge(directory, catalog.extensions.pdo_mariadb_wasm);
  const manifest = await createManifest({ versions: [minor] });
  assert.deepEqual(startedEngines.get(environment), engineIdentity(manifest.engines[minor]),
    `PHP ${minor}: tested engine differs from release artifacts`);
  const receipt = expectedDatabaseReceipt({ minor, environment, manifest, commit: sourceCommit(), catalog });
  await writeFile(filename, `${JSON.stringify(receipt, null, 2)}\n`);
  startedEngines.delete(environment);
}

export function verifyDatabaseReceipts(receipts, { minor, manifest, commit, catalog }) {
  assert.ok(Array.isArray(receipts) && receipts.length === databaseEnvironments.length, `PHP ${minor}: all real MariaDB environments must pass`);
  for (const [index, environment] of databaseEnvironments.entries()) {
    assert.deepEqual(receipts[index], expectedDatabaseReceipt({ minor, environment, manifest, commit, catalog }),
      `PHP ${minor}: missing or mismatched MariaDB ${environment} verification; rerun the combined database suite`);
  }
}
