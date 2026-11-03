// Page Preview over the links in the rendered page.
//
// Page Preview only keeps a popover over an element in the page's own
// document, and a link in the preview is inside a shadow root; so the popover
// is anchored to the preview's host element, and what that cannot express (the
// pointer leaving the link for other text in the preview, or going from one
// link to the next) is done here.
//
// The popover itself is stored where Obsidian puts it, on the HoverParent the
// view passes; that is why the view lends this one field through an accessor
// rather than keeping a copy.

import type { App, HoverParent, HoverPopover, TFile } from 'obsidian';
import { isExternalHref, resolveLinkTarget } from './linkTarget';
import { HOVER_SOURCE } from './hoverSource';

/** How long the pointer may be off a link before its popover closes. */
const HIDE_DELAY_MS = 300;

/** Close a hover popover. `hide` is not in Obsidian's typings, so it is looked for; a popover without it just times out as usual. */
function hidePopover(popover: HoverPopover | null): void {
  (popover as unknown as { hide?: () => void } | null)?.hide?.();
}

export interface HoverPreviewHost {
  readonly app: App;
  /** The view, which is what Obsidian hands the popover back to. */
  readonly hoverParent: HoverParent;
  file(): TFile | null;
  /** The element the popover is anchored to: the preview's own box. */
  host(): HTMLElement | undefined;
  vaultRoot(): string | undefined;
}

export class HoverPreview {
  /** Obsidian's Page Preview keeps the popover it opens over one of this view's links here. */
  hoverPopover: HoverPopover | null = null;
  /** The link the pointer is over, so a new one is told from the same one. */
  private link?: Element;
  private hideTimer = 0;

  constructor(private readonly host: HoverPreviewHost) {}

  /**
   * The pointer left the preview altogether (Page Preview closes the popover
   * itself): the next link is a new one.
   */
  left(): void {
    this.link = undefined;
  }

  /**
   * The pointer moved over the preview: over a link to another DITA file, ask
   * Page Preview for its popover (it applies the "require Ctrl" setting).
   */
  onMove(evt: MouseEvent): void {
    const link = this.targetAt(evt.target);
    if (link?.el === this.link) return;
    this.link = link?.el;
    window.clearTimeout(this.hideTimer);
    const host = this.host.host();
    const file = this.host.file();
    if (!link || !host || !file) {
      this.hideTimer = window.setTimeout(() => {
        const popover = this.hoverPopover;
        if (popover && !this.link && !popover.hoverEl.matches(':hover')) hidePopover(popover);
      }, HIDE_DELAY_MS);
      return;
    }
    // Another link: the popover for the last one goes, and so does a request
    // still waiting for Ctrl (Page Preview drops those on the next mouseover
    // that is not over its target, which for a shadow root is this host).
    hidePopover(this.hoverPopover);
    host.ownerDocument.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    this.host.app.workspace.trigger('hover-link', {
      event: evt,
      source: HOVER_SOURCE,
      hoverParent: this.host.hoverParent,
      targetEl: host,
      linktext: link.linktext,
      sourcePath: file.path,
    });
  }

  /** The popover is gone or the view is closing: nothing left to watch. */
  destroy(): void {
    window.clearTimeout(this.hideTimer);
    hidePopover(this.hoverPopover);
  }

  /** The link under the pointer that leads to another DITA file, and the Obsidian link text for it. */
  private targetAt(target: EventTarget | null): { el: Element; linktext: string } | undefined {
    const vaultRoot = this.host.vaultRoot();
    const file = this.host.file();
    const el = target instanceof Element ? target : null;
    if (!el || !vaultRoot || !file) return undefined;
    const base = (a: Element): string | undefined => a.closest('[data-dita-book-file]')?.getAttribute('data-dita-book-file') ?? undefined;
    // The first selector that matches the link names where it goes; a "#" placeholder href never does.
    const link =
      el.closest('a.map-tree-link[data-href]') ??
      el.closest('[data-dita-book-xref]') ??
      el.closest('a[data-dita-href]') ??
      el.closest('a[href]');
    if (!link) return undefined;
    const href =
      link.getAttribute('data-href') ?? link.getAttribute('data-dita-book-xref') ?? link.getAttribute('data-dita-href') ?? link.getAttribute('href') ?? '';
    if (!href || isExternalHref(href) || href.startsWith('#')) return undefined;
    const target_ = resolveLinkTarget(vaultRoot, file.path, href, base(link));
    if (!target_) return undefined;
    return { el: link, linktext: target_.fragment ? `${target_.path}#${target_.fragment}` : target_.path };
  }
}
