// What the completion engine needs from the outside world, read from disk.
//
// Plain fs + core only (no Obsidian API), so it is unit-testable. Answers are
// cached briefly: completion is asked on every keystroke, while keys and file
// lists change rarely.

import { readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  CompletionEnv,
  IMAGE_EXT,
  KeySpace,
  buildKeySpaceForDocument,
  collectIds,
  collectReferenceableFiles,
  decodeHrefPart,
  toRelativeHref,
} from '@dita-viewer/core';

export interface CompletionEnvInput {
  absPath: string;
  vaultRoot: string;
  isMap: boolean;
  /** Cache lifetime in ms. */
  ttl?: number;
  now?: () => number;
}

/** CompletionEnv plus what the file watcher needs: which maps the keys came from. */
export interface PluginCompletionEnv extends CompletionEnv {
  /** Absolute paths of the ditamaps the key values were read from (see KeySpace.files). */
  keyFiles(): readonly string[];
}

const SKIP = new Set(['node_modules', 'out']);

function listDir(dir: string): { name: string; isDirectory: boolean }[] {
  return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
}

function collectImages(baseDir: string, maxDepth = 3, maxResults = 200): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxResults) return;
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = listDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory) walk(full, depth + 1);
      else if (IMAGE_EXT.test(e.name)) out.push(toRelativeHref(baseDir, full));
    }
  };
  walk(baseDir, 0);
  return out;
}

export function createCompletionEnv(input: CompletionEnvInput): PluginCompletionEnv {
  const { absPath, vaultRoot, isMap } = input;
  const ttl = input.ttl ?? 3000;
  const now = input.now ?? Date.now;
  const docDir = dirname(absPath);
  const cache = new Map<string, { at: number; value: unknown }>();

  function cached<T>(key: string, load: () => T): T {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value as T;
    const value = load();
    cache.set(key, { at: now(), value });
    return value;
  }

  // One key space for both the values and the files they came from, so the
  // watcher and the completion popup can never disagree about which maps count.
  const keySpace = (): KeySpace =>
    cached('keys', (): KeySpace => {
      try {
        return buildKeySpaceForDocument(absPath, { root: vaultRoot, onError: () => undefined });
      } catch {
        return { keys: new Map<string, string>(), defs: new Map(), files: [], status: 'none' };
      }
    });

  return {
    isMap,
    keys: () => keySpace().keys,
    keyFiles: () => keySpace().files,
    files: (kind) =>
      kind === 'image'
        ? cached('images', () => collectImages(docDir))
        : cached('topics', () => collectReferenceableFiles(docDir, listDir)),
    idsIn: (filePart) => {
      const target = resolve(docDir, decodeHrefPart(filePart));
      // Never read outside the vault, whatever the href says.
      if (!target.startsWith(resolve(vaultRoot))) return undefined;
      return cached(`ids:${target}`, () => {
        try {
          return collectIds(readFileSync(target, 'utf8'));
        } catch {
          return undefined;
        }
      });
    },
  };
}
