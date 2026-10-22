// Copy the built plugin into the local Obsidian test vault, if that vault is
// present. `npm run build` calls this after a successful bundle so there is no
// manual copy step; `npm run sync:test` runs it on its own.
//
// The destination is optional on purpose: a fresh clone (or CI) has no ignored
// .obsidian folder, and the build must still succeed there.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const distDir = resolve(root, 'packages/obsidian-plugin/dist');
const pluginDir = process.env.DITA_TEST_VAULT_PLUGIN
  ? resolve(process.env.DITA_TEST_VAULT_PLUGIN)
  : resolve(root, 'test-dita-file/.obsidian/plugins/dita-viewer');

/**
 * Copy every file in the plugin's dist directory to the test vault plugin
 * directory. Existing files such as the vault's data.json are left alone.
 *
 * @param {{ quiet?: boolean }} [options]
 * @returns {number | undefined} number of files copied, or undefined when the
 *   optional test vault is absent.
 */
export function syncTestVault({ quiet = false } = {}) {
  if (!existsSync(distDir)) {
    throw new Error(`build output not found: ${distDir}`);
  }
  if (!existsSync(pluginDir)) {
    if (!quiet) console.log(`[sync] no test vault plugin folder, skipped: ${pluginDir}`);
    return undefined;
  }

  mkdirSync(pluginDir, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copyFileSync(join(distDir, entry.name), join(pluginDir, entry.name));
    copied++;
  }
  if (!quiet) console.log(`[sync] copied ${copied} file(s) to ${pluginDir}`);
  return copied;
}

// `node scripts/sync-test-vault.mjs` (npm run sync:test)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    syncTestVault();
  } catch (error) {
    console.error(`[sync] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
