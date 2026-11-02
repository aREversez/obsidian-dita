// The site view's sidebar and stepping: a .ditamap shown as one topic per page,
// with the map's tree beside it and a previous / next button per page.
//
// The state here describes one map: the manifest the last render returned, the
// page the reader asked for and the page actually on screen (they differ while
// a render is in flight or has failed), the cached topic titles, and the id to
// scroll to once the next page is in the DOM. A leaf reused for another map
// starts from that map's first topic.
//
// The view owns the mode, the preview and the render; everything that needs
// them is asked for through the host, so this file builds DOM and keeps a
// manifest, nothing more.

import { App, HoverParent, Keymap, TFile, moment } from 'obsidian';
import { decodeHrefPart } from '@dita-viewer/core';
import type { SiteNavEntry } from '@dita-viewer/core';
import { resolveLinkTarget } from './linkTarget';
import { siteLabels } from './roleLabels';
import { HOVER_SOURCE } from './hoverSource';
import { panesFor } from './viewMode';
import type { ViewMode } from './viewMode';
import type { RenderSiteResult } from './renderFile';

/** One page of the site, in reading order. */
interface SitePage {
  absPath: string;
  title: string;
}

export interface SiteNavHost {
  readonly app: App;
  /** The view: Page Preview anchors the popover it opens over a row to it. */
  readonly hoverParent: HoverParent;
  /** The sidebar, outside the preview's Shadow DOM. */
  readonly el: HTMLElement;
  /** The header's previous / next topic buttons. */
  readonly prevAction: HTMLElement;
  readonly nextAction: HTMLElement;
  file(): TFile | null;
  mode(): ViewMode;
  vaultRoot(): string | undefined;
  /** The preview's shadow root: where a page anchor is looked up. */
  shadow(): ShadowRoot;
  /** The preview does not show the current text any more. */
  markStale(): void;
  /** Render the page on screen again. */
  render(): void;
  setPreviewScroll(top: number): void;
  nextFrame(cb: FrameRequestCallback): number;
  /** Open a file's source at a position (Ctrl/Cmd+click on a row). */
  openSource(absPath: string, place: { line?: number; col?: number; id?: string }, evt?: MouseEvent): void;
}

export class SiteNav {
  private entries: SiteNavEntry[] = [];
  private pages: SitePage[] = [];
  /** The page the reader asked to go to. */
  private currentPath?: string;
  /** The page the preview actually shows. */
  private shownPath?: string;
  /** Raw topic titles by file, so unnamed topics are not re-read on every render. */
  private readonly titles = new Map<string, { stamp: string; title: string | null }>();
  private mapTitle?: string;
  private mapPathValue?: string;
  /** Element id to reveal after the next page is in the DOM. */
  private pendingAnchor?: string;
  /** Makes each rebuilt sidebar's accessible title id unique in the document. */
  private titleSeq = 0;

  constructor(private readonly host: SiteNavHost) {}

  /** The page the reader asked for, which is what the next render fetches. */
  get current(): string | undefined {
    return this.currentPath;
  }

  /** The page the preview actually shows, or undefined before the first render. */
  get shown(): string | undefined {
    return this.shownPath;
  }

  /**
   * Ask for a page before the first render, as a saved pane state does: the
   * render that follows shows it, or the map's first page when the map no
   * longer has it.
   */
  restore(absPath: string): void {
    this.currentPath = absPath;
  }

  /** Relative path of the map this state describes, or undefined before the first render. */
  get mapPath(): string | undefined {
    return this.mapPathValue;
  }

  /** Raw topic titles by file, kept between renders. */
  get titleCache(): Map<string, { stamp: string; title: string | null }> {
    return this.titles;
  }

  hasPage(absPath: string): boolean {
    return this.pages.some((page) => page.absPath === absPath);
  }

  /** Forget the current map's state (new file, or an emptied view). */
  reset(): void {
    this.entries = [];
    this.pages = [];
    this.currentPath = undefined;
    this.shownPath = undefined;
    this.titles.clear();
    this.mapTitle = undefined;
    this.mapPathValue = undefined;
    this.pendingAnchor = undefined;
    this.host.el?.replaceChildren();
    this.updateActions();
  }

