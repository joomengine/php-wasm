import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createManifest } from './manifest.mjs';
import { readCatalog, root } from './catalog.mjs';
import { databaseEnvironments, databaseReceiptPath, sourceCommit, verificationSuites, verifyDatabaseReceipts } from './database-test-receipt.mjs';

const minor = process.argv[2];
if (!minor) throw new Error('Usage: node scripts/test-receipt.mjs <PHP minor>');
const manifest = await createManifest({ versions: [minor] });
const commit = sourceCommit();
const catalog = await readCatalog();
const databaseTests = await Promise.all(databaseEnvironments.map(async environment => JSON.parse(await readFile(databaseReceiptPath(minor, environment), 'utf8'))));
verifyDatabaseReceipts(databaseTests, { minor, manifest, commit, catalog });
const receipt = {
  schemaVersion: 1,
  commit,
  runtimeVersion: manifest.runtimeVersion,
  phpMinor: minor,
  engine: manifest.engines[minor],
  suites: verificationSuites,
  databaseTests,
};
// CI calls this after the PHP and combined MariaDB suites succeed.
// Database receipts independently bind every environment to the tested engines.
await writeFile(path.join(root, 'dist', `verification-${minor}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Recorded tested artifact hashes for PHP ${minor} at ${commit}`);
