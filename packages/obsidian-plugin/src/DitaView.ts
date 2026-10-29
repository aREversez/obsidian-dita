import { FileSystemAdapter, Keymap, Menu, Notice, TFile, TextFileView, ViewStateResult, WorkspaceLeaf, moment, normalizePath, setIcon } from 'obsidian';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import coreCss from '@dita-viewer/core/styles/dita-content.css';
import adapterCss from './theme/obsidian-adapter.css';
import { collectDiagnostics, decodeHrefPart, getKeyDefs, isExcluded, profileGroups, profileValuesOfKeys, splitRefFragment } from '@dita-viewer/core';
import type { Ditaval, ProfileFilter, ProfileGroup, SiteNavEntry } from '@dita-viewer/core';
import { renderBookFile, renderDitaFile, renderDitamapFile, renderSiteFile } from './renderFile';
import type { RenderFileResult } from './renderFile';
import { siteLabels } from './roleLabels';
import { SettingsProvider } from './settings';
import { MODE_ICONS, MODE_LABELS, ViewMode, modesFor, panesFor, parseViewMode, previewKindFor, toggleMode } from './viewMode';
import { SourceEditor, createSourceEditor } from './sourceEditor';
import { createCompletionEnv } from './completionEnv';
import { ditaCompletionSource } from './completionSource';
import { EchoGuard, lineForPreviewOffset, Anchor, isOffsetVisible, previewOffsetForLine } from './syncLines';
import { Debounced, debounce } from './debounce';
import { ProblemRange, problemRanges } from './sourceDiagnostics';
import { SourceReference, positionOfId } from './references';
import { createIdReader } from './fileIds';
import { badgeBox, badgeHit, conrefKindOf } from './conrefJump';
import { outlineEntryPosition } from './mapOutline';
import { detectEol, toLf, withEol } from './lineEndings';
import type { Eol } from './lineEndings';
import { refreshOutlines } from './outlinePatch';
import { StructureSpec, WrapSpec } from './snippetsData';
import { insertStructure, wrapSelection } from './snippets';
import {
  DEFAULT_PROFILE_STATE,
  ProfileState,
  buildFilter,
  isDefaultProfileState,
  listDitavalFiles,
  loadDitaval,
  normalizeProfileState,
  resolveDitavalPath,
} from './profileState';
import { ProfilePanel } from './profilePanel';
import type { ProfilePanelHost } from './profilePanel';
import { DitavalPicker } from './pickers';

export const VIEW_TYPE_DITA = 'dita-viewer-topic';

// One pair of stylesheets per window, shared by every preview in it.
// Constructable sheets are parsed once and adopted by each shadow root; they
// cannot cross documents, so a popout window gets its own pair.
const sheetsByDocument = new WeakMap<Document, CSSStyleSheet[]>();
function getSheets(doc: Document): CSSStyleSheet[] {
  let sheets = sheetsByDocument.get(doc);
  if (!sheets) {
    const win = doc.defaultView ?? window;
    sheets = [coreCss, adapterCss].map((css) => {
      const s = new win.CSSStyleSheet();
      s.replaceSync(css);
      return s;
    });
    sheetsByDocument.set(doc, sheets);
  }
  return sheets;
}

/** After the preview is told to jump to a line, ignore the editor's own scroll echo for this long. */
const SYNC_QUIET_MS = 250;

/** The key a keyref/conkeyref names: everything before the first '/'. */
function keyNameOf(value: string): string {
  const slash = value.indexOf('/');
  return (slash < 0 ? value : value.slice(0, slash)).trim();
}

/** The path part of an href, percent-decoded and without a query or fragment. */
function pathOf(href: string): string {
  const hash = href.indexOf('#');
  return decodeHrefPart((hash < 0 ? href : href.slice(0, hash)).split('?')[0]);
}

/** The decoded #fragment of an href, or ''. */
function fragmentOf(href: string): string {
  const hash = href.indexOf('#');
  return hash < 0 ? '' : decodeHrefPart(href.slice(hash + 1));
}

/**
 * Reading view, source editor, side-by-side live preview, and the map site
 * and book views for DITA topics and maps.
 *
 * Reading view and the preview pane render the topic inside a Shadow DOM.
 * Obsidian theme selectors (which target things like `table`, `code`, `a`
 * under .markdown-rendered, or even bare elements) cannot reach into it; the
 * theme's CSS *variables* do pass through, and the adapter stylesheet turns
 * them into the preview's look. The source editor is a CodeMirror view styled
 * from the same variables (sourceEditor.ts).
 *
 * The text lives in `this.data` (TextFileView), which the editor keeps in
 * step with what is on screen; Obsidian saves it, and reloads it when the
 * file changes on disk.
 */
export class DitaView extends TextFileView {
  private mode: ViewMode;
  private container!: HTMLElement;
  private errorEl!: HTMLElement;
  private editorEl!: HTMLElement;
  private scroller!: HTMLElement;
  private host!: HTMLElement;
  private shadow!: ShadowRoot;
  private body!: HTMLElement;
  private editor!: SourceEditor;
  private modeAction!: HTMLElement;
  /** Shown only while a reveal has a view to go back to. */
  private backAction!: HTMLElement;
  /** The site sidebar, outside the preview's Shadow DOM. */
  private siteNav!: HTMLElement;
  private sitePrevAction!: HTMLElement;
  private siteNextAction!: HTMLElement;
  private siteEntries: SiteNavEntry[] = [];
  private sitePages: Array<{ absPath: string; title: string }> = [];
  private siteCurrent?: string;
  /** The page the preview actually shows; siteCurrent is where the reader asked to go. */
  private siteShown?: string;
  /** Raw topic titles by file, so unnamed topics are not re-read on every render. */
  private readonly siteTitleCache = new Map<string, { stamp: string; title: string | null }>();
  private siteMapTitle?: string;
  /** Relative path of the map the site state above describes. */
  private siteMapPath?: string;
  /** Element id to reveal after the next site page is in the DOM. */
  private sitePendingAnchor?: string;
  /** Makes each rebuilt sidebar's accessible title id unique in the document. */
  private siteNavTitleSeq = 0;

  private dependencies = new Set<string>();
  /** Files the last diagnostics run read (reference targets, key maps). */
  private lintDependencies = new Set<string>();
  private rendering = false;
  private renderAgain = false;
  /** The preview does not show the current text (it was edited while no preview was visible, or since the last render). */
  private previewStale = true;
  private readonly scheduleRender: Debounced;
  /** The Outline pane lists headings parsed from the text, so it follows typing after a pause too. */
  private readonly scheduleOutlineRefresh: Debounced;
  private syncFrame = 0;
  private quietUntil = 0;
  /** Our own scroll moves of the preview and of the editor, so their echoes are not taken for the user's. */
  private readonly previewEcho = new EchoGuard();
  private readonly editorEcho = new EchoGuard();
  private syncEditorFrame = 0;
  private readonly idReader = createIdReader();
  /** A reveal requested through setEphemeralState, applied once the text is loaded. */
  private pendingReveal?: { line?: number; col?: number; id?: string };
  /** The view to offer as "Back" after a reveal switched this pane to split. */
  private revealReturnMode?: ViewMode;
  /** The line ending of the file on disk; the editor itself only knows \n. */
  private eol: Eol = '\n';