  /** Take the manifest the last site render returned and rebuild the sidebar from it. */
  applyResult(result: RenderSiteResult, mapPath: string): void {
    this.mapTitle = result.title;
    this.entries = result.entries;
    this.pages = result.entries
      .filter((entry): entry is SiteNavEntry & { absPath: string } => entry.absPath !== undefined)
      .map((entry) => ({ absPath: entry.absPath, title: entry.title }));
    this.currentPath = result.current;
    this.shownPath = result.current;
    this.mapPathValue = mapPath;
    this.renderSidebar();
    this.updateActions();
  }

  /**
   * The render failed: keep the sidebar and the buttons describing the page that
   * is still on screen, not the one the reader asked for.
   */
  revertToShown(): void {
    if (this.currentPath === this.shownPath) return;
    this.currentPath = this.shownPath;
    this.renderSidebar();
    this.updateActions();
  }

  /** Switch the site to one topic page, optionally scrolling to an id in it. */
  openPage(absPath: string, anchor?: string): void {
    if (this.host.mode() !== 'site' || !absPath) return;
    if (absPath === this.currentPath) {
      if (anchor) this.scrollToAnchor(anchor);
      else this.host.setPreviewScroll(0);
      return;
    }
    this.currentPath = absPath;
    this.pendingAnchor = anchor;
    this.host.setPreviewScroll(0);
    this.host.markStale();
    if (panesFor(this.host.mode()).preview) this.host.render();
  }

  step(delta: number): void {
    const index = this.pages.findIndex((page) => page.absPath === this.currentPath);
    const target = this.pages[index + delta];
    if (target) this.openPage(target.absPath);
  }

  scrollToAnchor(id: string): void {
    const decoded = decodeHrefPart(id);
    if (!decoded) return;
    const anchor = this.host.shadow().getElementById(decoded);
    anchor?.scrollIntoView({ block: 'start' });
  }

  /** Forget an anchor a failed render never showed. */
  clearPendingAnchor(): void {
    this.pendingAnchor = undefined;
  }

  /**
   * Scroll to the anchor a page switch asked for, once the page that arrived is
   * in the DOM and laid out.
   */
  applyPendingAnchor(): void {
    const anchor = this.pendingAnchor;
    this.pendingAnchor = undefined;
    if (anchor && this.host.mode() === 'site') {
      this.host.nextFrame(() => this.scrollToAnchor(anchor));
    }
  }

  /** Show/hide and enable the header's previous / next topic buttons. */
  updateActions(): void {
    const { prevAction, nextAction } = this.host;
    if (!prevAction || !nextAction) return;
    const isSite = this.host.mode() === 'site';
    prevAction.toggleClass('dita-hidden', !isSite);
    nextAction.toggleClass('dita-hidden', !isSite);
    if (!isSite) return;

    const index = this.pages.findIndex((page) => page.absPath === this.currentPath);
    const previous = index > 0 ? this.pages[index - 1] : undefined;
    const next = index >= 0 ? this.pages[index + 1] : undefined;
    this.setAction(prevAction, previous, 'Previous topic');
    this.setAction(nextAction, next, 'Next topic');
  }

  private setAction(action: HTMLElement, target: { title: string } | undefined, fallback: string): void {
    const disabled = target === undefined;
    action.toggleClass('is-disabled', disabled);
    action.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    action.setAttribute('aria-label', target ? `${fallback}: ${target.title}` : fallback);
  }

  // ── the sidebar ──

