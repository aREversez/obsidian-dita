// Topic rendering pipeline: text/title extraction, interfaces, parse-and-render
// functions, and the LRU render cache that book mode uses to skip re-rendering
// unchanged topics. Moved verbatim from ditaRenderUtils.ts (P5 pure refactor);
// imports its dependencies from sibling modules so no cycle through the barrel.

import { existsSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { DitaNode } from '../parser/domTypes';
import { parseDita, preprocessEntities } from '../parser/ditaParser';
import { renderDocument } from '../render/renderer';
import { buildRenderContext } from './renderContext';
import { sourceStamp, readSourceText, noteSourceDependencies } from './sourceText';
import { decodeHrefPart } from './refResolvers';

// ── Text extraction ──

export function collectText(node: DitaNode): string {
  if (node.type === 'text') return node.text || '';
  return (node.children || []).map(collectText).join('');
}

// ── Title map (id → title text for xref) ──

export function buildTitleMap(root: DitaNode): Map<string, string> {
  const map = new Map<string, string>();
  function walk(node: DitaNode) {
    if (node.type === 'element') {
      const id = node.attributes?.id;
      if (id) {
        const titleChild = (node.children || []).find(
          (c) => c.type === 'element' && c.baseType === 'topic/title',
        );
        if (titleChild) {
          map.set(id, collectText(titleChild));
        }
      }
      for (const child of node.children || []) walk(child);
    }
  }
  walk(root);
  return map;
}

// ── Shared: render a single .dita file to an HTML fragment ──

export interface TopicRenderInput {
  filePath: string;
  keyMap: Map<string, string>;
  asWebviewUri: (relPath: string) => string;
  headingLevel: number;
  /**
   * Fallback language (e.g. from vscode.env.language) used to pick note
   * labels (Warning/Attention/...) when the topic itself has no xml:lang
   * of its own to go by -- see detectNoteLabels. Most individual topic
   * files don't repeat xml:lang on every file (it's commonly set once,
   * at the ditamap or bookmap level, and left implicit on topics), so
   * relying on the topic's own root attribute alone left those topics
   * permanently defaulting to English regardless of the editor's own
   * display language.
   */
  uiLanguage?: string;
  /** See RenderContext.suppressIndexterm (render/renderer.ts) -- passed
   *  through untouched; only the "Export as HTML" command sets this. */
  suppressIndexterm?: boolean;
  /**
   * Optional sink: absolute paths of every file this render read -- the
   * topic itself, each conref/conrefend target, each file consulted for an
   * xref title, and each image whose dimensions were emitted. Callers that
   * cache rendered output use it as their invalidation set; renderTopicCached
   * is the only caller that does. Left unset by "Export as HTML", which
   * renders once and has nothing to invalidate.
   */
  collectDependencies?: Set<string>;
  /** See TopicXmlRenderInput.bookMembers below; passed through untouched. */
  bookMembers?: ReadonlySet<string>;
  /**
   * Mark conref'd content for the preview's tint and jump button (see
   * RenderContext.conrefSource). Off for "Export as HTML"; renderTopicCached,
   * which only ever serves previews, turns it on.
   */
  markConrefs?: boolean;
}

export interface TopicRenderResult {
  html: string;
  title?: string;
  error?: string;
}

export interface TopicXmlRenderInput {
  xml: string;
  docDir: string;
  keyMap: Map<string, string>;
  asWebviewUri: (relPath: string) => string;
  headingLevel: number;
  uiLanguage?: string;
  /** See TopicRenderInput.suppressIndexterm above. */
  suppressIndexterm?: boolean;
  /** See TopicRenderInput.collectDependencies above. */
  collectDependencies?: Set<string>;
  /**
   * Absolute paths of every topic that is part of the current book/docsite
   * render -- passed straight to RenderContext.isInCurrentBook (see that
   * field's own doc comment for why a cross-file xref's clickability
   * depends on this). Undefined for standalone single-topic preview and
   * "Export as HTML", which is exactly when a cross-file xref should keep
   * rendering as the non-clickable xref-external hint it always has.
   *
   * A ReadonlySet, not a plain array: renderBookParts/MapViewerProvider
   * build this once per book and hand the SAME instance to every topic's
   * render call, which renderTopicCached leans on for its own cache key
   * (compared by identity, exactly like keyMap) -- membership lookups
   * would work the same with an array, but identity comparison is the
   * whole point here.
   */
  bookMembers?: ReadonlySet<string>;
  /**
   * Absolute path of the topic being rendered, and the opt-in that uses it:
   * together they let the renderer mark conref'd content (same-file targets
   * included). See RenderContext.conrefSource.
   */
  docFile?: string;
  markConrefs?: boolean;
}

export interface ParsedTopicResult {
  doc?: import('../parser/domTypes').DitaDocument;
  html: string;
  title?: string;
  error?: string;
}


/**
 * Resolves an imagemap hotspot href the same way the map tree's openTopic
 * handler resolves its targets, then opens it in the right place. Kept
 * next to decodeHrefPart because it reuses that decoding; vscode is
 * injected so this module stays free of a runtime vscode dependency (its
 * script builders are unit-tested standalone).
 *
 * http(s) URLs and non-DITA files (test.html, test.pdf, images) go to the
 * system handler via openExternal -- a rendered page's hotspot promises an
 * "opens the target" experience, and VS Code can't render a useful PDF or
 * web page inline. DITA sources open in the matching preview editor
 * (.ditamap -> ditaViewer.mapPreview, .dita/.xml -> ditaViewer.preview),
 * mirroring openTopic's view-type decision, so clicking a hotspot whose
 * xref points at another topic behaves like clicking a link to that topic.
 */
export function openHrefTarget(
  vscode: typeof import('vscode'),
  href: string,
  baseDir: string,
): void {
  const raw = (href || '').trim();
  if (!raw) return;
  if (/^https?:\/\//i.test(raw)) {
    void vscode.env.openExternal(vscode.Uri.parse(raw));
    return;
  }
  if (raw.startsWith('#')) return; // same-page anchors never reach the host
  const filePart = decodeHrefPart(raw.split('#')[0]);
  if (!filePart) return;
  const targetPath = resolve(baseDir, filePart);
  const targetUri = vscode.Uri.file(targetPath);
  const lower = filePart.toLowerCase();
  if (lower.endsWith('.ditamap')) {
    void vscode.commands.executeCommand('vscode.openWith', targetUri, 'ditaViewer.mapPreview');
  } else if (lower.endsWith('.dita') || lower.endsWith('.xml')) {
    void vscode.commands.executeCommand('vscode.openWith', targetUri, 'ditaViewer.preview');
  } else {
    void vscode.env.openExternal(targetUri);
  }
}


export function renderTopicXml(input: TopicXmlRenderInput): ParsedTopicResult {
  const { xml, docDir, keyMap, asWebviewUri, headingLevel, uiLanguage, suppressIndexterm, collectDependencies, bookMembers, docFile, markConrefs } = input;
  try {
    const preprocessedXml = preprocessEntities(xml);
    const ditaDoc = parseDita(preprocessedXml);
    const titleMap = buildTitleMap(ditaDoc.root);

    // Resolvers, note/index labels and image dimensions are assembled by the
    // shared buildRenderContext factory (renderContext.ts) so this path, the
    // single-topic preview and the diff panel wire them identically. The book
    // extras (isInCurrentBook, collectDependencies) and indexLabel are on here.
    const { ctx, touchedFiles } = buildRenderContext({
      docDir,
      ownRoot: ditaDoc.root,
      titleMap,
      keyMap,
      asWebviewUri,
      headingLevel,
      uiLanguage,
      includeIndexLabel: true,
      suppressIndexterm,
      bookMembers,
      collectDependencies,
      docFile,
      markConrefs,
    });

    const html = renderDocument(ditaDoc.root, ctx);

    if (collectDependencies) {
      for (const touched of touchedFiles()) collectDependencies.add(touched);
    }

    const titleNode = (ditaDoc.root.children || []).find(
      (c) => c.type === 'element' && c.baseType === 'topic/title',
    );
    const title = titleNode ? collectText(titleNode) : undefined;
    return { doc: ditaDoc, html, title };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { html: '', error: `Error rendering topic: ${message}` };
  }
}

export function renderTopicToHtml(input: TopicRenderInput): TopicRenderResult {
  const { filePath, keyMap, asWebviewUri, headingLevel, uiLanguage, suppressIndexterm, collectDependencies, bookMembers, markConrefs } = input;
  try {
    if (!existsSync(filePath)) {
      return { html: '', error: `File not found: ${filePath}` };
    }
    // The topic's own file is a dependency of its own render even though it
    // is read here rather than through the shared file cache.
    collectDependencies?.add(filePath);
    const rawXml = readSourceText(filePath, 'utf-8');
    const result = renderTopicXml({
      xml: rawXml,
      docDir: dirname(filePath),
      keyMap,
      asWebviewUri,
      headingLevel,
      uiLanguage,
      suppressIndexterm,
      collectDependencies,
      bookMembers,
      docFile: filePath,
      markConrefs,
    });
    return { html: result.html, title: result.title, error: result.error };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { html: '', error: `Error rendering ${filePath}: ${message}` };
  }
}

// ── Topic render cache (book mode) ──

/**
 * Fingerprint of a set of files, used to decide whether a cached result
 * derived from them is still valid: one sourceStamp per file (sourceText.ts
 * has the rules, including how a missing file and a changed size count),
 * joined in order.
 *
 * Shared by buildKeyMap's cache (keyMap.ts), renderTopicCached below and
 * the book search index. It lived privately in the first until the topic
 * cache needed the identical logic; keeping one copy is the point.
 */
export function stampFiles(files: string[]): string {
  return files.map(sourceStamp).join('|');
}

/**
 * Pure directory-walking core of findDitamapFiles (keyMap.ts). Lives here
 * rather than there for the same reason stampFiles above does: keyMap.ts
 * imports vscode at module scope for parseDocRoot/vscode.Uri, so nothing
 * defined there can be unit tested without a vscode.Uri/workspace, even
 * logic like this that never touches vscode itself.
 *
 * Walks upward from startDir to root (inclusive); at *each* level it scans
 * that directory's whole subtree, not just its direct children, for
 * .ditamap files -- layouts that keep maps/ and topics/ as siblings (see
 * test-dita-file/manual) put the nearest map one directory below the
 * ancestor level being scanned, so a direct-children-only scan at each
 * ancestor silently misses it and buildKeyMap falls back to whichever
 * unrelated .ditamap happens to sit directly in a further-up ancestor, if
 * any, instead of the real one (kill test: keyMap.test.ts).
 */
export function collectDitamapFilesUpward(startDir: string, root: string, stopAtFirstMatch: boolean): string[] {
  const results: string[] = [];
  // A directory two ancestor levels up recursively covers everything a
  // closer level already scanned, so without this a .ditamap nested a
  // couple of directories down would be reported once per ancestor level
  // that subsumes it, not once.
  const visited = new Set<string>();
  let dir = startDir;
  while (dir.length >= root.length) {
    collectDitamapFilesRecursive(dir, results, visited);
    if (stopAtFirstMatch && results.length > 0) return results;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return results;
}

function collectDitamapFilesRecursive(dir: string, results: string[], visited: Set<string>): void {
  if (visited.has(dir)) return;
  visited.add(dir);
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.warn(`Failed to read directory ${dir}:`, e instanceof Error ? e.message : e);
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDitamapFilesRecursive(full, results, visited);
    } else if (entry.name.toLowerCase().endsWith('.ditamap')) {
      results.push(full);
    }
  }
}

