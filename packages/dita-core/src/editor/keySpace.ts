// ── key definitions of one ditamap (vscode-free, unit-testable) ──
//
// Split out of keyMap.ts, which imports vscode and so cannot be loaded by
// the mocha suite. buildKeyMap (keyMap.ts) and any other consumer of "the
// keys a map defines" go through collectMapKeys so there is one rule for
// what a keydef contributes.

import { dirname } from 'path';
import { DitaNode } from '../parser/domTypes';
import { parseDitamap, preprocessEntities } from '../parser/ditaParser';
import { expandDitamapRefs, FileReader } from './refResolvers';
import { sourceStamp } from './sourceText';

function extractTextFromNode(node: DitaNode): string {
  if (node.type === 'text') return node.text || '';
  return (node.children || []).map(extractTextFromNode).join('');
}

function getNodeValue(node: DitaNode, childBaseTypes: string[]): string | undefined {
  for (const bt of childBaseTypes) {
    const child = (node.children || []).find(
      (c) => c.type === 'element' && c.baseType === bt,
    );
    if (child) {
      const text = extractTextFromNode(child).trim();
      if (text) return text;
    }
    // DITA wraps <keyword> inside <keywords>; also search inside known wrappers
    const wrapper = (node.children || []).find(
      (c) => c.type === 'element' && (c.baseType === 'map/keywords'),
    );
    if (wrapper) {
      const inner = (wrapper.children || []).find(
        (c) => c.type === 'element' && c.baseType === bt,
      );
      if (inner) {
        const text = extractTextFromNode(inner).trim();
        if (text) return text;
      }
    }
  }
  return undefined;
}

function getKeyValueFromRef(node: DitaNode): string | undefined {
  // Priority: keyword > linktext > navtitle > shortdesc > indexterm
  const topicmeta = (node.children || []).find(
    (c) => c.type === 'element' && (c.baseType === 'map/topicmeta'),
  );
  if (!topicmeta) return undefined; // No topicmeta, no value
  return getNodeValue(topicmeta, [
    'map/keyword',
    'map/linktext',
    'map/navtitle',
    'map/shortdesc',
  ]);
}

/** The individual key names in a `keys` attribute (whitespace-separated). */
export function splitKeyNames(keys: string): string[] {
  return keys.split(/\s+/).filter(Boolean);
}

/** All names a key defined under the given scope chain answers to: bare plus each qualified form. */
export function qualifiedNames(name: string, scopeChain: string[]): string[] {
  const out = [name];
  for (let i = 0; i < scopeChain.length; i++) {
    out.push(scopeChain.slice(i).join('.') + '.' + name);
  }
  return out;
}

/** Like qualifiedNames, for a definition that lives in several scope chains at once. */
export function qualifiedNamesMulti(name: string, scopeChains: string[][]): string[] {
  const out = new Set<string>([name]);
  for (const chain of scopeChains) for (const q of qualifiedNames(name, chain)) out.add(q);
  return [...out];
}

/**
 * A key's resource target, captured alongside its text value so conkeyref can
 * resolve `keyname/elementid` to a file. `href` is relative to `baseDir` (the
 * directory of the map that first defined the key, after referenced-submap
 * hrefs are rebased by expandDitamapRefs). A key that defines a text value but
 * no resource is still recorded, with `href` undefined -- conkeyref against
 * such a key falls back to `conref`, distinct from a key that is not defined at
 * all. First definition wins, mirroring the value map's precedence.
 */
export interface KeyHrefDef {
  href?: string;
  baseDir: string;
}

/**
 * Parses one ditamap, expands the ditamaps it references, and adds every
 * key it defines to `into` (first definition wins, in document order).
 * When `hrefs` is supplied, each newly defined key also records its resource
 * target there (same first-definition-wins gate as the value), keyed by the
 * individual name. Throws if the map itself cannot be read or parsed; the
 * caller decides whether that is fatal.
 */
export function collectMapKeys(
  mapPath: string,
  into: Map<string, string>,
  read: FileReader,
  hrefs?: Map<string, KeyHrefDef>,
): void {
  const content = read(mapPath, 'utf-8');
  const doc = parseDitamap(preprocessEntities(content));
  const mapRoot = doc.root;
  const mapDir = dirname(mapPath);
  // Expand referenced ditamaps so keydefs from included maps are visible
  expandDitamapRefs(mapRoot, mapDir, read);
  // scopeChains: the keyscope names enclosing `node`, outermost first; several
  // chains when a keyscope lists several names. A key answers to its bare name
  // and to every qualified form (`a.k`, `x.a.k`), so a keyref written either
  // way finds it. The bare name is still defined unscoped -- the lookup does
  // not know where the referencing element sits, so it cannot tell which
  // scope's `k` is meant; the qualified names are what tell scopes apart.
  function walk(node: DitaNode, scopeChains: string[][]) {
    if (node.type !== 'element') return;
    const baseType = node.baseType;
    let chains = scopeChains;
    const keyscope = node.attributes?.keyscope;
    if (keyscope) {
      const scopes = splitKeyNames(keyscope);
      if (scopes.length) chains = chains.flatMap((chain) => scopes.map((s) => chain.concat(s)));
    }
    if ((baseType === 'map/topicref' || baseType === 'map/keydef') && node.attributes?.keys) {
      const value = getKeyValueFromRef(node);
      // keys is a space-separated list: one keydef defines every name in it
      // with the same resource. First definition of each name wins (DITA
      // precedence; nearest map scanned first).
      for (const keyName of splitKeyNames(node.attributes.keys)) {
        for (const name of qualifiedNamesMulti(keyName, chains)) {
          if (!into.has(name)) {
            into.set(name, value || keyName);
            hrefs?.set(name, { href: node.attributes?.href, baseDir: mapDir });
          }
        }
      }
    }
    for (const child of node.children || []) walk(child, chains);
  }
  for (const child of mapRoot.children || []) walk(child, [[]]);
}

