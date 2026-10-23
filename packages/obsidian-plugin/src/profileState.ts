// What a pane remembers about conditional processing, and how it reads a
// .ditaval from disk.
//
// No Obsidian imports, so it is unit-tested in plain mocha. A .ditaval is not
// a file type Obsidian knows, so the vault index may not list it; the files
// are found by walking the vault folder instead, and read with Node's fs like
// every other file the plugin reads.

import { readFileSync, readdirSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { parseDitaval } from '@dita-viewer/core';
import type { Ditaval, ProfileFilter } from '@dita-viewer/core';

export interface ProfileState {
  /** Vault-relative path of the .ditaval in force, forward slashes. */
  ditaval?: string;
  /** `attribute:value` pairs the reader turned off by hand. */
  hidden: string[];
  /** Whether profiled content is drawn with its tinted box and label. */
  highlight: boolean;
}

export const DEFAULT_PROFILE_STATE: Readonly<ProfileState> = { hidden: [], highlight: true };

/** More than this many hand-picked values is not a real selection; ignore the rest. */
const MAX_HIDDEN = 500;

export function isDitavalPath(path: string): boolean {
  return /\.ditaval$/i.test(path);
}

/**
 * A path that stays inside the vault and names a .ditaval. The check does not
 * lean on the host's path rules: a pane state can be synced from another
 * system, where `C:\x` is as absolute as `/x`.
 */
export function isValidDitavalPath(path: unknown): path is string {
  if (typeof path !== 'string' || !isDitavalPath(path)) return false;
  if (isAbsolute(path) || /^([a-zA-Z]:|[\\/])/.test(path)) return false;
  return !path.split(/[\\/]/).some((part) => part === '..');
}

/** Turn whatever a saved pane state held into a valid ProfileState, field by field. */
export function normalizeProfileState(raw: unknown): ProfileState {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const hidden: string[] = [];
  if (Array.isArray(r.hidden)) {
    const seen = new Set<string>();
    for (const item of r.hidden) {
      if (typeof item !== 'string' || item.indexOf(':') <= 0 || seen.has(item)) continue;
      seen.add(item);
      hidden.push(item);
      if (hidden.length >= MAX_HIDDEN) break;
    }
  }
  const state: ProfileState = {
    hidden,
    highlight: typeof r.highlight === 'boolean' ? r.highlight : DEFAULT_PROFILE_STATE.highlight,
  };
  if (isValidDitavalPath(r.ditaval)) state.ditaval = r.ditaval.replace(/\\/g, '/');
  return state;
}

/** True when nothing differs from a fresh pane, so the state need not be saved. */
export function isDefaultProfileState(state: ProfileState): boolean {
  return state.ditaval === undefined && state.hidden.length === 0 && state.highlight === DEFAULT_PROFILE_STATE.highlight;
}

export interface LoadedDitaval {
  ditaval?: Ditaval;
  /** Why the file is not (fully) in force. */
  error?: string;
  /** The file does not exist; creating it should bring the filter back. */
  missing?: boolean;
}

/** The absolute path of a vault-relative .ditaval, or undefined when it would leave the vault. */
export function resolveDitavalPath(vaultRoot: string, vaultRelative: string): string | undefined {
  if (!isValidDitavalPath(vaultRelative)) return undefined;
  const abs = resolve(vaultRoot, vaultRelative);
  const rel = relative(vaultRoot, abs);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? undefined : abs;
}

/** Read and parse a .ditaval. Never throws. */
export function loadDitaval(absPath: string): LoadedDitaval {
  let text: string;
  try {
    text = readFileSync(absPath, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { error: 'The DITAVAL file does not exist.', missing: true };
    return { error: `The DITAVAL file could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const ditaval = parseDitaval(text.replace(/^﻿/, ''));
  if (ditaval.error !== undefined) return { ditaval, error: `The DITAVAL file is not well-formed XML (${ditaval.error}).` };
  return { ditaval };
}

/** The filter a pane applies, or undefined when it would remove nothing. */
export function buildFilter(ditaval: Ditaval | undefined, hidden: readonly string[]): ProfileFilter | undefined {
  if (!ditaval && hidden.length === 0) return undefined;
  return { ditaval, hidden: new Set(hidden) };
}

/** Directory names the search never enters: not documents, and potentially huge. */
const SKIPPED_DIRS = new Set(['node_modules']);
const MAX_DEPTH = 8;
const MAX_FILES = 500;

/** Vault-relative paths (forward slashes) of every .ditaval under the vault, sorted. */
export function listDitavalFiles(vaultRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Dot folders are Obsidian's own (.obsidian, .trash) or version control.
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(abs, depth + 1);
      } else if (entry.isFile() && isDitavalPath(entry.name)) {
        found.push(relative(vaultRoot, abs).split(sep).join('/'));
        if (found.length >= MAX_FILES) return;
      }
    }
  };
  walk(vaultRoot, 0);
  return found.sort((a, b) => a.localeCompare(b));
}
