// Completion for DITA source text: elements, attributes, attribute values, key
// references, file paths and ids.
//
// Host-neutral. It works on the document text and a cursor offset and returns
// plain suggestions; the host turns them into its own completion items (the
// Obsidian plugin maps them onto CodeMirror's). Everything it needs from
// outside -- the key space, the files on disk -- comes through CompletionEnv,
// so it runs unchanged in plain mocha.
//
// Context detection (where in a tag the cursor is) and tag-stack scanning are
// the VS Code DITA Viewer's own (language/ditaLanguageUtils.ts, copied
// verbatim); what is new here is ranking elements by their parent, image paths
// for <image href>, attribute de-duplication, and enumerated values.

import { STANDARD_TAG_TO_BASETYPE } from './parser/standardTagMap';
import { MAP_STANDARD_TAG_TO_BASETYPE } from './parser/mapTagMap';
import { collectIds, findUnclosedTag, getAttributesForTag, getCompletionContext } from './language/ditaLanguageUtils';
import { CHILD_HINTS, ENUM_VALUES, FILE_ATTRS, IMAGE_HREF_TAGS, ROOT_HINTS } from './completionData';

export type SuggestionKind = 'tag' | 'closeTag' | 'attribute' | 'value' | 'key' | 'file' | 'id';

export interface Suggestion {
  /** What the user types to match this, and what is shown. */
  label: string;
  kind: SuggestionKind;
  /** Short explanation shown beside the label. */
  detail?: string;
  /** Text that replaces the typed prefix (defaults to the label). */
  insert: string;
  /** Caret position within `insert` after applying (defaults to its end). */
  cursor?: number;
  /** Open a new completion straight after applying, e.g. for the value of an inserted attribute. */
  continueAfter?: boolean;
  /** Ranking, -99..99: higher is listed first among equal matches. */
  boost: number;
}

export interface CompletionResult {
  /** Start of the text the suggestions replace; it ends at the cursor. */
  from: number;
  suggestions: Suggestion[];
}

export interface CompletionEnv {
  /** A .ditamap rather than a topic: picks the element vocabulary. */
  isMap: boolean;
  /** Key name -> its value, for keyref / conkeyref. */
  keys(): ReadonlyMap<string, string>;
  /** Files an href/conref may point at, relative to the document: topics and maps, or images. */
  files(kind: 'topic' | 'image'): Promise<string[]> | string[];
  /** Element ids in another file, or undefined if it cannot be read. `filePart` is as written in the href. */
  idsIn(filePart: string): string[] | undefined;
}

const BOOST_MAX = 90;

/** Rank by position in a hint list: earlier is higher. */
function rankBoost(index: number): number {
  return Math.max(1, BOOST_MAX - index);
}

export async function complete(text: string, offset: number, env: CompletionEnv): Promise<CompletionResult | undefined> {
  const ctx = getCompletionContext(text, offset);
  switch (ctx.kind) {
    case 'tag':
      return ctx.closing ? completeCloseTag(text, offset, ctx.prefix ?? '') : completeTag(text, offset, ctx.prefix ?? '', env);
    case 'attrName':
      return completeAttrName(text, offset, ctx.tagName, ctx.prefix ?? '');
    case 'attrValue':
      return completeAttrValue(text, offset, ctx.tagName, ctx.attrName ?? '', ctx.prefix ?? '', env);
    default:
      return undefined;
  }
}

// ── elements ──

function completeCloseTag(text: string, offset: number, prefix: string): CompletionResult | undefined {
  const lt = offset - prefix.length - 2;
  const open = findUnclosedTag(text.slice(0, Math.max(lt, 0)));
  if (!open) return undefined;
  return {
    from: offset - prefix.length,
    suggestions: [{ label: open, kind: 'closeTag', detail: 'close tag', insert: `${open}>`, boost: BOOST_MAX }],
  };
}

