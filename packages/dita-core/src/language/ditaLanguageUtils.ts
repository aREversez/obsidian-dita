// Pure, editor-agnostic logic behind the DITA language features
// (go-to-definition, completion, diagnostics, document symbols).
// Everything here works on raw text + offsets so it stays unit-testable;
// the VS Code glue lives in ditaLanguageFeatures.ts.

import { DitaNode, SourceRange } from '../parser/domTypes';
import { createBookRoleLabeler, RoleLabelFormatter } from '../render/mapTypeMap';

// ── Reference attribute scanning ──

/** Attributes whose values reference other files/keys/elements. */
const REF_ATTRS = new Set(['href', 'conref', 'conkeyref', 'keyref']);

export interface RefEntry {
  /** Attribute name (href / conref / conkeyref / keyref) */
  attr: string;
  /** Raw attribute value */
  value: string;
  /** Offset of the first character of the value (inside the quotes) */
  valueStart: number;
  /** Offset just past the last character of the value */
  valueEnd: number;
  /** Tag the attribute belongs to */
  tagName: string;
  /** scope attribute on the same tag, if any */
  scope?: string;
  /** format attribute on the same tag, if any */
  format?: string;
}

const TAG_RE = /<([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Collects every reference-bearing attribute in the document text. */
export function collectRefEntries(text: string): RefEntry[] {
  const entries: RefEntry[] = [];
  TAG_RE.lastIndex = 0;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = TAG_RE.exec(text)) !== null) {
    const tagName = tagMatch[1];
    const attrSegment = tagMatch[2];
    if (!attrSegment) continue;
    const segmentOffset = tagMatch.index + 1 + tagName.length;

    // First pass: pick up scope/format so hrefs can be classified
    let scope: string | undefined;
    let format: string | undefined;
    ATTR_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ATTR_RE.exec(attrSegment)) !== null) {
      const val = am[2] ?? am[3];
      if (am[1] === 'scope') scope = val;
      else if (am[1] === 'format') format = val;
    }

    ATTR_RE.lastIndex = 0;
    while ((am = ATTR_RE.exec(attrSegment)) !== null) {
      if (!REF_ATTRS.has(am[1])) continue;
      const eqAndQuote = am[0].indexOf('=') + 1 + (am[0].slice(am[0].indexOf('=') + 1).match(/["']/)?.index ?? 0);
      const valueStart = segmentOffset + am.index + eqAndQuote + 1;
      const val = am[2] ?? am[3];
      entries.push({
        attr: am[1],
        value: val,
        valueStart,
        valueEnd: valueStart + val.length,
        tagName,
        scope,
        format,
      });
    }
  }
  return entries;
}

/** Finds the reference attribute whose value contains the given offset. */
export function findRefAttrAt(text: string, offset: number): RefEntry | undefined {
  return collectRefEntries(text).find((e) => offset >= e.valueStart && offset <= e.valueEnd);
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WIN_ABS_RE = /^([a-zA-Z]:[\\/]|\\\\|\/)/;

/** True when the reference points outside the local project (not resolvable from disk). */
export function isExternalRef(value: string, scope?: string): boolean {
  if (!value) return true;
  if (scope === 'external' || scope === 'peer') return true;
  if (URL_SCHEME_RE.test(value)) return true;
  if (WIN_ABS_RE.test(value)) return true;
  return false;
}

// ── Key definition lookup ──

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the offset of the keys="..." attribute that defines the given key
 * inside a ditamap source text, or -1. A keys attribute may hold a
 * space-separated list of key names.
 */
export function findKeyDefinitionOffset(mapText: string, key: string): number {
  const re = /\bkeys\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mapText)) !== null) {
    const names = m[1].split(/\s+/).filter(Boolean);
    if (names.includes(key)) return m.index;
  }
  return -1;
}

