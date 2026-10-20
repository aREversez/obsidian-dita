/**
 * CJK / Latin spacing around resolved keyref text.
 *
 * Pure functions with no vscode dependency, so preview and HTML export share
 * one rule. The rule looks at the two characters that touch across a key
 * boundary: a CJK ideograph on one side and a Latin letter/digit on the other,
 * with nothing between them, needs one space. Anything else (punctuation,
 * existing whitespace, same-script neighbours) is left exactly as authored.
 */

import type { DitaNode } from '../parser/domTypes';

/** Ancestors whose content is literal (code, paths, names) -- never touched. */
const NO_SPACING_BASE_TYPES = new Set([
  'topic/codeblock',
  'topic/codeph',
  'topic/filepath',
  'topic/varname',
  'topic/cmdname',
  'topic/msgph',
  'topic/systemoutput',
  'topic/userinput',
  'topic/apiname',
  'topic/parmname',
  'topic/option',
]);

/** Per-element escape hatch: <ph keyref="x" outputclass="no-cjk-spacing"/> */
export const NO_SPACING_CLASS = 'no-cjk-spacing';

export function isCjk(ch: string | undefined): boolean {
  return !!ch && /[\u4E00-\u9FFF]/.test(ch);
}

export function isLatinAlnum(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9]/.test(ch);
}

/** True when a space must be inserted between two touching characters. */
export function needsSpace(prev: string | undefined, next: string | undefined): boolean {
  return (isCjk(prev) && isLatinAlnum(next)) || (isLatinAlnum(prev) && isCjk(next));
}

export function isSpacingSuppressed(parentBaseType: string | undefined, node: DitaNode): boolean {
  if (parentBaseType && NO_SPACING_BASE_TYPES.has(parentBaseType)) return true;
  if (node.baseType && NO_SPACING_BASE_TYPES.has(node.baseType)) return true;
  return (node.attributes?.outputclass || '').split(/\s+/).includes(NO_SPACING_CLASS);
}

/** Text a node contributes, substituting key values for empty keyref elements. */
export function nodeText(node: DitaNode, resolveKey?: (key: string) => string | undefined): string {
  if (node.type === 'text') return node.text || '';
  const own = (node.children || []).map((c) => nodeText(c, resolveKey)).join('');
  if (own === '' && resolveKey && node.attributes?.keyref) {
    return resolveKey(node.attributes.keyref) || '';
  }
  return own;
}

export function isEmptyKeyref(node: DitaNode): boolean {
  if (node.type !== 'element' || !node.attributes?.keyref) return false;
  return !(node.children || []).some((c) => c.type === 'element' || (c.text || '') !== '');
}

/**
 * For each child, decide whether a space is needed before and/or after it.
 * Only empty keyref elements that actually resolve are candidates. Neighbour
 * characters are found by scanning outward past siblings that contribute no
 * text (images, index terms), so `汉字<indexterm/><ph keyref/>` still works.
 */
export function computeKeyrefSpacing(
  children: DitaNode[],
  parentBaseType: string | undefined,
  resolveKey?: (key: string) => string | undefined,
): { before: boolean; after: boolean }[] {
  const texts = children.map((c) => nodeText(c, resolveKey));
  const result = children.map(() => ({ before: false, after: false }));
  if (!resolveKey) return result;

  children.forEach((child, i) => {
    if (!isEmptyKeyref(child) || isSpacingSuppressed(parentBaseType, child)) return;
    const own = texts[i];
    if (!own) return;

    let prev: string | undefined;
    for (let j = i - 1; j >= 0 && prev === undefined; j--) {
      if (texts[j]) prev = texts[j][texts[j].length - 1];
    }
    let next: string | undefined;
    for (let j = i + 1; j < children.length && next === undefined; j++) {
      if (texts[j]) next = texts[j][0];
    }
    result[i].before = needsSpace(prev, own[0]);
    result[i].after = needsSpace(own[own.length - 1], next);
  });

  // Two adjacent keys can both claim the same gap; keep only the left one's "after".
  for (let i = 1; i < result.length; i++) {
    if (result[i].before && result[i - 1].after) result[i].before = false;
  }
  return result;
}
