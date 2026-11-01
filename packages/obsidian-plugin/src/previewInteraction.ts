// What a click, a right-click or a key on the rendered page does.
//
// The preview is the reader's half of the view: links and outline rows open
// files, xrefs cross pages of a book or a site, the selection can be copied,
// and in split view a click puts the caret on the source of what it hit. The
// find bar (Ctrl/Cmd+F) is here too, because what it searches is the page.
//
// Nothing here is view state: the view owns the page, the editor, the sidebar
// and the jumps out of the page, and lends them through the host.

import { App, Keymap, Menu, TFile, normalizePath } from 'obsidian';
import { decodeHrefPart } from '@dita-viewer/core';
import { isExternalHref, resolveLinkTarget } from './linkTarget';
import { PreviewFind } from './previewFind';
import type { SiteNav } from './siteNav';
import type { SourceEditor } from './sourceEditor';
import type { SourceNavigation } from './sourceNavigation';
import { MODE_LABELS, panesFor } from './viewMode';
import type { ViewMode } from './viewMode';

export interface PreviewInteractionHost {
  readonly app: App;
  file(): TFile | null;
  mode(): ViewMode;
  vaultRoot(): string | undefined;
  /** The rendered page: what a click lands on and what a drag selects. */
  body(): HTMLElement | undefined;
  /** The shadow root the page is in; Chromium keeps its selection on the root. */
  shadow(): ShadowRoot | undefined;
  /** The box the shadow root is attached to (its events retarget to it). */
  host(): HTMLElement | undefined;
  /** Where the find bar goes. */
  container(): HTMLElement | undefined;
  /** The preview's scrolling box, which takes the focus back when the find bar closes. */
  scroller(): HTMLElement | undefined;
  /** The source editor, for the find bar when only the source shows. */
  editor(): SourceEditor | undefined;
  /** The site sidebar, whose pages a cross-page xref switches to. */
  site(): SiteNav | undefined;
  /** The jumps out of this page, and the way back from one. */
  nav(): SourceNavigation;
  setPreviewScroll(top: number): void;
  /** Revealing in the editor must not scroll the preview back. */
  quietSync(): void;
  goBack(): void;
  backMode(): ViewMode | undefined;
}

export class PreviewInteraction {
  private find?: PreviewFind;

  constructor(private readonly host: PreviewInteractionHost) {}

  /** The selection inside the preview. Chromium keeps selections within a shadow root on the root itself. */
  private selection(): Selection | null {
    const shadow = this.host.shadow() as unknown as { getSelection?: () => Selection | null } | undefined;
    const owner = this.host.host()?.ownerDocument;
    return shadow?.getSelection?.() ?? owner?.getSelection() ?? null;
  }

  /**
   * Obsidian's Find command (Ctrl/Cmd+F) calls this on any view that has it.
   * The preview gets a find bar of its own; with only the source showing the
   * editor's own search opens instead.
   */
  showSearch(): void {
    if (!panesFor(this.host.mode()).preview) {
      this.host.editor()?.openSearch();
      return;
    }
    const shadow = this.host.shadow();
    const body = this.host.body();
    const container = this.host.container();
    const scroller = this.host.scroller();
    if (!shadow || !body || !container || !scroller) return;
    this.find ??= new PreviewFind({
      shadow,
      body,
      barParent: container,
      selectedText: () => this.selection()?.toString() ?? '',
      onClose: () => scroller.focus({ preventScroll: true }),
    });
    this.find.open();
  }

  /** The page changed under the find bar (a render, a filter). */
  refreshFind(): void {
    this.find?.refresh();
  }

  /** The preview is going away: the bar goes with it. */
  closeFind(): void {
    this.find?.close();
  }

  destroy(): void {
    this.find?.destroy();
    this.find = undefined;
  }

  private selectAll(): void {
    const body = this.host.body();
    const sel = this.selection();
    if (body && sel) sel.selectAllChildren(body);
  }

  private async copySelection(): Promise<void> {
    const text = this.selection()?.toString() ?? '';
    if (text) await navigator.clipboard.writeText(text);
  }