/**
 * Strips the same-document marker some authors prefix onto a conref/href
 * fragment -- the "./id" (or "./topicId/elementId") shorthand, carried over
 * from relative-file-path conventions, that some tools accept as another
 * way of writing a bare "#id". Once stripped, the rest of the fragment
 * parses exactly like a plain "topicId/elementId" or bare "elementId"
 * fragment. A fragment with no such prefix is returned unchanged.
 *
 * This is the single place that understands the "./" shorthand -- every
 * caller that splits a fragment into a topic-scope part and an element-id
 * part should normalize through here first, rather than special-casing
 * "." locally, so the same-document marker is handled consistently
 * wherever fragments are parsed (go-to-definition, find-references, and
 * this file's own findConrefTargetOffset all split fragments this way).
 */
export function stripSameDocumentFragmentPrefix(fragment: string): string {
  return fragment.replace(/^\.\/+/, '');
}

/**
 * Splits a conref/href fragment into the two parts the DITA addressing
 * grammar defines -- "topicId" or "topicId/elementId" -- after normalizing
 * the "./" same-document shorthand. A one-part fragment addresses the topic
 * itself, so topicId is undefined and the whole fragment is the id named.
 *
 * This is the single place that splits a fragment. Callers must not do their
 * own split('/')[0]: that answers "which topic" when the question is nearly
 * always "which element", and for the standard two-part form the two are
 * different strings by definition. ditaRenderUtils resolves conref content
 * this way already (parts.length > 1 ? parts[1] : parts[0]); find-references
 * took parts[0] instead, which is why conrefs rendered fine but could not be
 * found from their declaration.
 */
export function splitRefFragment(fragment: string): { topicId: string | undefined; elementId: string } {
  const normalized = stripSameDocumentFragmentPrefix(fragment);
  const slashIdx = normalized.indexOf('/');
  return slashIdx >= 0
    ? { topicId: normalized.substring(0, slashIdx), elementId: normalized.substring(slashIdx + 1) }
    : { topicId: undefined, elementId: normalized };
}

/**
 * Resolves a conref/href fragment ("topicId" or "topicId/elementId") to the
 * offset of the target id="..." attribute in the target file's text, or -1.
 */
export function findConrefTargetOffset(text: string, fragment: string): number {
  const { topicId, elementId } = splitRefFragment(fragment);
  if (!elementId) return -1;

  const findId = (id: string, from: number): number => {
    const re = new RegExp(`\\bid\\s*=\\s*"${escapeRegExp(id)}"`, 'g');
    re.lastIndex = from;
    const m = re.exec(text);
    return m ? m.index : -1;
  };

  // A bare elementId (no "/" at all) has no real topic to scope the search
  // by. Before the stripSameDocumentFragmentPrefix normalization above, a
  // same-document self-reference marker (e.g. conref="#./noteId") landed
  // here as a literal "." topicId, which could never match a real
  // id="..." and always reported the target as missing -- normalizing the
  // fragment first means that case now falls into the same "no scope"
  // bucket as a plain "#noteId" bare id.
  if (topicId === undefined || topicId === '') {
    return findId(elementId, 0);
  }

  const topicOff = findId(topicId, 0);
  if (topicOff < 0) return -1;
  return findId(elementId, topicOff);
}

// ── Reverse lookup (Find All References) ──
//
// Go-to-definition above answers "what does this reference point at?"
// These two answer the opposite question for the two things DITA content
// can be "the definition of": an element's id="..." (targeted by
// conref/href fragments) and a keydef's keys="..." (targeted by
// keyref/conkeyref). The actual workspace scan that uses these to find
// callers lives in ditaLanguageFeatures.ts's DitaReferenceProvider --
// kept here, offset-based and file-agnostic, so it stays unit-testable.

export interface IdAttrHit {
  id: string;
  valueStart: number;
  valueEnd: number;
}

/** If the offset falls inside an id="..." attribute value, returns that id
 *  and the value's span; otherwise undefined. */
export function findIdAttrAt(text: string, offset: number): IdAttrHit | undefined {
  const re = /\bid\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const valueStart = m.index + m[0].indexOf('"') + 1;
    const valueEnd = valueStart + m[1].length;
    if (offset >= valueStart && offset <= valueEnd) {
      return { id: m[1], valueStart, valueEnd };
    }
  }
  return undefined;
}

