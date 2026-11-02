import { FileSystemAdapter, HoverParent, HoverPopover, Menu, TextFileView, ViewStateResult, WorkspaceLeaf, moment, normalizePath, setIcon } from 'obsidian';
import { join } from 'path';
import { collectDiagnostics } from '@dita-viewer/core';
import { renderBookFile, renderDitaFile, renderDitamapFile, renderSiteFile } from './renderFile';
import type { RenderFileResult } from './renderFile';
import { SettingsProvider } from './settings';
import { MODE_ICONS, MODE_LABELS, ViewMode, modesFor, panesFor, parseViewMode, previewKindFor, toggleMode } from './viewMode';
import { SourceEditor, createSourceEditor } from './sourceEditor';
import { createCompletionEnv } from './completionEnv';
import { ditaCompletionSource } from './completionSource';
import { ScrollSync } from './scrollSync';
import { SiteNav } from './siteNav';
import { sitePageFromState, sitePageToState } from './siteState';
import { ProfileController } from './profileController';
import { HoverPreview } from './hoverPreview';
import { SourceNavigation } from './sourceNavigation';
import { PreviewInteraction } from './previewInteraction';
import { HOVER_SOURCE } from './hoverSource';
import { Debounced, debounce } from './debounce';
import { ProblemRange, problemRanges } from './sourceDiagnostics';
import { createIdReader } from './fileIds';
import { detectEol, toLf, withEol } from './lineEndings';
import type { Eol } from './lineEndings';
import { markActiveHeading, refreshOutlines } from './outlinePatch';
import { getSheets } from './previewSheets';
import { StructureSpec, WrapSpec } from './snippetsData';
import { insertStructure, wrapSelection } from './snippets';
import { setRenderedHtml } from './renderedHtml';

export const VIEW_TYPE_DITA = 'dita-viewer-topic';

/** The id the preview's links hover under, re-exported where the plugin registers it. */
export { HOVER_SOURCE };

