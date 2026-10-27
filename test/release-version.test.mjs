import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { root } from '../scripts/catalog.mjs';
import { verifyReleaseVersion } from '../scripts/release-version.mjs';

async function fixture(t, { version = '0.1.0', lockVersion = version, rootVersion = version } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'php-wasm-release-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'release-fixture', version }));
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({
    name: 'release-fixture', version: lockVersion, lockfileVersion: 3,
    packages: { '': { name: 'release-fixture', version: rootVersion } },
  }));
  return directory;
}

test('accepts matching stable tag and all package versions', async t => {
  const directory = await fixture(t);
  assert.equal((await verifyReleaseVersion({ directory, tag: 'v0.1.0' })).version, '0.1.0');
  assert.equal((await verifyReleaseVersion({ directory })).version, '0.1.0');
});

test('rejects the observed v0.1.1 tag on 0.1.0 source with recovery instructions', async t => {
  const directory = await fixture(t);
  await assert.rejects(verifyReleaseVersion({ directory, tag: 'v0.1.1' }), error => {
    assert.match(error.message, /v0\.1\.1.*package\.json version 0\.1\.0.*expected v0\.1\.0/);
    assert.match(error.message, /npm run release:prepare/);
    assert.match(error.message, /retrying the same mismatched tag cannot fix it/);
    return true;
  });
});

for (const field of ['lockVersion', 'rootVersion']) {
  test(`rejects stale ${field} even when tag matches package.json`, async t => {
    const directory = await fixture(t, { [field]: '0.0.9' });
    await assert.rejects(verifyReleaseVersion({ directory, tag: 'v0.1.0' }), /package-lock\.json versions must both match/);
  });
}

test('rejects incomplete lockfile metadata', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '0.1.0' }));
  await assert.rejects(verifyReleaseVersion({ directory, tag: 'v0.1.0' }), /package-lock\.json versions must both match/);
});

test('rejects prerelease, malformed and non-string stable versions', async t => {
  for (const version of ['0.1.2-rc.1', '0.1.2+build', '01.1.2', '1.2', 'v1.2.3', '0.1.2\n', ' 0.1.2', 123, null]) {
    const directory = await fixture(t, { version });
    await assert.rejects(verifyReleaseVersion({ directory }), /must be a stable semantic version/);
  }
});

test('requires exact tag spelling', async t => {
  const directory = await fixture(t);
  for (const tag of ['', '0.1.0', 'v0.1.0-rc.1', 'v0.1.0\n']) {
    await assert.rejects(verifyReleaseVersion({ directory, tag }), /does not match package\.json/);
  }
});

test('CLI fails before release for missing or mismatched tags and succeeds for the actual version', async () => {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const env = { ...process.env, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' };
  const run = (args, overrides = {}) => spawnSync(process.execPath, ['scripts/release-version.mjs', ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8',
  });
  const missing = run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage: npm run release:check/);
  assert.equal(run(['v999.999.999']).status, 1);
  assert.equal(run([`v${version}`, 'unexpected']).status, 1);
  assert.equal(run([`v${version}`]).status, 0);
  assert.equal(run([], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}` }).status, 0);
  assert.equal(run([], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v999.999.999' }).status, 1);
});

test('release:prepare updates both files without creating a commit, tag or running lifecycle scripts', async t => {
  const directory = await fixture(t);
  const { scripts } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'release-fixture', version: '0.1.0',
    scripts: { 'release:prepare': scripts['release:prepare'], version: 'node -e "process.exit(42)"' },
  }));
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return result.stdout.trim();
  };
  run('git', ['init', '--initial-branch=main']);
  run('git', ['add', 'package.json', 'package-lock.json']);
  run('git', ['-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'fixture']);
  const before = run('git', ['rev-parse', 'HEAD']);
  run('npm', ['run', 'release:prepare', '--', '0.1.2']);
  assert.equal((await verifyReleaseVersion({ directory, tag: 'v0.1.2' })).version, '0.1.2');
  assert.equal(run('git', ['rev-parse', 'HEAD']), before);
  assert.equal(run('git', ['tag', '--list']), '');
  assert.deepEqual(run('git', ['diff', '--name-only']).split('\n').sort(), ['package-lock.json', 'package.json']);
});