export interface KeysAttrHit {
  /** The single key token the offset lands on (keys="a b c" can hold several). */
  key: string;
  valueStart: number;
  valueEnd: number;
}

/** If the offset falls inside one key of a keydef's keys="..." attribute
 *  value, returns that specific key token (not the whole space-separated
 *  list) and its span; otherwise undefined. Only matches on a <keydef> (or
 *  <topicref>/<mapref> carrying its own keys attribute) tag, not any other
 *  element that happens to have a "keys" attribute. */
export function findKeysAttrAt(text: string, offset: number): KeysAttrHit | undefined {
  const re = /\bkeys\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const listStart = m.index + m[0].indexOf('"') + 1;
    const listEnd = listStart + m[1].length;
    if (offset < listStart || offset > listEnd) continue;
    const relOffset = offset - listStart;
    let tokenStart = 0;
    for (const token of m[1].split(/(\s+)/)) {
      const tokenEnd = tokenStart + token.length;
      if (!/^\s*$/.test(token) && relOffset >= tokenStart && relOffset <= tokenEnd) {
        return { key: token, valueStart: listStart + tokenStart, valueEnd: listStart + tokenEnd };
      }
      tokenStart = tokenEnd;
    }
    return undefined;
  }
  return undefined;
}

export interface KeydefHit {
  /** All key names declared via keys="..." on the enclosing keydef, in
   *  document order. Usually one, but keys="a b c" declares several
   *  aliases for the same target -- all of them are valid search targets
   *  since they all resolve to the same content. */
  keys: string[];
}

/** If the offset falls ANYWHERE inside a <keydef> element -- not just
 *  literally inside its keys="..." attribute value the way findKeysAttrAt
 *  above requires -- returns every key that keydef declares.
 *
 *  This exists specifically for Find All References: clicking on some
 *  OTHER part of a keydef (its <keyword> display text, its href, its
 *  topicmeta, whitespace inside a multi-line keydef) is an easy mistake
 *  for someone unfamiliar with the extension to make when trying to find
 *  where a key is used -- especially the keyword text, which is the
 *  human-readable label a reader would naturally click on. Silently
 *  falling through to the generic "who references this ditamap file"
 *  answer in that case is actively confusing: it still returns results,
 *  so it looks like it worked, but it answers a different question than
 *  the one being asked. findKeysAttrAt's narrower, attribute-value-only
 *  match still takes priority when it hits (see ditaLanguageFeatures.ts'
 *  resolveReferenceTarget) so clicking the exact key name still resolves
 *  to just that one key rather than every alias on the keydef. */
export function findEnclosingKeydefKeys(text: string, offset: number): KeydefHit | undefined {
  const tagRe = /<keydef\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const tagStart = m.index;
    const tagText = m[0];
    const selfClosing = /\/\s*>$/.test(tagText);
    let elementEnd: number;
    if (selfClosing) {
      elementEnd = tagStart + tagText.length;
    } else {
      const closeTag = '</keydef>';
      const closeIdx = text.indexOf(closeTag, tagStart + tagText.length);
      elementEnd = closeIdx >= 0 ? closeIdx + closeTag.length : tagStart + tagText.length;
    }
    if (offset < tagStart || offset > elementEnd) continue;

    const keysMatch = /\bkeys\s*=\s*"([^"]*)"/.exec(tagText);
    if (!keysMatch) return undefined;
    const keys = keysMatch[1].split(/\s+/).filter(Boolean);
    return keys.length ? { keys } : undefined;
  }
  return undefined;
}

/** Collects all id="..." values declared in a document text. */
export function collectIds(text: string): string[] {
  const ids: string[] = [];
  const re = /\bid\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

/** Converts a character offset into a 0-based line/column pair. */
export function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart };
}

// ── Completion context detection ──

export type CompletionContextKind = 'tag' | 'attrName' | 'attrValue' | 'none';

