// Shared render-context factory (P2).
//
// The three DITA render paths -- renderTopicXml (book / site / map preview),
// DitaViewerProvider.renderTopicContentUntracked (single-topic custom editor)
// and ditaDiffProvider.computeDiff (the Git compare panel) -- each used to
// hand-assemble the same conref / keyref / title / image resolvers into a
// RenderContext. Duplicating the wiring meant that adding a resolver (the
// upcoming conkeyref, P3) in one path would silently leave the other two
// behind. Centralising it here means the key resolvers are wired once.
//
// Pure module: no vscode import. `asWebviewUri` and the document directory
// are passed in by the caller (those are the only genuinely per-path bits),
// so the whole factory is unit-testable in plain mocha.
//
// What legitimately differs per path stays as input flags, so wiring the
// factory in is behaviour-preserving:
//   - includeIndexLabel: preview and book set indexLabel, the diff view does
//     not (it never surfaces indexterm chips). Kept as a flag to preserve
//     that byte-for-byte.
//   - collectDependencies / bookMembers: only the book/site path uses them.
//     collectDependencies also folds image reads into the dependency set.
//   - suppressIndexterm: only the export path sets it.

import { resolve } from 'path';
import { DitaNode } from '../parser/domTypes';
import { RenderContext } from '../render/renderer';
import {
  makeFileCache,
  makeConrefResolver,
  makeConrefRangeResolver,
  makeFileTitleResolver,
  makeIsInCurrentBook,
  detectNoteLabels,
  detectIndexLabel,
  readImageDimensions,
  decodeHrefPart,
} from './refResolvers';
import { getKeyDefs, KeyHrefDef } from './keySpace';
import { resolveConkeyref } from './conkeyref';

export interface BuildRenderContextInput {
  /** Directory hrefs in this document resolve against (== RenderContext.documentDir). */
  docDir: string;
  /** The document's own parsed root, for same-document conref lookups. */
  ownRoot: DitaNode;
  /** This document's id -> title map (empty for the diff view). */
  titleMap: Map<string, string>;
  /** Resolved key values for keyref / conkeyref. */
  keyMap: Map<string, string>;
  /**
   * Each key's resource target (href + defining map dir), used to resolve
   * conkeyref. Normally left undefined: the defs are looked up from `keyMap`
   * by instance identity (getKeyDefs), since both come from one buildKeySpace
   * call and the render paths thread the keyMap through everywhere. Pass it
   * explicitly only to drive conkeyref with a hand-built keyMap (tests).
   */
  keyDefs?: ReadonlyMap<string, KeyHrefDef>;
  /**
   * Absolute path of the document being rendered. Together with `markConrefs`
   * it lets same-file conrefs be marked too (their target file is this one).
   */
  docFile?: string;
  /**
   * Opt-in: have the renderer mark conref'd content (data-conref-* attributes)
   * for the preview's gray tint and jump button. Left off by every path that
   * must emit plain markup -- "Export as HTML" and the diff view. Needs
   * `docFile`; without it nothing is marked.
   */
  markConrefs?: boolean;
  /** Per-path URI function; the callers keep their vscode-dependent versions. */
  asWebviewUri: (relPath: string) => string;
  headingLevel: number;
  uiLanguage?: string;
  /** Preview and book: true; diff: false (omits ctx.indexLabel). */
  includeIndexLabel?: boolean;
  suppressIndexterm?: boolean;
  /** Book / docsite only: the set of files that make up the current book. */
  bookMembers?: ReadonlySet<string>;
  /** Book / site only: sink that records every file the render read. */
  collectDependencies?: Set<string>;
}

export interface BuiltRenderContext {
  ctx: RenderContext;
  /** Every file the shared cache read while resolving -- the book/site path
   *  folds these into collectDependencies after renderDocument returns. */
  touchedFiles: () => string[];
}

