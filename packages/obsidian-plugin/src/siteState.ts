// The site view's page, as it is kept in the pane's saved state.
//
// The page is known to the renderer by its absolute path, which says where the
// vault is on this machine; a layout that is synced or moved would carry a
// path that points nowhere. So the state keeps the path inside the vault, with
// forward slashes, and gives the absolute one back on this machine. Free of
// Obsidian imports so it is unit-tested.

import { isAbsolute, relative, resolve, sep } from 'path';

/** Is `rel` (from path.relative) somewhere outside the directory it was taken from? */
function outside(rel: string): boolean {
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** The page's path inside the vault, or undefined when it is not inside it. */
export function sitePageToState(vaultRoot: string, absPath: string): string | undefined {
  const rel = relative(vaultRoot, absPath);
  return outside(rel) ? undefined : rel.split(sep).join('/');
}

/**
 * The absolute path a saved page names in this vault, or undefined for anything
 * that is not a path inside it (a layout file is data from outside, and may be
 * edited by hand or come from somewhere else).
 */
export function sitePageFromState(vaultRoot: string, saved: unknown): string | undefined {
  if (typeof saved !== 'string' || saved === '') return undefined;
  const absPath = resolve(vaultRoot, saved);
  return outside(relative(vaultRoot, absPath)) ? undefined : absPath;
}
