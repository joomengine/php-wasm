import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './catalog.mjs';
import { verifyRelease } from './verify-release.mjs';

const args = process.argv.slice(2);
const browserSmoke = args.includes('--browser');
const directories = args.filter(argument => argument !== '--browser');
if (directories.length > 1 || directories.some(argument => argument.startsWith('-'))) {
  throw new Error('Usage: node scripts/smoke-release.mjs [release directory] [--browser]');
}
const directory = path.resolve(directories[0] ?? path.join(root, 'release'));
const { archive, manifest, version } = await verifyRelease(directory);
const temporary = await mkdtemp(path.join(tmpdir(), 'php-wasm-release-'));
let browser;
let server;
try {
  const deployment = path.join(temporary, 'runtime', version);
  await mkdir(deployment, { recursive: true });
  // The archive is produced by our own package job, checksum-verified above.
  // Require only files/directories under package/ before extracting to a fresh root.
  const names = execFileSync('tar', ['-tzf', path.join(directory, archive)], { encoding: 'utf8' }).trimEnd().split('\n');
  assert.ok(names.length > 1 && names.every(name => name.startsWith('package/') && !name.split('/').includes('..')), 'Unsafe archive paths');
  const entries = execFileSync('tar', ['-tvzf', path.join(directory, archive)], { encoding: 'utf8' }).trimEnd().split('\n');
  assert.ok(entries.every(entry => /^[-d]/.test(entry)), 'Release archive must contain only regular files and directories');
  execFileSync('tar', ['-xzf', path.join(directory, archive), '--no-same-owner', '--no-same-permissions', '-C', deployment]);
  const packagePath = path.join(deployment, 'package');
  const manifestUrl = pathToFileURL(path.join(packagePath, 'runtime-manifest.json'));
  assert.deepEqual(JSON.parse(await readFile(manifestUrl, 'utf8')), manifest, 'Packaged and published manifests must match');
  // All runtime imports and engine loads below come exclusively from the archive.
  const { createPHP } = await import(pathToFileURL(path.join(packagePath, 'src/index.mjs')));
  for (const [minor, engine] of Object.entries(manifest.engines)) {
    const php = await createPHP({ manifestUrl, phpVersion: minor });
    try {
      await php.fs.writeFile('/workspace/package.php', '<?php echo json_encode([PHP_VERSION, PHP_SAPI, $argv[1]]);');
      const result = await php.run({ script: '/workspace/package.php', args: ['standalone archive'] });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr.length, 0);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)), [engine.phpVersion, 'cli', 'standalone archive']);
      console.log(`Packaged PHP ${minor} passed in Node.js.`);
    } finally { await php.close(); }
  }

  if (browserSmoke) {
    const { chromium } = await import('playwright');
    server = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = path.resolve(temporary, `.${pathname}`);
        if (!file.startsWith(`${temporary}${path.sep}`)) { response.writeHead(403).end(); return; }
        if ((await stat(file)).isDirectory()) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>Packaged PHP runtime</title>');
          return;
        }
        const contentType = { '.mjs': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json' }[path.extname(file)] ?? 'application/octet-stream';
        const bytes = await readFile(file);
        response.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length }).end(bytes);
      } catch { response.writeHead(404).end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PHP_WASM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PHP_WASM_CHROMIUM_EXECUTABLE } : {}),
    });
    const page = await browser.newPage();
    const uncaught = [];
    page.on('pageerror', error => uncaught.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/runtime/${version}/package/`);
    const minor = Object.keys(manifest.engines)[0];
    const result = await page.evaluate(async phpVersion => {
      const { createPHP } = await import(new URL('./src/index.mjs', location.href).href);
      const php = await createPHP({ manifestUrl: new URL('./runtime-manifest.json', location.href), phpVersion });
      try {
        await php.fs.writeFile('/workspace/package.php', '<?php echo json_encode([PHP_VERSION, PHP_SAPI, $argv[1]]);');
        const output = await php.run({ script: '/workspace/package.php', args: ['nested Pages path'] });
        return { exitCode: output.exitCode, stderr: output.stderr.length, value: JSON.parse(new TextDecoder().decode(output.stdout)), isolated: crossOriginIsolated };
      } finally { await php.close(); }
    }, minor);
    assert.deepEqual(result, { exitCode: 0, stderr: 0, value: [manifest.engines[minor].phpVersion, 'cli', 'nested Pages path'], isolated: false });
    assert.deepEqual(uncaught, []);
    console.log('Packaged Chromium runtime passed at a nested Pages URL without cross-origin isolation.');
  }
} finally {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
