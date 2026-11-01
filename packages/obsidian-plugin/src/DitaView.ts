import { FileSystemAdapter, HoverParent, HoverPopover, Keymap, Menu, Notice, TFile, TextFileView, ViewStateResult, WorkspaceLeaf, moment, normalizePath, setIcon } from 'obsidian';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { collectDiagnostics, decodeHrefPart, getKeyDefs, splitRefFragment } from '@dita-viewer/core';
import { renderBookFile, renderDitaFile, renderDitamapFile, renderSiteFile } from './renderFile';
import type { RenderFileResult } from './renderFile';
import { SettingsProvider } from './settings';
import { MODE_ICONS, MODE_LABELS, ViewMode, modesFor, panesFor, parseViewMode, previewKindFor, toggleMode } from './viewMode';
import { SourceEditor, createSourceEditor } from './sourceEditor';
import { createCompletionEnv } from './completionEnv';
import { ditaCompletionSource } from './completionSource';
import { ScrollSync } from './scrollSync';
import { SiteNav } from './siteNav';
import { ProfileController } from './profileController';
import { HOVER_SOURCE } from './hoverSource';
import { Debounced, debounce } from './debounce';
import { ProblemRange, problemRanges } from './sourceDiagnostics';
import { SourceReference, positionOfId } from './references';
import { createIdReader } from './fileIds';
import { badgeBox, badgeHit, conrefKindOf } from './conrefJump';
import { outlineEntryPosition } from './mapOutline';
import { detectEol, toLf, withEol } from './lineEndings';
import type { Eol } from './lineEndings';
import { isExternalHref, resolveLinkTarget } from './linkTarget';
import { markActiveHeading, refreshOutlines } from './outlinePatch';
import { getSheets } from './previewSheets';
import { PreviewFind } from './previewFind';
import { StructureSpec, WrapSpec } from './snippetsData';
import { insertStructure, wrapSelection } from './snippets';
import { setRenderedHtml } from './renderedHtml';

export const VIEW_TYPE_DITA = 'dita-viewer-topic';

/** The id the preview's links hover under, re-exported where the plugin registers it. */
export { HOVER_SOURCE };

/** Close a hover popover. `hide` is not in Obsidian's typings, so it is looked for; a popover without it just times out as usual. */
function hidePopover(popover: HoverPopover | null): void {
  (popover as unknown as { hide?: () => void } | null)?.hide?.();
}

/** The key a keyref/conkeyref names: everything before the first '/'. */
/** Show or hide a header button with a class, not an inline style. */
function setShown(el: HTMLElement, shown: boolean): void {
  el.toggleClass('dita-hidden', !shown);
}

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
export class DitaView extends TextFileView implements HoverParent {
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
  /** The site view's manifest, page and buttons (siteNav.ts). */
  private site!: SiteNav;

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
  /** Scroll sync between the editor and the preview (scrollSync.ts). */
  private sync!: ScrollSync;
  /** The frame that tells the Outline where this view is; one however often the view moves. */
  private outlineMarkFrame = 0;
  private find?: PreviewFind;
  /** Obsidian's Page Preview keeps the popover it opens over one of this view's links here. */
  hoverPopover: HoverPopover | null = null;
  private hoverLink?: Element;
  private hoverHideTimer = 0;
  private readonly idReader = createIdReader();
  /** A reveal requested through setEphemeralState, applied once the text is loaded. */
  private pendingReveal?: { line?: number; col?: number; id?: string };
  /** The view to offer as "Back" after a reveal switched this pane to split. */
  private revealReturnMode?: ViewMode;
  /** The line ending of the file on disk; the editor itself only knows \n. */
  private eol: Eol = '\n';

