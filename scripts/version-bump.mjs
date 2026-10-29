// Run by `npm version` in the plugin package (its "version" script): copy the
// version npm just wrote to package.json into the root manifest.json and
// versions.json, the two files the community plugin directory reads.
//
//   npm version 0.2.0 -w obsidian-dita --no-git-tag-version
//   npm run release:prepare   # build, then refresh the root main.js and styles.css
//
// `npm run release:ship -- <version>` runs both steps, then commits and tags;
// pushing the tag is manual, and the release workflow publishes from there.

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
