// Outline row -> source position.
//
// The outline tree carries each entry's href but no line number (the map
// renderer has none to give). The context menu's "Reveal in source" scans the
// map's own text for the topicref with that href, which is enough for entries
// defined in this map. An entry spliced in from a referenced submap has a
// rebased href that is not in this text; the caller falls back to opening the
// target topic.

import { collectRefEntries, decodeHrefPart, offsetToLineCol } from '@dita-viewer/core';

export interface OutlinePosition {
  /** Zero-based line. */
  line: number;
  /** Zero-based column of the first character inside the quotes. */
  col: number;
}

/** The source position of the map's `href` attribute for this outline row. */
export function outlineEntryPosition(mapText: string, href: string): OutlinePosition | undefined {
  if (!href || href.startsWith('#')) return undefined;
  const entries = collectRefEntries(mapText);
  const entry =
    entries.find((e) => e.attr === 'href' && e.value === href) ??
    entries.find((e) => e.attr === 'href' && decodeHrefPart(e.value) === decodeHrefPart(href));
  return entry ? offsetToLineCol(mapText, entry.valueStart) : undefined;
}