  // ── conditional processing ──
  /** The pane's .ditaval, hidden values, panel and filter (profileController.ts). */
  private readonly profiling: ProfileController;
  private profileAction!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: SettingsProvider) {
    super(leaf);
    this.mode = plugin.settings.defaultMode;
    this.scheduleRender = debounce(() => void this.render(), () => this.plugin.settings.previewDelayMs);
    this.scheduleOutlineRefresh = debounce(() => refreshOutlines(this.app, this.file), () => this.plugin.settings.previewDelayMs);
    this.profiling = new ProfileController({
      app: this.app,
      body: () => this.body,
      container: () => this.container,
      action: () => this.profileAction,
      // The header button toggles the panel itself, and the DITAVAL picker is a
      // modal: clicking in either must not count as clicking away.
      isIgnoredClick: (target) =>
        this.profileAction?.contains(target) || (target.instanceOf(Element) && target.closest('.modal-container') !== null),
      isMapFile: () => this.isMapFile(),
      mode: () => this.mode,
      addDependency: (absPath) => this.dependencies.add(absPath),
      removeDependency: (absPath) => this.dependencies.delete(absPath),
      markStale: () => {
        this.previewStale = true;
      },
      render: () => void this.render(),
      refreshFind: () => this.find?.refresh(),
      saveLayout: () => this.app.workspace.requestSaveLayout(),
    });
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
    this.sync = new ScrollSync({
      scroller: this.scroller,
      shadow: this.shadow,
      editor: () => this.editor,
      mode: () => this.mode,
      nextFrame: (cb) => this.nextFrame(cb),
      cancelFrame: (id) => this.containerEl.win.cancelAnimationFrame(id),
    });
    this.shadow.addEventListener('click', (evt) => this.onClick(evt as MouseEvent));
    this.shadow.addEventListener('contextmenu', (evt) => this.onContextMenu(evt as MouseEvent));
    this.shadow.addEventListener('mouseover', (evt) => this.onHoverMove(evt as MouseEvent));
    // The pointer left the preview altogether (Page Preview closes the popover itself): the next link is a new one.
    this.host.addEventListener('mouseleave', () => {
      this.hoverLink = undefined;
    });
    this.shadow.addEventListener('pointermove', (evt) => this.onConrefHover(evt as PointerEvent));
    this.host.addEventListener('pointerleave', () => this.host.classList.remove('dv-conref-hot'));
    // Focusable by click, so Ctrl/Cmd+A selects the topic rather than the whole app.
    this.scroller.tabIndex = -1;
    this.scroller.addEventListener('keydown', (evt) => this.onPreviewKey(evt));
    this.scroller.addEventListener(
      'scroll',
      () => {
        this.sync.queueFromPreview();
        this.markOutlineHeading();
      },
      { passive: true },
    );

    this.editor = createSourceEditor(this.editorEl, {
      text: this.data ?? '',
      onChange: (text) => this.onEdited(text),
      onScroll: () => this.sync.queueFromEditor(),
      onCursorLine: (line) => {
        this.sync.revealLine(line);
        this.markOutlineHeading();
      },
      completion: ditaCompletionSource(() => this.completionEnv()),
      lint: (text) => this.lintSource(text),
      onReference: (ref, evt) => this.openReference(ref, evt),
    });

    this.backAction = this.addAction('arrow-left', 'Back to the previous view', () => this.goBack());
    setShown(this.backAction, false);
    const sitePrevAction = this.addAction('chevron-left', 'Previous topic', () => this.site.step(-1));
    sitePrevAction.addClass('dita-site-step');
    const siteNextAction = this.addAction('chevron-right', 'Next topic', () => this.site.step(1));
    siteNextAction.addClass('dita-site-step');
    this.site = new SiteNav({
      app: this.app,
      hoverParent: this,
      el: this.siteNav,
      prevAction: sitePrevAction,
      nextAction: siteNextAction,
      file: () => this.file,
      mode: () => this.mode,
      vaultRoot: () => this.vaultRoot(),
      shadow: () => this.shadow,
      markStale: () => {
        this.previewStale = true;
      },
      render: () => void this.render(),
      setPreviewScroll: (top) => this.sync.setPreviewScroll(top),
      nextFrame: (cb) => this.nextFrame(cb),
      openSource: (absPath, place, evt) => this.openSource(absPath, place, evt),
    });
    this.siteNav.addEventListener('click', (evt) => this.site.onNavClick(evt as MouseEvent));
    this.siteNav.addEventListener('mouseover', (evt) => this.site.onNavHover(evt));
    this.modeAction = this.addAction(MODE_ICONS[this.mode], 'View mode', (evt) => this.showModeMenu(evt));
    this.profileAction = this.addAction('filter', 'Conditional processing', () => this.toggleProfilePanel());
    this.profileAction.addClass('dita-profile-action');
    this.profiling.attach();
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

  /** Run `cb` before the next paint of the window this view is in (a popout has its own frames). */
  private nextFrame(cb: FrameRequestCallback): number {
    return this.containerEl.win.requestAnimationFrame(cb);
  }

  async onClose(): Promise<void> {
    this.scheduleRender.cancel();
    this.scheduleOutlineRefresh.cancel();
    this.sync?.destroy();
    if (this.outlineMarkFrame) this.containerEl.win.cancelAnimationFrame(this.outlineMarkFrame);
    this.find?.destroy();
    this.find = undefined;
    window.clearTimeout(this.hoverHideTimer);
    hidePopover(this.hoverPopover);
    this.profiling.destroy();
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
    if (this.file && this.site?.mapPath !== undefined && this.site.mapPath !== this.file.path) {
      this.site.reset();
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
    this.profiling.reset();
    this.site?.reset();
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
      if (mode === 'site') this.sync?.setPreviewScroll(0);
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
    if (!this.profiling.isDefault) state.profiling = this.profiling.state;
    return state;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const saved = state as { mode?: unknown; profiling?: unknown } | null;
    this.mode = parseViewMode(saved?.mode, this.mode);
    // Like the mode, the filter stays with the pane when the state names none.
    if (saved && 'profiling' in saved) this.profiling.restore(saved.profiling);
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
    this.site?.updateActions();
    this.updateBackAction();
    // Conditional processing acts on the preview; with only the source showing there is nothing to filter.
    this.profiling.setVisible(panes.preview);
    if (!panes.preview) this.find?.close();
    // Typing while only the source was showing left the preview behind.
    if (panes.preview && this.previewStale && this.file) void this.render();
    // What the Outline follows (the caret, or the preview) depends on the mode.
    this.markOutlineHeading();
    if (panes.editor) {
      // CodeMirror cannot measure while hidden; once visible, measure and line up the preview.
      this.nextFrame(() => {
        this.editor.remeasure();
        if (this.mode === 'split') this.sync.syncNow();
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
    setShown(this.backAction, show);
    if (show) this.backAction.setAttribute('aria-label', `Back to ${MODE_LABELS[back]}`);
  }

  // ── site navigation ──

  // The site view's sidebar, manifest, stepping and buttons live in
  // siteNav.ts; the two header buttons are built in onOpen and handed to it.

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
    this.profiling.refreshPanel();
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
    return this.profiling.hasDitaval();
  }

  toggleProfilePanel(): void {
    this.profiling.togglePanel();
  }

  /** Pick a .ditaval from the vault and apply it to this pane. */
  chooseDitaval(): void {
    this.profiling.choose();
  }

  clearDitaval(): void {
    this.profiling.clear();
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
    this.profiling.reload();
    const filter = this.profiling.filter();

    let result: RenderFileResult;
    if (this.isMapFile() && this.mode === 'site') {
      const site = renderSiteFile({
        xml: this.data,
        absPath,
        vaultRoot,
        toResourceUrl: (rel) => adapter.getResourcePath(normalizePath(rel)),
        uiLanguage: moment.locale(),
        current: this.site.current,
        titleCache: this.site.titleCache,
        filter,
      });
      result = site;
      if (site.error === undefined) this.site.applyResult(site, file.path);
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
    const ditaval = this.profiling.dependency;
    if (ditaval) this.dependencies.add(ditaval);

    if (result.error !== undefined) {
      // Mid-edit text is often not valid: keep the last good preview on screen
      // and say what is wrong, rather than blanking the page on every keystroke.
      this.showError(result.error);
      this.site.clearPendingAnchor();
      // The old page is still on screen: keep the sidebar and the previous/next
      // buttons describing it, not the page the reader asked for.
      if (this.mode === 'site') this.site.revertToShown();
      return;
    }
    this.showError(undefined);
    setRenderedHtml(this.body, result.html);
    this.profiling.applyFilter();
    this.find?.refresh();
    this.previewStale = false;
    this.updateScheme();
    this.sync.setPreviewScroll(scrollTop);
    // The page changed under the same scroll position.
    this.markOutlineHeading();
    // A cross-page site xref asks for an element on the page that just
    // arrived; the page has to be laid out before it can be scrolled to.
    this.site.applyPendingAnchor();
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

  // ── the Outline pane's current heading ──

  /**
   * The line the Outline's current heading follows: the caret's while the
   * source is showing (side by side included), otherwise the line at the top of
   * the preview. A map's outline tree, the site and the book show no lines of
   * this file's text, so no line stands for them.
   */
  outlineLine(): number | undefined {
    if (!this.editor) return undefined;
    if (panesFor(this.mode).editor) {
      const state = this.editor.view.state;
      return state.doc.lineAt(state.selection.main.head).number - 1;
    }
    if (this.mode !== 'reading') return undefined;
    return this.sync.lineAtPreviewTop();
  }

  /** Tell the Outline panes showing this file which heading this view is at, on the next frame. */
  private markOutlineHeading(): void {
    if (this.outlineMarkFrame || !this.file) return;
    this.outlineMarkFrame = this.nextFrame(() => {
      this.outlineMarkFrame = 0;
      if (this.file) markActiveHeading(this.app, this.file);
    });
  }

  // ── preview interaction ──

  /** The selection inside the preview. Chromium keeps selections within a shadow root on the root itself. */
  private previewSelection(): Selection | null {
    const root = this.shadow as unknown as { getSelection?: () => Selection | null };
    return root.getSelection?.() ?? this.host.ownerDocument.getSelection();
  }

  /**
   * Obsidian's Find command (Ctrl/Cmd+F) calls this on any view that has it.
   * The preview gets a find bar of its own; with only the source showing the
   * editor's own search opens instead.
   */
  showSearch(): void {
    if (!panesFor(this.mode).preview) {
      this.editor.openSearch();
      return;
    }
    this.find ??= new PreviewFind({
      shadow: this.shadow,
      body: this.body,
      barParent: this.container,
      selectedText: () => this.previewSelection()?.toString() ?? '',
      onClose: () => this.scroller.focus({ preventScroll: true }),
    });
    this.find.open();
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
    const lineEl = nearest && section.contains(nearest) ? nearest : section.querySelector('[data-line]');
    const line = lineEl ? Number(lineEl.getAttribute('data-line')) : 0;
    const col = lineEl ? Number(lineEl.getAttribute('data-start-col') ?? 0) : 0;
    this.openSourceBeside(file, line, col);
  }

  // ── hover preview ──

  /** The link under the pointer that leads to another DITA file, and the Obsidian link text for it. */
  private hoverTargetAt(target: EventTarget | null): { el: Element; linktext: string } | undefined {
    const vaultRoot = this.vaultRoot();
    const el = target instanceof Element ? target : null;
    if (!el || !vaultRoot || !this.file) return undefined;
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
    const target_ = resolveLinkTarget(vaultRoot, this.file.path, href, base(link));
    if (!target_) return undefined;
    return { el: link, linktext: target_.fragment ? `${target_.path}#${target_.fragment}` : target_.path };
  }

  /**
   * The pointer moved over the preview: over a link to another DITA file, ask
   * Page Preview for its popover (it applies the "require Ctrl" setting).
   *
   * Page Preview only keeps a popover over an element in the page's own
   * document, and a link in the preview is inside a shadow root; so the
   * popover is anchored to the preview's host element, and what that cannot
   * express (the pointer leaving the link for other text in the preview, or
   * going from one link to the next) is done here.
   */
  private onHoverMove(evt: MouseEvent): void {
    const link = this.hoverTargetAt(evt.target);
    if (link?.el === this.hoverLink) return;
    this.hoverLink = link?.el;
    window.clearTimeout(this.hoverHideTimer);
    if (!link || !this.file) {
      this.hoverHideTimer = window.setTimeout(() => {
        const popover = this.hoverPopover;
        if (popover && !this.hoverLink && !popover.hoverEl.matches(':hover')) hidePopover(popover);
      }, 300);
      return;
    }
    // Another link: the popover for the last one goes, and so does a request
    // still waiting for Ctrl (Page Preview drops those on the next mouseover
    // that is not over its target, which for a shadow root is this host).
    hidePopover(this.hoverPopover);
    this.host.ownerDocument.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    this.app.workspace.trigger('hover-link', {
      event: evt,
      source: HOVER_SOURCE,
      hoverParent: this,
      targetEl: this.host,
      linktext: link.linktext,
      sourcePath: this.file.path,
    });
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
      if (isExternalHref(target)) window.open(target, '_blank');
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

    if (isExternalHref(href)) {
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
    const link = resolveLinkTarget(vaultRoot, this.file.path, href, baseAbsPath);
    if (!link) return;
    const target = this.app.vault.getAbstractFileByPath(normalizePath(link.path));
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
    if (file && file !== this.site.current) {
      if (this.site.hasPage(file)) {
        this.site.openPage(file, id || undefined);
        return;
      }
      if (file) this.openSource(file, id ? { id } : {});
      return;
    }
    if (id) this.site.scrollToAnchor(id);
    else this.sync.setPreviewScroll(0);
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
    this.sync.quiet();
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
    this.sync.quiet();
    const reveal = () => {
      this.editor.reveal(line, col);
      this.editor.focus();
    };
    // A pane that was hidden needs a frame to be laid out before it can scroll.
    if (visible) reveal();
    else this.nextFrame(reveal);
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
    const offset = this.sync.offsetForLine(line);
    if (offset === undefined) {
      this.showSource(line, 0);
      return;
    }
    this.sync.setPreviewScroll(Math.max(0, offset));
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
