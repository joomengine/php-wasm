import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog, root } from './catalog.mjs';

export async function createManifest({ directory = path.join(root, 'dist'), versions } = {}) {
  const catalog = await readCatalog();
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const selected = versions ?? Object.keys(catalog.php);
  if (!selected.length) throw new Error('At least one PHP engine is required');
  const engines = {};
  for (const minor of selected) {
    if (!Object.hasOwn(catalog.php, minor)) throw new Error(`Unsupported PHP version: ${minor}`);
    const modulePath = `php/${minor}/php.mjs`;
    const wasmPath = `php/${minor}/php.wasm`;
    const module = await readFile(path.join(directory, modulePath));
    const wasm = await readFile(path.join(directory, wasmPath));
    if (!module.length || wasm.subarray(0, 8).toString('hex') !== '0061736d01000000') {
      throw new Error(`PHP ${minor} has invalid engine artifacts`);
    }
    engines[minor] = {
      phpVersion: catalog.php[minor].version,
      module: { url: modulePath, sha256: createHash('sha256').update(module).digest('hex') },
      wasm: { url: wasmPath, sha256: createHash('sha256').update(wasm).digest('hex') },
    };
  }
  const manifest = { schemaVersion: 1, abiVersion: 1, runtimeVersion: pkg.version, engines };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--php')) throw new Error('Usage: node scripts/manifest.mjs [--php 8.4]');
  const manifest = await createManifest({ versions: args.length ? [args[1]] : undefined });
  console.log(`Wrote dist/runtime-manifest.json for PHP ${Object.keys(manifest.engines).join(', ')}`);
}
