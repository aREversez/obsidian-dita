// Authoring problems in one DITA source file, for a host's editor.
//
// Project-owned, not one of the verbatim VS Code files: the viewer's own
// diagnostics are built on `vscode.Diagnostic`, and this is the part a host
// without that type needs. Positions are 0-based line/column pairs with an
// exclusive end, the same convention as the parser's SourceRange.
//
// Two passes. The source must first be well-formed XML; a broken document gets
// that one error and nothing else, because every element position after the
// error would be a guess. Only then is the tree walked for the mistakes that
// read fine as XML: references to nothing and ids used twice.

import { existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import sax from 'sax';
import { DitaNode } from './parser/domTypes';
import { parseDita, parseDitamap } from './parser/ditaParser';
import { decodeHrefPart } from './editor/refResolvers';
import { splitRefFragment } from './language/ditaLanguageUtils';

export type DiagnosticSeverity = 'error' | 'warning';

export interface DitaDiagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** 0-based; `endLine`/`endCol` are exclusive. */
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface DiagnosticsInput {
  /** The source as it is in the editor, unsaved edits included. */
  xml: string;
  /** Absolute path of the document; relative hrefs resolve against its folder. */
  absPath: string;
  /** Keys the ditamaps near the document define; see buildKeyMapForDocument. */
  keys?: ReadonlyMap<string, string>;
  /**
   * Existence test for an absolute path. Defaults to fs.existsSync; a host
   * that can only reach files inside its own workspace passes its own.
   */
  fileExists?: (absPath: string) => boolean;
  /**
   * The ids another DITA file defines, for `topic.dita#id`. The host reads
   * and caches them (it knows which files it may read); omitted means
   * cross-file anchors are not checked.
   */
  idsIn?: (absPath: string) => readonly string[] | undefined;
  /** True for a .ditamap. Defaults to the file extension. */
  isMap?: boolean;
  /**
   * The ditamaps the key space came from. The check never reads them itself
   * (it only looks key names up in `keys`), but a host that watches files
   * needs them too: a key defined or removed in a map changes the answer for
   * every keyref in this document.
   */
  keyFiles?: readonly string[];
  /**
   * Absolute paths whose content this result was derived from: every
   * reference target (existing or missing, so creating it counts as a
   * change) and every key map. A host re-runs the check when one of them
   * changes on disk, rather than showing a stale warning until the file is
   * reopened.
   */
  collectDependencies?: Set<string>;
}

/** A file whose #id anchors can be checked with idsIn. */
const DITA_FILE = /\.(dita|ditamap|xml)$/i;

/** `http:`, `mailto:`, `C:` — a reference the vault cannot resolve by path. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Attributes that point at a file or an element. */
const FILE_ATTRIBUTES = ['href', 'conref', 'conrefend'] as const;
/** Attributes that point at a key. conkeyref adds an element id after a '/'. */
const KEY_ATTRIBUTES = ['keyref', 'conkeyref'] as const;

// ── line/column helpers ──

/** Offsets of every line start, so a source position and an offset convert both ways. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function offsetOf(starts: number[], text: string, line: number, col: number): number {
  const start = starts[Math.min(Math.max(0, line), starts.length - 1)];
  return Math.min(text.length, start + Math.max(0, col));
}

function positionOf(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo] };
}

/**
 * Index just past the '>' that closes the tag opening at `start`, skipping
 * quoted attribute values (a conref can contain '>'), or `start + 1` when the
 * tag is unterminated.
 */
function openingTagEnd(text: string, start: number): number {
  let quote: string | undefined;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
  }
  return start + 1;
}

/**
 * The range to underline for an element: its opening tag. The parser records
 * the whole element (open through close), which for a container would paint
 * half the screen for one bad attribute.
 */
