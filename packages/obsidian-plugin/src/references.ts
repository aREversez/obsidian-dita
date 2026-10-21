// What a Ctrl/Cmd+click in the source lands on, and where an id is defined.
//
// Free of Obsidian and CodeMirror imports: finding the attribute under an
// arbitrary document offset (including a tag whose attributes wrap over
// several lines) is the awkward part, so it is tested on its own.

export type ReferenceKind = 'file' | 'key';

export interface SourceReference {
  kind: ReferenceKind;
  /** The attribute as written: href, conref, conrefend, keyref or conkeyref. */
  attribute: string;
  /** The attribute value, exactly as written between the quotes. */
  value: string;
}

const FILE_ATTRIBUTES = new Set(['href', 'conref', 'conrefend']);
const KEY_ATTRIBUTES = new Set(['keyref', 'conkeyref']);

/** name="value" or name='value', anywhere inside a tag's text. */
const ATTRIBUTE = /([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function isNameStart(ch: string): boolean {
  return /[A-Za-z_:]/.test(ch);
}

/**
 * The `<…>` whose text holds `offset`. Undefined when the offset is in plain
 * text, before the first tag, or inside a comment/CDATA block: a cursor there
 * is not on an attribute and Ctrl+click must do the normal thing.
 */
function tagBounds(text: string, offset: number): { start: number; end: number } | undefined {
  const start = text.lastIndexOf('<', offset);
  if (start < 0) return undefined;
  const next = text[start + 1];
  if (next === undefined || (!isNameStart(next) && next !== '/')) return undefined;
  let quote: string | undefined;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '<') {
      // A new tag began: the offset sits in text, not in the first tag.
      return undefined;
    } else if (ch === '>') {
      return i < offset ? undefined : { start, end: i + 1 };
    }
  }
  return undefined;
}

export function referenceAt(text: string, offset: number): SourceReference | undefined {
  const tag = tagBounds(text, offset);
  if (!tag) return undefined;
  const inner = text.slice(tag.start, tag.end);

  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(inner)) !== null) {
    const attribute = match[1];
    const key = FILE_ATTRIBUTES.has(attribute) ? 'file' : KEY_ATTRIBUTES.has(attribute) ? 'key' : undefined;
    if (!key) continue;
    // The whole name="value" span is the hit area: it reads as one thing, and
    // a caret just after the closing quote is still "on" the reference.
    const start = tag.start + match.index;
    if (offset < start || offset > start + match[0].length) continue;
    const value = match[2] ?? match[3] ?? '';
    if (!value.trim()) continue;
    return { kind: key, attribute, value };
  }
  return undefined;
}

/**
 * Where the element carrying `id` starts, so a jump can put the caret on its
 * tag rather than on the attribute that named it. Undefined when no element
 * in the text has that id.
 */
export function positionOfId(text: string, id: string): { line: number; col: number } | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attribute = new RegExp(`\\bid\\s*=\\s*(?:"${escaped}"|'${escaped}')`);
  const match = attribute.exec(text);
  if (!match) return undefined;
  const start = text.lastIndexOf('<', match.index);
  const offset = start >= 0 ? start : match.index;
  const line = text.slice(0, offset).split('\n').length - 1;
  const col = offset - (text.lastIndexOf('\n', offset - 1) + 1);
  return { line, col };
}
