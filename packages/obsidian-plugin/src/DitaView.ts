import { FileSystemAdapter, Keymap, Menu, Notice, TFile, TextFileView, ViewStateResult, WorkspaceLeaf, moment, normalizePath, setIcon } from 'obsidian';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import coreCss from '../../dita-core/styles/dita-content.css';
import adapterCss from './theme/obsidian-adapter.css';
import { collectDiagnostics, decodeHrefPart, getKeyDefs, splitRefFragment } from '@dita-viewer/core';
import { renderBookFile, renderDitaFile, renderDitamapFile } from './renderFile';
import { SettingsProvider } from './settings';
import { MODE_ICONS, MODE_LABELS, ViewMode, modesFor, panesFor, parseViewMode, toggleMode } from './viewMode';
import { SourceEditor, createSourceEditor } from './sourceEditor';
import { createCompletionEnv } from './completionEnv';
import { ditaCompletionSource } from './completionSource';
import { Anchor, isOffsetVisible, previewOffsetForLine } from './syncLines';
import { Debounced, debounce } from './debounce';
import { ProblemRange, problemRanges } from './sourceDiagnostics';
import { SourceReference, positionOfId } from './references';
import { createIdReader } from './fileIds';
import { badgeBox, badgeHit, conrefKindOf } from './conrefJump';
import { outlineEntryPosition } from './mapOutline';
import { StructureSpec, WrapSpec } from './snippetsData';
import { insertStructure, wrapSelection } from './snippets';

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
 * Reading view, source editor, side-by-side live preview and the map book
 * view for DITA topics and maps.
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

  private dependencies = new Set<string>();
  /** Files the last diagnostics run read (reference targets, key maps). */
  private lintDependencies = new Set<string>();
  private rendering = false;
  private renderAgain = false;
  /** The preview does not show the current text (it was edited while no preview was visible, or since the last render). */
  private previewStale = true;
  private readonly scheduleRender: Debounced;
  private syncFrame = 0;
  private quietUntil = 0;
  private readonly idReader = createIdReader();
  /** A reveal requested through setEphemeralState, applied once the text is loaded. */
  private pendingReveal?: { line?: number; col?: number; id?: string };
  /** The view to offer as "Back" after a reveal switched this pane to split. */
  private revealReturnMode?: ViewMode;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: SettingsProvider) {
    super(leaf);
    this.mode = plugin.settings.defaultMode;
    this.scheduleRender = debounce(() => void this.render(), () => this.plugin.settings.previewDelayMs);
  }

  getViewType(): string {
    return VIEW_TYPE_DITA;
  }

  getDisplayText(): string {
    return this.file?.basename ?? 'DITA';
  }

  /** True for a .ditamap, the only file that has a book view. */
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
    this.container = this.contentEl.createDiv({ cls: 'dita-container' });
    this.errorEl = this.container.createDiv({ cls: 'dita-error' });
    this.errorEl.hide();
    const panes = this.container.createDiv({ cls: 'dita-panes' });
    this.editorEl = panes.createDiv({ cls: 'dita-source' });
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
    this.modeAction = this.addAction(MODE_ICONS[this.mode], 'View mode', (evt) => this.showModeMenu(evt));
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

  async onClose(): Promise<void> {
    this.scheduleRender.cancel();
    if (this.syncFrame) cancelAnimationFrame(this.syncFrame);
    this.editor?.destroy();
  }

  // ── TextFileView contract ──

  getViewData(): string {
    return this.editor ? this.editor.getText() : this.data;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    // A leaf can be re-used for another file: a topic has no book view.
    if (this.file && this.mode === 'book' && !this.isMapFile()) {
      this.mode = 'reading';
      this.revealReturnMode = undefined;
      if (this.container) this.applyMode();
    }
    this.scheduleRender.cancel();
    if (!this.editor) return; // onOpen has not run yet; it seeds the editor from this.data
    this.editor.load(data, clear);
    this.previewStale = true;
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
    // Book view merges a whole map; never put a single topic in it.
    if (mode === 'book' && !this.isMapFile()) return;
    // Reading and split show the map outline; book shows the merged topics.
    // Crossing that boundary needs a re-render even when the source is unchanged.
    if ((mode === 'book') !== (this.mode === 'book')) this.previewStale = true;
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
    return { ...super.getState(), mode: this.mode };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const saved = (state as { mode?: unknown } | null)?.mode;
    this.mode = parseViewMode(saved, this.mode);
    if (this.container) this.applyMode();
    await super.setState(state, result);
  }

  /** Where to put the caret when another view opens this file (conref jump, Ctrl/Cmd+click). */
  setEphemeralState(state: unknown): void {
    const saved = (state ?? {}) as { ditaLine?: unknown; ditaCol?: unknown; ditaId?: unknown };
    const line = typeof saved.ditaLine === 'number' && Number.isFinite(saved.ditaLine) ? saved.ditaLine : undefined;
    const col = typeof saved.ditaCol === 'number' && Number.isFinite(saved.ditaCol) ? saved.ditaCol : undefined;
    const id = typeof saved.ditaId === 'string' && saved.ditaId ? saved.ditaId : undefined;
    if (line === undefined && id === undefined) return;
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
    setIcon(this.modeAction, MODE_ICONS[this.mode]);
    this.modeAction.setAttribute('aria-label', MODE_LABELS[this.mode]);
    this.updateBackAction();
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

  // ── editing ──

  private onEdited(text: string): void {
    this.data = text;
    this.requestSave();
    this.previewStale = true;
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
    if (panesFor(this.mode).preview) await this.render();
  }

  /** The theme's light/dark flag, for the few rules that cannot be derived from variables. */
  updateScheme(): void {
    if (!this.host) return;
    const dark = this.host.ownerDocument.body.classList.contains('theme-dark');
    this.host.setAttribute('data-scheme', dark ? 'dark' : 'light');
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

    const result =
      this.isMapFile() && this.mode === 'book'
        ? renderBookFile({
            xml: this.data,
            absPath,
            vaultRoot,
            toResourceUrl: (rel) => adapter.getResourcePath(normalizePath(rel)),
            uiLanguage: moment.locale(),
          })
        : this.isMapFile()
          ? renderDitamapFile({ xml: this.data, absPath, vaultRoot, uiLanguage: moment.locale() })
          : renderDitaFile({
              xml: this.data,
              absPath,
              vaultRoot,
              toResourceUrl: (rel) => adapter.getResourcePath(normalizePath(rel)),
              uiLanguage: moment.locale(),
            });
    this.dependencies = result.dependencies;

    if (result.error !== undefined) {
      // Mid-edit text is often not valid: keep the last good preview on screen
      // and say what is wrong, rather than blanking the page on every keystroke.
      this.showError(result.error);
      return;
    }
    this.showError(undefined);
    this.body.innerHTML = result.html;
    this.previewStale = false;
    this.updateScheme();
    this.scroller.scrollTop = scrollTop;
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
      anchors.push({ line: Number(el.getAttribute('data-line')), top: el.getBoundingClientRect().top - base });
    });
    return anchors;
  }

  private queueSyncToPreview(): void {
    if (this.mode !== 'split' || this.syncFrame || performance.now() < this.quietUntil) return;
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
      this.scroller.scrollTop = 0;
      return;
    }
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) {
      this.scroller.scrollTop = this.scroller.scrollHeight;
      return;
    }
    const offset = previewOffsetForLine(this.measureAnchors(), this.editor.topLine());
    if (offset !== undefined) this.scroller.scrollTop = offset;
  }

  /** The caret moved: bring its line into the preview if it is out of sight. */
  private revealInPreview(line: number): void {
    if (this.mode !== 'split' || performance.now() < this.quietUntil) return;
    const offset = previewOffsetForLine(this.measureAnchors(), line);
    if (offset === undefined) return;
    const h = this.scroller.clientHeight;
    if (!isOffsetVisible(offset, this.scroller.scrollTop, h, h * 0.2)) {
      this.scroller.scrollTop = Math.max(0, offset - h * 0.3);
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
    const bookSection = this.mode === 'book' ? target?.closest('[data-dita-book-file]') : null;
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
      // Book view has no outline rows; reveal the topic the reader right-clicked.
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
   * "Reveal in source" inside book view: open the topic in a split beside the
   * book, at the line of the element that was right-clicked. Book view has no
   * outline rows, so the clicked section is the target.
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
    // A cross-file xref inside the book: the target is another topic that is
    // already on the page, so scroll to its section instead of opening a file.
    const bookRef = (evt.target as Element | null)?.closest('[data-dita-book-xref]');
    if (bookRef) {
      evt.preventDefault();
      this.jumpInBook(bookRef.getAttribute('data-dita-book-xref') ?? '');
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
   * Ctrl/Cmd is held. `baseAbsPath` overrides the base (a book topic, whose
   * links are relative to the topic file rather than to the map).
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
      // Keep a way back to the outline or book the reader came from.
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
