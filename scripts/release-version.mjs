import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './catalog.mjs';

export async function verifyReleaseVersion({ tag, directory = root } = {}) {
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version !== pkg.version.trim() ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)) {
    throw new Error(`package.json version ${JSON.stringify(pkg.version)} must be a stable semantic version (for example 0.1.2)`);
  }
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error(`package-lock.json versions must both match package.json version ${pkg.version}; update both files with npm run release:prepare -- <version>`);
  }
  if (tag !== undefined && tag !== `v${pkg.version}`) {
    throw new Error(`Release tag ${JSON.stringify(tag)} does not match package.json version ${pkg.version} (expected v${pkg.version}). Run npm run release:prepare -- <version>, commit and merge both package files, then tag the tested commit. See CONTRIBUTING.md; retrying the same mismatched tag cannot fix it.`);
  }
  return pkg;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const tag = process.argv[2] ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
    if (process.argv.length > 3 || !tag) throw new Error('Usage: npm run release:check -- v<version>');
    const { version } = await verifyReleaseVersion({ tag });
    console.log(`Release tag ${tag}, package.json and package-lock.json agree on ${version}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