/**
 * Budget for the topic render cache below, in bytes of rendered HTML.
 *
 * Bounded and clearable like every other cache in this file, per the rule
 * stated at imageDimensionsCache -- but bounded by bytes rather than by entry
 * count, because count is not a meaningful unit here. The other caches hold
 * fixed-size entries (a dimension pair, a keymap), so capping their count caps
 * their memory; a topic's HTML varies by orders of magnitude between a stub
 * and a full reference topic, so any count cap is either far too generous in
 * bytes or, set low enough to be safe, far too tight in entries.
 *
 * Too tight in entries is the failure that matters, and it is not gradual: a
 * book with more topics than the cap gets NO reuse at all. Each pass renders
 * in map order, so once the cache is full every insertion evicts an entry the
 * same pass has not reached again yet -- a cyclic access pattern, LRU's
 * classic worst case. Budgeting by bytes puts the cliff where it belongs: a
 * book whose entire HTML exceeds the budget is already costing at least that
 * much to hold as one assembled string (plus the webview DOM built from it),
 * so that is the point at which caching more stops being worth it.
 *
 * 32MB holds roughly 4,500 typical topics -- any realistic book, with room
 * for several open at once. Cleared from clearAllCaches() on deactivation.
 */
export const TOPIC_RENDER_CACHE_MAX_BYTES = 32 * 1024 * 1024;

