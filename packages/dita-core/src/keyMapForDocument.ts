// Host-neutral key map lookup for one document.
//
// The VS Code host builds this in editor/keyMap.ts, which also talks to the
// workspace (context map picker, caches, warnings) and so imports `vscode`.
// This is the part a host without those features needs: find the ditamaps
// near the document and resolve their key definitions, the same way the VS
// Code preview does when no context map is set.

import { dirname } from 'path';
import { collectDitamapFilesUpward } from './editor/topicRender';
import { KeySpace, buildKeySpace } from './editor/keySpace';
import { readSourceText } from './editor/sourceText';

export interface KeyMapOptions {
  /**
   * Highest directory the search for ditamaps may climb to (inclusive), e.g.
   * an Obsidian vault root. Required so a host never walks above its own
   * workspace.
   */
  root: string;
  /**
   * true (default): use the maps of the nearest directory level that has any,
   * scanning that level's whole subtree. false: collect the maps of every
   * ancestor level, as the VS Code preview does. The nearest-only default
   * keeps a large vault from being scanned end to end for each topic.
   */
  nearestOnly?: boolean;
  onError?: (mapPath: string, error: unknown) => void;
}

/**
 * The whole key space for one document: the key values, each key's resource
 * target, and the map files they were read from. Diagnostics want the values
 * and the files (to watch); render paths and completion want the values map.
 */
export function buildKeySpaceForDocument(docFile: string, options: KeyMapOptions): KeySpace {
  const maps = collectDitamapFilesUpward(dirname(docFile), options.root, options.nearestOnly ?? true);
  return buildKeySpace(undefined, maps, readSourceText, options.onError);
}

export function buildKeyMapForDocument(docFile: string, options: KeyMapOptions): Map<string, string> {
  return buildKeySpaceForDocument(docFile, options).keys;
}
