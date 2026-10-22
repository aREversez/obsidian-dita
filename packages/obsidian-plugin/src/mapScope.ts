// Which open documents a changed .ditamap can affect.
//
// A document's keys come from the maps found by walking up from its own
// folder, so a map only matters to documents in its own folder or below it.
// Without this check every map change re-rendered and re-checked every open
// DITA view in the vault.

import { dirname, isAbsolute, relative } from 'path';

/** True when `mapAbsPath` lies in the folder of `docAbsPath` or in one above it. */
export function mapMayAffect(mapAbsPath: string, docAbsPath: string): boolean {
  const rel = relative(dirname(mapAbsPath), dirname(docAbsPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
