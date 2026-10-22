// Render one .dita file to an HTML fragment for the preview.
//
// Pure with respect to Obsidian: everything it needs from the host comes in as
// arguments, so it is unit-tested in plain mocha. (DitaView.ts is the part
// that touches the Obsidian API.)

import { dirname, isAbsolute, relative, resolve, sep } from 'path';
import { buildKeyMapForDocument, decodeHrefPart, renderBookXml, renderMapXml, renderSiteXml, renderTopicXml } from '@dita-viewer/core';
import type { SiteNavEntry } from '@dita-viewer/core';
import { bookLabels, outlineLabel, roleFormatFor, siteLabels } from './roleLabels';

export interface RenderFileInput {
  /** The topic's source text (read through the vault, so unsaved edits elsewhere are not an issue). */
  xml: string;
  /** Absolute path of the topic on disk. */
  absPath: string;
  /** Absolute path of the vault root; nothing outside it is read for keys, nor shown as an image. */
  vaultRoot: string;
  /** Maps a vault-relative path ("img/a.png") to a URL the preview can load. */
  toResourceUrl: (vaultRelativePath: string) => string;
  /** Language for note labels when the topic has no xml:lang (e.g. "zh-cn"). */
  uiLanguage?: string;
}

export interface RenderFileResult {
  html: string;
  title?: string;
  error?: string;
  /** Absolute paths of every file this render read; a change to any of them stales the preview. */
  dependencies: Set<string>;
}

export function renderDitaFile(input: RenderFileInput): RenderFileResult {
  const { xml, absPath, vaultRoot, toResourceUrl, uiLanguage } = input;
  const docDir = dirname(absPath);
  const dependencies = new Set<string>([absPath]);

  const asWebviewUri = (relPath: string): string => {
    const target = resolve(docDir, decodeHrefPart(relPath));
    const rel = relative(vaultRoot, target);
    // A path that climbs out of the vault cannot be served as a vault resource.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return '';
    return toResourceUrl(rel.split(sep).join('/'));
  };

  try {
    const keyMap = buildKeyMapForDocument(absPath, {
      root: vaultRoot,
      onError: (mapPath, e) => console.warn(`DITA Viewer: could not read keys from ${mapPath}:`, e instanceof Error ? e.message : e),
    });
    const result = renderTopicXml({
      xml,
      docDir,
      keyMap,
      asWebviewUri,
      headingLevel: 1,
      uiLanguage,
      collectDependencies: dependencies,
      docFile: absPath,
      // The tint carries the reuse badge the preview turns into a jump to the
      // source of the reused element (DitaView.jumpToConref).
      markConrefs: true,
    });
    return { html: result.html, title: result.title, error: result.error, dependencies };
  } catch (e) {
    return { html: '', error: e instanceof Error ? e.message : String(e), dependencies };
  }
}

export interface RenderMapInput {
  xml: string;
  absPath: string;
  vaultRoot: string;
  uiLanguage?: string;
}

/** Render a .ditamap to its outline tree. Same result shape as renderDitaFile. */
export function renderDitamapFile(input: RenderMapInput): RenderFileResult {
  const { xml, absPath, vaultRoot, uiLanguage } = input;
  const dependencies = new Set<string>([absPath]);
  try {
    const keyMap = buildKeyMapForDocument(absPath, {
      root: vaultRoot,
      onError: (mapPath, e) => console.warn(`DITA Viewer: could not read keys from ${mapPath}:`, e instanceof Error ? e.message : e),
    });
    const html = renderMapXml({
      xml,
      docDir: dirname(absPath),
      keyMap,
      roleFormat: roleFormatFor(uiLanguage),
      treeLabel: outlineLabel(uiLanguage),
      collectDependencies: dependencies,
    });
    return { html, dependencies };
  } catch (e) {
    return { html: '', error: e instanceof Error ? e.message : String(e), dependencies };
  }
}

export interface RenderBookInput extends RenderMapInput {
  /** Maps a vault-relative path ("img/a.png") to a URL the preview can load. */
  toResourceUrl: (vaultRelativePath: string) => string;
}

/** Render a .ditamap as a book: every referenced topic on one page. */
export function renderBookFile(input: RenderBookInput): RenderFileResult {
  const { xml, absPath, vaultRoot, toResourceUrl, uiLanguage } = input;
  const dependencies = new Set<string>([absPath]);
  try {
    const keyMap = buildKeyMapForDocument(absPath, {
      root: vaultRoot,
      onError: (mapPath, e) => console.warn(`DITA Viewer: could not read keys from ${mapPath}:`, e instanceof Error ? e.message : e),
    });
    const result = renderBookXml({
      xml,
      docDir: dirname(absPath),
      keyMap,
      roleFormat: roleFormatFor(uiLanguage),
      labels: bookLabels(uiLanguage),
      uiLanguage,
      // The core resolves each image against its own topic's folder; a path
      // that climbs out of the vault cannot be served as a vault resource.
      toResourceUrl: (targetAbsPath) => {
        const rel = relative(vaultRoot, targetAbsPath);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return '';
        return toResourceUrl(rel.split(sep).join('/'));
      },
      collectDependencies: dependencies,
    });
    return { html: result.html, title: result.title, dependencies };
  } catch (e) {
    return { html: '', error: e instanceof Error ? e.message : String(e), dependencies };
  }
}

export interface RenderSiteInput extends RenderBookInput {
  /** Absolute path of the page to show; the first topic when omitted or stale. */
  current?: string;
}

export interface RenderSiteResult extends RenderFileResult {
  /** Sidebar entries in reading order, topicheads included as groups. */
  entries: SiteNavEntry[];
  /** The page actually rendered (the first topic when `current` was stale). */
  current?: string;
  /** The current topic's own title. */
  topicTitle?: string;
}

/** Render one page of a .ditamap as a site, plus the sidebar manifest. */
export function renderSiteFile(input: RenderSiteInput): RenderSiteResult {
  const { xml, absPath, vaultRoot, toResourceUrl, uiLanguage, current } = input;
  const dependencies = new Set<string>([absPath]);
  try {
    const keyMap = buildKeyMapForDocument(absPath, {
      root: vaultRoot,
      onError: (mapPath, e) => console.warn(`DITA Viewer: could not read keys from ${mapPath}:`, e instanceof Error ? e.message : e),
    });
    const result = renderSiteXml({
      xml,
      docDir: dirname(absPath),
      keyMap,
      roleFormat: roleFormatFor(uiLanguage),
      labels: siteLabels(uiLanguage),
      uiLanguage,
      current,
      // The core resolves each image against the current topic's folder; a
      // path that climbs out of the vault cannot be served as a vault resource.
      toResourceUrl: (targetAbsPath) => {
        const rel = relative(vaultRoot, targetAbsPath);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return '';
        return toResourceUrl(rel.split(sep).join('/'));
      },
      collectDependencies: dependencies,
    });
    return {
      html: result.html,
      title: result.title,
      entries: result.entries,
      current: result.current,
      topicTitle: result.topicTitle,
      dependencies,
    };
  } catch (e) {
    return {
      html: '',
      error: e instanceof Error ? e.message : String(e),
      entries: [],
      dependencies,
    };
  }
}