interface TopicRenderCacheEntry {
  html: string;
  title: string | undefined;
  /** Absolute paths the render read; see TopicRenderInput.collectDependencies. */
  files: string[];
  stamps: string;
  /**
   * Compared by identity, not by content: buildKeyMap hands back the same Map
   * instance for as long as its own cache entry is valid, so identity is a
   * cheap proxy for "the key values this HTML was rendered with". If that
   * cache is evicted and rebuilt with identical contents the check fails and
   * the topic re-renders -- a false invalidation, never a stale hit, which is
   * the safe direction to be wrong in.
   */
  keyMap: Map<string, string>;
  uiLanguage: string | undefined;
  suppressIndexterm: boolean | undefined;
  /** Compared by identity, same rationale as keyMap above -- the same
   *  topic renders different HTML (a cross-file xref is a real link or
   *  not) depending on which book's membership set it was rendered
   *  against, so a stale entry from a different book must never answer
   *  for this one. renderBookParts/MapViewerProvider hand the same Set
   *  instance to every topic in one book's render pass, so this stays a
   *  cheap identity check rather than a per-render content comparison. */
  bookMembers: ReadonlySet<string> | undefined;
  /** Retained size of html, stored so eviction can subtract it without
   *  re-measuring every entry. */
  bytes: number;
}