/** Show or hide a header button with a class, not an inline style. */
function setShown(el: HTMLElement, shown: boolean): void {
  el.toggleClass('dita-hidden', !shown);
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
  /** The page a saved state asked for in a file, until that file is loaded and the site view is there to take it. */
  private pendingSitePage?: { page: string; file: string };

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
  /** Page Preview over a link in the preview (hoverPreview.ts). */
  private readonly hover: HoverPreview;

  /**
   * Obsidian's Page Preview keeps the popover it opens over one of this view's
   * links here; the field itself is HoverPreview's, so both sides see the same
   * one. It has to stay on the view: it is the HoverParent contract.
   */
  get hoverPopover(): HoverPopover | null {
    return this.hover.hoverPopover;
  }

  set hoverPopover(popover: HoverPopover | null) {
    this.hover.hoverPopover = popover;
  }

  private readonly idReader = createIdReader();
  /** The jumps into the source, and the way back from one (sourceNavigation.ts). */
  private readonly nav: SourceNavigation;
  /** Clicks, keys and the find bar on the rendered page (previewInteraction.ts). */
  private readonly interact: PreviewInteraction;
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
      refreshFind: () => this.interact.refreshFind(),
      saveLayout: () => this.app.workspace.requestSaveLayout(),
    });
    this.hover = new HoverPreview({
      app: this.app,
      hoverParent: this,
      file: () => this.file,
      host: () => this.host,
      vaultRoot: () => this.vaultRoot(),
    });
    this.nav = new SourceNavigation({
      app: this.app,
      file: () => this.file,
      mode: () => this.mode,
      vaultRoot: () => this.vaultRoot(),
      editor: () => this.editor,
      keys: () => this.completionEnv()?.keys(),
      getViewData: () => this.getViewData(),
      setMode: (mode) => this.setMode(mode),
      showBackTo: (back) => {
        if (!this.backAction) return;
        const show = back !== undefined && back !== this.mode;
        setShown(this.backAction, show);
        if (show && back !== undefined) this.backAction.setAttribute('aria-label', `Back to ${MODE_LABELS[back]}`);
      },
      previewHost: () => this.host,
      quietSync: () => this.sync?.quiet(),
      offsetForLine: (line) => this.sync?.offsetForLine(line),
      setPreviewScroll: (top) => this.sync?.setPreviewScroll(top),
      nextFrame: (cb) => this.nextFrame(cb),
      // After a split opens a topic, it shows the source, not whatever mode the pane had.
      setSourceMode: (view) => {
        if (view instanceof DitaView) view.setMode('source');
      },
    });
    this.interact = new PreviewInteraction({
      app: this.app,
      file: () => this.file,
      mode: () => this.mode,
      vaultRoot: () => this.vaultRoot(),
      body: () => this.body,
      shadow: () => this.shadow,
      host: () => this.host,
      container: () => this.container,
      scroller: () => this.scroller,
      editor: () => this.editor,
      site: () => this.site,
      nav: () => this.nav,
      setPreviewScroll: (top) => this.sync?.setPreviewScroll(top),
      quietSync: () => this.sync?.quiet(),
      goBack: () => this.goBack(),
      backMode: () => this.nav.backMode,
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
    this.shadow.addEventListener('click', (evt) => this.interact.onClick(evt as MouseEvent));
    this.shadow.addEventListener('contextmenu', (evt) => this.interact.onContextMenu(evt as MouseEvent));
    this.shadow.addEventListener('mouseover', (evt) => this.hover.onMove(evt as MouseEvent));
    this.host.addEventListener('mouseleave', () => this.hover.left());
    this.shadow.addEventListener('pointermove', (evt) => this.nav.onConrefHover(evt as PointerEvent));
    this.host.addEventListener('pointerleave', () => this.host.classList.remove('dv-conref-hot'));
    // Focusable by click, so Ctrl/Cmd+A selects the topic rather than the whole app.
    this.scroller.tabIndex = -1;
    this.scroller.addEventListener('keydown', (evt) => this.interact.onKey(evt));
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
      onReference: (ref, evt) => this.nav.openReference(ref, evt),
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
      openSource: (absPath, place, evt) => this.nav.openSource(absPath, place, evt),
    });
    this.takeSitePage();
    this.siteNav.addEventListener('click', (evt) => this.site.onNavClick(evt as MouseEvent));
    this.siteNav.addEventListener('mouseover', (evt) => this.site.onNavHover(evt));
    this.modeAction = this.addAction(MODE_ICONS[this.mode], 'View mode', (evt) => this.showModeMenu(evt));
    this.profileAction = this.addAction('filter', 'Conditional processing', () => this.toggleProfilePanel());
    this.profileAction.addClass('dita-profile-action');
    this.profiling.attach();
    this.updateScheme();
    this.applyMode();
    this.nav.applyPending();
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
    this.interact.destroy();
    this.hover.destroy();
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
      this.nav.clearBack();
      if (this.container) this.applyMode();
    }
    // Site state describes one map. Reusing the leaf for another map starts
    // from that map's first topic instead of carrying the old page along.
    if (this.file && this.site?.mapPath !== undefined && this.site.mapPath !== this.file.path) {
      this.site.reset();
    }
    this.takeSitePage();
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
    this.nav.applyPending();
    // A load is not a keystroke: show it now rather than after the typing delay.
    if (panesFor(this.mode).preview) void this.render();
  }

  /**
   * Hand a page a saved state asked for to the site view, once there is a site
   * view and the file is the one the state was for. A leaf that is still
   * opening has no file yet, or still the one it showed before, so the page
   * waits; once the file is known it is used or dropped. A topic has no site,
   * and a page the map no longer has is the renderer's to replace with the
   * first one.
   */
  private takeSitePage(): void {
    const pending = this.pendingSitePage;
    if (!pending || !this.site || !this.file) return;
    this.pendingSitePage = undefined;
    if (this.file.path === pending.file && this.isMapFile()) this.site.restore(pending.page);
  }

  clear(): void {
    this.data = '';
    this.nav.reset();
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
    this.nav.clearBack();
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
    // The page of a map's site, so a restart comes back to it, not the first page.
    const root = this.vaultRoot();
    const page = this.site?.current ?? this.pendingSitePage?.page;
    const saved = root && page ? sitePageToState(root, page) : undefined;
    if (saved) state.sitePage = saved;
    return state;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const saved = state as { mode?: unknown; profiling?: unknown; sitePage?: unknown; file?: unknown } | null;
    this.mode = parseViewMode(saved?.mode, this.mode);
    const root = this.vaultRoot();
    const page = root ? sitePageFromState(root, saved?.sitePage) : undefined;
    if (page && typeof saved?.file === 'string') {
      this.pendingSitePage = { page, file: saved.file };
      // The file that is already open gets no load, and so no setViewData to take it.
      if (this.file?.path === saved.file) this.takeSitePage();
    }
    // Like the mode, the filter stays with the pane when the state names none.
    if (saved && 'profiling' in saved) this.profiling.restore(saved.profiling);
    if (this.container) this.applyMode();
    await super.setState(state, result);
  }

  /** Where to put the caret when another view opens this file (conref jump, Ctrl/Cmd+click). */
  setEphemeralState(state: unknown): void {
    this.nav.request(state);
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
    const back = this.nav.backMode;
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
    if (!panes.preview) this.interact.closeFind();
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
    const back = this.nav.backMode;
    if (back) this.setMode(back);
  }

  /** Show the header Back button and name its destination. */
  private updateBackAction(): void {
    this.nav.updateBackAction();
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
      if (site.error === undefined) {
        const before = this.site.shown;
        this.site.applyResult(site, file.path);
        // The saved state names the page on screen; a turned page is a change to it.
        if (this.site.shown !== before) this.app.workspace.requestSaveLayout();
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
    this.interact.refreshFind();
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

  // Clicks, keys, the context menu and the find bar live in
  // previewInteraction.ts; Obsidian calls this on any view that has it.

  /**
   * Obsidian's Find command (Ctrl/Cmd+F) calls this on any view that has it.
   * The preview gets a find bar of its own; with only the source showing the
   * editor's own search opens instead.
   */
  showSearch(): void {
    this.interact.showSearch();
  }

  private vaultRoot(): string | undefined {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
  }
}
