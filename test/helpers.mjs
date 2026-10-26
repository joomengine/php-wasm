import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const phpVersion = process.env.PHP_WASM_VERSION ?? '8.4';
export const engineDirectory = process.env.PHP_WASM_ENGINE_DIR
  ? resolve(root, process.env.PHP_WASM_ENGINE_DIR)
  : resolve(root, 'dist/php', phpVersion);
export const decode = value => new TextDecoder().decode(value);
export const encode = value => new TextEncoder().encode(value);

export async function engineOptions(baseURL, { manifest = true } = {}) {
  if (manifest && process.env.PHP_WASM_MANIFEST) {
    const manifest = process.env.PHP_WASM_MANIFEST;
    return {
      manifestUrl: /^[a-z][a-z\d+.-]*:/i.test(manifest)
        ? manifest
        : baseURL
          ? new URL(`/${resolve(root, manifest).slice(root.length)}`, baseURL).href
          : pathToFileURL(resolve(root, manifest)).href,
      phpVersion,
    };
  }
  const asset = async name => {
    const path = resolve(engineDirectory, name);
    let content;
    try {
      content = await readFile(path);
    } catch (cause) {
      throw new Error(`Real PHP WebAssembly artifacts are required. Build PHP ${phpVersion} before running integration tests: missing ${path}`, { cause });
    }
    return {
      url: baseURL ? new URL(`/engine/${name}`, baseURL).href : pathToFileURL(path).href,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  };
  const versions = JSON.parse(await readFile(new URL('../versions.json', import.meta.url), 'utf8'));
  const exactVersion = versions.php[phpVersion]?.version;
  if (!exactVersion) throw new Error(`PHP ${phpVersion} is not present in versions.json`);
  return { engine: { phpVersion: exactVersion, module: await asset('php.mjs'), wasm: await asset('php.wasm') } };
}

export async function installFixtures(php) {
  for (const name of ['cli', 'request', 'binary', 'session', 'exit', 'fatal', 'timeout', 'dependency-versions', 'zlib-seek']) {
    await php.fs.writeFile(`/workspace/${name}.php`, await readFile(new URL(`fixtures/${name}.php`, import.meta.url)));
  }
}

export async function directEngineOptions() {
  const options = await engineOptions();
  if (options.engine) return options;
  const url = new URL(options.manifestUrl);
  const source = url.protocol === 'file:'
    ? await readFile(url, 'utf8')
    : await fetch(url).then(response => {
      if (!response.ok) throw new Error(`Unable to read test manifest: HTTP ${response.status}`);
      return response.text();
    });
  const manifest = JSON.parse(source);
  const engine = structuredClone(manifest.engines[phpVersion]);
  engine.module.url = new URL(engine.module.url, url).href;
  engine.wasm.url = new URL(engine.wasm.url, url).href;
  return { engine };
}

export function headerValues(response, name) {
  return response.headers.filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
}

// This server is deliberately local-only and serves real source and engine files.
export async function serve() {
  const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        response.end('<!doctype html><html><title>PHP WASM integration tests</title><body></body></html>');
        return;
      }
      const base = pathname.startsWith('/engine/') ? engineDirectory : root;
      const relative = pathname.startsWith('/engine/') ? pathname.slice('/engine/'.length) : pathname.slice(1);
      const path = resolve(base, relative);
      if (!path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`) || !(await stat(path)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
