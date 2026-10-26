import { fail } from './errors.mjs';
import { record, string } from './validation.mjs';

const node = typeof process !== 'undefined' && Boolean(process.versions?.node);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_MODULE_BYTES = 32 * 1024 * 1024;
const MAX_WASM_BYTES = 256 * 1024 * 1024;

function assetURL(value, base) {
  let url;
  try { url = new URL(string(value, 'asset URL'), base); } catch { fail('INVALID_MANIFEST', 'Asset URLs must be absolute or relative to a manifest URL'); }
  if (!['https:', 'http:', ...(node ? ['file:'] : [])].includes(url.protocol) || url.username || url.password) {
    fail('INVALID_MANIFEST', 'Engine assets require HTTP(S) URLs, or file URLs in Node.js');
  }
  return url;
}

async function read(url, limit) {
  if (url.protocol === 'file:') {
    const { readFile, stat } = await import('node:fs/promises');
    if ((await stat(url)).size > limit) fail('ASSET_TOO_LARGE', `Asset exceeds its size limit: ${url}`);
    const data = await readFile(url);
    if (data.byteLength > limit) fail('ASSET_TOO_LARGE', `Asset exceeds its size limit: ${url}`);
    return new Uint8Array(data);
  }
  const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) fail('ASSET_FETCH_FAILED', `Asset fetch returned HTTP ${response.status}: ${url}`);
  if (Number(response.headers.get('content-length')) > limit) fail('ASSET_TOO_LARGE', `Asset exceeds its size limit: ${url}`);
  if (!response.body) fail('ASSET_FETCH_FAILED', `Asset response has no body: ${url}`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) fail('ASSET_TOO_LARGE', `Asset exceeds its size limit: ${url}`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function verifiedAsset(input, base, limit) {
  record(input, 'asset');
  if (typeof input.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.sha256)) fail('INVALID_MANIFEST', 'Each engine asset requires a SHA-256 hexadecimal digest');
  const url = assetURL(input.url, base);
  const data = await read(url, limit);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== input.sha256.toLowerCase()) fail('INTEGRITY_MISMATCH', `SHA-256 verification failed: ${url}`);
  return { url, data };
}

export async function resolveEngine(options) {
  let engine = options.engine;
  let base;
  let runtimeVersion = null;
  if (options.manifestUrl !== undefined) {
    base = assetURL(options.manifestUrl);
    const raw = await read(base, MAX_MANIFEST_BYTES);
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { fail('INVALID_MANIFEST', 'Runtime manifest is not valid UTF-8 JSON'); }
    record(manifest, 'manifest');
    if (manifest.schemaVersion !== 1 || manifest.abiVersion !== 1) fail('ENGINE_ABI_MISMATCH', 'Runtime requires manifest schemaVersion 1 and abiVersion 1');
    record(manifest.engines, 'manifest.engines');
    if (!Object.hasOwn(manifest.engines, options.phpVersion)) fail('PHP_VERSION_UNAVAILABLE', `PHP ${options.phpVersion} is not included in the runtime manifest`);
    engine = manifest.engines[options.phpVersion];
    runtimeVersion = string(manifest.runtimeVersion, 'runtimeVersion');
  }
  record(engine, 'engine');
  if (typeof engine.phpVersion !== 'string' || !/^8\.(3|4|5)\.\d+$/.test(engine.phpVersion)) fail('INVALID_MANIFEST', 'Engine phpVersion must be an exact supported PHP 8.3, 8.4, or 8.5 version');
  if (options.phpVersion && engine.phpVersion !== options.phpVersion && !engine.phpVersion.startsWith(`${options.phpVersion}.`)) {
    fail('INVALID_MANIFEST', 'Selected PHP version does not match the engine record');
  }
  const [module, wasm] = await Promise.all([
    verifiedAsset(engine.module, base, MAX_MODULE_BYTES),
    verifiedAsset(engine.wasm, base, MAX_WASM_BYTES),
  ]);
  return { module, wasm, phpVersion: engine.phpVersion, runtimeVersion };
}

/** Import precisely the verified bytes, never a second network request. */
export async function importEngine(source) {
  if (node) {
    // Emscripten's Node branch needs a file import.meta.url for createRequire.
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const directory = await mkdtemp(join(tmpdir(), 'joomengine-php-'));
    try {
      const path = join(directory, 'engine.mjs');
      await writeFile(path, source, { mode: 0o600 });
      return await import(pathToFileURL(path).href);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { return await import(url); }
  finally { URL.revokeObjectURL(url); }
}
