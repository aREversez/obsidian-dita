// Where a link in a DITA page points, as a path in the vault.
//
// A link is relative to the document it is in (or, inside a book or site, to
// the topic it came from, whose absolute path is then given), and may carry a
// "#fragment" naming an element. Free of Obsidian imports so it is unit-tested.

import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { decodeHrefPart } from '@dita-viewer/core';

export interface LinkTarget {
  /** Vault-relative, with forward slashes. */
  path: string;
  /** What follows the "#", not decoded; empty when there is none. */
  fragment: string;
}

/**
 * The vault path an href resolves to, or undefined when it names no file
 * (empty, or only a "#fragment" on the same page) or one outside the vault.
 * `fromPath` is the vault-relative path of the document the link is in;
 * `baseAbsPath` replaces it as the base when given.
 */
export function resolveLinkTarget(vaultRoot: string, fromPath: string, href: string, baseAbsPath?: string): LinkTarget | undefined {
  const hash = href.indexOf('#');
  const file = hash < 0 ? href : href.slice(0, hash);
  if (!file) return undefined;
  const baseDir = baseAbsPath ? dirname(baseAbsPath) : resolve(vaultRoot, dirname(fromPath));
  const rel = relative(vaultRoot, resolve(baseDir, decodeHrefPart(file)));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return { path: rel.split(sep).join('/'), fragment: hash < 0 ? '' : href.slice(hash + 1) };
}

/** Is this href a link to somewhere else on the web or a mail address? */
export function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}