function openingTagRange(text: string, starts: number[], node: DitaNode): Omit<DitaDiagnostic, 'severity' | 'message'> {
  const start = offsetOf(starts, text, node.sourceRange.startLine, node.sourceRange.startCol);
  const end = openingTagEnd(text, start);
  const endPos = positionOf(starts, end);
  return {
    startLine: node.sourceRange.startLine,
    startCol: node.sourceRange.startCol,
    endLine: endPos.line,
    endCol: endPos.col,
  };
}

// ── well-formedness ──

/**
 * Replaces the DOCTYPE declaration with spaces instead of deleting it, so the
 * line and column SAX reports still match the editor. A DITA DOCTYPE is often
 * two lines long; deleting it (as preprocessEntities does) would shift every
 * position after it up by one.
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
  const blanked = xml.slice(start, i).replace(/[^\n]/g, ' ');
  return xml.slice(0, start) + blanked + xml.slice(i);
}

/** CDATA and comments are skipped; what is left is a named entity reference. */
const CDATA_COMMENT_OR_ENTITY = /(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)|&([A-Za-z_][\w.-]*);/g;
const XML_BUILTIN = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/**
 * Makes a DITA source parseable without changing where anything is.
 *
 * DITA sources use `&nbsp;` and friends with no DTD loaded to declare them, so
 * a strict XML parser would stop at the first one. preprocessEntities (the
 * renderer's answer) swaps each for its character, which is right for
 * rendering but moves every later column on that line: an underline placed by
 * the parser's position would land on the wrong tag. Here each named
 * reference becomes the same number of spaces instead, so line and column
 * still match the editor. The result is only ever parsed, never shown.
 */
function parseableSource(xml: string): string {
  return blankDoctype(xml).replace(CDATA_COMMENT_OR_ENTITY, (full: string, verbatim: string | undefined, name: string) =>
    verbatim !== undefined || XML_BUILTIN.has(name) ? full : ' '.repeat(full.length),
  );
}

/**
 * The first XML error, with the tag it belongs to underlined where one can be
 * found.
 */
function checkWellFormed(xml: string): DitaDiagnostic | undefined {
  const source = parseableSource(xml);
  const parser = sax.parser(true, { trim: false, normalize: false });
  let failure: { line: number; column: number; message: string } | undefined;
  parser.onerror = (err) => {
    failure = { line: parser.line, column: parser.column, message: err.message };
    // Abort: SAX would otherwise keep parsing whatever follows the error.
    throw err;
  };
  try {
    parser.write(source).close();
  } catch {
    // onerror recorded it; the throw above is only the abort mechanism.
  }
  if (!failure) return undefined;

  const message = failure.message.split('\n')[0].trim() || failure.message;
  const starts = lineStarts(xml);
  const at = offsetOf(starts, xml, failure.line, Math.max(0, failure.column - 1));
  // The error points just past the offending character (often a tag's '>').
  // Widening to the enclosing tag underlines `</para>` rather than one char
  // after it; at end of file there is no tag, so the position stays as is.
  const tagStart = Math.max(xml.lastIndexOf('<', at), xml.lastIndexOf('<', at - 1));
  const tagEnd = tagStart >= 0 ? openingTagEnd(xml, tagStart) : -1;
  const insideTag = tagStart >= 0 && at < tagEnd;
  // A tag whose '>' is missing swallows the next one, and the parser only
  // notices at that next tag. Blame the tag that was left open.
  const previous = insideTag ? xml.lastIndexOf('<', tagStart - 1) : -1;
  if (previous >= 0 && /[A-Za-z_:]/.test(xml[previous + 1] ?? '') && openingTagEnd(xml, previous) > tagStart) {
    const name = /^<([^\s/>]+)/.exec(xml.slice(previous))?.[1] ?? '';
    const end = previous + xml.slice(previous, tagStart).trimEnd().length;
    const a = positionOf(starts, previous);
    const b = positionOf(starts, end);
    return {
      severity: 'error',
      message: `The <${name}> tag is missing its closing ">"`,
      startLine: a.line,
      startCol: a.col,
      endLine: b.line,
      endCol: b.col,
    };
  }
  const from = insideTag ? positionOf(starts, tagStart) : positionOf(starts, at);
  const to = insideTag ? positionOf(starts, tagEnd) : positionOf(starts, Math.min(xml.length, at + 1));
  return {
    severity: 'error',
    message,
    startLine: from.line,
    startCol: from.col,
    endLine: to.line,
    endCol: to.col,
  };
}

