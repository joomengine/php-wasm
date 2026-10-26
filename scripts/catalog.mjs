import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

export async function readCatalog() {
  const catalog = JSON.parse(await readFile(new URL('../versions.json', import.meta.url), 'utf8'));
  if (catalog.schemaVersion !== 1 || typeof catalog.php !== 'object' || !catalog.php) {
    throw new Error('versions.json must contain schemaVersion 1 and a php map');
  }
  const entries = Object.entries(catalog.php);
  if (!entries.length) throw new Error('The PHP version catalog cannot be empty');
  for (const [minor, engine] of entries) {
    if (!/^\d+\.\d+$/.test(minor) || !engine.version?.startsWith(`${minor}.`) ||
        !/^\d+\.\d+\.\d+$/.test(engine.version)) {
      throw new Error(`Invalid PHP version catalog entry: ${minor}`);
    }
    validateSource(engine, `PHP ${minor}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(catalog.emscripten?.version ?? '')) {
    throw new Error('An exact Emscripten version is required');
  }
  for (const [name, source] of Object.entries(catalog.libraries ?? {})) validateSource(source, name);
  return catalog;
}

function validateSource(source, name) {
  if (source.repository) {
    if (source.fallbackUrls !== undefined) throw new Error(`${name}: fallbackUrls apply only to archives`);
    if (new URL(source.repository).protocol !== 'https:' || !/^[a-f0-9]{40}$/.test(source.commit ?? '')) {
      throw new Error(`${name} requires an HTTPS Git repository and exact commit`);
    }
  } else {
    if (!/^[a-f0-9]{64}$/.test(source.sha256 ?? '')) throw new Error(`${name} requires a SHA-256 digest`);
    if (source.fallbackUrls !== undefined && !Array.isArray(source.fallbackUrls)) {
      throw new Error(`${name}: fallbackUrls must be an array`);
    }
    for (const url of [source.url, ...(source.fallbackUrls ?? [])]) {
      if (typeof url !== 'string' || new URL(url).protocol !== 'https:') {
        throw new Error(`${name} source URLs must use HTTPS`);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = await readCatalog();
  if (process.argv[2] === 'matrix') process.stdout.write(JSON.stringify(Object.keys(catalog.php)));
  else process.stdout.write(`${Object.entries(catalog.php).map(([minor, e]) => `${minor}: ${e.version}`).join('\n')}\n`);
}