export function buildRenderContext(input: BuildRenderContextInput): BuiltRenderContext {
  const { docDir, ownRoot, titleMap, keyMap, asWebviewUri, headingLevel, uiLanguage } = input;

  // One cache shared by all three resolvers. They routinely load the same
  // conref/title target; sharing avoids re-parsing it and gives a single
  // place to read back the complete set of files this render touched.
  const fileCache = makeFileCache(docDir);
  const conrefResolver = makeConrefResolver(docDir, ownRoot, fileCache);
  const conrefRangeResolver = makeConrefRangeResolver(docDir, ownRoot, fileCache);
  const fileTitleResolver = makeFileTitleResolver(docDir, fileCache);

  const ctx: RenderContext = {
    headingLevel,
    asWebviewUri,
    documentDir: docDir,
    // Local id match first, then cross-file ("file.dita#topicId" or "file.dita").
    resolveTitle: (id: string) => titleMap.get(id) || fileTitleResolver(id),
    resolveKey: (key: string) => keyMap.get(key),
    resolveConref: (conref: string) => conrefResolver(conref),
    resolveConrefRange: (conref: string, conrefend: string) => conrefRangeResolver(conref, conrefend),
    noteLabels: detectNoteLabels(ownRoot, uiLanguage),
    suppressIndexterm: input.suppressIndexterm,
    getImageDimensions: (relPath: string) => {
      try {
        const absPath = resolve(docDir, decodeHrefPart(relPath));
        // An image's dimensions are emitted as width/height attributes, so
        // the file is a genuine dependency of the rendered HTML and has to be
        // recorded alongside the conref/title targets (only when the caller
        // passes a sink -- the preview and diff paths do not).
        input.collectDependencies?.add(absPath);
        return readImageDimensions(absPath);
      } catch {
        return undefined;
      }
    },
  };

  if (input.markConrefs && input.docFile) {
    const docFile = input.docFile;
    // origins only holds elements resolved from another file or through a
    // chain; a same-document target has none, and lives in docFile.
    ctx.conrefSource = (target: DitaNode) => fileCache.originOf(target)?.file ?? docFile;
  }

  if (input.includeIndexLabel) ctx.indexLabel = detectIndexLabel(ownRoot, uiLanguage);
  if (input.bookMembers) ctx.isInCurrentBook = makeIsInCurrentBook(docDir, input.bookMembers);

  // conkeyref rides on the same file cache: a key's href resolves against the
  // map that defined it (baseDir), not the topic being rendered, so it needs
  // the absolute-path loader rather than the docDir-relative conref resolver.
  // Discovered from keyMap by identity unless the caller passed defs directly.
  let lastLoaded: { file?: string; root: DitaNode } | undefined;
  const keyDefs = input.keyDefs ?? getKeyDefs(keyMap);
  if (keyDefs && keyDefs.size > 0) {
    const loadTopic = (baseDir: string, href: string): DitaNode | undefined => {
      const absPath = resolve(baseDir, decodeHrefPart(href.split('#')[0]));
      // A conkeyref target is a real dependency of the rendered HTML, exactly
      // like a conref target; record it when the caller tracks dependencies.
      input.collectDependencies?.add(absPath);
      return fileCache.loadAbsPath(absPath);
    };
    ctx.resolveConkeyref = (conkeyref: string) => {
      const el = resolveConkeyref(conkeyref, keyDefs, (baseDir, href) => {
        const absPath = resolve(baseDir, decodeHrefPart(href.split('#')[0]));
        const root = loadTopic(baseDir, href);
        if (root) lastLoaded = { file: absPath, root };
        return root;
      });
      if (el && lastLoaded) fileCache.noteOrigin(el, lastLoaded);
      return el;
    };
  }

  // One hop further along a reference chain, resolved relative to the file
  // that holds `from`. conkeyref wins over conref when it resolves, the same
  // rule as the first hop (an unresolvable conkeyref falls back to conref).
  ctx.resolveChainHop = (from: DitaNode): DitaNode | undefined => {
    const conkeyref = from.attributes?.conkeyref;
    if (conkeyref && ctx.resolveConkeyref) {
      lastLoaded = undefined;
      const viaKey = ctx.resolveConkeyref(conkeyref);
      if (viaKey) return viaKey;
    }
    const conref = from.attributes?.conref;
    return conref ? conrefResolver(conref, from) : undefined;
  };

  return { ctx, touchedFiles: () => fileCache.touchedFiles() };
}