// ── document walk ──

function elementChildren(node: DitaNode): DitaNode[] {
  return (node.children ?? []).filter((c) => c.type === 'element');
}

function walk(root: DitaNode, visit: (node: DitaNode) => void): void {
  visit(root);
  for (const child of elementChildren(root)) walk(child, visit);
}

/** Every id in the document, mapped to the 0-based line it is first used on. */
function idsWithLines(root: DitaNode): Map<string, number> {
  const ids = new Map<string, number>();
  walk(root, (node) => {
    const id = node.attributes?.id;
    if (id && !ids.has(id)) ids.set(id, node.sourceRange.startLine);
  });
  return ids;
}

/**
 * The first id a `#fragment` names that `has` does not know. A fragment is
 * `topicid` or `topicid/elementid` (DITA's two-part form), so both halves must
 * exist; a single id may be a topic's or an element's.
 */
export function missingFragmentId(fragment: string, has: (id: string) => boolean): string | undefined {
  const { topicId, elementId } = splitRefFragment(fragment);
  const wanted = topicId ? [topicId, elementId] : [elementId];
  return wanted.filter((id) => id !== '').find((id) => !has(id));
}

/**
 * The key a keyref/conkeyref names: everything before the first '/' (the rest,
 * if any, is an element id inside the target topic).
 */
function keyNameOf(value: string): string {
  const slash = value.indexOf('/');
  return (slash < 0 ? value : value.slice(0, slash)).trim();
}

interface CheckState {
  text: string;
  starts: number[];
  docDir: string;
  keys: ReadonlyMap<string, string>;
  fileExists: (absPath: string) => boolean;
  idsIn?: (absPath: string) => readonly string[] | undefined;
  /** Receives every external file the check looked at; see DiagnosticsInput. */
  deps?: Set<string>;
  /** Ids in this document; #fragments resolve against these. */
  ownIds: Map<string, number>;
  out: DitaDiagnostic[];
}

function report(state: CheckState, node: DitaNode, message: string): void {
  state.out.push({ severity: 'warning', message, ...openingTagRange(state.text, state.starts, node) });
}

/**
 * True when the href names a file this vault can open: no scheme, no absolute
 * path, and not marked external or peer (a peer is in another deliverable, so
 * it need not exist next to this file).
 */
function isLocalRef(node: DitaNode, value: string): boolean {
  const scope = node.attributes?.scope;
  if (scope === 'external' || scope === 'peer') return false;
  if (URL_SCHEME.test(value) || isAbsolute(value)) return false;
  return true;
}

function checkFileRef(state: CheckState, node: DitaNode, attribute: string): void {
  const raw = (node.attributes?.[attribute] ?? '').trim();
  if (!raw || raw === '#') return;

  const hash = raw.indexOf('#');
  const pathPart = (hash < 0 ? raw : raw.slice(0, hash)).split('?')[0];
  const fragment = hash < 0 ? '' : raw.slice(hash + 1);
  if (!pathPart) {
    // "#id": a target in this file. An id the document does not define is a
    // broken link even though the file it "points at" trivially exists.
    const missing = fragment ? missingFragmentId(decodeHrefPart(fragment), (id) => state.ownIds.has(id)) : undefined;
    if (missing !== undefined) report(state, node, `No element with id "${missing}" in this file`);
    return;
  }
  if (!isLocalRef(node, raw)) return;

  const target = resolve(state.docDir, decodeHrefPart(pathPart));
  // Watched even when it does not exist: creating the file is exactly the
  // fix for "File not found", and must clear the warning without reopening.
  state.deps?.add(target);
  if (!state.fileExists(target)) {
    report(state, node, `File not found: ${pathPart}`);
    return;
  }
  if (!fragment || !state.idsIn || !DITA_FILE.test(target)) return;
  const ids = state.idsIn(target);
  const missing = ids ? missingFragmentId(decodeHrefPart(fragment), (id) => ids.includes(id)) : undefined;
  if (missing !== undefined) report(state, node, `No element with id "${missing}" in ${pathPart}`);
}

