// Fail when the manifest, versions.json, the plugin's package.json and (when
// given) the release tag disagree. `npm run release:check` runs it on every
// verify; the release workflow passes the tag as the first argument.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './release-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(resolve(root, rel), 'utf-8'));

const problems = checkRelease({
  manifest: read('manifest.json'),
  versions: read('versions.json'),
  pluginVersion: read('packages/obsidian-plugin/package.json').version,
  tag: process.argv[2] || undefined,
});

if (problems.length > 0) {
  console.error(problems.map((p) => `release check: ${p}`).join('\n'));
  process.exit(1);
}
console.log('release check: manifest.json, versions.json and package.json agree.');
