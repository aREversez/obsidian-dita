// Render a .ditamap as a book: every topic it references, in map order, on
// one page.
//
// Like mapRender.ts this is only glue around the copied parser and renderer:
// parse the map, splice in referenced submaps, collect the entries, then
// render each topic with renderTopicXml and wrap it in a section. The topic
// files are read from disk through readSourceText (the same cache and
// overlay rules the rest of the core uses).
//
// The wrapper carries the topic's absolute path in data-dita-book-file. A
// cross-file xref inside the book renders as data-dita-book-xref="path#id"
// (see baseTypeMap.ts); the host uses the wrapper to find the target section
// and scroll to it instead of opening another file.

import { dirname, isAbsolute, resolve } from 'path';
import { DitaDocument } from './parser/domTypes';
import { parseDitamap, preprocessEntities } from './parser/ditaParser';
import { decodeHrefPart, expandDitamapRefs } from './editor/refResolvers';
import { readSourceText } from './editor/sourceText';
import { renderTopicXml } from './editor/topicRender';
import { collectMapEntries, getMapTitleText } from './render/mapTypeMap';
import type { MapEntry, RoleLabelFormatter } from './render/mapTypeMap';
import { pruneExcluded } from './profiling';
import type { ProfileFilter } from './profiling';

export interface BookXmlRenderInput {
  /** The map's source text. */
  xml: string;
  /**
   * Folder of the map. Hrefs in the map and in every spliced-in submap are
   * relative to it by the time collectMapEntries sees them.
   */
  docDir: string;
  /**
   * Key name -> text, for keyref in titles and navtitles. Pass the Map a
   * buildKeySpace / buildKeyMapForDocument call returned, not a copy: the
   * renderer finds each key's file target through that very instance, so a
   * copy silently turns conkeyref and keyref-with-href into empty output.
   */
  keyMap?: Map<string, string>;
  /** Words the book itself adds, for a host that shows another language. */
  labels?: { missingTopic?: string };
  /** Formats bookmap division labels ("Chapter 1", "第 1 章", ...). */
  roleFormat?: RoleLabelFormatter;
  /** Fallback language for note labels, as in renderTopicXml. */
  uiLanguage?: string;
  /** Heading level of a top-level topic (default 1); nested entries go deeper. */
  headingLevel?: number;
  /**
   * Maps an absolute file path to a URL the preview can load. Called for
   * every image in every topic, with the path already resolved against that
   * topic's own folder.
   */
  toResourceUrl?: (absPath: string) => string;
  /** Receives the absolute path of every map and topic file read. */
  collectDependencies?: Set<string>;
  /**
   * Conditional processing: map entries the filter leaves out (a topicref with
   * `audience="internal"`, say) are dropped, with their sub-entries, before
   * anything is rendered. Profiled content inside a topic is not touched here;
   * it carries data-profile-keys for the host to hide.
   */
  filter?: ProfileFilter;
  /**
   * Reads a topic file. Defaults to readSourceText; injectable so tests can
   * render without touching the disk.
   */
  readFile?: (absPath: string) => string;
}

