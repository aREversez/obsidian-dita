// Reference-resolution primitives, split out of ditaRenderUtils.ts.
//
// This is a LEAF module: it imports only the parser, the render tag maps,
// source text and Node fs/path -- never renderContext or ditaRenderUtils.
// Pulling these helpers down here is what unties the renderContext <->
// ditaRenderUtils cycle (P2/P3 introduced renderContext; the resolvers it
// needs lived in the giant file that also builds render contexts, so the two
// imported each other -- directly, and transitively through keySpace ->
// expandDitamapRefs). renderContext, keySpace and ditaRenderUtils now all sit
// ABOVE this module; nothing below reaches back up. Behaviour is unchanged --
// this is a pure move of code lifted verbatim from ditaRenderUtils.ts.
import { existsSync, openSync, readSync, closeSync, statSync } from 'fs';
import { resolve, isAbsolute, extname, dirname, relative, normalize } from 'path';
import { DitaNode } from '../parser/domTypes';
import { parseDita, parseDitamap, preprocessEntities } from '../parser/ditaParser';
import { extractText, getMapTitleText, isDitamapRef } from '../render/mapTypeMap';
import { readSourceText } from './sourceText';
// ── Image dimensions (for reserving layout space before the image loads) ──
//
// <img loading="lazy"> with no width/height reserves zero space until the
// browser actually decodes the file, then snaps the surrounding content
// down to make room -- barely noticeable for a single image in the topic
// preview, but Book mode composites many topics' worth of images into one
// long page, so scrolling through it means repeatedly landing on a fresh
// batch of not-yet-loaded images and watching everything below them lurch
// as each one finally loads. Reading real width/height from the file
// (only the header, not the whole image -- a bounded 64KB read handles
// every format below even for a multi-MB JPEG with a large EXIF/ICC
// profile before its SOF marker) lets width/height attributes go on the
// <img> tag, which combined with this project's existing img{height:auto}
// makes the browser reserve the correct *aspect ratio* box immediately,
// still scaling responsively via max-width -- not a fixed pixel size.
// This only fills a gap: an explicit @width/@height on the DITA <image>
// element itself always wins (see the image renderer in baseTypeMap.ts).

const IMAGE_HEADER_READ_BYTES = 65536;

function readHeaderBytes(filePath: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed / never opened */ }
    }
  }
}

function readPngDimensions(buf: Buffer): { width: number; height: number } | undefined {
  // 8-byte signature, then a 4-byte chunk length + "IHDR" + width (4B BE) + height (4B BE)
  if (buf.length < 24) return undefined;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readGifDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 10) return undefined;
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return undefined;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function readBmpDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 26) return undefined;
  if (buf.toString('ascii', 0, 2) !== 'BM') return undefined;
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  // A negative height means a top-down (rather than the default
  // bottom-up) bitmap -- the magnitude is still the real pixel height.
  return { width: Math.abs(width), height: Math.abs(height) };
}

function readJpegDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    // Markers with no payload to skip over
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) break;
    const segmentLength = buf.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buf.length) return undefined; // truncated read -- header didn't fit in what we sampled
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (marker === 0xda) return undefined; // Start of Scan reached with no SOF found
    offset += 2 + segmentLength;
  }
  return undefined;
}

function readSvgDimensions(buf: Buffer): { width: number; height: number } | undefined {
  const text = buf.toString('utf-8');
  const svgTagMatch = text.match(/<svg\b[^>]*>/);
  if (!svgTagMatch) return undefined;
  const tag = svgTagMatch[0];
  const widthMatch = tag.match(/\bwidth="([\d.]+)(?:px)?"/);
  const heightMatch = tag.match(/\bheight="([\d.]+)(?:px)?"/);
  if (widthMatch && heightMatch) {
    const width = parseFloat(widthMatch[1]);
    const height = parseFloat(heightMatch[1]);
    if (width > 0 && height > 0) return { width, height };
  }
  // Percentage/unitless width+height, or neither present -- fall back to
  // viewBox, which every real-world SVG has anyway and gives an aspect
  // ratio even when absolute pixel dimensions weren't authored at all.
  const viewBoxMatch = tag.match(/\bviewBox="\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*"/);
  if (viewBoxMatch) {
    const width = parseFloat(viewBoxMatch[1]);
    const height = parseFloat(viewBoxMatch[2]);
    if (width > 0 && height > 0) return { width, height };
  }
  return undefined;
}