  // ── conditional processing ──
  private profile: ProfileState = { ...DEFAULT_PROFILE_STATE, hidden: [] };
  /** The chosen .ditaval as parsed; undefined when none is chosen or it did not read cleanly. */
  private ditaval?: Ditaval;
  private ditavalAbs?: string;
  private ditavalError?: string;
  /** Elements the filter hides in the page on screen. */
  private filteredCount = 0;
  private profileAction!: HTMLElement;
  private profilePanel?: ProfilePanel;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: SettingsProvider) {
    super(leaf);
    this.mode = plugin.settings.defaultMode;
    this.scheduleRender = debounce(() => void this.render(), () => this.plugin.settings.previewDelayMs);
    this.scheduleOutlineRefresh = debounce(() => refreshOutlines(this.app, this.file), () => this.plugin.settings.previewDelayMs);
  }

  getViewType(): string {
    return VIEW_TYPE_DITA;
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'DITA';
  }

  /** True for a .ditamap, the only file that has site or book view. */
  isMapFile(): boolean {
    return this.file?.extension.toLowerCase() === 'ditamap';
  }

  getIcon(): string {
    return 'file-text';
  }

  canAcceptExtension(extension: string): boolean {
    return extension === 'dita' || extension === 'ditamap';
  }

  // ── lifecycle ──

  async onOpen(): Promise<void> {
    // The pane is ours from edge to edge: Obsidian gives .view-content padding
    // and a scrollbar of its own (it turns both off for markdown views), and
    // the preview scrolls itself. Left alone, that is a second scrollbar beside
    // the real one, with its bottom padding as blank space scrolling under the
    // text. styles.css takes the pane back for this view type.
    this.contentEl.addClass('dita-pane');
    this.container = this.contentEl.createDiv({ cls: 'dita-container' });
    this.errorEl = this.container.createDiv({ cls: 'dita-error' });
    this.errorEl.hide();
    const panes = this.container.createDiv({ cls: 'dita-panes' });
    this.editorEl = panes.createDiv({ cls: 'dita-source' });
    this.siteNav = panes.createDiv({ cls: 'dita-site-nav' });
    this.siteNav.addEventListener('click', (evt) => this.onSiteNavClick(evt as MouseEvent));
    this.scroller = panes.createDiv({ cls: 'dita-scroller' });
    this.host = this.scroller.createDiv({ cls: 'dita-view' });
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.adoptedStyleSheets = getSheets(this.host.ownerDocument);
    this.body = this.shadow.createDiv({ cls: 'dita-body' });
    this.body.id = 'dita-content-root';
    // Every reuse badge points its aria-describedby here; the class clips the
    // node visually but keeps it in the accessibility tree.
    const conrefHint = this.shadow.createDiv({ cls: 'dv-visually-hidden', text: 'Jump to the source of the reused content' });
    conrefHint.id = 'dv-conref-jump-hint';
    this.shadow.addEventListener('click', (evt) => this.onClick(evt as MouseEvent));
    this.shadow.addEventListener('contextmenu', (evt) => this.onContextMenu(evt as MouseEvent));
    this.shadow.addEventListener('pointermove', (evt) => this.onConrefHover(evt as PointerEvent));
    this.host.addEventListener('pointerleave', () => this.host.classList.remove('dv-conref-hot'));
    // Focusable by click, so Ctrl/Cmd+A selects the topic rather than the whole app.
    this.scroller.tabIndex = -1;
    this.scroller.addEventListener('keydown', (evt) => this.onPreviewKey(evt));
    this.scroller.addEventListener('scroll', () => this.queueSyncToEditor(), { passive: true });

    this.editor = createSourceEditor(this.editorEl, {
      text: this.data ?? '',
      onChange: (text) => this.onEdited(text),
      onScroll: () => this.queueSyncToPreview(),
      onCursorLine: (line) => this.revealInPreview(line),
      completion: ditaCompletionSource(() => this.completionEnv()),
      lint: (text) => this.lintSource(text),
      onReference: (ref, evt) => this.openReference(ref, evt),
    });

    this.backAction = this.addAction('arrow-left', 'Back to the previous view', () => this.goBack());
    this.backAction.style.display = 'none';
    this.sitePrevAction = this.addAction('chevron-left', 'Previous topic', () => this.stepSite(-1));
    this.sitePrevAction.addClass('dita-site-step');
    this.siteNextAction = this.addAction('chevron-right', 'Next topic', () => this.stepSite(1));
    this.siteNextAction.addClass('dita-site-step');
    this.modeAction = this.addAction(MODE_ICONS[this.mode], 'View mode', (evt) => this.showModeMenu(evt));
    this.profileAction = this.addAction('filter', 'Conditional processing', () => this.toggleProfilePanel());
    this.profileAction.addClass('dita-profile-action');
    this.profilePanel = new ProfilePanel(
      this.container,
      this.profileHost(),
      // The header button toggles the panel itself, and the DITAVAL picker is a
      // modal: clicking in either must not count as clicking away.
      (target) => this.profileAction.contains(target) || (target instanceof Element && target.closest('.modal-container') !== null),
      () => this.updateProfileAction(),
    );
    this.reloadDitaval();
    this.updateProfileAction();
    this.updateScheme();
    this.applyMode();
    this.applyPendingReveal();
  }

  private envCache?: { path: string; env: ReturnType<typeof createCompletionEnv> };

  private completionEnv(): ReturnType<typeof createCompletionEnv> | undefined {
    const file = this.file;
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (!file || !adapter.getBasePath) return undefined;
    if (this.envCache?.path !== file.path) {
      const vaultRoot = adapter.getBasePath();
      this.envCache = {
        path: file.path,
        env: createCompletionEnv({ absPath: join(vaultRoot, file.path), vaultRoot, isMap: file.extension === 'ditamap' }),
      };
    }
    return this.envCache.env;
  }

  /**
   * The key values this file's keyrefs resolve against, for the Outline: the
   * same briefly-cached key space the preview renders with, so a row and the
   * page cannot show different product names.
   */
  outlineKeys(): ReadonlyMap<string, string> | undefined {
    return this.completionEnv()?.keys();
  }

  async onClose(): Promise<void> {
    this.scheduleRender.cancel();
    this.scheduleOutlineRefresh.cancel();
    if (this.syncFrame) cancelAnimationFrame(this.syncFrame);
    if (this.syncEditorFrame) cancelAnimationFrame(this.syncEditorFrame);
    this.profilePanel?.destroy();
    this.editor?.destroy();
  }

  // ── TextFileView contract ──

  getViewData(): string {
    const text = this.editor ? this.editor.getText() : this.data;
    // The editor's document is always \n-separated, and this string is what
    // Obsidian writes back on save and compares with the file it read. Handing
    // back \n unconditionally is what quietly turned a CRLF .dita file into an
    // LF one: one keystroke, one save, and every line ending changed.
    return withEol(text, this.eol);
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    // Whatever the file uses, so a save writes it back the same way.
    this.eol = detectEol(data);
    // A leaf can be re-used for another file: a topic has no site or book view.
    if (this.file && (this.mode === 'site' || this.mode === 'book') && !this.isMapFile()) {
      this.mode = 'reading';
      this.revealReturnMode = undefined;
      if (this.container) this.applyMode();
    }
    // Site state describes one map. Reusing the leaf for another map starts
    // from that map's first topic instead of carrying the old page along.
    if (this.file && this.siteMapPath !== undefined && this.siteMapPath !== this.file.path) {
      this.resetSiteState();
    }
    this.scheduleRender.cancel();
    if (!this.editor) {
      // onOpen has not run yet; it seeds the editor from this.data
      refreshOutlines(this.app, this.file);
      return;
    }
    // The editor's text is \n-only; handing it the file's CRLF would make an
    // unchanged file differ from it at every line end, and the merge below
    // would rewrite the document from the first line on.
    this.editor.load(toLf(data), clear);
    this.previewStale = true;
    refreshOutlines(this.app, this.file);
    this.applyPendingReveal();
    // A load is not a keystroke: show it now rather than after the typing delay.
    if (panesFor(this.mode).preview) void this.render();
  }

  clear(): void {
    this.data = '';
    this.pendingReveal = undefined;
    this.revealReturnMode = undefined;
    this.updateBackAction();
    this.scheduleRender.cancel();
    this.editor?.load('', true);
    this.body?.replaceChildren();
    this.filteredCount = 0;
    this.updateProfileAction();
    this.resetSiteState();
    this.dependencies.clear();
    this.lintDependencies.clear();
    this.showError(undefined);
    this.previewStale = true;
  }

  // ── mode ──

  getMode(): ViewMode {
    return this.mode;
  }

  setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    // Site and book views need a whole map; never put a single topic in them.
    if ((mode === 'site' || mode === 'book') && !this.isMapFile()) return;
    // Topic outline, site page and merged book all share the preview pane but
    // show different documents. Crossing that boundary needs a re-render even
    // when the source is unchanged.
    if (previewKindFor(mode) !== previewKindFor(this.mode)) {
      this.previewStale = true;
      if (mode === 'site') this.setPreviewScroll(0);
    }
    // Any deliberate mode change ends the "Back to ..." offer; showSource
    // records a new one after switching to split.
    this.revealReturnMode = undefined;
    this.mode = mode;
    this.applyMode();
    this.app.workspace.requestSaveLayout();
  }

  toggleMode(): void {
    this.setMode(toggleMode(this.mode));
  }

  getState(): Record<string, unknown> {
    const state: Record<string, unknown> = { ...super.getState(), mode: this.mode };
    // A pane with no filter saves nothing extra.
    if (!isDefaultProfileState(this.profile)) state.profiling = this.profile;
    return state;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const saved = state as { mode?: unknown; profiling?: unknown } | null;
    this.mode = parseViewMode(saved?.mode, this.mode);
    // Like the mode, the filter stays with the pane when the state names none.
    if (saved && 'profiling' in saved) {
      this.profile = normalizeProfileState(saved.profiling);
      this.reloadDitaval();
      if (this.container) this.applyProfileState();
    }
    if (this.container) this.applyMode();
    await super.setState(state, result);
  }

  /** Where to put the caret when another view opens this file (conref jump, Ctrl/Cmd+click). */
  setEphemeralState(state: unknown): void {
    const saved = (state ?? {}) as { ditaLine?: unknown; ditaCol?: unknown; ditaId?: unknown; line?: unknown };
    const line = typeof saved.ditaLine === 'number' && Number.isFinite(saved.ditaLine) ? saved.ditaLine : undefined;
    const col = typeof saved.ditaCol === 'number' && Number.isFinite(saved.ditaCol) ? saved.ditaCol : undefined;
    const id = typeof saved.ditaId === 'string' && saved.ditaId ? saved.ditaId : undefined;
    if (line === undefined && id === undefined) {
      // A plain `line` is how Obsidian's own Outline (and a link to a line) asks for a position.
      if (typeof saved.line === 'number' && Number.isFinite(saved.line)) this.goToLine(saved.line);
      return;
    }
    this.pendingReveal = { line, col, id };
    this.applyPendingReveal();
  }

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    menu.addSeparator();
    this.addModeItems(menu);
  }

  private showModeMenu(evt: MouseEvent): void {
    const menu = new Menu();
    this.addModeItems(menu);
    menu.showAtMouseEvent(evt);
  }

  /** The mode list, prefixed by "Back to ..." after a reveal changed the view. */
  private addModeItems(menu: Menu): void {
    const back = this.revealReturnMode;
    if (back && back !== this.mode) {
      menu.addItem((item) =>
        item
          .setTitle(`Back to ${MODE_LABELS[back]}`)
          .setIcon('arrow-left')
          .onClick(() => this.setMode(back)),
      );
      menu.addSeparator();
    }
    for (const m of modesFor(this.isMapFile())) {
      menu.addItem((item) => item.setTitle(MODE_LABELS[m]).setIcon(MODE_ICONS[m]).setChecked(m === this.mode).onClick(() => this.setMode(m)));
    }
  }

  private applyMode(): void {
    const panes = panesFor(this.mode);
    this.container.dataset.mode = this.mode;
    // A site page sits beside its sidebar, so it takes the sidebar header's
    // top padding instead of the full-pane reading padding.
    this.body?.classList.toggle('dita-body--site', this.mode === 'site');
    setIcon(this.modeAction, MODE_ICONS[this.mode]);
    this.modeAction.setAttribute('aria-label', MODE_LABELS[this.mode]);
    this.sitePrevAction.style.display = this.mode === 'site' ? '' : 'none';
    this.siteNextAction.style.display = this.mode === 'site' ? '' : 'none';
    this.updateSiteNavActions();
    this.updateBackAction();
    // Conditional processing acts on the preview; with only the source showing there is nothing to filter.
    this.profileAction.style.display = panes.preview ? '' : 'none';
    if (!panes.preview) this.profilePanel?.close();
    // Typing while only the source was showing left the preview behind.
    if (panes.preview && this.previewStale && this.file) void this.render();
    if (panes.editor) {
      // CodeMirror cannot measure while hidden; once visible, measure and line up the preview.
      requestAnimationFrame(() => {
        this.editor.remeasure();
        if (this.mode === 'split') this.syncPreviewToEditor();
      });
    }
  }

  /** Return to the view a reveal replaced, if there is one. */
  private goBack(): void {
    if (this.revealReturnMode) this.setMode(this.revealReturnMode);
  }

  /** Show the header Back button and name its destination. */
  private updateBackAction(): void {
    if (!this.backAction) return;
    const back = this.revealReturnMode;
    const show = back !== undefined && back !== this.mode;
    this.backAction.style.display = show ? '' : 'none';
    if (show) this.backAction.setAttribute('aria-label', `Back to ${MODE_LABELS[back]}`);
  }

  // ── site navigation ──

  /** Forget the current map's sidebar/page state (new file, or clear()). */
  private resetSiteState(): void {
    this.siteEntries = [];
    this.sitePages = [];
    this.siteCurrent = undefined;
    this.siteShown = undefined;
    this.siteTitleCache.clear();
    this.siteMapTitle = undefined;
    this.siteMapPath = undefined;
    this.sitePendingAnchor = undefined;
    this.siteNav?.replaceChildren();
    this.updateSiteNavActions();
  }

  /** Rebuild the sidebar from the manifest the last site render returned. */
  private renderSiteNav(): void {
    if (!this.siteNav) return;
    const previousScroll = this.siteNav.querySelector<HTMLElement>('.dita-site-nav-scroll')?.scrollTop ?? 0;
    this.siteNav.replaceChildren();

    const header = this.siteNav.createDiv({ cls: 'dita-site-nav-header' });
    const title = header.createDiv({
      cls: 'dita-site-nav-title',
      text: this.siteMapTitle ?? this.file?.basename ?? 'Site',
    });
    const titleId = `dita-site-nav-title-${++this.siteNavTitleSeq}`;
    title.id = titleId;

    const scroller = this.siteNav.createDiv({ cls: 'dita-site-nav-scroll' });
    const tree = scroller.createEl('nav', { cls: 'dita-site-nav-tree' });
    const labels = siteLabels(moment.locale());
    // Label the navigation landmark from the visible map title. Do not use
    // aria-label here: Obsidian turns any aria-label into a hover tooltip, and
    // the nav covers the whole sidebar, so it would pop up over every row.
    tree.setAttribute('aria-labelledby', titleId);
    if (this.siteEntries.length === 0) {
      scroller.createDiv({ cls: 'dita-site-nav-empty', text: labels.noTopics });
      return;
    }

    const list = tree.createEl('ul', { cls: 'dita-site-tree' });
    // Each surviving entry's original depth decides which open list it
    // belongs to; entries are already compacted and in reading order.
    const stack: Array<{ depth: number; list: HTMLElement }> = [{ depth: -1, list }];
    for (let i = 0; i < this.siteEntries.length; i++) {
      const entry = this.siteEntries[i];
      while (stack.length > 1 && stack[stack.length - 1].depth >= entry.depth) stack.pop();
      const parent = stack[stack.length - 1].list;
      const item = parent.createEl('li', { cls: 'dita-site-item' });
      const next = this.siteEntries[i + 1];
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
        if (entry.absPath === this.siteCurrent) {
          link.addClass('is-active');
          link.setAttribute('aria-current', 'page');
        }
      }

      if (hasChildren) {
        const children = item.createEl('ul', { cls: 'dita-site-children' });
        stack.push({ depth: entry.depth, list: children });
      }
    }

    const scroll = scroller;
    scroll.scrollTop = previousScroll;
    const active = scroller.querySelector<HTMLElement>('.dita-site-link.is-active');
    if (active) {
      // Keep the current page's row visible without moving the page itself.
      requestAnimationFrame(() => {
        if (!active.isConnected) return;
        const row = active.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        if (row.top < box.top) scroll.scrollTop -= box.top - row.top + 8;
        else if (row.bottom > box.bottom) scroll.scrollTop += row.bottom - box.bottom + 8;
      });
    }
  }

  private onSiteNavClick(evt: MouseEvent): void {
    const link = (evt.target as Element | null)?.closest<HTMLElement>('[data-site-target]');
    const absPath = link?.dataset.siteTarget;
    if (!link || !absPath) return;
    evt.preventDefault();
    if (Keymap.isModEvent(evt)) {
      this.openSource(absPath, {}, evt);
      return;
    }
    this.openSitePage(absPath);
  }

  /** Show/hide and enable the header's previous/next topic buttons. */
  private updateSiteNavActions(): void {
    if (!this.sitePrevAction || !this.siteNextAction) return;
    const isSite = this.mode === 'site';
    this.sitePrevAction.style.display = isSite ? '' : 'none';
    this.siteNextAction.style.display = isSite ? '' : 'none';
    if (!isSite) return;

    const index = this.sitePages.findIndex((page) => page.absPath === this.siteCurrent);
    const previous = index > 0 ? this.sitePages[index - 1] : undefined;
    const next = index >= 0 ? this.sitePages[index + 1] : undefined;
    this.setSiteAction(this.sitePrevAction, previous, 'Previous topic');
    this.setSiteAction(this.siteNextAction, next, 'Next topic');
  }

  private setSiteAction(action: HTMLElement, target: { title: string } | undefined, fallback: string): void {
    const disabled = target === undefined;
    action.toggleClass('is-disabled', disabled);
    action.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    action.setAttribute('aria-label', target ? `${fallback}: ${target.title}` : fallback);
  }

  private stepSite(delta: number): void {
    const index = this.sitePages.findIndex((page) => page.absPath === this.siteCurrent);
    const target = this.sitePages[index + delta];
    if (target) this.openSitePage(target.absPath);
  }

  /** Switch the site to one topic page, optionally scrolling to an id in it. */
  private openSitePage(absPath: string, anchor?: string): void {
    if (this.mode !== 'site' || !absPath) return;
    if (absPath === this.siteCurrent) {
      if (anchor) this.scrollToSiteAnchor(anchor);
      else this.setPreviewScroll(0);
      return;
    }
    this.siteCurrent = absPath;
    this.sitePendingAnchor = anchor;
    this.setPreviewScroll(0);
    this.previewStale = true;
    if (panesFor(this.mode).preview) void this.render();
  }

  private scrollToSiteAnchor(id: string): void {
    const decoded = decodeHrefPart(id);
    if (!decoded) return;
    const anchor = this.shadow.getElementById(decoded);
    anchor?.scrollIntoView({ block: 'start' });
  }

  // ── editing ──

  private onEdited(text: string): void {
    this.data = text;
    this.requestSave();
    this.previewStale = true;
    this.scheduleOutlineRefresh();
    if (panesFor(this.mode).preview) this.scheduleRender();
  }

  /** True when the source pane is showing, for commands that edit the text. */
  hasSource(): boolean {
    return panesFor(this.mode).editor;
  }

  /** Wrap the selection in `spec`; with nothing selected, leave an empty element. */
  applyWrap(spec: WrapSpec): void {
    const view = this.editor?.view;
    if (!view) return;
    const sel = view.state.selection.main;
    const edit = wrapSelection(view.state.sliceDoc(sel.from, sel.to), spec);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: edit.insert },
      selection: { anchor: sel.from + edit.caret, head: sel.from + edit.caret + edit.select },
      scrollIntoView: true,
    });
    view.focus();
  }

  /** Insert `spec`'s template at the caret, indented like the current line. */
  applyStructure(spec: StructureSpec): void {
    const view = this.editor?.view;
    if (!view) return;
    const caret = view.state.selection.main.head;
    const edit = insertStructure(view.state.sliceDoc(0, caret), caret, spec.template);
    view.dispatch({
      changes: { from: caret, insert: edit.insert },
      selection: { anchor: caret + edit.caret },
      scrollIntoView: true,
    });
    view.focus();
  }

  /**
   * Problems in the current source, for the editor's squiggles. Runs after
   * typing stops, so it may read other files (existence, anchors).
   */
  private lintSource(text: string): readonly ProblemRange[] {
    const file = this.file;
    const vaultRoot = this.vaultRoot();
    this.lintDependencies = new Set();
    if (!file || !vaultRoot) return [];
    const env = this.completionEnv();
    const dependencies = new Set<string>();
    const problems = collectDiagnostics({
      xml: text,
      absPath: join(vaultRoot, file.path),
      keys: env?.keys(),
      keyFiles: env?.keyFiles(),
      idsIn: this.idReader,
      collectDependencies: dependencies,
    });
    this.lintDependencies = dependencies;
    return problemRanges(text.split('\n'), problems);
  }

  /** Called by the plugin when a vault file changes. */
  dependsOnAbsolutePath(absPath: string): boolean {
    return this.dependencies.has(absPath) || this.lintDependencies.has(absPath);
  }

  /** Re-render after something the topic references (not the topic itself) changed. */
  async refresh(): Promise<void> {
    // The keys and anchors the check reads are cached for a moment; a change
    // on disk is exactly when that cache is wrong.
    this.envCache = undefined;
    this.editor?.recheck();
    this.previewStale = true;
    // A title may be built from a key this change redefined.
    refreshOutlines(this.app, this.file);
    if (panesFor(this.mode).preview) await this.render();
    // The .ditaval or the page's values may be what changed.
    this.profilePanel?.refresh();
  }

  /** The theme's light/dark flag, for the few rules that cannot be derived from variables. */
  updateScheme(): void {
    if (!this.host) return;
    const dark = this.host.ownerDocument.body.classList.contains('theme-dark');
    this.host.setAttribute('data-scheme', dark ? 'dark' : 'light');
  }

  // ── conditional processing ──

  /** True when the preview is showing, which is when the filter has something to act on. */
  hasPreview(): boolean {
    return panesFor(this.mode).preview;
  }

  hasDitaval(): boolean {
    return this.profile.ditaval !== undefined;
  }

  toggleProfilePanel(): void {
    if (!this.profilePanel) return;
    if (this.profilePanel.isOpen) this.profilePanel.close();
    else this.profilePanel.open();
  }

  /** Pick a .ditaval from the vault and apply it to this pane. */
  chooseDitaval(): void {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('DITA Viewer needs a vault stored on the local file system.');
      return;
    }
    const files = listDitavalFiles(adapter.getBasePath());
    if (files.length === 0) {
      new Notice('No .ditaval files were found in this vault.');
      return;
    }
    new DitavalPicker(this.app, files, (path) => this.setDitaval(path)).open();
  }

  clearDitaval(): void {
    this.setDitaval(undefined);
  }

  private setDitaval(path: string | undefined): void {
    this.profile = { ...this.profile, ditaval: path };
    if (path === undefined) delete this.profile.ditaval;
    this.reloadDitaval();
    if (this.ditavalError) new Notice(this.ditavalError);
    this.onProfileChanged();
    this.profilePanel?.refresh();
  }

  /** Read the chosen .ditaval from disk; an unreadable or malformed one is not applied. */
  private reloadDitaval(): void {
    const previous = this.ditavalAbs;
    this.ditaval = undefined;
    this.ditavalAbs = undefined;
    this.ditavalError = undefined;
    const rel = this.profile.ditaval;
    const adapter = this.app?.vault.adapter;
    if (previous) this.dependencies.delete(previous);
    if (!rel || !(adapter instanceof FileSystemAdapter)) return;
    const abs = resolveDitavalPath(adapter.getBasePath(), rel);
    if (!abs) {
      this.ditavalError = 'The DITAVAL path points outside the vault.';
      return;
    }
    // Watched even when it is missing, so creating it brings the filter back.
    this.ditavalAbs = abs;
    this.dependencies.add(abs);
    const loaded = loadDitaval(abs);
    this.ditavalError = loaded.error;
    // A half-read filter would look like it works; say so instead and apply none.
    if (loaded.error === undefined) this.ditaval = loaded.ditaval;
  }

  private profileFilter(): ProfileFilter | undefined {
    return buildFilter(this.ditaval, this.profile.hidden);
  }

  /** A saved or switched state is in place: bring the page and the header in line with it. */
  private applyProfileState(): void {
    this.body.classList.toggle('hide-profiling', !this.profile.highlight);
    this.onProfileChanged();
    this.profilePanel?.refresh();
  }

  /**
   * The filter changed. Content inside a topic is hidden in place, which is
   * instant; a map's site and book views also drop whole topics, which the
   * renderer decides, so those render again.
   */
  private onProfileChanged(): void {
    this.app.workspace.requestSaveLayout();
    this.applyProfileFilter();
    if (this.isMapFile() && (this.mode === 'site' || this.mode === 'book')) {
      this.previewStale = true;
      void this.render();
    }
  }

  /** Hide or show every profiled element of the page on screen according to the filter. */
  private applyProfileFilter(): void {
    const filter = this.profileFilter();
    const verdicts = new Map<string, boolean>();
    let hidden = 0;
    // Document order: an element is judged after its ancestors, so one inside
    // a hidden block is not counted as well.
    this.body.querySelectorAll<HTMLElement>('[data-profile-keys]').forEach((el) => {
      const keys = el.getAttribute('data-profile-keys') ?? '';
      let out = verdicts.get(keys);
      if (out === undefined) {
        out = isExcluded(profileValuesOfKeys(keys), filter);
        verdicts.set(keys, out);
      }
      el.classList.toggle('profile-filtered-out', out);
      if (out && !el.parentElement?.closest('.profile-filtered-out')) hidden++;
    });
    this.filteredCount = hidden;
    this.updateProfileAction();
    this.profilePanel?.updateStatus();
  }

  /** The header button lights up while a filter is in force, and says what it is doing. */
  private updateProfileAction(): void {
    if (!this.profileAction) return;
    const active = this.profileFilter() !== undefined || this.ditavalError !== undefined;
    this.profileAction.toggleClass('is-active', active);
    const parts = ['Conditional processing'];
    if (this.profile.ditaval) parts.push(this.profile.ditaval.split('/').pop() ?? this.profile.ditaval);
    if (this.ditavalError) parts.push(this.ditavalError);
    if (this.filteredCount > 0) parts.push(`${this.filteredCount} hidden`);
    this.profileAction.setAttribute('aria-label', parts.join(' · '));
  }

  private profileHost(): ProfilePanelHost {
    return {
      groups: (): ProfileGroup[] => {
        const sets: ReturnType<typeof profileValuesOfKeys>[] = [];
        const seen = new Set<string>();
        this.body.querySelectorAll('[data-profile-keys]').forEach((el) => {
          const keys = el.getAttribute('data-profile-keys') ?? '';
          if (seen.has(keys)) return;
          seen.add(keys);
          sets.push(profileValuesOfKeys(keys));
        });
        return profileGroups(sets, this.profile.hidden);
      },
      hidden: () => new Set(this.profile.hidden),
      ditaval: () => this.ditaval,
      ditavalPath: () => this.profile.ditaval,
      ditavalError: () => this.ditavalError,
      highlight: () => this.profile.highlight,
      hiddenCount: () => this.filteredCount,
      setValueHidden: (att, value, hide) => {
        const key = `${att}:${value}`;
        const rest = this.profile.hidden.filter((k) => k !== key);
        this.profile = { ...this.profile, hidden: hide ? [...rest, key] : rest };
        this.onProfileChanged();
      },
      showAll: () => {
        this.profile = { ...this.profile, hidden: [] };
        this.onProfileChanged();
        this.profilePanel?.refresh();
      },
      setHighlight: (on) => {
        this.profile = { ...this.profile, highlight: on };
        this.body.classList.toggle('hide-profiling', !on);
        this.app.workspace.requestSaveLayout();
      },
      chooseDitaval: () => this.chooseDitaval(),
      clearDitaval: () => this.clearDitaval(),
    };
  }

  // ── rendering ──

  private async render(): Promise<void> {
    // Renders are serial: a burst of changes collapses into one trailing render.
    if (this.rendering) {
      this.renderAgain = true;
      return;
    }
    this.rendering = true;
    try {
      do {
        this.renderAgain = false;
        this.renderOnce();
      } while (this.renderAgain);
    } finally {
      this.rendering = false;
    }
  }

  private renderOnce(): void {
    const file = this.file;
    if (!file) return;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      this.showError('DITA Viewer needs a vault stored on the local file system.');
      return;
    }
    const vaultRoot = adapter.getBasePath();
    const absPath = join(vaultRoot, file.path);
    const scrollTop = this.scroller.scrollTop;
    // The file may have changed since the last render; this is what a change
    // to it (it is one of the dependencies below) triggers.
    this.reloadDitaval();
    const filter = this.profileFilter();

    let result: RenderFileResult;
    if (this.isMapFile() && this.mode === 'site') {
      const site = renderSiteFile({
        xml: this.data,
        absPath,
        vaultRoot,
        toResourceUrl: (rel) => adapter.getResourcePath(normalizePath(rel)),
        uiLanguage: moment.locale(),
        current: this.siteCurrent,
        titleCache: this.siteTitleCache,
        filter,
      });
      result = site;
      if (site.error === undefined) {
        this.siteMapTitle = site.title;
        this.siteEntries = site.entries;
        this.sitePages = site.entries
          .filter((entry): entry is SiteNavEntry & { absPath: string } => entry.absPath !== undefined)
          .map((entry) => ({ absPath: entry.absPath, title: entry.title }));
        this.siteCurrent = site.current;
        this.siteShown = site.current;
        this.siteMapPath = file.path;
        this.renderSiteNav();
        this.updateSiteNavActions();
      }
    } else if (this.isMapFile() && this.mode === 'book') {
      result = renderBookFile({
        xml: this.data,
        absPath,
        vaultRoot,
        toResourceUrl: (rel) => adapter.getResourcePath(normalizePath(rel)),
        uiLanguage: moment.locale(),
        filter,
      });
    } else if (this.isMapFile()) {
      result = renderDitamapFile({ xml: this.data, absPath, vaultRoot, uiLanguage: moment.locale() });
    } else {
      result = renderDitaFile({
        xml: this.data,
        absPath,
        vaultRoot,
        toResourceUrl: (rel) => adapter.getResourcePath(normalizePath(rel)),
        uiLanguage: moment.locale(),
      });
    }
    this.dependencies = result.dependencies;
    // Editing, creating or deleting the .ditaval re-renders the preview.
    if (this.ditavalAbs) this.dependencies.add(this.ditavalAbs);

    if (result.error !== undefined) {
      // Mid-edit text is often not valid: keep the last good preview on screen
      // and say what is wrong, rather than blanking the page on every keystroke.
      this.showError(result.error);
      this.sitePendingAnchor = undefined;
      // The old page is still on screen: keep the sidebar and the previous/next
      // buttons describing it, not the page the reader asked for.
      if (this.mode === 'site' && this.siteCurrent !== this.siteShown) {
        this.siteCurrent = this.siteShown;
        this.renderSiteNav();
        this.updateSiteNavActions();
      }
      return;
    }
    this.showError(undefined);
    this.body.innerHTML = result.html;
    this.body.classList.toggle('hide-profiling', !this.profile.highlight);
    this.applyProfileFilter();
    this.previewStale = false;
    this.updateScheme();
    this.setPreviewScroll(scrollTop);
    // A cross-page site xref asks for an element on the page that just
    // arrived; the page has to be laid out before it can be scrolled to.
    const anchor = this.sitePendingAnchor;
    this.sitePendingAnchor = undefined;
    if (anchor && this.mode === 'site') {
      requestAnimationFrame(() => this.scrollToSiteAnchor(anchor));
    }
  }

  private showError(text: string | undefined): void {
    if (!this.errorEl) return;
    if (text === undefined) {
      this.errorEl.hide();
      return;
    }
    this.errorEl.setText(text);
    this.errorEl.show();
  }

  // ── scroll and cursor sync (source drives preview) ──

  private measureAnchors(): Anchor[] {
    const base = this.scroller.getBoundingClientRect().top - this.scroller.scrollTop;
    const anchors: Anchor[] = [];
    this.shadow.querySelectorAll('[data-line]').forEach((el) => {
      // A line the conditional-processing filter hides has no position to follow.
      if (el.getClientRects().length === 0) return;
      anchors.push({ line: Number(el.getAttribute('data-line')), top: el.getBoundingClientRect().top - base });
    });
    return anchors;
  }

  private queueSyncToPreview(): void {
    if (this.mode !== 'split' || this.syncFrame || performance.now() < this.quietUntil) return;
    if (this.editorEcho.isEcho(this.editor.view.scrollDOM.scrollTop)) return;
    this.syncFrame = requestAnimationFrame(() => {
      this.syncFrame = 0;
      this.syncPreviewToEditor();
    });
  }

  private syncPreviewToEditor(): void {
    if (this.mode !== 'split') return;
    const sc = this.editor.view.scrollDOM;
    // The ends line up exactly, whatever the two documents' proportions.
    if (sc.scrollTop <= 0) {
      this.setPreviewScroll(0);
      return;
    }
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) {
      this.setPreviewScroll(this.scroller.scrollHeight);
      return;
    }
    const offset = previewOffsetForLine(this.measureAnchors(), this.editor.topLine());
    if (offset !== undefined) this.setPreviewScroll(offset);
  }

  /** Move the preview by code, noting where it ends up so its scroll event is known for an echo. */
  private setPreviewScroll(top: number): void {
    this.scroller.scrollTop = top;
    this.previewEcho.expect(this.scroller.scrollTop);
  }

  /** The preview was scrolled (by the user): bring the editor to the same place. */
  private queueSyncToEditor(): void {
    if (this.mode !== 'split' || this.syncEditorFrame || performance.now() < this.quietUntil) return;
    if (this.previewEcho.isEcho(this.scroller.scrollTop)) return;
    this.syncEditorFrame = requestAnimationFrame(() => {
      this.syncEditorFrame = 0;
      this.syncEditorToPreview();
    });
  }

  private syncEditorToPreview(): void {
    if (this.mode !== 'split') return;
    const sc = this.scroller;
    const ed = this.editor.view.scrollDOM;
    if (sc.scrollTop <= 0) {
      ed.scrollTop = 0;
    } else if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) {
      // The ends line up exactly, as they do when the editor leads.
      ed.scrollTop = ed.scrollHeight;
    } else {
      const line = lineForPreviewOffset(this.measureAnchors(), sc.scrollTop);
      if (line === undefined) return;
      this.editor.scrollToTopLine(line);
    }
    this.editorEcho.expect(ed.scrollTop);
  }

  /** The caret moved: bring its line into the preview if it is out of sight. */
  private revealInPreview(line: number): void {
    if (this.mode !== 'split' || performance.now() < this.quietUntil) return;
    const offset = previewOffsetForLine(this.measureAnchors(), line);
    if (offset === undefined) return;
    const h = this.scroller.clientHeight;
    if (!isOffsetVisible(offset, this.scroller.scrollTop, h, h * 0.2)) {
      this.setPreviewScroll(Math.max(0, offset - h * 0.3));
    }
  }

  // ── preview interaction ──

  /** The selection inside the preview. Chromium keeps selections within a shadow root on the root itself. */
  private previewSelection(): Selection | null {
    const root = this.shadow as unknown as { getSelection?: () => Selection | null };
    return root.getSelection?.() ?? this.host.ownerDocument.getSelection();
  }

  private selectAllInPreview(): void {
    const sel = this.previewSelection();
    sel?.selectAllChildren(this.body);
  }

  private async copySelection(): Promise<void> {
    const text = this.previewSelection()?.toString() ?? '';
    if (text) await navigator.clipboard.writeText(text);
  }

  private onPreviewKey(evt: KeyboardEvent): void {
    if ((evt.ctrlKey || evt.metaKey) && !evt.altKey && !evt.shiftKey && evt.key.toLowerCase() === 'a') {
      evt.preventDefault();
      this.selectAllInPreview();
      return;
    }
    if (evt.key !== 'Enter' && evt.key !== ' ' && evt.key !== 'Spacebar') return;
    // The listener sits outside the shadow root, so the target is retargeted
    // to the host; composedPath()[0] is the element the reader focused.
    const target = evt.composedPath()[0];
    const el = target instanceof Element ? target.closest('[data-conref]') : null;
    if (!el) return;
    evt.preventDefault();
    this.jumpToConref(el);
  }

  private onContextMenu(evt: MouseEvent): void {
    evt.preventDefault();
    const target = evt.target as Element | null;
    const entry = target?.closest('a.map-tree-link[data-href]');
    const bookSection =
      this.mode === 'book' || this.mode === 'site'
        ? target?.closest('[data-dita-book-file]')
        : null;
    const hasSelection = (this.previewSelection()?.toString() ?? '') !== '';
    const menu = new Menu();
    // After "Reveal in source" the reader can come back from the same menu
    // they right-clicked in, not only from the header button.
    const back = this.revealReturnMode;
    if (back && back !== this.mode) {
      menu.addItem((item) =>
        item
          .setTitle(`Back to ${MODE_LABELS[back]}`)
          .setIcon('arrow-left')
          .onClick(() => this.goBack()),
      );
      menu.addSeparator();
    }
    if (entry) {
      const href = entry.getAttribute('data-href') ?? '';
      menu.addItem((item) =>
        item.setTitle('Open').setIcon('file-text').onClick(() => this.openRelative(href)),
      );
      menu.addItem((item) =>
        item.setTitle('Reveal in source').setIcon('code').onClick(() => this.revealOutlineEntry(href)),
      );
      menu.addSeparator();
    } else if (bookSection) {
      // Book/site views have no outline rows; reveal the topic the reader
      // right-clicked.
      menu.addItem((item) =>
        item
          .setTitle('Reveal in source')
          .setIcon('code')
          .onClick(() => this.revealBookSection(bookSection, target)),
      );
      menu.addSeparator();
    }
    menu.addItem((item) => item.setTitle('Copy').setIcon('copy').setDisabled(!hasSelection).onClick(() => void this.copySelection()));
    menu.addItem((item) => item.setTitle('Select all').setIcon('text-select').onClick(() => this.selectAllInPreview()));
    menu.showAtMouseEvent(evt);
  }

  /**
   * "Reveal in source" for an outline row: put the caret on the topicref in
   * this map. Rows spliced in from a referenced submap have no line in this
   * text, so those open the topic they name in the source instead.
   */
  private revealOutlineEntry(href: string): void {
    const pos = outlineEntryPosition(this.getViewData(), href);
    if (pos) {
      this.showSource(pos.line, pos.col);
      return;
    }
    if (!this.file || !href || href.startsWith('#')) return;
    const target = this.app.vault.getAbstractFileByPath(
      normalizePath(join(dirname(this.file.path), decodeHrefPart(href.split('#')[0]))),
    );
    if (target instanceof TFile) {
      this.openSourceBeside(target, 0, 0);
      return;
    }
    new Notice('The topic for this outline entry was not found.');
  }

  /**
   * "Reveal in source" inside book or site view: open the topic in a split
   * beside the map, at the line of the element that was right-clicked. Those
   * views have no outline rows, so the clicked page/section is the target.
   */
  /** Show a file's source in a new pane beside this one; the outline or book stays put. */
  private openSourceBeside(file: TFile, line: number, col: number): void {
    const leaf = this.app.workspace.getLeaf('split', 'vertical');
    const eState = {
      ditaLine: Number.isFinite(line) ? line : 0,
      ditaCol: Number.isFinite(col) ? col : 0,
    };
    void leaf.openFile(file, { eState }).then(() => {
      if (leaf.view instanceof DitaView) leaf.view.setMode('source');
    });
  }

  private revealBookSection(section: Element, target: Element | null): void {
    const abs = section.getAttribute('data-dita-book-file');
    const vaultRoot = this.vaultRoot();
    if (!abs || !vaultRoot) return;
    const rel = relative(vaultRoot, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      new Notice('The topic is outside the vault.');
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(normalizePath(rel));
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${rel}`);
      return;
    }
    const nearest = target?.closest('[data-line]');
    const lineEl = (nearest && section.contains(nearest) ? nearest : section.querySelector('[data-line]')) as Element | null;
    const line = lineEl ? Number(lineEl.getAttribute('data-line')) : 0;
    const col = lineEl ? Number(lineEl.getAttribute('data-start-col') ?? 0) : 0;
    this.openSourceBeside(file, line, col);
  }

  private onClick(evt: MouseEvent): void {
    // A reuse badge wins over whatever it sits on: its background is the jump
    // affordance, the rest of the element still behaves normally.
    const conref = this.conrefBadge(evt);
    if (conref) {
      evt.preventDefault();
      this.jumpToConref(conref, evt);
      return;
    }
    // An outline entry: open the topic it points at. Its href is "#"; the real
    // target is in data-href, relative to the map.
    const entry = (evt.target as Element | null)?.closest('a.map-tree-link[data-href]');
    if (entry && this.file) {
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
      if (this.mode === 'site') this.jumpInSite(target);
      else this.jumpInBook(target);
      return;
    }
    // A cross-file xref or related link in the single-topic preview: its href
    // is only the "#" placeholder, the real target is in data-dita-href.
    const linked = (evt.target as Element | null)?.closest('a[data-dita-href]');
    if (linked && this.file) {
      evt.preventDefault();
      const target = linked.getAttribute('data-dita-href') ?? '';
      if (/^(https?:|mailto:)/i.test(target)) window.open(target, '_blank');
      else if (target && !target.startsWith('#')) {
        const section = linked.closest('[data-dita-book-file]');
        this.openRelative(target, evt, section?.getAttribute('data-dita-book-file') ?? undefined);
      }
      return;
    }
    const a = (evt.target as Element | null)?.closest('a[href]');
    if (!a || !this.file) {
      this.jumpToSource(evt);
      return;
    }
    const href = a.getAttribute('href') ?? '';
    evt.preventDefault();

    if (/^(https?:|mailto:)/i.test(href)) {
      window.open(href, '_blank');
      return;
    }
    if (href.startsWith('#')) {
      this.shadow.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' });
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
    const vaultRoot = this.vaultRoot();
    if (!vaultRoot || !this.file) return;
    const [path] = href.split('#');
    const baseDir = baseAbsPath ? dirname(baseAbsPath) : resolve(vaultRoot, dirname(this.file.path));
    const rel = relative(vaultRoot, resolve(baseDir, decodeHrefPart(path)));
    if (rel.startsWith('..') || isAbsolute(rel)) return;
    const target = this.app.vault.getAbstractFileByPath(normalizePath(rel));
    if (target instanceof TFile) {
      void this.app.workspace.getLeaf(evt ? Keymap.isModEvent(evt) : false).openFile(target);
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
    this.shadow.querySelectorAll('[data-dita-book-file]').forEach((el) => {
      if (!section && el.getAttribute('data-dita-book-file') === file) section = el;
    });
    if (!section) {
      if (file) this.openSource(file, {});
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
    if (file && file !== this.siteCurrent) {
      if (this.sitePages.some((page) => page.absPath === file)) {
        this.openSitePage(file, id || undefined);
        return;
      }
      if (file) this.openSource(file, id ? { id } : {});
      return;
    }
    if (id) this.scrollToSiteAnchor(id);
    else this.setPreviewScroll(0);
  }

  /** Side by side, clicking the preview puts the caret at that element's source. */
  private jumpToSource(evt: MouseEvent): void {
    if (this.mode !== 'split') return;
    if (this.host.ownerDocument.getSelection()?.isCollapsed === false) return; // the user is selecting text
    const el = (evt.target as Element | null)?.closest('[data-line]');
    if (!el) return;
    const line = Number(el.getAttribute('data-line'));
    const col = Number(el.getAttribute('data-start-col') ?? 0);
    if (!Number.isFinite(line)) return;
    // Revealing scrolls the editor; without this the echo would scroll the preview back.
    this.quietUntil = performance.now() + SYNC_QUIET_MS;
    this.editor.reveal(line, Number.isFinite(col) ? col : 0);
  }

  // ── source navigation ──

  /** Ctrl/Cmd+click in the source: open the file or the key the attribute names. */
  private openReference(ref: SourceReference, evt: MouseEvent): void {
    const file = this.file;
    const vaultRoot = this.vaultRoot();
    if (!file || !vaultRoot) return;
    const here = join(vaultRoot, file.path);

    if (ref.kind === 'key') {
      const key = keyNameOf(ref.value);
      const keys = this.completionEnv()?.keys();
      // getKeyDefs indexes its WeakMap by the map instance; completionEnv hands
      // out that same Map, read-only only so callers do not mutate the cache.
      const def = keys ? getKeyDefs(keys as Map<string, string>)?.get(key) : undefined;
      const href = def?.href ?? '';
      const target = href ? pathOf(href) : '';
      if (!def || !target) {
        new Notice(`Key "${key}" has no file target.`);
        return;
      }
      const fragment = fragmentOf(href);
      this.openSource(resolve(def.baseDir, target), fragment ? { id: fragment } : {}, evt);
      return;
    }

    const path = pathOf(ref.value);
    const fragment = fragmentOf(ref.value);
    if (!path) {
      // "#id": a target in this file.
      if (fragment) this.revealId(fragment);
      return;
    }
    if (/^(https?:|mailto:)/i.test(ref.value)) {
      window.open(ref.value, '_blank');
      return;
    }
    this.openSource(resolve(dirname(here), path), fragment ? { id: fragment } : {}, evt);
  }

  /** Open a source position: in this view when it is this file, in another leaf otherwise. */
  private openSource(absPath: string, place: { line?: number; col?: number; id?: string }, evt?: MouseEvent): void {
    const vaultRoot = this.vaultRoot();
    if (!vaultRoot) return;
    const rel = relative(vaultRoot, absPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      new Notice('The target file is outside the vault.');
      return;
    }
    const path = normalizePath(rel);
    if (path === this.file?.path) {
      if (place.id) this.revealId(place.id);
      else if (place.line !== undefined) this.showSource(place.line, place.col ?? 0);
      return;
    }
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile)) {
      new Notice(`File not found: ${rel}`);
      return;
    }
    // With no position to show, open the file the way any link would, in
    // whatever mode the user has set; a position needs the source pane.
    const eState = place.id
      ? { ditaId: place.id }
      : place.line !== undefined
        ? { ditaLine: place.line, ditaCol: place.col ?? 0 }
        : undefined;
    void this.app.workspace.getLeaf(evt ? Keymap.isModEvent(evt) : false).openFile(target, eState ? { eState } : undefined);
  }

  /** Put the caret on the element that carries `id` in this file. */
  private revealId(fragment: string): void {
    // A fragment is "topicid" or "topicid/elementid"; the caret goes to the
    // element, which is the part after the slash.
    const id = splitRefFragment(fragment).elementId;
    const pos = positionOfId(this.editor.getText(), id);
    if (!pos) {
      new Notice(`No element with id "${id}" in this file.`);
      return;
    }
    this.showSource(pos.line, pos.col);
  }

  /** Bring a source position into view, opening the editor pane when only the preview was showing. */
  private showSource(line: number, col: number): void {
    const visible = panesFor(this.mode).editor;
    const previous = this.mode;
    if (!visible) {
      this.setMode('split');
      // Keep a way back to the outline, site or book the reader came from.
      this.revealReturnMode = previous;
      this.updateBackAction();
    }
    // Revealing scrolls the editor; without this the echo would scroll the preview back.
    this.quietUntil = performance.now() + SYNC_QUIET_MS;
    const reveal = () => {
      this.editor.reveal(line, col);
      this.editor.focus();
    };
    // A pane that was hidden needs a frame to be laid out before it can scroll.
    if (visible) reveal();
    else requestAnimationFrame(reveal);
  }

  /**
   * Scroll to a source line the way the other panes do: put the caret there
   * when the source is showing, otherwise move the preview without switching
   * views. A view with nothing in its preview to scroll to (a map's outline
   * tree) falls back to showing the source.
   */
  private goToLine(line: number): void {
    if (!this.editor) return;
    if (panesFor(this.mode).editor) {
      this.showSource(line, 0);
      return;
    }
    const offset = previewOffsetForLine(this.measureAnchors(), line);
    if (offset === undefined) {
      this.showSource(line, 0);
      return;
    }
    this.setPreviewScroll(Math.max(0, offset));
  }

  /** Apply a reveal that arrived with the file (setEphemeralState) once its text is here. */
  private applyPendingReveal(): void {
    const pending = this.pendingReveal;
    if (!pending || !this.editor) return;
    // An id is looked up in the text, so wait until the file's text is in the
    // editor; setViewData calls this again once it is.
    if (pending.id && this.editor.getText() === '') return;
    this.pendingReveal = undefined;
    if (pending.id) {
      this.revealId(pending.id);
      return;
    }
    this.showSource(pending.line ?? 0, pending.col ?? 0);
  }

  private vaultRoot(): string | undefined {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
  }

  // ── conref jump ──

  /** The reuse badge under the pointer, if any: a background cannot answer that itself. */
  private conrefBadge(evt: MouseEvent): Element | undefined {
    const el = (evt.target as Element | null)?.closest('[data-conref]');
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) return undefined;
    const box = badgeBox(el.getBoundingClientRect(), win.getComputedStyle(el), conrefKindOf(el));
    return badgeHit(box, evt.clientX, evt.clientY) ? el : undefined;
  }

  private onConrefHover(evt: PointerEvent): void {
    this.host.classList.toggle('dv-conref-hot', this.conrefBadge(evt) !== undefined);
  }

  /** The badge was clicked (or Enter/Space pressed on it): open the reused element's source. */
  private jumpToConref(el: Element, evt?: MouseEvent): void {
    const file = el.getAttribute('data-conref-file');
    const line = Number(el.getAttribute('data-conref-line'));
    const col = Number(el.getAttribute('data-conref-col') ?? 0);
    if (!file || !Number.isFinite(line)) return;
    this.openSource(file, { line, col: Number.isFinite(col) ? col : 0 }, evt);
  }
}
