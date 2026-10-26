import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createManifest } from './manifest.mjs';
import { root } from './catalog.mjs';

const minor = process.argv[2];
if (!minor) throw new Error('Usage: node scripts/test-receipt.mjs <PHP minor>');
const manifest = await createManifest({ versions: [minor] });
const commit = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('An exact source commit is required');
const receipt = {
  schemaVersion: 1,
  commit,
  runtimeVersion: manifest.runtimeVersion,
  phpMinor: minor,
  engine: manifest.engines[minor],
  suites: ['node', 'chromium', 'firefox'],
};
// CI calls this only after all three real-engine suites succeed.
await writeFile(path.join(root, 'dist', `verification-${minor}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Recorded tested artifact hashes for PHP ${minor} at ${commit}`);
