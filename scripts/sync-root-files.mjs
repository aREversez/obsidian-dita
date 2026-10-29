// Copy the built plugin assets from packages/obsidian-plugin/dist to the
// repository root, where the Obsidian community plugin directory and the
// reviewers expect main.js, styles.css and manifest.json to live next to each
// other and to be committed to the tag being released.
//
//   npm run sync:root          # after `npm run build`
//   node scripts/sync-root-files.mjs --check   # verify without writing (CI)
//
// manifest.json is bidirectional: the root copy is the source the build reads
// (see esbuild.config.mjs), so here it is only compared, never overwritten.
// version-bump.mjs keeps it in step with package.json.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'packages/obsidian-plugin/dist');

// Files the build produces in dist that the submission needs at the root.
const COPYABLE = ['main.js', 'styles.css', 'manifest.json'];

/**
 * @returns {string[]} the copied file names; throws when the build output or
 *   the source manifest.json is missing.
 */
export function syncRootFiles({ check = false, quiet = false } = {}) {
  const drifted = [];
  for (const name of COPYABLE) {
    const from = resolve(distDir, name);
    const to = resolve(root, name);
    if (!existsSync(from)) {
      throw new Error(`build output missing: ${from} (run \`npm run build\` first)`);
    }
    const same =
      existsSync(to) &&
      readFileSync(from).equals(readFileSync(to));
    if (!same) {
      drifted.push(name);
      if (!check) copyFileSync(from, to);
    }
  }
  if (check && drifted.length > 0) {
    throw new Error(
      `root files are out of sync with the build: ${drifted.join(', ')} (run \`npm run sync:root\` and commit)`,
    );
  }
  if (!quiet) {
    console.log(
      check
        ? 'sync-root-files: root main.js, styles.css and manifest.json match the build.'
        : `sync-root-files: ${drifted.length > 0 ? `updated ${drifted.join(', ')}` : 'already in sync'}.`,
    );
  }
  return drifted;
}

// `node scripts/sync-root-files.mjs [--check]` (npm run sync:root)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    syncRootFiles({ check: process.argv.includes('--check') });
  } catch (error) {
    console.error(`sync-root-files: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