export interface BookXmlRenderResult {
  html: string;
  /** The map's own title, when it has one. */
  title?: string;
  /** Absolute paths of every topic shown, in reading order. */
  members: string[];
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The absolute path of the topic an entry points at, or undefined when it is
 * not a local topic file (a URL, an absolute path, a fragment, a .ditamap,
 * a PDF, ...). Map hrefs were rebased onto the root map's folder by
 * expandDitamapRefs, so docDir is the only base needed here.
 */
export function topicPathOf(entry: MapEntry, docDir: string): string | undefined {
  const href = entry.href;
  if (!href || href.startsWith('#')) return undefined;
  if (URL_SCHEME_RE.test(href) || isAbsolute(href)) return undefined;
  const pathPart = decodeHrefPart(href.split('#')[0]);
  const lower = pathPart.toLowerCase();
  if (!lower.endsWith('.dita') && !lower.endsWith('.xml')) return undefined;
  return resolve(docDir, pathPart);
}

interface BookItem {
  entry: MapEntry;
  /** Absolute topic path, for entries that render a topic. */
  absPath?: string;
}

function roleHtml(entry: MapEntry): string {
  return entry.role ? `<p class="dita-book-role">${escapeHtml(entry.role)}</p>` : '';
}

function headingLevelFor(entry: MapEntry, base: number): number {
  return Math.min(6, Math.max(1, base + entry.depth));
}

export function renderBookXml(input: BookXmlRenderInput): BookXmlRenderResult {
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
  const entries = collectMapEntries(doc.root, resolveKey, input.roleFormat);
  const title = getMapTitleText(doc.root, resolveKey);

  // Members are settled before any topic renders: every topic's cross-file
  // xrefs need the complete set to decide whether they point inside the book.
  const members = new Set<string>();
  const items: BookItem[] = [];
  for (const entry of entries) {
    if (entry.resourceOnly) continue;
    const absPath = topicPathOf(entry, input.docDir);
    if (absPath) members.add(absPath);
    items.push({ entry, absPath });
  }

  const baseLevel = input.headingLevel ?? 1;
  const sections: string[] = [];
  const renderedTopics = new Set<string>();
  for (const item of items) {
    const { entry, absPath } = item;
    if (!absPath) {
      // A topichead (or a structural entry) has a title but no file: show it
      // as a divider so "Part I" still appears between its chapters.
      if (entry.href || !entry.displayName) continue;
      const level = headingLevelFor(entry, baseLevel);
      sections.push(
        `<section class="dita-book-division" data-depth="${entry.depth}">${roleHtml(entry)}` +
          `<h${level} class="dita-book-division-title">${escapeHtml(entry.displayName)}</h${level}></section>`,
      );
      continue;
    }

    // A nested topicref with a fragment ("chapter.dita#section") points into
    // a topic that may already be on the page in full; rendering the whole
    // file again would duplicate it. The section itself is already there.
    if ((entry.href ?? '').includes('#') && renderedTopics.has(absPath)) continue;
    renderedTopics.add(absPath);

    // The file is a dependency whether it exists or not: creating a missing
    // topic should make the book re-render, just like editing an existing one.
    dependencies.add(absPath);
    let xml: string;
    try {
      xml = readFile(absPath);
    } catch {
      sections.push(
        `<p class="dita-book-missing">${escapeHtml(input.labels?.missingTopic ?? 'Missing topic')}: <code>${escapeHtml(entry.href ?? absPath)}</code></p>`,
      );
      continue;
    }

    const docDir = dirname(absPath);
    const asWebviewUri = (relPath: string): string => {
      if (!input.toResourceUrl) return '';
      return input.toResourceUrl(resolve(docDir, decodeHrefPart(relPath)));
    };
    const result = renderTopicXml({
      xml,
      docDir,
      keyMap,
      asWebviewUri,
      headingLevel: headingLevelFor(entry, baseLevel),
      uiLanguage: input.uiLanguage,
      collectDependencies: dependencies,
      bookMembers: members,
      docFile: absPath,
      markConrefs: true,
    });
    if (result.error !== undefined) {
      sections.push(`<p class="dita-book-error">${escapeHtml(result.error)}</p>`);
      continue;
    }
    sections.push(
      `<section class="dita-book-topic" data-dita-book-file="${escapeHtml(absPath)}" data-depth="${entry.depth}">` +
        `${roleHtml(entry)}${result.html}</section>`,
    );
  }

  const header = title
    ? `<header class="dita-book-titlepage"><h1 class="dita-book-title">${escapeHtml(title)}</h1></header>`
    : '';
  return {
    html: `<article class="dita-book">${header}${sections.join('\n')}</article>`,
    title,
    members: [...members],
  };
}
