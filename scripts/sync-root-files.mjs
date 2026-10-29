// Copy the built plugin assets from packages/obsidian-plugin/dist to the
// repository root, where the Obsidian community plugin directory and the
// reviewers expect main.js, styles.css and manifest.json to live next to each
// other and to be committed to the tag being released.
//
//   npm run sync:root          # build, then refresh the root copies (release:prepare)
//   npm run sync:root:check    # report without writing (CI)
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

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

// The bundle inlines the .css sources, so a CRLF working tree builds a main.js
// a few hundred bytes larger than the same source checked out with LF, which
// is what .gitattributes enforces everywhere. A checkout that ignores that is
// still the same plugin, so a line-ending-only difference is reported instead
// of failing the run.
const toLF = (buffer) => buffer.toString('binary').split(CR + LF).join(LF);

/**
 * @param {{ check?: boolean, quiet?: boolean }} [options] `check` writes
 *   nothing and throws on what a release would ship wrong.
 * @returns {{ changed: string[], lineEndingOnly: string[], missing: string[] }}
 *   what a plain run would rewrite, split by whether the difference is real
 *   content or only line endings.
 */
export function syncRootFiles({ check = false, quiet = false } = {}) {
  const changed = [];
  const lineEndingOnly = [];
  const missing = [];

  for (const name of COPYABLE) {
    const from = resolve(distDir, name);
    const to = resolve(root, name);
    if (!existsSync(from)) {
      throw new Error(`build output missing: ${from} (run \`npm run build\` first)`);
    }

    if (!existsSync(to)) {
      missing.push(name);
      if (!check) copyFileSync(from, to);
      continue;
    }

    const built = readFileSync(from);
    const committed = readFileSync(to);
    if (built.equals(committed)) continue;

    if (name !== 'manifest.json' && toLF(built) === toLF(committed)) {
      lineEndingOnly.push(name);
    } else {
      // manifest.json is hand-maintained and carries the version the installer
      // reads, so any difference means the root is not the release the build made.
      changed.push(name);
    }
    if (!check) copyFileSync(from, to);
  }

  if (check) {
    if (missing.length > 0) {
      throw new Error(`the submission needs ${missing.join(', ')} committed at the repository root.`);
    }
    if (changed.length > 0) {
      throw new Error(
        `root ${changed.join(', ')} is not what this build produces (run \`npm run release:prepare\` and commit).`,
      );
    }
    if (!quiet) {
      console.log(
        lineEndingOnly.length > 0
          ? `sync-root-files: ${lineEndingOnly.join(', ')} match the build apart from line endings.`
          : 'sync-root-files: root main.js, styles.css and manifest.json match the build.',
      );
    }
    return { changed, lineEndingOnly, missing };
  }

  if (!quiet) {
    const written = [...changed, ...lineEndingOnly, ...missing];
    console.log(`sync-root-files: ${written.length > 0 ? `wrote ${written.join(', ')}` : 'already in sync'}.`);
  }
  return { changed, lineEndingOnly, missing };
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
