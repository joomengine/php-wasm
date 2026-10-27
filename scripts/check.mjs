import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { readCatalog, root } from './catalog.mjs';
import { verifyReleaseVersion } from './release-version.mjs';

await readCatalog();
const pkg = await verifyReleaseVersion();
for (const file of Object.values(pkg.exports['.'])) await access(path.join(root, file));

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(name));
    else result.push(name);
  }
  return result;
}
for (const directory of ['src', 'scripts', 'test']) {
  for (const file of await walk(path.join(root, directory))) {
    if (!/\.(?:mjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`JavaScript syntax check failed: ${file}`);
  }
}
for (const file of await walk(path.join(root, '.github'))) {
  if (!/\.ya?ml$/.test(file)) continue;
  const document = parseDocument(await readFile(file, 'utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`${file}: ${document.errors.map(e => e.message).join('; ')}`);
  const workflow = document.toJS();
  if (!file.includes(`${path.sep}workflows${path.sep}`)) continue;
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses && !step.uses.startsWith('./') && !/@[a-f0-9]{40}$/.test(step.uses)) {
        throw new Error(`${file}: Actions must be pinned to full commit SHAs: ${step.uses}`);
      }
    }
  }
}
console.log('Source syntax, YAML, action pins, package metadata, and source catalog are valid.');
