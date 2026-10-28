// DITA text -> the headings Obsidian's Outline pane lists.
//
// The Outline reads `HeadingCache` entries (text, level, position) that
// Obsidian itself only builds for Markdown. Here they come from the core's
// document symbols instead: a topic gives its title, nested topics and titled
// sections / examples; a map gives its topicref hierarchy. The level is the
// nesting depth, so the Outline nests the way the document does.
//
// Free of Obsidian imports so it is unit-tested.

import {
  collectMapSymbols,
  collectTopicSymbols,
  getMapTitleText,
  parseDita,
  parseDitamap,
  preprocessEntities,
} from '@dita-viewer/core';
import type { DitaNode, DocSymbolSpec } from '@dita-viewer/core';

export interface HeadingPos {
  /** Zero-based, exact. */
  line: number;
  /**
   * Approximate: the core swaps a named entity (`&nbsp;`) for one character
   * before parsing, so on a line that has one before the element these are a
   * few characters short. Only `line` is used (the Outline scrolls to a line);
   * Obsidian's other uses of the offset work on Markdown's cache, which a
   * DITA file never has.
   */
  col: number;
  offset: number;
}

/** The shape of Obsidian's `HeadingCache`, which is what the Outline consumes. */
export interface OutlineHeading {
  heading: string;
  /** 1 to 6, as for Markdown headings. */
  level: number;
  position: { start: HeadingPos; end: HeadingPos };
}

const MAX_LEVEL = 6;

/** What the core names a section or example that has no title of its own. */
const UNTITLED = new Set(['(section)', '(example)']);

/**
 * Replaces the DOCTYPE with spaces, keeping its line breaks. The core's
 * entity preprocessing deletes it, and a DITA DOCTYPE is often two lines
 * long, which would move every position after it up by a line.
 */
function blankDoctype(xml: string): string {
  const start = xml.indexOf('<!DOCTYPE');
  if (start < 0) return xml;
  let i = start + '<!DOCTYPE'.length;
  let quote: string | undefined;
  let subset = false;
  for (; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[') {
      subset = true;
    } else if (ch === ']') {
      subset = false;
    } else if (ch === '>' && !subset) {
      i++;
      break;
    }
  }
  return xml.slice(0, start) + xml.slice(start, i).replace(/[^\n]/g, ' ') + xml.slice(i);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function toPos(starts: readonly number[], textLength: number, line: number, col: number): HeadingPos {
  const l = Math.min(Math.max(0, line), starts.length - 1);
  return { line: l, col, offset: Math.min(textLength, starts[l] + Math.max(0, col)) };
}

/** `line:col` of an element's start, how the symbols and the parsed tree are matched up. */
const keyOf = (r: { startLine: number; startCol: number }): string => `${r.startLine}:${r.startCol}`;

/**
 * Elements inside a resource-only subtree: in the map for their keys, not part
 * of the book. The attribute cascades, and a container that yields no row of
 * its own (topicgroup) has to mark what it holds here, since flatten never
 * sees that container at all.
 */
function resourceOnly(node: DitaNode, inherited = false, found = new Set<string>()): Set<string> {
  if (node.type !== 'element') return found;
  // As the core's map walk does it: an explicit attribute wins outright, so a
  // nested `normal` opts back into the book, and otherwise the parent's value
  // carries down.
  const own = node.attributes?.['processing-role'];
  const only = own === 'resource-only' || (own !== 'normal' && inherited);
  if (only) found.add(keyOf(node.sourceRange));
  for (const child of node.children) resourceOnly(child, only, found);
  return found;
}

function flatten(
  symbols: readonly DocSymbolSpec[],
  depth: number,
  out: OutlineHeading[],
  at: (line: number, col: number) => HeadingPos,
  skip: ReadonlySet<string>,
): void {
  for (const s of symbols) {
    // Key definitions and resource-only references (with what they contain)
    // are plumbing, not a table of contents.
    if (s.kind === 'keydef' || skip.has(keyOf(s.range))) continue;
    // A bookmap's frontmatter / backmatter / booklists are containers with no
    // name of their own: their entries belong to the level above.
    if (s.kind === 'structural') {
      flatten(s.children, depth, out, at, skip);
      continue;
    }
    // A section with no title has no heading; what it holds belongs to the level above.
    if (s.kind === 'section' && UNTITLED.has(s.name)) {
      flatten(s.children, depth, out, at, skip);
      continue;
    }
    out.push({
      heading: s.name,
      level: Math.min(depth + 1, MAX_LEVEL),
      position: { start: at(s.range.startLine, s.range.startCol), end: at(s.range.endLine, s.range.endCol) },
    });
    flatten(s.children, depth + 1, out, at, skip);
  }
}

/** The map's own title element (`<booktitle>` of a bookmap, else `<title>`), for its row. */
function mapTitle(root: DitaNode): { name: string; range: DocSymbolSpec['range'] } | undefined {
  const name = getMapTitleText(root);
  const el = root.children.find((c) => c.type === 'element' && c.tagName === 'booktitle') ??
    root.children.find((c) => c.type === 'element' && c.tagName === 'title');
  return name && el ? { name, range: el.sourceRange } : undefined;
}

/**
 * The headings of a topic or map, in document order, or undefined when the
 * text cannot be parsed (half-typed XML, an empty file): the caller keeps the
 * last good list rather than flashing an empty Outline while someone types.
 */
export function ditaHeadings(text: string, isMap: boolean): OutlineHeading[] | undefined {
  const source = blankDoctype(text.replace(/^\uFEFF/, ''));
  let symbols: DocSymbolSpec[];
  let title: ReturnType<typeof mapTitle>;
  let skip = new Set<string>();
  try {
    const parsed = (isMap ? parseDitamap : parseDita)(preprocessEntities(source));
    symbols = isMap ? collectMapSymbols(parsed.root) : collectTopicSymbols(parsed.root);
    if (isMap) {
      title = mapTitle(parsed.root);
      skip = resourceOnly(parsed.root);
    }
  } catch {
    return undefined;
  }
  const starts = lineStarts(source);
  const at = (line: number, col: number): HeadingPos => toPos(starts, source.length, line, col);
  const out: OutlineHeading[] = [];
  // A topic's title is its first row; a map has none among its symbols, so
  // it gets one and its entries nest under it.
  if (title) out.push({ heading: title.name, level: 1, position: { start: at(title.range.startLine, title.range.startCol), end: at(title.range.endLine, title.range.endCol) } });
  flatten(symbols, title ? 1 : 0, out, at, skip);
  return out;
}

/**
 * Headings per file, re-derived only when the text changes, so the Outline
 * (which asks every time it redraws) does not parse the document each time.
 * Bounded: one entry per file opened since start-up would grow without limit.
 */
export class HeadingTracker {
  private static readonly MAX_ENTRIES = 50;
  private readonly entries = new Map<string, { text: string; headings: OutlineHeading[] }>();

  headingsFor(path: string, text: string, isMap: boolean): OutlineHeading[] {
    const hit = this.entries.get(path);
    if (hit && hit.text === text) return hit.headings;
    // Text that does not parse keeps the previous headings, and is remembered
    // so it is not parsed again for every redraw.
    const headings = ditaHeadings(text, isMap) ?? hit?.headings ?? [];
    if (!hit && this.entries.size >= HeadingTracker.MAX_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    this.entries.set(path, { text, headings });
    return headings;
  }

  /** The last headings known for a file, for when its text is not at hand. */
  lastKnown(path: string): OutlineHeading[] {
    return this.entries.get(path)?.headings ?? [];
  }

  forget(path: string): void {
    this.entries.delete(path);
  }
}