export interface DitaCompletionContext {
  kind: CompletionContextKind;
  /** Tag the cursor is inside of (for attrName/attrValue) */
  tagName?: string;
  /** Attribute whose value is being typed (for attrValue) */
  attrName?: string;
  /** Text already typed for the current token */
  prefix?: string;
  /** Offset where the current attr value starts (for attrValue) */
  valueStart?: number;
  /** True when typing a closing tag ("</se") */
  closing?: boolean;
}

/** Classifies what kind of completion applies at the given offset. */
export function getCompletionContext(text: string, offset: number): DitaCompletionContext {
  const lastLt = text.lastIndexOf('<', offset - 1);
  if (lastLt < 0) return { kind: 'none' };
  const between = text.substring(lastLt, offset);
  // Comments / processing instructions / closed tags → no structural completion
  if (between.includes('>') || between.startsWith('<!') || between.startsWith('<?')) {
    return { kind: 'none' };
  }

  // Still typing the tag name itself: "<", "<no", "</se"
  const tagTyping = /^<(\/?)([\w.-]*)$/.exec(between);
  if (tagTyping) return { kind: 'tag', prefix: tagTyping[2], closing: tagTyping[1] === '/' };

  const tagNameMatch = /^<\/?([\w.-]+)/.exec(between);
  const tagName = tagNameMatch ? tagNameMatch[1] : undefined;

  // Inside an attribute value: attr="partial
  const valueMatch = /([\w:.-]+)\s*=\s*"([^"]*)$/.exec(between);
  if (valueMatch) {
    return {
      kind: 'attrValue',
      tagName,
      attrName: valueMatch[1],
      prefix: valueMatch[2],
      valueStart: offset - valueMatch[2].length,
    };
  }

  // After whitespace inside the tag → attribute name position
  if (/[\s"']([\w:.-]*)$/.test(between)) {
    const anm = /([\w:.-]*)$/.exec(between);
    return { kind: 'attrName', tagName, prefix: anm ? anm[1] : '' };
  }

  return { kind: 'none' };
}

// ── Tag auto-closing ──

/**
 * When the character just typed before `offset` is the '>' of an opening
 * tag, returns the tag name to auto-close. Closing tags, self-closing tags,
 * comments, PIs and '>' inside attribute values yield undefined.
 */
