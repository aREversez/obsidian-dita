// Run by `npm version` in the plugin package (its "version" script): copy the
// version npm just wrote to package.json into manifest.json and versions.json.
//
//   npm version 0.2.0 -w obsidian-dita --no-git-tag-version
//
// then commit and tag `0.2.0`; the release workflow does the rest.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersions } from './release-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'manifest.json');
const versionsPath = resolve(root, 'versions.json');
const read = (path) => JSON.parse(readFileSync(path, 'utf-8'));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const version = read(resolve(root, 'packages/obsidian-plugin/package.json')).version;
const next = bumpVersions({ manifest: read(manifestPath), versions: read(versionsPath) }, version);
write(manifestPath, next.manifest);
write(versionsPath, next.versions);
console.log(`manifest.json and versions.json are at ${version}.`);
