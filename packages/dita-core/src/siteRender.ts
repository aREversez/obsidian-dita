// Render one page of a .ditamap as a small site: the current topic plus a
// sidebar manifest of every topic in the map.
//
// The manifest is built from the same flattened entries bookRender uses, so
// the sidebar and the pages agree on which topics are members and in what
// order. Only the pages themselves are rendered one at a time; when the map
// leaves an entry unnamed, the sidebar sniffs that topic's own <title> for a
// readable label (explicit navtitles/linktext win and cost no read). Book view
// still shows every topic's title because it renders every page.
//
// The page wrapper carries data-dita-book-file, exactly like a book section,
// so the host can open relative links and "reveal in source" against the
// topic that contains them. A cross-file xref renders as
// data-dita-book-xref="path#id" (see baseTypeMap.ts); the host uses this
// manifest to switch pages before scrolling to the anchor.

import { statSync } from 'fs';
import { dirname, resolve } from 'path';
import { DitaDocument } from './parser/domTypes';
import { parseDitamap, preprocessEntities } from './parser/ditaParser';
import { decodeHrefPart, expandDitamapRefs } from './editor/refResolvers';
import { readSourceText } from './editor/sourceText';
import { renderTopicXml } from './editor/topicRender';
import { collectMapEntries, getMapTitleText } from './render/mapTypeMap';
import { topicPathOf } from './bookRender';
import { pruneExcluded } from './profiling';
import type { BookXmlRenderInput } from './bookRender';

export interface SiteXmlRenderInput extends Omit<BookXmlRenderInput, 'labels' | 'headingLevel'> {
  /** Words the site itself adds, for a host that shows another language. */
  labels?: { missingTopic?: string; noTopics?: string };
  /**
   * Absolute path of the page to show. Defaults to the first topic. An
   * unknown path (for example after the map changed) falls back to the
   * first topic rather than rendering an empty page.
   */
  current?: string;
  /**
   * Remembers each topic's raw <title> between renders, so a host that
   * re-renders on every change does not re-read every unnamed topic. An entry
   * is reused only while the file's modified time and size are unchanged; the
   * host owns the Map and may keep it for the life of the view.
   */
  titleCache?: Map<string, { stamp: string; title: string | null }>;
}

export interface SiteNavEntry {
  /** Absolute path of the topic page; undefined for a group heading. */
  absPath?: string;
  /** The sidebar label: the map's navtitle/linktext, else the topic's own title. */
  title: string;
  /** Compacted nesting level, 0 at the map's top level. */
  depth: number;
  /** Bookmap division label ("Chapter 1", "第 1 章", ...), when there is one. */
  role?: string;
  /** The entry's original map href, useful for showing a missing topic. */
  href?: string;
  /** True for a topichead / href-less topicref with navigable descendants. */
  isGroup?: boolean;
}

export interface SiteXmlRenderResult {
  html: string;
  /** The map's own title, when it has one. */
  title?: string;
  /** The current topic's own <title>, when it rendered. */
  topicTitle?: string;
  /** Sidebar entries in reading order, groups included. */
  entries: SiteNavEntry[];
  /** Absolute paths of every topic page in the map, in reading order. */
  members: string[];
  /** Absolute path of the page rendered above, when the map has any topic. */
  current?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function roleHtml(entry: SiteNavEntry | undefined): string {
  return entry?.role ? `<p class="dita-site-role">${escapeHtml(entry.role)}</p>` : '';
}

function decodeXmlText(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (all, name: string) => {
    const lower = name.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : all;
  });
}

/**
 * A topic file's first <title>, cheaply -- no DOM and no render. The sidebar
 * only needs a label, and maps routinely leave entries unnamed. Explicit map
 * navtitles win (buildSiteNav only calls this when the map named nothing), so
 * a well-authored map pays no file reads here. Keyrefs in a title are filled
 * from the map's key space before tags are stripped.
 */
/** The first <title>'s markup, before keyrefs are filled; undefined if there is none. */
function rawTitleFromXml(xml: string): string | undefined {
  let text: string;
  try {
    text = preprocessEntities(xml);
  } catch {
    return undefined;
  }
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  return /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(withoutComments)?.[1];
}

function finishTitle(raw: string, resolveKey: (key: string) => string | undefined): string | undefined {
  const withKeys = raw.replace(
    /<[^>]*\bkeyref=(?:"([^"]+)"|'([^']+)')[^>]*\/?>/gi,
    (all, doubleQuoted: string | undefined, singleQuoted: string | undefined) =>
      resolveKey(decodeXmlText(doubleQuoted ?? singleQuoted ?? '')) ?? all,
  );
  const plain = decodeXmlText(
    withKeys
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
  return plain || undefined;
}