  private renderSidebar(): void {
    const el = this.host.el;
    if (!el) return;
    const previousScroll = el.querySelector<HTMLElement>('.dita-site-nav-scroll')?.scrollTop ?? 0;
    el.replaceChildren();

    const header = el.createDiv({ cls: 'dita-site-nav-header' });
    const title = header.createDiv({
      cls: 'dita-site-nav-title',
      text: this.mapTitle ?? this.host.file()?.basename ?? 'Site',
    });
    const titleId = `dita-site-nav-title-${++this.titleSeq}`;
    title.id = titleId;

    const scroller = el.createDiv({ cls: 'dita-site-nav-scroll' });
    const tree = scroller.createEl('nav', { cls: 'dita-site-nav-tree' });
    const labels = siteLabels(moment.locale());
    // Label the navigation landmark from the visible map title. Do not use
    // aria-label here: Obsidian turns any aria-label into a hover tooltip, and
    // the nav covers the whole sidebar, so it would pop up over every row.
    tree.setAttribute('aria-labelledby', titleId);
    if (this.entries.length === 0) {
      scroller.createDiv({ cls: 'dita-site-nav-empty', text: labels.noTopics });
      return;
    }

    const list = tree.createEl('ul', { cls: 'dita-site-tree' });
    // Each surviving entry's original depth decides which open list it
    // belongs to; entries are already compacted and in reading order.
    const stack: Array<{ depth: number; list: HTMLElement }> = [{ depth: -1, list }];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      while (stack.length > 1 && stack[stack.length - 1].depth >= entry.depth) stack.pop();
      const parent = stack[stack.length - 1].list;
      const item = parent.createEl('li', { cls: 'dita-site-item' });
      const next = this.entries[i + 1];
      const hasChildren = next !== undefined && next.depth > entry.depth;

      if (entry.isGroup || !entry.absPath) {
        const group = item.createDiv({ cls: 'dita-site-group' });
        if (entry.role) group.createSpan({ cls: 'dita-site-role', text: entry.role });
        group.createSpan({ cls: 'dita-site-group-label', text: entry.title });
      } else {
        const link = item.createEl('a', { cls: 'dita-site-link', href: '#' });
        link.dataset.siteTarget = entry.absPath;
        if (entry.role) link.createSpan({ cls: 'dita-site-role', text: entry.role });
        link.createSpan({ cls: 'dita-site-label', text: entry.title });
        if (entry.absPath === this.currentPath) {
          link.addClass('is-active');
          link.setAttribute('aria-current', 'page');
        }
      }

      if (hasChildren) {
        const children = item.createEl('ul', { cls: 'dita-site-children' });
        stack.push({ depth: entry.depth, list: children });
      }
    }

    scroller.scrollTop = previousScroll;
    const active = scroller.querySelector<HTMLElement>('.dita-site-link.is-active');
    if (active) {
      // Keep the current page's row visible without moving the page itself.
      this.host.nextFrame(() => {
        if (!active.isConnected) return;
        const row = active.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        if (row.top < box.top) scroller.scrollTop -= box.top - row.top + 8;
        else if (row.bottom > box.bottom) scroller.scrollTop += row.bottom - box.bottom + 8;
      });
    }
  }

  /**
   * A row of the site's navigation tree. It is in the page's own document,
   * unlike the links in the preview, so Page Preview can anchor the popover
   * to the row itself and closes it when the pointer leaves.
   */
  onNavHover(evt: MouseEvent): void {
    const link = (evt.target as Element | null)?.closest<HTMLElement>('a[data-site-target]');
    const absPath = link?.dataset.siteTarget;
    const vaultRoot = this.host.vaultRoot();
    const file = this.host.file();
    if (!link || !absPath || !vaultRoot || !file) return;
    const target = resolveLinkTarget(vaultRoot, file.path, absPath);
    if (!target) return;
    this.host.app.workspace.trigger('hover-link', {
      event: evt,
      source: HOVER_SOURCE,
      hoverParent: this.host.hoverParent,
      targetEl: link,
      linktext: target.path,
      sourcePath: file.path,
    });
  }

  onNavClick(evt: MouseEvent): void {
    const link = (evt.target as Element | null)?.closest<HTMLElement>('[data-site-target]');
    const absPath = link?.dataset.siteTarget;
    if (!link || !absPath) return;
    evt.preventDefault();
    if (Keymap.isModEvent(evt)) {
      this.host.openSource(absPath, {}, evt);
      return;
    }
    this.openPage(absPath);
  }
}
