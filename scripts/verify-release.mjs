import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog, root } from './catalog.mjs';
import { verifyReleaseVersion } from './release-version.mjs';

export async function verifyRelease(directory = path.join(root, 'release')) {
  const catalog = await readCatalog();
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : process.env.RELEASE_TAG;
  const pkg = await verifyReleaseVersion({ tag });
  const archive = `php-wasm-${pkg.version}.tar.gz`;
  const assets = [archive, 'runtime-manifest.json'];
  assert.deepEqual((await readdir(directory)).sort(), [...assets, 'SHA256SUMS'].sort(), 'Unexpected release assets');
  for (const file of [...assets, 'SHA256SUMS']) {
    assert.ok((await lstat(path.join(directory, file))).isFile(), `${file} must be a regular file`);
  }
  const sums = (await readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trimEnd().split('\n');
  assert.equal(sums.length, assets.length, 'SHA256SUMS must cover every release asset exactly once');
  const verified = new Set();
  for (const line of sums) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    assert.ok(match && assets.includes(match[2]) && !verified.has(match[2]), 'Invalid or duplicate checksum entry');
    const digest = createHash('sha256').update(await readFile(path.join(directory, match[2]))).digest('hex');
    assert.equal(digest, match[1], `Checksum mismatch: ${match[2]}`);
    verified.add(match[2]);
  }
  const manifest = JSON.parse(await readFile(path.join(directory, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.abiVersion, 1);
  assert.equal(manifest.runtimeVersion, pkg.version);
  assert.deepEqual(Object.keys(manifest.engines).sort(), Object.keys(catalog.php).sort());
  for (const [minor, engine] of Object.entries(manifest.engines)) {
    assert.equal(engine.phpVersion, catalog.php[minor].version);
    for (const [key, file] of [['module', 'php.mjs'], ['wasm', 'php.wasm']]) {
      assert.equal(engine[key].url, `php/${minor}/${file}`);
      assert.match(engine[key].sha256, /^[a-f0-9]{64}$/);
    }
  }
  return { archive, manifest, version: pkg.version };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/verify-release.mjs [release directory]');
  const { archive } = await verifyRelease(process.argv[2]);
  console.log(`Verified checksums, complete engine catalog, and version for ${archive}.`);
}
