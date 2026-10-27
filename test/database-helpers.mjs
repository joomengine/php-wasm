import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { engineDirectory, root } from './helpers.mjs';

export const bridgeDirectory = resolve(root, process.env.PHP_WASM_MARIADB_DIR ?? '.build/mariadb-bridge');
export const databaseFixture = await readFile(new URL('./fixtures/database.php', import.meta.url), 'utf8');

export async function loadMariaDB() {
  const moduleURL = pathToFileURL(resolve(bridgeDirectory, 'src/index.mjs')).href;
  try {
    await stat(resolve(bridgeDirectory, 'vendor/lite4mariadb/index.mjs'));
    return await import(moduleURL);
  } catch (cause) {
    throw new Error(`The verified MariaDB bridge release is required at ${bridgeDirectory}. Run the bridge preparation step before combined integration tests.`, { cause });
  }
}

export function databaseOptions() {
  return {
    database: 'joomla',
    engineModuleUrl: pathToFileURL(resolve(bridgeDirectory, 'vendor/lite4mariadb/index.mjs')).href,
  };
}

// MariaDB pthreads require isolation; the existing PHP-only suite deliberately
// keeps its own server unisolated to verify ordinary static-host compatibility.
export async function serveDatabase() {
  const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html' };
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><meta charset="utf-8"><title>PHP and MariaDB WASM integration</title>');
        return;
      }
      const mount = pathname.startsWith('/mariadb/')
        ? { base: bridgeDirectory, relative: pathname.slice('/mariadb/'.length) }
        : pathname.startsWith('/engine/')
          ? { base: engineDirectory, relative: pathname.slice('/engine/'.length) }
          : { base: root, relative: pathname.slice(1) };
      const path = resolve(mount.base, mount.relative);
      if (!path.startsWith(`${mount.base.replace(/\/$/, '')}${sep}`) || !(await stat(path)).isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
      const stream = createReadStream(path);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    },
  };
}
