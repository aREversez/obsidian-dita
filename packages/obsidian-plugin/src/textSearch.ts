// Finding text in a rendered page, where a phrase may run across inline
// elements ("the <b>quick</b> fox") and the whitespace the reader sees is not
// the whitespace in the DOM (a paragraph's source line breaks).
//
// The page's text nodes are joined into one string, a marker between nodes
// that sit in different blocks so a match cannot run from one paragraph into
// the next. Matches are found in that string and mapped back to (node, offset)
// pairs, which is what a DOM Range needs. No DOM here, so it is unit-tested.

export interface TextPart {
  text: string;
  /** This part starts a new block (paragraph, list item, cell, ...). */
  breakBefore: boolean;
}

export interface TextIndex {
  /** All the parts, joined. */
  text: string;
  /** Where part i starts in `text`. */
  starts: number[];
  lengths: number[];
}

export interface Match {
  start: number;
  end: number;
}

/** More than this and the page is all matches; stop looking. */
export const MAX_MATCHES = 2000;

/** Stands between blocks. Not whitespace, so a search for "a b" cannot match across it. */
const BLOCK_BREAK = '\u0001';

/** Parts with no text are dropped before this; every part here has at least one character. */
export function buildIndex(parts: readonly TextPart[]): TextIndex {
  let text = '';
  const starts: number[] = [];
  const lengths: number[] = [];
  parts.forEach((part, i) => {
    if (i > 0 && part.breakBefore) text += BLOCK_BREAK;
    starts.push(text.length);
    lengths.push(part.text.length);
    text += part.text;
  });
  return { text, starts, lengths };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every non-overlapping match of `query` in `text`. Any run of whitespace in
 * the query matches any run in the text, so a phrase is found across a line
 * break in the source. Case-insensitive unless `matchCase`.
 */
export function findMatches(text: string, query: string, matchCase: boolean): Match[] {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const re = new RegExp(words.map(escapeRegExp).join('\\s+'), matchCase ? 'gu' : 'giu');
  const out: Match[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

/**
 * The part and the offset inside it for a position in the joined text. For
 * the end of a match the position is exclusive, so it is looked up as the
 * last character and one is added back: a match ending exactly at the end of
 * a part ends in that part, not at the start of the next.
 */
export function locate(index: TextIndex, position: number, edge: 'start' | 'end'): { part: number; offset: number } {
  const at = edge === 'end' ? position - 1 : position;
  let lo = 0;
  let hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  const within = Math.min(Math.max(0, at - index.starts[lo]), index.lengths[lo] - 1);
  return { part: lo, offset: edge === 'end' ? within + 1 : within };
}