/** modified time + size, or undefined when the file cannot be statted (then nothing is cached). */
function fileStamp(absPath: string): string | undefined {
  try {
    const st = statSync(absPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return undefined;
  }
}

function pageOpen(absPath: string, depth?: number): string {
  const depthAttr = depth === undefined ? '' : ` data-depth="${depth}"`;
  return `<article class="dita-site-page" data-dita-book-file="${escapeHtml(absPath)}"${depthAttr}>`;
}

/**
 * Builds the sidebar manifest. Depth is compacted: an entry dropped here
 * (resource-only, duplicate topic, or a childless href-less entry) leaves no
 * hole above its surviving descendants. The caller resolves the current page
 * from `members`.
 */
function buildSiteNav(
  entries: ReturnType<typeof collectMapEntries>,
  docDir: string,
  readFile: (absPath: string) => string,
  resolveKey: (key: string) => string | undefined,
  dependencies: Set<string>,
  titleCache?: Map<string, { stamp: string; title: string | null }>,
): { entries: SiteNavEntry[]; members: string[] } {
  const nav: SiteNavEntry[] = [];
  const members: string[] = [];
  const seen = new Set<string>();
  const survivingAncestors: number[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    while (
      survivingAncestors.length > 0 &&
      survivingAncestors[survivingAncestors.length - 1] >= entry.depth
    ) {
      survivingAncestors.pop();
    }
    const depth = survivingAncestors.length;

    if (entry.resourceOnly) continue;

    const absPath = topicPathOf(entry, docDir);
    if (absPath) {
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      members.push(absPath);
      dependencies.add(absPath);

      let title = entry.displayName;
      if (!entry.displayNameExplicit) {
        try {
          const stamp = titleCache ? fileStamp(absPath) : undefined;
          const hit = stamp !== undefined ? titleCache?.get(absPath) : undefined;
          let raw: string | null;
          if (hit && hit.stamp === stamp) {
            raw = hit.title;
          } else {
            raw = rawTitleFromXml(readFile(absPath)) ?? null;
            if (stamp !== undefined) titleCache?.set(absPath, { stamp, title: raw });
          }
          title = (raw === null ? undefined : finishTitle(raw, resolveKey)) ?? title;
        } catch {
          // Missing or unreadable: the map's own fallback label is still
          // better than dropping the page from the sidebar.
        }
      }
      nav.push({
        absPath,
        title,
        depth,
        role: entry.role,
        href: entry.href,
      });
      survivingAncestors.push(entry.depth);
      continue;
    }

    // A href that resolved to nothing is an external link, a PDF, a .ditamap
    // that wasn't expanded, or a fragment-only reference. None is a page.
    if (entry.href) continue;
    if (!entry.displayName) continue;
    const hasChildren = i + 1 < entries.length && entries[i + 1].depth > entry.depth;
    if (!hasChildren) continue;
    nav.push({
      title: entry.displayName,
      depth,
      role: entry.role,
      isGroup: true,
    });
    survivingAncestors.push(entry.depth);
  }

  return { entries: nav, members };
}

export function renderSiteXml(input: SiteXmlRenderInput): SiteXmlRenderResult {
  const doc: DitaDocument = parseDitamap(preprocessEntities(input.xml));
  const dependencies = input.collectDependencies ?? new Set<string>();
  const readFile = input.readFile ?? ((path: string) => readSourceText(path, 'utf-8'));
  const read = (path: string, _enc: 'utf-8'): string => {
    dependencies.add(resolve(path));
    return readFile(path);
  };
  expandDitamapRefs(doc.root, input.docDir, read);
  pruneExcluded(doc.root, input.filter);

  const keyMap = input.keyMap ?? new Map<string, string>();
  const resolveKey = (key: string): string | undefined => keyMap.get(key);
  const mapEntries = collectMapEntries(doc.root, resolveKey, input.roleFormat);
  const title = getMapTitleText(doc.root, resolveKey);
  const { entries, members } = buildSiteNav(
    mapEntries,
    input.docDir,
    readFile,
    resolveKey,
    dependencies,
    input.titleCache,
  );

  // The page is a dependency whether it exists or not: creating a missing
  // topic should make the site re-render, just like editing an existing one.
  for (const member of members) dependencies.add(member);

  const requested = input.current ? resolve(input.current) : undefined;
  const current = requested && members.includes(requested) ? requested : members[0];
  const currentEntry = entries.find((entry) => entry.absPath === current);

  if (!current) {
    const empty = input.labels?.noTopics ?? 'This map has no topics.';
    return {
      html:
        `<article class="dita-site-page dita-site-empty">` +
        `<p class="dita-site-empty-text">${escapeHtml(empty)}</p></article>`,
      title,
      entries,
      members,
    };
  }

  let xml: string;
  try {
    xml = readFile(current);
  } catch {
    const missing = input.labels?.missingTopic ?? 'Missing topic';
    return {
      html:
        pageOpen(current, currentEntry?.depth) +
        `${roleHtml(currentEntry)}` +
        `<p class="dita-site-missing">${escapeHtml(missing)}: ` +
        `<code>${escapeHtml(currentEntry?.href ?? current)}</code></p></article>`,
      title,
      entries,
      members,
      current,
    };
  }

  const topicDir = dirname(current);
  const asWebviewUri = (relPath: string): string => {
    if (!input.toResourceUrl) return '';
    return input.toResourceUrl(resolve(topicDir, decodeHrefPart(relPath)));
  };
  const result = renderTopicXml({
    xml,
    docDir: topicDir,
    keyMap,
    asWebviewUri,
    // One topic per page: every topic is a top-level heading here, whatever
    // its nesting depth in the map (that depth is the sidebar's business).
    headingLevel: 1,
    uiLanguage: input.uiLanguage,
    collectDependencies: dependencies,
    bookMembers: new Set(members),
    docFile: current,
    markConrefs: true,
  });

  if (result.error !== undefined) {
    return {
      html:
        pageOpen(current, currentEntry?.depth) +
        `${roleHtml(currentEntry)}` +
        `<p class="dita-site-error">${escapeHtml(result.error)}</p></article>`,
      title,
      entries,
      members,
      current,
    };
  }

  return {
    html:
      pageOpen(current, currentEntry?.depth) +
      `${roleHtml(currentEntry)}${result.html}</article>`,
    title,
    topicTitle: result.title,
    entries,
    members,
    current,
  };
}