export function getAutoCloseTag(text: string, offset: number): string | undefined {
  if (text[offset - 1] !== '>') return undefined;
  const lastLt = text.lastIndexOf('<', offset - 2);
  if (lastLt < 0) return undefined;
  const tagText = text.substring(lastLt, offset);
  if (tagText.startsWith('</') || tagText.startsWith('<!') || tagText.startsWith('<?')) {
    return undefined;
  }
  if (/\/\s*>$/.test(tagText)) return undefined;
  // An odd number of quotes means the '>' was typed inside an attribute value
  if (((tagText.match(/"/g) || []).length) % 2 === 1) return undefined;
  const m = /^<([A-Za-z][\w.-]*)(?:[\s>]|$)/.exec(tagText);
  return m ? m[1] : undefined;
}

/** Innermost tag left unclosed at the end of the given text. */
export function findUnclosedTag(text: string): string | undefined {
  // Strip constructs whose content must not feed the tag stack
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<![^>]*>/g, ' ');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    if (m[1]) {
      // Pop down to the matching open tag (tolerates malformed nesting)
      const idx = stack.lastIndexOf(m[2]);
      if (idx >= 0) stack.length = idx;
    } else if (!/\/\s*$/.test(m[3])) {
      stack.push(m[2]);
    }
  }
  return stack[stack.length - 1];
}

/**
 * When the two characters ending at `offset` are '</', returns the tag name
 * that completes the closing tag, or undefined.
 */
export function getCloseTagCompletion(text: string, offset: number): string | undefined {
  if (text.substring(offset - 2, offset) !== '</') return undefined;
  return findUnclosedTag(text.substring(0, offset - 2));
}

// ── Attribute knowledge for completion ──

const UNIVERSAL_ATTRS = [
  'id',
  'conref',
  'conkeyref',
  'keyref',
  'outputclass',
  'props',
  'audience',
  'platform',
  'product',
  'rev',
  'importance',
  'translate',
  'xml:lang',
];

const REF_TAG_ATTRS = ['href', 'keys', 'keyref', 'navtitle', 'format', 'scope', 'processing-role', 'toc', 'type', 'collection-type'];

export const TAG_SPECIFIC_ATTRS: Record<string, string[]> = {
  xref: ['href', 'format', 'scope', 'type'],
  link: ['href', 'format', 'scope', 'type'],
  image: ['href', 'height', 'width', 'placement', 'align', 'scale'],
  note: ['type', 'othertype'],
  topicref: REF_TAG_ATTRS,
  keydef: ['keys', 'href', 'format', 'scope', 'processing-role'],
  mapref: ['href', 'format', 'processing-role'],
  chapter: REF_TAG_ATTRS,
  part: REF_TAG_ATTRS,
  appendix: REF_TAG_ATTRS,
  preface: REF_TAG_ATTRS,
  glossaryref: REF_TAG_ATTRS,
  topichead: ['navtitle', 'collection-type'],
  table: ['frame', 'colsep', 'rowsep', 'pgwide'],
  tgroup: ['cols'],
  colspec: ['colname', 'colwidth', 'colnum'],
  entry: ['colname', 'namest', 'nameend', 'morerows', 'valign', 'align'],
  codeblock: ['outputclass', 'scale'],
  ph: ['keyref'],
  keyword: ['keyref'],
  term: ['keyref'],
  lq: ['href', 'reftitle'],
  fig: ['frame', 'expanse'],
  section: ['spectitle'],
};

/** Attribute names offered for a tag: tag-specific first, then universal. */
export function getAttributesForTag(tag: string | undefined): string[] {
  const specific = tag ? TAG_SPECIFIC_ATTRS[tag] || [] : [];
  const merged: string[] = [...specific];
  for (const a of UNIVERSAL_ATTRS) if (!merged.includes(a)) merged.push(a);
  return merged;
}

// ── Document symbols ──

export interface DocSymbolSpec {
  name: string;
  detail?: string;
  kind: 'topic' | 'section' | 'ref' | 'head' | 'structural' | 'keydef';
  range: SourceRange;
  children: DocSymbolSpec[];
}

function plainText(node: DitaNode): string {
  if (node.type === 'text') return node.text || '';
  return (node.children || []).map(plainText).join('');
}

function findTitleText(node: DitaNode): string | undefined {
  const titleChild = (node.children || []).find(
    (c) => c.type === 'element' && c.baseType === 'topic/title',
  );
  if (!titleChild) return undefined;
  const t = plainText(titleChild).trim();
  return t || undefined;
}

/** Outline for a .dita topic file: topics, sections and examples. */
// Topic specializations are recognized by tag name too: authored source
// files carry no @class attribute, so their baseType stays undefined.
const TOPIC_ROOT_TAGS = new Set([
  'topic',
  'concept',
  'task',
  'reference',
  'glossentry',
  'glossgroup',
  'troubleshooting',
]);

function isTopicNode(node: DitaNode): boolean {
  return node.baseType === 'topic/topic' || (!!node.tagName && TOPIC_ROOT_TAGS.has(node.tagName));
}

export function collectTopicSymbols(root: DitaNode): DocSymbolSpec[] {
  function walk(node: DitaNode): DocSymbolSpec[] {
    const result: DocSymbolSpec[] = [];
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      const bt = child.baseType;
      if (isTopicNode(child)) {
        result.push({
          name: findTitleText(child) || child.attributes?.id || '(topic)',
          detail: child.tagName,
          kind: 'topic',
          range: child.sourceRange,
          children: walk(child),
        });
      } else if (bt === 'topic/section' || bt === 'topic/example') {
        result.push({
          name: findTitleText(child) || (bt === 'topic/example' ? '(example)' : '(section)'),
          detail: child.tagName,
          kind: 'section',
          range: child.sourceRange,
          children: walk(child),
        });
      } else {
        result.push(...walk(child));
      }
    }
    return result;
  }

  // The root topic itself is represented too, so breadcrumbs show it
  if (isTopicNode(root)) {
    return [
      {
        name: findTitleText(root) || root.attributes?.id || '(topic)',
        detail: root.tagName,
        kind: 'topic',
        range: root.sourceRange,
        children: walk(root),
      },
    ];
  }
  return walk(root);
}

/** Display name for a map reference node (navtitle > linktext > href > keys). */
export function getMapRefName(node: DitaNode): string {
  const topicmeta = (node.children || []).find(
    (c) => c.type === 'element' && c.baseType === 'map/topicmeta',
  );
  if (topicmeta) {
    for (const bt of ['map/navtitle', 'map/linktext']) {
      const child = (topicmeta.children || []).find(
        (c) => c.type === 'element' && c.baseType === bt,
      );
      if (child) {
        const t = plainText(child).trim();
        if (t) return t;
      }
    }
  }
  const navtitleAttr = node.attributes?.navtitle;
  if (navtitleAttr) return navtitleAttr;
  const href = node.attributes?.href;
  if (href) return href;
  const keys = node.attributes?.keys;
  if (keys) return keys;
  return '(unnamed)';
}

/** Outline for a .ditamap file: topicref hierarchy with structural containers. */
export function collectMapSymbols(root: DitaNode, roleFormat?: RoleLabelFormatter): DocSymbolSpec[] {
  const roleLabel = createBookRoleLabeler(roleFormat);
  function walk(node: DitaNode, depth: number): DocSymbolSpec[] {
    const result: DocSymbolSpec[] = [];
    for (const child of node.children || []) {
      if (child.type !== 'element') continue;
      const bt = child.baseType;
      if (bt === 'map/topicref' || bt === 'map/mapref') {
        // Book divisions surface their numbered role ("Chapter 1", …)
        const label = roleLabel(child.tagName, depth);
        result.push({
          name: getMapRefName(child),
          detail: label || child.tagName,
          kind: 'ref',
          range: child.sourceRange,
          children: walk(child, depth + 1),
        });
      } else if (bt === 'map/keydef') {
        result.push({
          name: child.attributes?.keys || '(keydef)',
          detail: child.tagName,
          kind: 'keydef',
          range: child.sourceRange,
          children: walk(child, depth + 1),
        });
      } else if (bt === 'map/topichead') {
        result.push({
          name: getMapRefName(child),
          detail: child.tagName,
          kind: 'head',
          range: child.sourceRange,
          children: walk(child, depth + 1),
        });
      } else if (bt === 'map/bookmap-structural') {
        result.push({
          name: child.tagName || '(container)',
          kind: 'structural',
          range: child.sourceRange,
          children: walk(child, depth),
        });
      } else if (bt === 'map/reltable') {
        continue;
      } else {
        result.push(...walk(child, depth));
      }
    }
    return result;
  }
  return walk(root, 0);
}

// ── Unknown-element detection ──

/** An element the parser could not assign a DITA base type to. */
export interface UnknownElementEntry {
  tagName: string;
  sourceRange: SourceRange;
}

// Base types whose own renderer takes full, exclusive ownership of its
// subtree instead of generically dispatching to each child by its own
// baseType. An unmapped tag name underneath one of these causes no silent
// content loss -- the reason this diagnostic exists at all -- because
// nothing under them is shown via the generic per-child path regardless of
// whether the parser could classify it:
//
// - topic/foreign (<foreign>, <mathml>, and this project's 'svg-container'
//   convenience mapping in standardTagMap.ts): BASE_TYPE_RENDERERS in
//   baseTypeMap.ts serializes its children as raw markup directly, without
//   ever consulting each descendant's own baseType. Every MathML/SVG tag
//   underneath is correctly unrecognized by parseBaseType() -- that is the
//   point, it is not DITA -- so walking in and reporting its contents would
//   just relabel valid MathML/SVG markup as "unknown DITA elements".
// - topic/prolog: its renderer (baseTypeMap.ts) extracts only top-level
//   indexterm chips via a dedicated traversal and returns '' for
//   everything else -- by its own comment, "every OTHER prolog descendant
//   ... is still fully suppressed". author, critdate, metadata, audience,
//   keywords and the rest of DITA's prolog vocabulary are real, valid,
//   commonly-used elements; several (metadata, keywords, navtitle, author,
//   critdate, ...) simply have no entry of their own in standardTagMap.ts,
//   because nothing before this diagnostic ever needed one -- prolog's own
//   renderer already hides the entire subtree, mapped or not.
// - map/topicmeta: the same shape one level up, for maps -- its renderer
//   (mapTypeMap.ts) also returns '' unconditionally, with the topicref's
//   navtitle/keyword text pulled out separately via getNodeText() rather
//   than the generic per-child dispatch. indexterm is valid inside a map's
//   <topicmeta><keywords> (DITA maps reuse several topic-level metadata
//   elements verbatim) but was never given its own entry in mapTagMap.ts
//   for the same reason: nothing needed it before.
// - map/map-title: the map's own <title> (and <booktitle>/<mainbooktitle>/
//   <booktitlealt>/<subtitle>, which specialize the same base type) is
//   rendered by extractText() -- a dedicated, baseType-agnostic recursive
//   text walk with its own <ph keyref="..."> substitution built in, not
//   the generic per-child dispatch either. Nothing under a map's <title>
//   goes missing for being unmapped: extractText() walks every descendant
//   by its .children/.text shape alone and does not consult baseType at
//   all, which is exactly why a keyref-only <ph/> in a map title already
//   resolves correctly -- and why flagging it here was never accurate.
//
// Skipping these four is about what the renderer actually does with a
// subtree, not about the elements in it being any less real or valid DITA
// than a <p> or a <note> -- unlike topic/foreign, which is correctly
// non-DITA content.
const SUBTREE_OWNED_BASETYPES = new Set([
  'topic/foreign',
  'topic/prolog',
  'map/topicmeta',
  'map/map-title',
  // topic/indexterm's own renderer (collectIndextermChips() in
  // baseTypeMap.ts) walks node.children itself -- direct text nodes plus
  // nested topic/indexterm, topic/index-see and topic/index-see-also by
  // baseType -- and never dispatches through the generic recursive
  // renderer for anything else, so an unmapped tag anywhere inside an
  // indexterm causes no additional silent content loss to report here.
  // topic/index-see-also (and its siblings, all only ever valid inside an
  // indexterm) are included defensively for the case where the enclosing
  // indexterm itself failed to classify and so was not skipped.
  'topic/indexterm',
  'topic/index-see',
  'topic/index-see-also',
  'topic/index-sort-as',
  'topic/index-base',
  // map/relheader falls back to a baseType-agnostic extractText() walk for
  // a relcolspec's column title whenever @navtitle is absent (mapTypeMap.ts)
  // -- same shape as map/map-title above, content is never actually lost.
  'map/relcolspec',
]);

/**
 * Walks a parsed document and collects every element the parser fell
 * through on: neither its tag name nor an explicit @class attribute (DITA's
 * own mechanism for a specialized element to say what it specializes)
 * resolved to a known base type. renderEffectiveNode() in renderer.ts
 * treats exactly this case as "render the children, drop the element" --
 * silently, with no visual indication -- so from the reader's side a typo
 * here looks identical to the content simply not being there. Reusing
 * node.baseType, already computed by the same parseBaseType() the renderer
 * itself relies on, means this can never disagree with what actually gets
 * dropped: there is one source of truth for "does DITA Viewer recognize
 * this element", not a second copy of the classification logic that could
 * drift from it.
 */
export function collectUnknownElements(root: DitaNode): UnknownElementEntry[] {
  const results: UnknownElementEntry[] = [];

  function walk(node: DitaNode): void {
    if (node.type !== 'element') return;
    if (node.baseType && SUBTREE_OWNED_BASETYPES.has(node.baseType)) return;
    if (!node.baseType && node.tagName) {
      results.push({ tagName: node.tagName, sourceRange: node.sourceRange });
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  walk(root);
  return results;
}