// ── key space: context map vs. ancestor scan ──

export type KeyContextStatus = 'none' | 'active' | 'missing';

export interface KeySpace {
  keys: Map<string, string>;
  /** Each key's resource target (href + defining map dir), for conkeyref. */
  defs: Map<string, KeyHrefDef>;
  /** Every file the key values were derived from (for cache stamping). */
  files: string[];
  /** 'none': no context set. 'active': keys come from the context map alone.
   *  'missing': a context is set but its file no longer exists, so the
   *  ancestor scan was used instead. */
  status: KeyContextStatus;
}

/** A context counts only while its file (or an unsaved copy of it) exists. */
export function isKeyContextAvailable(contextMap: string | undefined): contextMap is string {
  return contextMap !== undefined && sourceStamp(contextMap) !== '?';
}

/**
 * The ditamaps the key definitions come from: the context map alone when one
 * is set and available, otherwise the ancestor maps. The single answer to
 * "where do keys come from" -- the key map behind previews and diagnostics
 * (buildKeySpace) and go-to-definition on a keyref must both ask this, or a
 * preview can show one brand's value while F12 jumps to another's.
 * `ancestorMaps` is a function so the directory walk is skipped when the
 * context answers.
 */
export function keySourceMaps(contextMap: string | undefined, ancestorMaps: () => string[]): string[] {
  return isKeyContextAvailable(contextMap) ? [contextMap] : ancestorMaps();
}

/**
 * The key space every keyref in the workspace resolves against.
 *
 * With a context map (Oxygen's DITA Maps Manager "context"), the keys are
 * those of that one map, expanded through its map references, and nothing
 * else: the ancestor maps are NOT consulted, so choosing one brand's keydef
 * map cannot pick up another brand's definition of the same key. Without a
 * context it is the ancestor scan buildKeyMap always did.
 *
 * A context whose file no longer exists falls back to the ancestor scan and
 * says so ('missing') -- the caller decides how to tell the user. A context
 * that exists but cannot be parsed is reported through onError and yields an
 * empty key space rather than quietly resolving against other maps.
 */
export function buildKeySpace(
  contextMap: string | undefined,
  ancestorMaps: string[],
  read: FileReader,
  onError: (mapPath: string, error: unknown) => void = () => undefined,
): KeySpace {
  const files: string[] = [];
  const recordingRead: FileReader = (path, encoding) => {
    files.push(path);
    return read(path, encoding);
  };

  const sources = keySourceMaps(contextMap, () => ancestorMaps);
  let status: KeyContextStatus = 'none';
  if (contextMap !== undefined) {
    // Listed even when missing, so the file reappearing changes the stamp.
    files.push(contextMap);
    status = isKeyContextAvailable(contextMap) ? 'active' : 'missing';
  }

  const keys = new Map<string, string>();
  const defs = new Map<string, KeyHrefDef>();
  for (const mf of sources) {
    try {
      collectMapKeys(mf, keys, recordingRead, defs);
    } catch (e) {
      onError(mf, e);
    }
  }
  // Pair the href definitions with the values map they were built from, so a
  // consumer handed only the values map (the render paths thread `keyMap`
  // everywhere but not `defs`) can still find the conkeyref targets for that
  // exact instance. Registered here rather than in keyMap.ts so every producer
  // of a KeySpace -- including the direct buildKeySpace callers the conkeyref
  // tests drive -- gets it, and so renderContext.ts can read it without
  // importing the vscode-dependent keyMap.ts.
  registerKeyDefs(keys, defs);
  return { keys, defs, files: [...new Set(files)], status };
}

// ── values map -> href defs, by instance identity ──
//
// The keys a map defines (values) and their resource targets (defs) are always
// produced together by one buildKeySpace call, and buildKeyMap hands back the
// SAME values-map instance for as long as its cache entry is valid -- the exact
// identity property renderTopicCached already leans on for cache keying. So a
// WeakMap from the values map to its defs travels with it: any render path that
// has the keyMap has its conkeyref defs, with no new field to thread through the
// many interfaces keyMap already passes through (and no path able to forget to).
const defsByKeyMap = new WeakMap<Map<string, string>, ReadonlyMap<string, KeyHrefDef>>();

export function registerKeyDefs(keys: Map<string, string>, defs: ReadonlyMap<string, KeyHrefDef>): void {
  defsByKeyMap.set(keys, defs);
}

/** The href defs paired with a given values map, or undefined if it was not
 *  produced by buildKeySpace (e.g. a hand-built map in a test). */
export function getKeyDefs(keys: Map<string, string>): ReadonlyMap<string, KeyHrefDef> | undefined {
  return defsByKeyMap.get(keys);
}
