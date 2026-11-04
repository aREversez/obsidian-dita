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

import type { App, HoverParent, HoverPopover, Point, TFile } from 'obsidian';
import { isExternalHref, resolveLinkTarget } from './linkTarget';
import { HOVER_SOURCE } from './hoverSource';

/** How long the pointer may be off a link before its popover closes. */
const HIDE_DELAY_MS = 300;

/** Close a hover popover. `hide` is not in Obsidian's typings, so it is looked for; a popover without it just times out as usual. */
function hidePopover(popover: HoverPopover | null): void {
  (popover as unknown as { hide?: () => void } | null)?.hide?.();
}

/**
 * Give a popover the point to open at, and let it place itself from there.
 *
 * Page Preview positions a popover from the last pointer it saw and, without
 * one, from the element the request named. Every link here names the preview's
 * box, so a request that arrives without a pointer puts the popover at the top
 * of the window, showing the top of the page. The point is stored on the
 * popover, so its later passes (content loaded, resized) keep it too.
 *
 * A popover that already has a position is left alone. Both members are in
 * Obsidian's implementation, not its typings; a popover without them keeps
 * Obsidian's own placement.
 */
export function anchorPopover(popover: HoverPopover, point: Point): void {
  const internal = popover as unknown as { staticPos?: Point | null; position?: () => void };
  if (internal.staticPos || typeof internal.position !== 'function') return;
  internal.staticPos = point;
  internal.position();
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
  private popover: HoverPopover | null = null;
  /** The link the pointer is over, so a new one is told from the same one. */
  private link?: Element;
  /** Where the pointer was when the link was entered: where its popover belongs. */
  private pointer?: Point;
  private hideTimer = 0;

  constructor(private readonly host: HoverPreviewHost) {}

  get hoverPopover(): HoverPopover | null {
    return this.popover;
  }

  /** Page Preview hands the popover back here once it has opened it, and takes it away when it closes. */
  set hoverPopover(popover: HoverPopover | null) {
    this.popover = popover;
    // The view is the hover parent of the site navigation too; only a popover
    // asked for over the preview's box belongs to a pointer seen in the preview.
    const target = (popover as unknown as { targetEl?: Element | null } | null)?.targetEl;
    const host = this.host.host();
    if (popover && this.pointer && host && target === host) anchorPopover(popover, this.pointer);
  }

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
    const host = this.host.host();
    const link = this.targetAt(evt.target);
    // Where the popover goes: Page Preview reads the pointer from the event
    // only for requests it makes itself, and for the preview's links it has
    // the preview's box instead. Keep the point the request was made from.
    if (link && host) this.pointer = { x: evt.clientX, y: evt.clientY };
    if (link?.el === this.link) return;
    this.link = link?.el;
    window.clearTimeout(this.hideTimer);
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