function checkKeyRef(state: CheckState, node: DitaNode, attribute: string): void {
  const raw = (node.attributes?.[attribute] ?? '').trim();
  if (!raw) return;
  const name = keyNameOf(raw);
  // No key space at all means no map was found near the document, not that
  // every key is missing: a topic opened on its own would otherwise warn on
  // each keyref it has.
  if (state.keys.size === 0) return;
  if (name && !state.keys.has(name)) {
    report(state, node, `Key "${name}" is not defined by the maps near this document`);
  }
}

/**
 * Duplicate ids, within each topic. DITA only requires an id to be unique in
 * its own topic, so the same id in a nested topic is legal; a topic's own id
 * belongs to the scope it sits in. A map has no topics and is one scope.
 */
function checkDuplicateIds(state: CheckState, root: DitaNode): void {
  const visit = (node: DitaNode, scope: Map<string, number>): void => {
    const id = node.attributes?.id;
    if (id) {
      const first = scope.get(id);
      // The first use is the definition; every later one is the mistake.
      // Tracked per id rather than by position so two tags on one line clash.
      if (first === undefined) scope.set(id, node.sourceRange.startLine);
      else report(state, node, `Duplicate id "${id}"; first used on line ${first + 1}`);
    }
    const inner = node.baseType === 'topic/topic' ? new Map<string, number>() : scope;
    for (const child of elementChildren(node)) visit(child, inner);
  };
  visit(root, new Map());
}

/**
 * What is wrong with this source, sorted by position. An empty array means the
 * document is well formed and every reference it makes can be resolved.
 */
export function collectDiagnostics(input: DiagnosticsInput): DitaDiagnostic[] {
  const { xml, absPath, keys, keyFiles, fileExists = existsSync, idsIn, collectDependencies } = input;
  // Key maps are dependencies whatever the document turns out to contain: a
  // keyref that resolves today can stop resolving when the map changes, and
  // no other file is read to find that out.
  if (collectDependencies) for (const map of keyFiles ?? []) collectDependencies.add(map);
  const wellFormed = checkWellFormed(xml);
  if (wellFormed) return [wellFormed];

  const isMap = input.isMap ?? /\.ditamap$/i.test(absPath);
  let root: DitaNode;
  try {
    root = (isMap ? parseDitamap : parseDita)(parseableSource(xml)).root;
  } catch (e) {
    // Well-formed, but not something the renderer can walk (an empty root,
    // say). Report it at the top rather than pretending the file is clean.
    return [{
      severity: 'error',
      message: e instanceof Error ? e.message : String(e),
      startLine: 0,
      startCol: 0,
      endLine: 0,
      endCol: 0,
    }];
  }

  const state: CheckState = {
    text: xml,
    starts: lineStarts(xml),
    docDir: dirname(absPath),
    keys: keys ?? new Map(),
    fileExists,
    idsIn,
    deps: collectDependencies,
    ownIds: idsWithLines(root),
    out: [],
  };

  checkDuplicateIds(state, root);
  walk(root, (node) => {
    for (const attribute of KEY_ATTRIBUTES) checkKeyRef(state, node, attribute);
    // keyref wins over href when both are present (DITA's indirect-first
    // rule), so a co-located href is a fallback and not worth a warning.
    if (node.attributes?.keyref) return;
    for (const attribute of FILE_ATTRIBUTES) checkFileRef(state, node, attribute);
  });

  return state.out.sort((a, b) => a.startLine - b.startLine || a.startCol - b.startCol);
}
