import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { readCatalog, root } from './catalog.mjs';
import { createManifest } from './manifest.mjs';
import { verificationSuites, verifyDatabaseReceipts } from './database-test-receipt.mjs';

const catalog = await readCatalog();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : process.env.RELEASE_TAG;
if (tag && tag !== `v${pkg.version}`) throw new Error(`Tag ${tag} does not match package version v${pkg.version}`);
const commit = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const manifest = await createManifest();
for (const minor of Object.keys(catalog.php)) {
  const receipt = JSON.parse(await readFile(path.join(root, 'dist', `verification-${minor}.json`), 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.commit !== commit || receipt.runtimeVersion !== pkg.version ||
      receipt.phpMinor !== minor || JSON.stringify(receipt.engine) !== JSON.stringify(manifest.engines[minor]) ||
      JSON.stringify(receipt.suites) !== JSON.stringify(verificationSuites)) {
    throw new Error(`PHP ${minor}: missing or mismatched verification receipt; rebuild and run all suites`);
  }
  verifyDatabaseReceipts(receipt.databaseTests, { minor, manifest, commit, catalog });
  const licenses = await readdir(path.join(root, 'dist', 'php', minor, 'licenses'));
  if (!licenses.length) throw new Error(`PHP ${minor}: upstream licenses must accompany binaries`);
}

const output = path.join(root, 'release');
const staging = path.join(output, 'package');
await rm(output, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const item of ['src', 'types', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md', 'package.json', 'versions.json', 'docs']) {
  await cp(path.join(root, item), path.join(staging, item), { recursive: true });
}
await cp(path.join(root, 'dist', 'php'), path.join(staging, 'php'), { recursive: true });
await cp(path.join(root, 'dist', 'runtime-manifest.json'), path.join(staging, 'runtime-manifest.json'));
for (const minor of Object.keys(catalog.php)) {
  await cp(path.join(root, 'dist', `verification-${minor}.json`), path.join(staging, `verification-${minor}.json`));
}
const archive = `php-wasm-${pkg.version}.tar.gz`;
const tar = spawn('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', 'package'], {
  cwd: output, stdio: ['ignore', 'pipe', 'inherit'],
});
const completion = new Promise((resolve, reject) => {
  tar.once('error', reject);
  tar.once('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
});
await Promise.all([pipeline(tar.stdout, createGzip({ level: 9 }), createWriteStream(path.join(output, archive))), completion]);
await cp(path.join(root, 'dist', 'runtime-manifest.json'), path.join(output, 'runtime-manifest.json'));
const checksums = [];
for (const file of [archive, 'runtime-manifest.json']) {
  checksums.push(`${createHash('sha256').update(await readFile(path.join(output, file))).digest('hex')}  ${file}`);
}
await writeFile(path.join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
await rm(staging, { recursive: true });
console.log(`Created release/${archive}; all ${Object.keys(catalog.php).length} PHP engines have matching test receipts.`);
