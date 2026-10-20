// conkeyref resolution (P3) -- the DITA "content reference by key".
//
// A conkeyref value ("keyname", "keyname/elementid" or
// "keyname/topicid/elementid") is an indirect content reference: the leading
// segment is a key, resolved through the map key space to the target topic's
// href, and the remaining segments address an element inside that topic. It is
// the key-based analogue of a direct conref -- once the target element is
// found, the renderer substitutes it exactly as it would a conref target
// (same-type merge, cross-type replacement, cycle guard).
//
// This module is pure: no vscode, no filesystem, no parser. It takes the key
// space's href definitions plus an injected `loadTopic` (the caller owns file
// IO, caching and parsing) and returns the resolved target element or
// undefined. Returning undefined is how the caller learns to fall back: per the
// DITA 1.3 spec (and DITA-OT's DOTJ046E behaviour), when a conkeyref cannot be
// resolved -- key not defined, key with no href, target file missing, addressed
// id not present -- an element that also carries a direct @conref uses that
// instead, and when there is no conref the element renders its own literal
// content.
//
// Key-space precedence is inherited unchanged from the definitions it is given
// (first definition wins; a context map fully replaces the ancestor scan) --
// this function only reads the map it is handed, so switching the key context
// switches conkeyref targets for free.

import { DitaNode } from '../parser/domTypes';
import { KeyHrefDef } from './keySpace';

/**
 * Addressing inside the key's target topic: the whole topic when the value has
 * only the key name, otherwise the last path segment (the element id, for both
 * the "key/elemid" and the "key/topicid/elemid" forms -- the intermediate topic
 * id is redundant for a by-id lookup).
 */
function parseConkeyref(conkeyref: string): { keyName: string; elementId?: string } {
  const segments = conkeyref.split('/').filter((s) => s !== '');
  const keyName = segments[0];
  const elementId = segments.length > 1 ? segments[segments.length - 1] : undefined;
  return { keyName, elementId };
}

/**
 * The element id a key's own href addresses: the last path segment of its
 * fragment ("file.dita#topicid/elemid" -> "elemid"; "file.dita#topicid" ->
 * "topicid"), or undefined when the href has no fragment. This is what a bare
 * conkeyref="keyname" points at when the key was defined against an element.
 */
function hrefFragmentTarget(href: string): string | undefined {
  const hash = href.indexOf('#');
  if (hash < 0) return undefined;
  const segments = href.slice(hash + 1).split('/').filter((s) => s !== '');
  if (segments.length === 0) return undefined;
  const last = segments[segments.length - 1];
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function findElementById(root: DitaNode, targetId: string): DitaNode | undefined {
  if (root.attributes?.id === targetId) return root;
  for (const child of root.children || []) {
    const found = findElementById(child, targetId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Resolve a conkeyref to its target element.
 *
 * Cycle protection is deliberately NOT done here. A conkeyref that resolves
 * back into an already-rendered chain (A -> B -> A) is caught one level up, by
 * the renderer: resolveConrefForNode only calls this when the value is not
 * already on its conrefChain, mirroring direct-conref cycle protection. Keeping
 * the guard out of this pure function means one owner for the rule and no dead
 * parameter at the call sites (buildRenderContext never threads a chain in).
 *
 * @param conkeyref the raw @conkeyref value.
 * @param defs      the key space's href definitions (from KeySpace.defs).
 * @param loadTopic loads and parses the topic at `href` (relative to
 *                  `baseDir`), returning its root, or undefined when the file
 *                  is missing or unparseable.
 */
export function resolveConkeyref(
  conkeyref: string,
  defs: ReadonlyMap<string, KeyHrefDef>,
  loadTopic: (baseDir: string, href: string) => DitaNode | undefined,
): DitaNode | undefined {
  if (!conkeyref) return undefined;

  const { keyName, elementId } = parseConkeyref(conkeyref);
  if (!keyName) return undefined;
  const def = defs.get(keyName);
  // Key not defined, or defined without a resource target: nothing to pull.
  if (!def || !def.href) return undefined;

  const root = loadTopic(def.baseDir, def.href);
  if (!root) return undefined;

  // An id in the conkeyref itself wins; otherwise the key's own href may name
  // the element ("file.dita#topicid/elemid"); with neither, the reference
  // targets the key's whole topic.
  const targetId = elementId ?? hrefFragmentTarget(def.href);
  if (!targetId) return root;
  return findElementById(root, targetId);
}