function completeTag(text: string, offset: number, prefix: string, env: CompletionEnv): CompletionResult | undefined {
  const lt = offset - prefix.length - 1;
  const parent = findUnclosedTag(text.slice(0, Math.max(lt, 0)));
  const vocabulary = env.isMap ? MAP_STANDARD_TAG_TO_BASETYPE : STANDARD_TAG_TO_BASETYPE;
  const hints: readonly string[] = parent
    ? CHILD_HINTS[parent] ?? []
    : env.isMap
      ? ROOT_HINTS.map
      : ROOT_HINTS.topic;
  const rank = new Map(hints.map((name, i) => [name, rankBoost(i)]));

  const suggestions: Suggestion[] = Object.keys(vocabulary).map((name) => ({
    label: name,
    kind: 'tag',
    detail: vocabulary[name],
    insert: name,
    boost: rank.get(name) ?? 0,
  }));
  // A hinted name the vocabulary does not list (a specialization the hint table
  // knows) is still worth offering where it is expected.
  for (const [name, boost] of rank) {
    if (!(name in vocabulary)) suggestions.push({ label: name, kind: 'tag', insert: name, boost });
  }
  return { from: offset - prefix.length, suggestions };
}

// ── attributes ──

/** Names of the attributes already written on the tag that ends at `offset`. */
function attributesPresent(text: string, offset: number, prefix: string): Set<string> {
  const lt = text.lastIndexOf('<', offset - 1);
  const written = text.slice(lt, offset - prefix.length);
  const names = new Set<string>();
  for (const m of written.matchAll(/([\w:.-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g)) names.add(m[1]);
  return names;
}

function completeAttrName(text: string, offset: number, tag: string | undefined, prefix: string): CompletionResult | undefined {
  const present = attributesPresent(text, offset, prefix);
  const names = getAttributesForTag(tag).filter((a) => !present.has(a));
  if (names.length === 0) return undefined;
  return {
    from: offset - prefix.length,
    suggestions: names.map((attr, i) => ({
      label: attr,
      kind: 'attribute',
      insert: `${attr}=""`,
      cursor: attr.length + 2,
      continueAfter: hasValueCompletion(tag, attr),
      boost: rankBoost(i),
    })),
  };
}

function hasValueCompletion(tag: string | undefined, attr: string): boolean {
  return (
    attr === 'keyref' || attr === 'conkeyref' || attr in FILE_ATTRS ||
    (tag !== undefined && `${tag}:${attr}` in ENUM_VALUES) || attr in ENUM_VALUES
  );
}

// ── attribute values ──

async function completeAttrValue(
  text: string,
  offset: number,
  tag: string | undefined,
  attr: string,
  prefix: string,
  env: CompletionEnv,
): Promise<CompletionResult | undefined> {
  const from = offset - prefix.length;

  if (attr === 'keyref' || attr === 'conkeyref') {
    // conkeyref="key/elementid": only the key is completed here.
    if (prefix.includes('/')) return undefined;
    const suggestions: Suggestion[] = [];
    for (const [key, value] of env.keys()) {
      suggestions.push({ label: key, kind: 'key', detail: value !== key ? value : undefined, insert: key, boost: 0 });
    }
    return suggestions.length > 0 ? { from, suggestions } : undefined;
  }

  if (attr in FILE_ATTRS) return completeReference(text, offset, tag, prefix, env);

  const values = (tag !== undefined ? ENUM_VALUES[`${tag}:${attr}`] : undefined) ?? ENUM_VALUES[attr];
  if (values) {
    return { from, suggestions: values.map((v, i) => ({ label: v, kind: 'value', insert: v, boost: rankBoost(i) })) };
  }
  return undefined;
}

async function completeReference(
  text: string,
  offset: number,
  tag: string | undefined,
  prefix: string,
  env: CompletionEnv,
): Promise<CompletionResult | undefined> {
  const valueStart = offset - prefix.length;
  const hash = prefix.indexOf('#');

  // After '#': ids in the target file ("#topicid/elementid" replaces from the last '/').
  if (hash >= 0) {
    const filePart = prefix.slice(0, hash);
    const ids = filePart ? env.idsIn(filePart) : collectIds(text);
    if (!ids || ids.length === 0) return undefined;
    const fragment = prefix.slice(hash + 1);
    const from = valueStart + hash + 1 + fragment.lastIndexOf('/') + 1;
    return { from, suggestions: ids.map((id) => ({ label: id, kind: 'id', insert: id, boost: 0 })) };
  }

  const kind = tag !== undefined && IMAGE_HREF_TAGS.has(tag) ? 'image' : 'topic';
  const files = await env.files(kind);
  if (files.length === 0) return undefined;
  return { from: valueStart, suggestions: files.map((f) => ({ label: f, kind: 'file', insert: f, boost: 0 })) };
}