  onKey(evt: KeyboardEvent): void {
    if ((evt.ctrlKey || evt.metaKey) && !evt.altKey && !evt.shiftKey && evt.key.toLowerCase() === 'a') {
      evt.preventDefault();
      this.selectAll();
      return;
    }
    if (evt.key !== 'Enter' && evt.key !== ' ' && evt.key !== 'Spacebar') return;
    // The listener sits outside the shadow root, so the target is retargeted
    // to the host; composedPath()[0] is the element the reader focused.
    const target = evt.composedPath()[0];
    const el = target instanceof Element ? target.closest('[data-conref]') : null;
    if (!el) return;
    evt.preventDefault();
    this.host.nav().jumpToConref(el);
  }

  onContextMenu(evt: MouseEvent): void {
    evt.preventDefault();
    const target = evt.target as Element | null;
    const entry = target?.closest('a.map-tree-link[data-href]');
    const mode = this.host.mode();
    const bookSection = mode === 'book' || mode === 'site' ? target?.closest('[data-dita-book-file]') : null;
    const hasSelection = (this.selection()?.toString() ?? '') !== '';
    const nav = this.host.nav();
    const menu = new Menu();
    // After "Reveal in source" the reader can come back from the same menu
    // they right-clicked in, not only from the header button.
    const back = this.host.backMode();
    if (back && back !== mode) {
      menu.addItem((item) =>
        item
          .setTitle(`Back to ${MODE_LABELS[back]}`)
          .setIcon('arrow-left')
          .onClick(() => this.host.goBack()),
      );
      menu.addSeparator();
    }
    if (entry) {
      const href = entry.getAttribute('data-href') ?? '';
      menu.addItem((item) => item.setTitle('Open').setIcon('file-text').onClick(() => this.openRelative(href)));
      menu.addItem((item) => item.setTitle('Reveal in source').setIcon('code').onClick(() => nav.revealOutlineEntry(href)));
      menu.addSeparator();
    } else if (bookSection) {
      // Book/site views have no outline rows; reveal the topic the reader
      // right-clicked.
      menu.addItem((item) =>
        item
          .setTitle('Reveal in source')
          .setIcon('code')
          .onClick(() => nav.revealBookSection(bookSection, target)),
      );
      menu.addSeparator();
    }
    menu.addItem((item) => item.setTitle('Copy').setIcon('copy').setDisabled(!hasSelection).onClick(() => void this.copySelection()));
    menu.addItem((item) => item.setTitle('Select all').setIcon('text-select').onClick(() => this.selectAll()));
    menu.showAtMouseEvent(evt);
  }

  onClick(evt: MouseEvent): void {
    const nav = this.host.nav();
    // A reuse badge wins over whatever it sits on: its background is the jump
    // affordance, the rest of the element still behaves normally.
    const conref = nav.conrefBadge(evt);
    if (conref) {
      evt.preventDefault();
      nav.jumpToConref(conref, evt);
      return;
    }
    // An outline entry: open the topic it points at. Its href is "#"; the real
    // target is in data-href, relative to the map.
    const entry = (evt.target as Element | null)?.closest('a.map-tree-link[data-href]');
    if (entry && this.host.file()) {
      evt.preventDefault();
      this.openRelative(entry.getAttribute('data-href') ?? '', evt);
      return;
    }
    // A cross-file xref inside the book: scroll to a section on this page.
    // Inside the site, switch to the target topic's page first.
    const bookRef = (evt.target as Element | null)?.closest('[data-dita-book-xref]');
    if (bookRef) {
      evt.preventDefault();
      const target = bookRef.getAttribute('data-dita-book-xref') ?? '';
      if (this.host.mode() === 'site') this.jumpInSite(target);
      else this.jumpInBook(target);
      return;
    }
    // A cross-file xref or related link in the single-topic preview: its href
    // is only the "#" placeholder, the real target is in data-dita-href.
    const linked = (evt.target as Element | null)?.closest('a[data-dita-href]');
    if (linked && this.host.file()) {
      evt.preventDefault();
      const target = linked.getAttribute('data-dita-href') ?? '';
      if (isExternalHref(target)) window.open(target, '_blank');
      else if (target && !target.startsWith('#')) {
        const section = linked.closest('[data-dita-book-file]');
        this.openRelative(target, evt, section?.getAttribute('data-dita-book-file') ?? undefined);
      }
      return;
    }
    const a = (evt.target as Element | null)?.closest('a[href]');
    if (!a || !this.host.file()) {
      this.jumpToSource(evt);
      return;
    }
    const href = a.getAttribute('href') ?? '';
    evt.preventDefault();

    if (isExternalHref(href)) {
      window.open(href, '_blank');
      return;
    }
    if (href.startsWith('#')) {
      this.host.shadow()?.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' });
      return;
    }
    // A plain link inside a book topic is relative to that topic, not to the
    // map; the section says which topic it is.
    const section = a.closest('[data-dita-book-file]');
    this.openRelative(href, evt, section?.getAttribute('data-dita-book-file') ?? undefined);
  }

