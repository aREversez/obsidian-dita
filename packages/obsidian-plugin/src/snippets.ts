// The text the "wrap in element" and "insert structure" commands put in.
//
// Pure: the caller says what is selected (or where the caret is) and gets back
// the inserted text plus where the caret and selection go, so the indentation
// rules are unit-tested and DitaView only dispatches the change.

import { WrapSpec } from './snippetsData';

export interface TextEdit {
  /** Text to insert in place of the replaced range. */
  insert: string;
  /** Offset inside `insert` the caret lands on. */
  caret: number;
  /** Length of the inserted text that stays selected, counted from `caret`. */
  select: number;
}

/**
 * Wrap the selected text (or, with nothing selected, leave an empty element
 * with the caret inside it). The wrapped text stays selected so a second wrap
 * nests around it without reaching for the mouse.
 */
export function wrapSelection(selected: string, spec: WrapSpec): TextEdit {
  const insert = spec.open + selected + spec.close;
  return { insert, caret: spec.open.length, select: selected.length };
}

/** Marker in a structure template where the caret should end up. */
export const CARET = '{{caret}}';

/**
 * Insert a structure template at `pos`, indented like the line `pos` is on.
 * Templates carry their own relative indentation, so only the current line's
 * leading whitespace is added to every line after the first.
 */
export function insertStructure(text: string, pos: number, template: string): TextEdit {
  const lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1)) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, pos))?.[0] ?? '';
  const lines = template.split('\n');
  const insert = lines.map((line, i) => (i === 0 ? line : indent + line)).join('\n');
  const marker = insert.indexOf(CARET);
  const caret = marker < 0 ? insert.length : marker;
  return { insert: insert.replace(CARET, ''), caret, select: 0 };
}