const topicRenderCache = new Map<string, TopicRenderCacheEntry>();
let topicRenderCacheBytes = 0;
let topicRenderCacheBudget = TOPIC_RENDER_CACHE_MAX_BYTES;

export function clearTopicRenderCache(): void {
  topicRenderCache.clear();
  topicRenderCacheBytes = 0;
}

/** How many topic renders are currently held -- test hook for eviction/clear. */
export function topicRenderCacheSize(): number {
  return topicRenderCache.size;
}

/** Bytes of HTML currently held -- test hook, paired with the size above. */
export function topicRenderCacheBytesHeld(): number {
  return topicRenderCacheBytes;
}

/**
 * Test hook: shrinks the budget so eviction can be exercised without first
 * rendering 32MB of real topics. Called with no argument it restores the
 * production budget. Nothing outside the test suite calls this.
 */
export function setTopicRenderCacheBudgetForTesting(bytes?: number): void {
  topicRenderCacheBudget = bytes ?? TOPIC_RENDER_CACHE_MAX_BYTES;
}

function dropTopicEntry(key: string): void {
  const entry = topicRenderCache.get(key);
  if (!entry) return;
  topicRenderCache.delete(key);
  topicRenderCacheBytes -= entry.bytes;
}

function dropOldestTopicEntry(): void {
  const oldest = topicRenderCache.keys().next().value;
  if (oldest !== undefined) dropTopicEntry(oldest);
}