  /**
   * Open a file named by a path relative to this document, in a new tab when
   * Ctrl/Cmd is held. `baseAbsPath` overrides the base (a book/site topic,
   * whose links are relative to the topic file rather than to the map).
   */
  private openRelative(href: string, evt?: MouseEvent, baseAbsPath?: string): void {
    const vaultRoot = this.host.vaultRoot();
    const file = this.host.file();
    if (!vaultRoot || !file) return;
    const link = resolveLinkTarget(vaultRoot, file.path, href, baseAbsPath);
    if (!link) return;
    const target = this.host.app.vault.getAbstractFileByPath(normalizePath(link.path));
    if (target instanceof TFile) {
      void this.host.app.workspace.getLeaf(evt ? Keymap.isModEvent(evt) : false).openFile(target);
    }
  }

  /**
   * Follow a cross-file xref rendered inside the book: scroll to the topic
   * section whose data-dita-book-file matches, then to the element id in it.
   * The link is only rendered for book members, so a miss means the page is
   * stale (the map changed since this HTML was made) -- open the topic.
   */
  private jumpInBook(target: string): void {
    if (!target) return;
    const hash = target.indexOf('#');
    const file = hash < 0 ? target : target.slice(0, hash);
    const id = hash < 0 ? '' : decodeHrefPart(target.slice(hash + 1));
    let section: Element | undefined;
    this.host.shadow()?.querySelectorAll('[data-dita-book-file]').forEach((el) => {
      if (!section && el.getAttribute('data-dita-book-file') === file) section = el;
    });
    if (!section) {
      if (file) this.host.nav().openSource(file, {});
      return;
    }
    const anchor = id ? Array.from(section.querySelectorAll('[id]')).find((el) => el.id === id) : undefined;
    (anchor ?? section).scrollIntoView({ block: 'start' });
  }

  /**
   * Follow a cross-file xref rendered inside the site: switch to the target
   * page, then scroll to its element id. A target that is not in the sidebar
   * means the manifest is stale -- open the topic instead.
   */
  private jumpInSite(target: string): void {
    if (!target) return;
    const hash = target.indexOf('#');
    const file = hash < 0 ? target : target.slice(0, hash);
    const id = hash < 0 ? '' : decodeHrefPart(target.slice(hash + 1));
    const site = this.host.site();
    if (!site) return;
    if (file && file !== site.current) {
      if (site.hasPage(file)) {
        site.openPage(file, id || undefined);
        return;
      }
      if (file) this.host.nav().openSource(file, id ? { id } : {});
      return;
    }
    if (id) site.scrollToAnchor(id);
    else this.host.setPreviewScroll(0);
  }

  /** Side by side, clicking the preview puts the caret at that element's source. */
  private jumpToSource(evt: MouseEvent): void {
    if (this.host.mode() !== 'split') return;
    const owner = this.host.host()?.ownerDocument;
    if (owner?.getSelection()?.isCollapsed === false) return; // the user is selecting text
    const el = (evt.target as Element | null)?.closest('[data-line]');
    if (!el) return;
    const line = Number(el.getAttribute('data-line'));
    const col = Number(el.getAttribute('data-start-col') ?? 0);
    if (!Number.isFinite(line)) return;
    // Revealing scrolls the editor; without this the echo would scroll the preview back.
    this.host.quietSync();
    this.host.editor()?.reveal(line, Number.isFinite(col) ? col : 0);
  }
}