const IMAGE_DIMENSION_READERS: Record<string, (buf: Buffer) => { width: number; height: number } | undefined> = {
  '.png': readPngDimensions,
  '.gif': readGifDimensions,
  '.bmp': readBmpDimensions,
  '.jpg': readJpegDimensions,
  '.jpeg': readJpegDimensions,
  '.svg': readSvgDimensions,
};

/**
 * Reads just enough of an image file to determine its natural pixel
 * dimensions, without loading or decoding the whole file. Returns
 * undefined for anything unreadable, unrecognized, or corrupt -- callers
 * treat that as "no dimensions available" and fall back to the previous
 * behavior (no width/height reserved), never an error.
 *
 * Cached by path + mtime: every source edit re-renders the whole topic
 * (see postContentUpdate in DitaViewerProvider.ts/MapViewerProvider.ts),
 * which calls this again for every image in it regardless of whether that
 * particular image had anything to do with what was just typed. A cheap
 * stat() to check mtime, versus re-opening and re-parsing the header, is
 * the difference that matters for a topic with a lot of images -- the
 * common case is the same unchanged images on every keystroke, not new
 * ones. Bounded by IMAGE_DIMENSIONS_CACHE_MAX with oldest-unused-first
 * eviction (a cache hit re-inserts the entry, so it counts as recently
 * used), keeping long sessions that preview many distinct images from
 * growing the Map without limit -- entries are tiny (a path plus two
 * numbers), but the project's rule is that every cache stays bounded and
 * clearable, and this one is cleared alongside the rest on deactivation.
 */
const imageDimensionsCache = new Map<string, { mtimeMs: number; dimensions: { width: number; height: number } | undefined }>();
// One entry per distinct image file ever previewed; bound it the same way
// keyMapCache is bounded in DitaViewerProvider.ts.
export const IMAGE_DIMENSIONS_CACHE_MAX = 1000;

export function clearImageDimensionsCache(): void {
  imageDimensionsCache.clear();
}

export function readImageDimensions(filePath: string): { width: number; height: number } | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    // Not statable (doesn't exist, permissions, ...) -- nothing to read,
    // and any previous cache entry for this path is now stale.
    imageDimensionsCache.delete(filePath);
    return undefined;
  }

  const cached = imageDimensionsCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    // Re-insert so a cache hit keeps the entry from being the oldest
    // (and therefore first-evicted) candidate.
    imageDimensionsCache.delete(filePath);
    imageDimensionsCache.set(filePath, cached);
    return cached.dimensions;
  }

  const reader = IMAGE_DIMENSION_READERS[extname(filePath).toLowerCase()];
  let dimensions: { width: number; height: number } | undefined;
  if (reader) {
    const buf = readHeaderBytes(filePath, IMAGE_HEADER_READ_BYTES);
    if (buf) {
      try {
        dimensions = reader(buf);
      } catch {
        dimensions = undefined;
      }
    }
  }
  if (imageDimensionsCache.size >= IMAGE_DIMENSIONS_CACHE_MAX) {
    const oldest = imageDimensionsCache.keys().next().value;
    if (oldest !== undefined) imageDimensionsCache.delete(oldest);
  }
  imageDimensionsCache.set(filePath, { mtimeMs, dimensions });
  return dimensions;
}

// ── Cross-file helpers (conref + title resolver share file cache) ──

/** Where a resolved reference target lives: the parsed file it came from. */
export interface NodeOrigin {
  /** Absolute path of the file; undefined for the document being rendered. */
  file?: string;
  root: DitaNode;
}