/**
 * renderTopicToHtml with reuse across passes -- the difference between "one
 * keystroke in one topic" and "the whole book again" in book mode, which
 * otherwise re-renders every referenced topic on each debounced pass (see
 * scripts/bench-book-render.js for the measured cost, and the budget note
 * above for why reuse is bounded in bytes).
 *
 * Deliberately opt-in and separate rather than built into renderTopicToHtml:
 * "Export as HTML" calls that one with its own asWebviewUri, and sharing a
 * single cache between the two would hand book-mode HTML to an exported
 * standalone file.
 *
 * Two assumptions worth stating, since neither is enforced by the key.
 *
 * asWebviewUri output depends only on the local URI and the window's remote
 * info, never on which webview asked: VS Code builds it as
 * `https://<scheme>+<authority>.vscode-resource.vscode-cdn.net<path>` in a
 * module-level helper with no panel in scope, and cspSource is likewise the
 * constant `'self' https://*.vscode-cdn.net` (both checked against the
 * shipped extension host bundle, not assumed). So HTML built for one map
 * panel is valid in another, and the caller's asWebviewUri closure is not
 * part of the cache key.
 *
 * headingLevel is part of the key rather than a merely validated field
 * because the same topic legitimately sits at different depths across two
 * open books -- validating it instead would make those two entries evict each
 * other on every pass.
 */
export function renderTopicCached(input: TopicRenderInput): TopicRenderResult {
  const key = `${input.filePath}\u0000${input.headingLevel}`;

  const cached = topicRenderCache.get(key);
  if (
    cached &&
    cached.keyMap === input.keyMap &&
    cached.uiLanguage === input.uiLanguage &&
    cached.suppressIndexterm === input.suppressIndexterm &&
    cached.bookMembers === input.bookMembers &&
    stampFiles(cached.files) === cached.stamps
  ) {
    // Re-insert so a hit keeps the entry from being the oldest (and therefore
    // first-evicted) candidate -- same LRU-by-reinsertion as
    // imageDimensionsCache above.
    topicRenderCache.delete(key);
    topicRenderCache.set(key, cached);
    // A hit reads nothing, but the answer still stands for these files.
    noteSourceDependencies(cached.files);
    return { html: cached.html, title: cached.title };
  }

  // Honour a caller-supplied sink as well, so anyone who passed one still
  // sees the dependency set instead of having it silently replaced.
  const dependencies = input.collectDependencies ?? new Set<string>();
  // Previews only (see above), so conref'd content is always marked here.
  const result = renderTopicToHtml({ ...input, markConrefs: true, collectDependencies: dependencies });
  if (result.error) {
    // Never cache a failure. A malformed mid-edit save is exactly the
    // transient case this path sees, and pinning it would keep serving the
    // error page after the file was fixed -- the dependency stamps would
    // still match, because the file that failed to parse is the very file
    // whose stamp gets compared.
    dropTopicEntry(key);
    return result;
  }

  const files = [...dependencies];
  // UTF-8 bytes, not html.length: DITA content is frequently CJK, where the
  // character count understates what is actually retained by up to 3x.
  const bytes = Buffer.byteLength(result.html, 'utf8');
  if (bytes > topicRenderCacheBudget) {
    // A single topic larger than the entire budget. Caching it would evict
    // everything else and then be evicted itself on the next insert, so skip
    // it: that entry alone falls back to uncached rendering.
    dropTopicEntry(key);
    return result;
  }

  // Make room before inserting, and account for any stale entry this key
  // already holds -- overwriting it in place would otherwise leak its bytes
  // out of the running total and shrink the effective budget permanently.
  dropTopicEntry(key);
  while (topicRenderCache.size > 0 && topicRenderCacheBytes + bytes > topicRenderCacheBudget) {
    dropOldestTopicEntry();
  }
  topicRenderCache.set(key, {
    html: result.html,
    title: result.title,
    files,
    stamps: stampFiles(files),
    keyMap: input.keyMap,
    uiLanguage: input.uiLanguage,
    suppressIndexterm: input.suppressIndexterm,
    bookMembers: input.bookMembers,
    bytes,
  });
  topicRenderCacheBytes += bytes;
  return result;
}
