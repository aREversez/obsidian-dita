// The ids another DITA file defines, cached until that file changes.
//
// Diagnostics run after every pause in typing. A topic's links mostly point
// at files that did not change since the last run, so re-reading and
// re-scanning them each time would be the only slow part of the check.
// Bounded like every other cache here: a large vault must not accumulate one
// entry per file ever linked to.

import { readFileSync, statSync } from 'fs';
import { collectIds } from '@dita-viewer/core';

export type IdReader = (absPath: string) => readonly string[] | undefined;

const MAX_ENTRIES = 200;

/** Cheap change stamp: same size and mtime means same content for our purposes. */
function fileStamp(absPath: string): string {
  try {
    const s = statSync(absPath);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '?';
  }
}

export function createIdReader(
  read: (absPath: string) => string = (p) => readFileSync(p, 'utf8'),
  stamp: (absPath: string) => string = fileStamp,
): IdReader {
  const cache = new Map<string, { stamp: string; ids: string[] | undefined }>();
  return (absPath) => {
    const now = stamp(absPath);
    const hit = cache.get(absPath);
    if (hit && hit.stamp === now) return hit.ids;
    let ids: string[] | undefined;
    if (now !== '?') {
      try {
        ids = collectIds(read(absPath));
      } catch {
        ids = undefined;
      }
    }
    if (!cache.has(absPath) && cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(absPath, { stamp: now, ids });
    return ids;
  };
}
