// A DITA file shown inside something else: the hover popover Obsidian's Page
// Preview opens over a link, and an `![[topic.dita]]` embed in a note.
//
// Obsidian builds the content of both from its embed registry, keyed by file
// extension; with nothing registered a file shows as a bare file card. The
// registry is not in the public API (`app.embedRegistry`), so the registration
// is guarded: if it is gone, nothing is registered and DITA files hover as
// before. The embed is a read-only render of the topic (or a map's outline)
// with the same styles as the preview, scrolled to the "#element" the link
// names.

import { App, Component, FileSystemAdapter, Keymap, TFile, moment, normalizePath } from 'obsidian';
import { join } from 'path';
import { splitRefFragment } from '@dita-viewer/core';
import { isExternalHref, resolveLinkTarget } from './linkTarget';
import { getSheets } from './previewSheets';
import { renderDitaFile, renderDitamapFile } from './renderFile';
import { setRenderedHtml } from './renderedHtml';

/** What Obsidian hands an embed creator. */
export interface EmbedInfo {
  app: App;
  linktext: string;
  sourcePath: string;
  containerEl: HTMLElement;
}

type EmbedCreator = (info: EmbedInfo, file: TFile, subpath: string) => Component;

interface EmbedRegistry {
  isExtensionRegistered(ext: string): boolean;
  registerExtensions(exts: string[], creator: EmbedCreator): void;
  unregisterExtensions(exts: string[]): void;
}

const EXTENSIONS = ['dita', 'ditamap'];

/** Register the embed for DITA files. Returns the function that removes it. */
export function registerDitaEmbed(app: App): () => void {
  const registry = (app as unknown as { embedRegistry?: Partial<EmbedRegistry> }).embedRegistry;
  if (
    !registry ||
    typeof registry.isExtensionRegistered !== 'function' ||
    typeof registry.registerExtensions !== 'function' ||
    typeof registry.unregisterExtensions !== 'function'
  ) {
    console.warn('DITA Viewer: Obsidian has no embed registry here; DITA links will not preview on hover.');
    return () => undefined;
  }
  const reg = registry as EmbedRegistry;
  const free = EXTENSIONS.filter((ext) => !reg.isExtensionRegistered(ext));
  if (free.length === 0) return () => undefined;
  reg.registerExtensions(free, (info, file, subpath) => new DitaEmbed(info, file, subpath));
  return () => reg.unregisterExtensions(free);
}

export class DitaEmbed extends Component {
  constructor(
    private readonly info: EmbedInfo,
    private readonly file: TFile,
    private readonly subpath: string,
  ) {
    super();
  }

  /** False once Obsidian has dropped the embed (the popover closed): stop waiting for it to be shown. */
  private alive = true;

  onunload(): void {
    this.alive = false;
  }

  /** Called by Obsidian once the embed is added; the popover shows what has been put in the container. */
  async loadFile(): Promise<void> {
    const { app, containerEl } = this.info;
    containerEl.addClass('dita-embed');
    const adapter = app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      containerEl.createDiv({ cls: 'dita-embed-error', text: 'A DITA file can only be previewed from a vault on disk.' });
      return;
    }
    const vaultRoot = adapter.getBasePath();
    const absPath = join(vaultRoot, this.file.path);
    const xml = await app.vault.cachedRead(this.file);
    const isMap = this.file.extension === 'ditamap';
    const result = isMap
      ? renderDitamapFile({ xml, absPath, vaultRoot, uiLanguage: moment.locale() })
      : renderDitaFile({ xml, absPath, vaultRoot, toResourceUrl: (rel) => adapter.getResourcePath(normalizePath(rel)), uiLanguage: moment.locale() });
    if (result.error !== undefined) {
      containerEl.createDiv({ cls: 'dita-embed-error', text: result.error });
      return;
    }

    const host = containerEl.createDiv({ cls: 'dita-view' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.adoptedStyleSheets = getSheets(host.ownerDocument);
    const body = shadow.createDiv({ cls: 'dita-body' });
    setRenderedHtml(body, result.html);
    const scheme = () => host.setAttribute('data-scheme', host.ownerDocument.body.classList.contains('theme-dark') ? 'dark' : 'light');
    scheme();
    this.registerEvent(app.workspace.on('css-change', scheme));

    // A link in the embed goes where it would in the preview (a new tab with Ctrl/Cmd).
    shadow.addEventListener('click', (evt) => this.onClick(evt as MouseEvent, vaultRoot));

    // The link named an element ("topic.dita#topic-id/element-id"): bring it
    // into view. The rendered page has the element's own id, without the topic's.
    let fragment = this.subpath.replace(/^#/, '');
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      // a stray "%": use it as written
    }
    const wanted = fragment ? splitRefFragment(fragment).elementId : undefined;
    if (wanted) this.scrollWhenShown(host, () => shadow.getElementById(wanted)?.scrollIntoView({ block: 'start' }));
  }

  /**
   * A popover is put in the page only after its content is loaded, and an
   * element that is not laid out cannot be scrolled to; wait (a second at
   * most) until the embed has a size.
   */
  private scrollWhenShown(host: HTMLElement, scroll: () => void, framesLeft = 60): void {
    if (host.isConnected && host.offsetHeight > 0) {
      scroll();
    } else if (framesLeft > 0 && this.alive) {
      host.win.requestAnimationFrame(() => this.scrollWhenShown(host, scroll, framesLeft - 1));
    }
  }

  private onClick(evt: MouseEvent, vaultRoot: string): void {
    const a = (evt.target as Element | null)?.closest('a[data-dita-href], a[href]');
    if (!a) return;
    evt.preventDefault();
    const href = a.getAttribute('data-dita-href') ?? a.getAttribute('href') ?? '';
    if (isExternalHref(href)) {
      window.open(href, '_blank');
      return;
    }
    const link = resolveLinkTarget(vaultRoot, this.file.path, href);
    const target = link && this.info.app.vault.getAbstractFileByPath(normalizePath(link.path));
    if (target instanceof TFile) void this.info.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(target);
  }
}
