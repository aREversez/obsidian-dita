// DITA text -> the headings Obsidian's Outline pane lists.
//
// The Outline reads `HeadingCache` entries (text, level, position) that
// Obsidian itself only builds for Markdown. Here they come from the core's
// document symbols instead: a topic gives its title, nested topics and titled
// sections / examples; a map gives its topicref hierarchy. The level is the
// nesting depth, so the Outline nests the way the document does.
//
// Free of Obsidian imports so it is unit-tested.

import { collectMapSymbols, collectTopicSymbols, parseDita, parseDitamap, preprocessEntities } from '@dita-viewer/core';
import type { DocSymbolSpec } from '@dita-viewer/core';

export interface HeadingPos {
  /** Zero-based. */
  line: number;
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

function flatten(
  symbols: readonly DocSymbolSpec[],
  depth: number,
  out: OutlineHeading[],
  at: (line: number, col: number) => HeadingPos,
): void {
  for (const s of symbols) {
    // Key definitions are plumbing, not a table of contents.
    if (s.kind === 'keydef') continue;
    // A section with no title has no heading; what it holds belongs to the level above.
    if (s.kind === 'section' && UNTITLED.has(s.name)) {
      flatten(s.children, depth, out, at);
      continue;
    }
    out.push({
      heading: s.name,
      level: Math.min(depth + 1, MAX_LEVEL),
      position: { start: at(s.range.startLine, s.range.startCol), end: at(s.range.endLine, s.range.endCol) },
    });
    flatten(s.children, depth + 1, out, at);
  }
}

/**
 * The headings of a topic or map, in document order, or undefined when the
 * text cannot be parsed (half-typed XML, an empty file): the caller keeps the
 * last good list rather than flashing an empty Outline while someone types.
 */
export function ditaHeadings(text: string, isMap: boolean): OutlineHeading[] | undefined {
  const source = blankDoctype(text.replace(/^\uFEFF/, ''));
  let symbols: DocSymbolSpec[];
  try {
    const parsed = (isMap ? parseDitamap : parseDita)(preprocessEntities(source));
    symbols = isMap ? collectMapSymbols(parsed.root) : collectTopicSymbols(parsed.root);
  } catch {
    return undefined;
  }
  const starts = lineStarts(source);
  const out: OutlineHeading[] = [];
  flatten(symbols, 0, out, (line, col) => toPos(starts, source.length, line, col));
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
