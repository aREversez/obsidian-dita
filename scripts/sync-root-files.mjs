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

// esbuild's output is not byte-reproducible across operating systems: the same
// source builds a few hundred bytes apart on Linux and Windows. The committed
// root copy is therefore only reported when it differs from the local build,
// never failed on it. manifest.json is different in kind: it is hand-maintained
// and is the version the installer reads, so it has to agree exactly.

/**
 * @param {{ check?: boolean, quiet?: boolean }} [options] `check` writes
 *   nothing and throws on what a reviewer would find wrong.
 * @returns {{ changed: string[], missing: string[] }} `changed` are the files
 *   that differ from the build (written unless `check`); `missing` the ones
 *   absent at the root.
 */
export function syncRootFiles({ check = false, quiet = false } = {}) {
  const changed = [];
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

    changed.push(name);
    if (!check) copyFileSync(from, to);
  }

  if (check) {
    if (missing.length > 0) {
      throw new Error(`the submission needs ${missing.join(', ')} committed at the repository root.`);
    }
    if (changed.includes('manifest.json')) {
      throw new Error(
        'manifest.json at the repository root is not the manifest this build used (run `npm run release:prepare` and commit).',
      );
    }
    if (!quiet) {
      console.log(
        changed.length > 0
          ? `sync-root-files: ${changed.join(', ')} differ from this machine's build; the release workflow ships its own.`
          : 'sync-root-files: root main.js, styles.css and manifest.json match the build.',
      );
    }
    return { changed, missing };
  }

  if (!quiet) {
    const written = [...changed, ...missing];
    console.log(`sync-root-files: ${written.length > 0 ? `wrote ${written.join(', ')}` : 'already in sync'}.`);
  }
  return { changed, missing };
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