export function makeFileCache(docDir: string) {
  const cache = new Map<string, DitaNode | undefined>();
  // Which file each resolved target element came from. A reference chain
  // (A -> B -> C) needs it: B's own conref is relative to B's file, and a
  // same-file "#id" in B points into B, not into the document being rendered.
  const origins = new WeakMap<DitaNode, NodeOrigin>();

  function noteOrigin(el: DitaNode, origin: NodeOrigin): void {
    origins.set(el, origin);
  }

  function originOf(el: DitaNode): NodeOrigin | undefined {
    return origins.get(el);
  }

  function loadFile(filePath: string): DitaNode | undefined {
    return loadAbsPath(resolve(docDir, decodeHrefPart(filePath)));
  }

  /**
   * Parse-and-cache a file already addressed by absolute path. loadFile is the
   * docDir-relative convenience wrapper; conkeyref needs this directly because
   * a key's href resolves against the *defining map's* directory, not the topic
   * being rendered. Sharing one cache keeps a conkeyref target and a conref
   * target of the same file parsed once, and lands both in touchedFiles.
   */
  function loadAbsPath(absPath: string): DitaNode | undefined {
    if (cache.has(absPath)) return cache.get(absPath);
    if (!existsSync(absPath)) { cache.set(absPath, undefined); return undefined; }
    try {
      const content = readSourceText(absPath, 'utf-8');
      // A .ditamap parses with the map tag table: without it, a map's own
      // <title>/<booktitle> would carry the topic parser's baseTypes and
      // map-title consumers (the Explorer tree's submap rows, via
      // makeFileTitleResolver) would see nothing they recognize.
      const doc = /\.ditamap$/i.test(absPath)
        ? parseDitamap(preprocessEntities(content))
        : parseDita(preprocessEntities(content));
      cache.set(absPath, doc.root);
      return doc.root;
    } catch {
      cache.set(absPath, undefined);
      return undefined;
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

  function findTitleOfElement(
    root: DitaNode,
    elementId: string,
    resolveKey?: (key: string) => string | undefined,
  ): string | undefined {
    const el = findElementById(root, elementId);
    if (!el) return undefined;
    const titleChild = (el.children || []).find(
      (c) => c.type === 'element' && c.baseType === 'topic/title',
    );
    if (!titleChild) return undefined;
    return extractText(titleChild, resolveKey);
  }

  /**
   * Every absolute path this cache was asked for, including ones that turned
   * out not to exist (those are memoized as undefined). Callers use it as the
   * dependency set of a render: rendered HTML can only be reused for as long
   * as none of these files changes. A missing file has to be reported as
   * carefully as a present one, since creating it later is exactly the kind
   * of change that must invalidate.
   */
  function touchedFiles(): string[] {
    return [...cache.keys()];
  }

  return { loadFile, loadAbsPath, findElementById, findTitleOfElement, touchedFiles, noteOrigin, originOf };
}

export function makeConrefResolver(
  docDir: string,
  ownRoot?: DitaNode,
  sharedCache?: ReturnType<typeof makeFileCache>,
): (conref: string, from?: DitaNode) => DitaNode | undefined {
  const cache = sharedCache ?? makeFileCache(docDir);

  /**
   * `from` is the element that carries the conref when it is a hop inside a
   * chain: its origin decides what a relative path or a same-file "#id" is
   * relative to. Without it the reference belongs to the document being rendered.
   */
  return (conref: string, from?: DitaNode): DitaNode | undefined => {
    const hashIdx = conref.indexOf('#');
    if (hashIdx < 0) return undefined;
    const filePath = conref.substring(0, hashIdx);
    const idPart = conref.substring(hashIdx + 1);
    const parts = idPart.split('/');
    const elementId = parts.length > 1 ? parts[1] : parts[0];
    if (!elementId) return undefined;

    const origin = from ? cache.originOf(from) : undefined;
    if (from && !origin) return undefined; // cannot place the hop: stop the chain here
    const selfRoot = origin ? origin.root : ownRoot;
    const selfFile = origin?.file;

    // No file path before "#" -- a same-document reference, e.g.
    // conref="#noteId" or the "#./noteId" shorthand some authors use
    // (treating the current file as if it were "./" of itself). docDir on
    // its own resolves to a *directory*, not a file, so handing an empty
    // filePath to loadFile always failed here: existsSync passed (the
    // directory exists), but reading a directory as a file then threw and
    // got silently cached as "not found". Search the document already
    // being rendered instead of touching the filesystem at all.
    if (!filePath) {
      if (!selfRoot) return undefined;
      const el = cache.findElementById(selfRoot, elementId);
      if (el) cache.noteOrigin(el, { file: selfFile, root: selfRoot });
      return el;
    }

    const baseDir = selfFile ? dirname(selfFile) : docDir;
    const abs = resolve(baseDir, decodeHrefPart(filePath));
    const root = cache.loadAbsPath(abs);
    if (!root) return undefined;
    const el = cache.findElementById(root, elementId);
    if (!el) return undefined;
    cache.noteOrigin(el, { file: abs, root });
    // Return the entire target element so its tag/baseType is preserved.
    // resolveConrefForNode in the renderer decides whether to replace just
    // the children (same-type conref) or the entire element (cross-type).
    return el;
  };
}

// conrefend extends a conref reference from a single element to a run of
// elements: everything from the conref target through the conrefend target,
// inclusive, in source-document order. Per the DITA spec this only applies
// when both ids resolve to elements that are siblings under the same
// parent — Oxygen's own conrefend support has the same restriction — so
// this returns undefined (letting the caller fall back to normal
// single-target conref handling) rather than guessing at some other
// relationship when that's not the case.
export function makeConrefRangeResolver(
  docDir: string,
  ownRoot?: DitaNode,
  sharedCache?: ReturnType<typeof makeFileCache>,
): (conref: string, conrefend: string) => DitaNode[] | undefined {
  const cache = sharedCache ?? makeFileCache(docDir);

  function resolveRef(ref: string): { root: DitaNode; id: string; file?: string } | undefined {
    const hashIdx = ref.indexOf('#');
    if (hashIdx < 0) return undefined;
    const filePath = ref.substring(0, hashIdx);
    // Strip the "./" same-document marker before splitting on "/" so a
    // topic-scoped same-document range (e.g. "#./topicId/elementId") lands
    // on the real topic/element pair instead of misreading "." as the
    // topic id and folding the rest of the fragment into a single
    // (unmatchable) id.
    const idPart = ref.substring(hashIdx + 1).replace(/^\.\/+/, '');
    const parts = idPart.split('/');
    const id = parts.length > 1 ? parts[1] : parts[0];

    // No file path before "#" -- a same-document reference, same as the
    // single-target makeConrefResolver above. docDir on its own resolves
    // to a *directory*, not a file, so handing an empty filePath to
    // loadFile always failed here the same way: existsSync passed, but
    // reading a directory as a file then threw and got silently cached as
    // "not found". Search the document already being rendered instead of
    // touching the filesystem at all.
    if (!filePath) {
      if (!ownRoot) return undefined;
      return { root: ownRoot, id };
    }

    const root = cache.loadFile(filePath);
    if (!root) return undefined;
    return { root, id, file: resolve(docDir, decodeHrefPart(filePath)) };
  }

  function findWithParent(node: DitaNode, targetId: string, parent: DitaNode | undefined): { el: DitaNode; parent: DitaNode } | undefined {
    if (node.attributes?.id === targetId && parent) return { el: node, parent };
    for (const child of node.children || []) {
      const found = findWithParent(child, targetId, node);
      if (found) return found;
    }
    return undefined;
  }

  return (conref: string, conrefend: string): DitaNode[] | undefined => {
    const start = resolveRef(conref);
    const end = resolveRef(conrefend);
    if (!start || !end) return undefined;

    const startFound = findWithParent(start.root, start.id, undefined);
    const endFound = findWithParent(end.root, end.id, undefined);
    if (!startFound || !endFound) return undefined;
    if (startFound.parent !== endFound.parent) return undefined;

    // Filter to element children before indexing: the parser preserves
    // whitespace-only text nodes between sibling elements (parsed with
    // trim:false), which would otherwise get swept into the slice and
    // thrown into the returned range as extra, attribute-less entries.
    // "Sibling" here means sibling *element*, matching what conref/
    // conrefend actually identify (elements with ids), not raw text runs.
    const siblings = (startFound.parent.children || []).filter((c) => c.type === 'element');
    const startIdx = siblings.indexOf(startFound.el);
    const endIdx = siblings.indexOf(endFound.el);
    if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return undefined;

    const run = siblings.slice(startIdx, endIdx + 1);
    // Record where the run lives, so the preview can offer a jump to it. The
    // run sits under one parent (checked above), hence in one file.
    for (const el of run) cache.noteOrigin(el, { file: start.file, root: start.root });
    return run;
  };
}

export function makeFileTitleResolver(
  docDir: string,
  sharedCache?: ReturnType<typeof makeFileCache>,
  resolveKey?: (key: string) => string | undefined,
): (href: string) => string | undefined {
  const cache = sharedCache ?? makeFileCache(docDir);

  return (href: string): string | undefined => {
    // Only local relative references can be resolved from disk — never probe
    // the filesystem for external URLs or absolute paths (on Windows an
    // https:// href would otherwise resolve to a junk docDir\https:\ path).
    if (!href || URL_SCHEME_RE.test(href) || isAbsolute(href)) return undefined;
    const hashIdx = href.indexOf('#');
    if (hashIdx < 0) {
      // No fragment: only hrefs that look like DITA files get file-level
      // resolution — bare ids (unmatched local anchors that callers pass
      // through) must not be probed as filenames. .ditamap resolves the
      // same way (its own <title>/<mainbooktitle> rather than a topic
      // <title>): the Explorer tree names submap rows by the referenced
      // map's own title, including a duplicate mapref whose children were
      // never spliced in.
      if (!/\.(dita|xml|ditamap)$/i.test(href)) return undefined;
      const root = cache.loadFile(href);
      if (!root) return undefined;
      if (/\.ditamap$/i.test(href)) return getMapTitleText(root, resolveKey);
      const titleChild = (root.children || []).find(
        (c) => c.type === 'element' && c.baseType === 'topic/title',
      );
      // extractText rather than collectText: a title whose product name or
      // version number is a keyref (the software-manual pattern) must show
      // the key's value, not drop it.
      return titleChild ? extractText(titleChild, resolveKey) : undefined;
    }
    const filePath = href.substring(0, hashIdx);
    const idPart = href.substring(hashIdx + 1);
    const topicId = idPart.split('/')[0];

    const root = cache.loadFile(filePath);
    if (!root) return undefined;
    return cache.findTitleOfElement(root, topicId, resolveKey);
  };
}

// ── Default note labels ──
// Values follow DITA-OT's own strings-en-us.xml / strings-zh-cn.xml bundles
// (org.dita.base/xsl/common) so the preview matches what a real DITA-OT
// publish would show. Two intentional deviations from DITA-OT's exact
// casing, kept for visual consistency across the 13 note types in this
// project's own UI (DITA-OT itself is inconsistent here — only Caution and
// Danger are upper-cased there, Warning is not):
//   - Caution/Danger are title case here, not DITA-OT's "CAUTION"/"DANGER"
//   - zh-cn "Notice" is left untranslated even in DITA-OT's own bundle
//     (literally has a `<!--TODO:Notice-->` in the source); this project
//     already ships '注意' for it, kept as-is here.
// Covers the full DITA 1.3 note/@type enumeration (13 values); 'other' is
// handled separately via @othertype in the topic/note renderer, since its
// label isn't a fixed string.
//
// zh-cn deviations from a literal DITA-OT mirror (both fixes, not stylistic):
//   - attention/caution previously collided with notice/warning (all four
//     rendered '注意'/'警告'), making the two pairs visually indistinguishable
//     in the preview. attention -> '留意', caution -> '小心' to disambiguate;
//     '小心'/'警告'/'危险' also matches the conventional CN safety-signage
//     triad for Caution/Warning/Danger.
//   - trouble -> '故障排除' ("troubleshooting"), not '故障' ("fault"); the
//     DITA semantic is remedy guidance, which '故障' alone doesn't convey.

export const DEFAULT_NOTE_LABELS: Record<string, string> = {
  note: 'Note', notice: 'Notice', warning: 'Warning', danger: 'Danger',
  important: 'Important', tip: 'Tip', restriction: 'Restriction',
  attention: 'Attention', caution: 'Caution', fastpath: 'Fastpath',
  remember: 'Remember', trouble: 'Trouble',
};

export const ZH_NOTE_LABELS: Record<string, string> = {
  note: '注', notice: '注意', warning: '警告', danger: '危险',
  important: '重要', tip: '提示', restriction: '限制',
  attention: '留意', caution: '小心', fastpath: '捷径',
  remember: '切记', trouble: '故障排除',
};

export function detectNoteLabels(root: DitaNode, uiLanguage?: string): Record<string, string> {
  const lang = root.attributes?.['xml:lang'] || uiLanguage || '';
  return lang.startsWith('zh') ? ZH_NOTE_LABELS : DEFAULT_NOTE_LABELS;
}

/** Same xml:lang-first, uiLanguage-fallback resolution as detectNoteLabels,
 *  for the "Index" label shown in indexterm chip tooltips. Kept separate
 *  rather than folded into noteLabels since it isn't a note type and has
 *  its own (much smaller) two-language set. */
export function detectIndexLabel(root: DitaNode, uiLanguage?: string): string {
  const lang = root.attributes?.['xml:lang'] || uiLanguage || '';
  return lang.startsWith('zh') ? '\u7d22\u5f15' : 'Index';
}

// ── Ditamap reference expansion ──
// Walks the map tree and inlines children from referenced .ditamap files
// so key-value pairs appear inline in tree/book view.

export type FileReader = (path: string, encoding: 'utf-8') => string;

export const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Builds the render context's isInCurrentBook resolver: given a cross-file
 * xref's raw href, return the absolute path of the target IF it is one of
 * the book's members, else undefined. Same local-reference guard the
 * inline version (renderTopicXml) applied before ever touching the file
 * system: never probe a URL-scheme or absolute href, and a fragment-only
 * href has no file part to resolve. Extracted for the shared
 * buildRenderContext factory (renderContext.ts) so the three render paths
 * agree on one implementation.
 */
export function makeIsInCurrentBook(
  docDir: string,
  bookMembers: ReadonlySet<string>,
): (href: string) => string | undefined {
  return (href: string): string | undefined => {
    if (!href || URL_SCHEME_RE.test(href) || isAbsolute(href)) return undefined;
    const pathPart = href.split('#')[0];
    if (!pathPart) return undefined;
    const absPath = resolve(docDir, decodeHrefPart(pathPart));
    return bookMembers.has(absPath) ? absPath : undefined;
  };
}

/**
 * Percent-decodes an href path segment for filesystem lookups. DITA tools
 * URL-encode spaces and special characters in hrefs (e.g. "my%20image.png"),
 * but the file on disk keeps the literal name. Malformed escape sequences
 * are returned unchanged.
 */
export function decodeHrefPart(part: string): string {
  if (!part.includes('%')) return part;
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function isLocalHref(href: string, scope?: string): boolean {
  if (!href || href.startsWith('#')) return false;
  if (scope === 'external' || scope === 'peer') return false;
  if (URL_SCHEME_RE.test(href)) return false;
  if (isAbsolute(href)) return false;
  return true;
}

// Hrefs inside a referenced map are relative to that map's own folder.
// When its children are inlined into the root map's tree, rewrite them so
// they stay valid relative to the root map's folder — otherwise nested
// keydef maps, sub-map topics and navigation all resolve to wrong paths.
function rebaseHrefs(node: DitaNode, fromDir: string, toDir: string): void {
  if (node.type !== 'element') return;
  const href = node.attributes?.href;
  if (href && node.attributes && isLocalHref(href, node.attributes.scope)) {
    const hashIdx = href.indexOf('#');
    const pathPart = hashIdx >= 0 ? href.substring(0, hashIdx) : href;
    const fragment = hashIdx >= 0 ? href.substring(hashIdx) : '';
    if (pathPart) {
      const abs = resolve(fromDir, pathPart);
      node.attributes.href = normalize(relative(toDir, abs)).replace(/\\/g, '/') + fragment;
    }
  }
  for (const child of node.children || []) rebaseHrefs(child, fromDir, toDir);
}

export function expandDitamapRefs(
  node: DitaNode,
  docDir: string,
  readFile: FileReader = readSourceText,
  ancestry?: Set<string>,
): void {
  if (node.type !== 'element') return;

  if (isDitamapRef(node)) {
    const href = node.attributes!.href!;
    const targetPath = resolve(docDir, decodeHrefPart(href.split('#')[0]));
    if (!ancestry) ancestry = new Set();
    // Scoped to the current chain of ancestor submaps (added on the way
    // down, removed on the way back up), NOT every submap expanded
    // anywhere else in the tree -- this guards only against a map that
    // (directly, or through a chain of further submaps) refers back to
    // one of its own ancestors, which would otherwise recurse forever. It
    // deliberately does NOT block the same submap being referenced twice
    // from two different topicrefs elsewhere in the map, which is a
    // legitimate, supported DITA pattern (e.g. a shared appendix or legal-
    // notices submap pulled into two different chapters) -- each such
    // reference gets its own independent expansion.
    if (!ancestry.has(targetPath)) {
      ancestry.add(targetPath);
      try {
        const content = readFile(targetPath, 'utf-8');
        const doc = parseDitamap(preprocessEntities(content));
        const refChildren = (doc.root.children || []).filter(
          (c) => c.type === 'element',
        );
        if (refChildren.length > 0) {
          const refDir = dirname(targetPath);
          if (refDir !== resolve(docDir)) {
            for (const rc of refChildren) rebaseHrefs(rc, refDir, docDir);
          }
          if (!node.children) node.children = [];
          node.children.push(...refChildren);
        }
      } catch {
        // file not found or parse error — skip silently
      }
      // Recurse into this node's now-spliced-in children (and any it
      // already had) while targetPath is still on the ancestry chain, so a
      // nested submap-of-a-submap is still cycle-checked correctly.
      for (const child of node.children || []) {
        expandDitamapRefs(child, docDir, readFile, ancestry);
      }
      ancestry.delete(targetPath);
      return;
    }
  }

  for (const child of node.children || []) {
    expandDitamapRefs(child, docDir, readFile, ancestry);
  }
}
