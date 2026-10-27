import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog, root } from './catalog.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function verifyBridge(directory, source) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'bridge-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.bridgeVersion, source.version);
  assert.equal(manifest.protocolVersion, source.protocolVersion);
  assert.equal(manifest.sourceCommit, source.commit);
  assert.equal(manifest.phpDriver.module, 'pdo_mariadb_wasm');
  assert.equal(manifest.phpDriver.pdoName, 'mysql');
  const found = [];
  async function walk(relative = '') {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else {
        assert.ok(entry.isFile(), `Non-regular bridge file: ${name}`);
        if (name === 'bridge-manifest.json') continue;
        const bytes = await readFile(path.join(directory, name));
        assert.deepEqual(manifest.files[name], { sha256: hash(bytes), bytes: bytes.length }, `Bridge inventory mismatch: ${name}`);
        found.push(name);
      }
    }
  }
  await walk();
  assert.deepEqual(found.sort(), Object.keys(manifest.files).sort(), 'Incomplete bridge archive');
  for (const required of ['src/index.mjs', 'native/pdo_mariadb_wasm.c', 'native/config.m4', 'vendor/lite4mariadb/index.mjs', 'vendor/lite4mariadb/lite4mariadb.wasm', 'vendor/lite4mariadb/COPYING']) {
    assert.ok(manifest.files[required], `Missing bridge asset: ${required}`);
  }
  return manifest;
}

export async function prepareMariaDB() {
  const catalog = await readCatalog();
  const source = catalog.extensions.pdo_mariadb_wasm;
  const { url, sha256 } = source.runtimeArchive;
  const build = path.join(root, '.build');
  const destination = path.resolve(root, process.env.PHP_WASM_MARIADB_DIR ?? '.build/mariadb-bridge');
  if (!destination.startsWith(`${build}${path.sep}`)) throw new Error('Test bridge staging must be inside .build/');
  const downloads = path.join(build, 'downloads');
  await mkdir(downloads, { recursive: true });
  const archive = path.join(downloads, `${sha256}.tar.gz`);
  let cached;
  try { cached = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!cached || hash(cached) !== sha256) {
    const temporary = `${archive}.part-${process.pid}`;
    try {
      execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--retry', '3', '--retry-all-errors', '--retry-max-time', '120', '--connect-timeout', '20', '--max-time', '180', '--output', temporary, '--url', url], { stdio: 'inherit' });
      assert.equal(hash(await readFile(temporary)), sha256, 'MariaDB release archive checksum mismatch');
      await rename(temporary, archive);
    } finally { await rm(temporary, { force: true }); }
  }
  const prefix = `mariadb-wasm-bridge-${source.version}`;
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n');
  for (const entry of entries) {
    assert.ok(entry.startsWith(`${prefix}/`) && !entry.split('/').includes('..') && !entry.includes('\\'), `Unsafe archive entry: ${entry}`);
  }
  const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  for (const line of details.trim().split('\n')) assert.match(line, /^[-d]/, 'Bridge archive must contain only files and directories');
  const temporary = await mkdtemp(path.join(build, 'mariadb-stage-'));
  try {
    execFileSync('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', temporary]);
    const extracted = path.join(temporary, prefix);
    await verifyBridge(extracted, source);
    // Verify release parity when the locked driver source has already been fetched.
    for (const name of ['config.m4', 'pdo_mariadb_wasm.c', 'php_pdo_mariadb_wasm.h']) {
      let native;
      try { native = await readFile(path.join(build, 'sources/pdo_mariadb_wasm/native', name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
      assert.deepEqual(await readFile(path.join(extracted, 'native', name)), native, `Compiled source differs from released bridge: ${name}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(extracted, destination);
    console.log(`Prepared MariaDB bridge ${source.version} (${source.commit}) at ${destination}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return destination;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareMariaDB();
