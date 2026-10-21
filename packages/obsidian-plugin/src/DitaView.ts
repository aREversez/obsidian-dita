import { FileSystemAdapter, Keymap, Menu, Notice, TFile, TextFileView, ViewStateResult, WorkspaceLeaf, moment, normalizePath, setIcon } from 'obsidian';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import coreCss from '../../dita-core/styles/dita-content.css';
import adapterCss from './theme/obsidian-adapter.css';
import { collectDiagnostics, decodeHrefPart, getKeyDefs } from '@dita-viewer/core';
import { renderDitaFile, renderDitamapFile } from './renderFile';
import { SettingsProvider } from './settings';
import { MODE_ICONS, MODE_LABELS, VIEW_MODES, ViewMode, panesFor, parseViewMode, toggleMode } from './viewMode';
import { SourceEditor, createSourceEditor } from './sourceEditor';
import { createCompletionEnv } from './completionEnv';
import { ditaCompletionSource } from './completionSource';
import { Anchor, isOffsetVisible, previewOffsetForLine } from './syncLines';
import { Debounced, debounce } from './debounce';
import { ProblemRange, problemRanges } from './sourceDiagnostics';
import { SourceReference, positionOfId } from './references';
import { createIdReader } from './fileIds';
import { badgeBox, badgeHit, conrefKindOf } from './conrefJump';
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
 * Reading view, source editor and side-by-side live preview for a .dita file.
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

  private dependencies = new Set<string>();
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
    this.scheduleRender.cancel();
    this.editor?.load('', true);
    this.body?.replaceChildren();
    this.dependencies.clear();
    this.showError(undefined);
    this.previewStale = true;
  }

  // ── mode ──

  getMode(): ViewMode {
    return this.mode;
  }

  setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
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
    for (const m of VIEW_MODES) {
      menu.addItem((item) => item.setTitle(MODE_LABELS[m]).setIcon(MODE_ICONS[m]).setChecked(m === this.mode).onClick(() => this.setMode(m)));
    }
  }

  private showModeMenu(evt: MouseEvent): void {
    const menu = new Menu();
    for (const m of VIEW_MODES) {
      menu.addItem((item) => item.setTitle(MODE_LABELS[m]).setIcon(MODE_ICONS[m]).setChecked(m === this.mode).onClick(() => this.setMode(m)));
    }
    menu.showAtMouseEvent(evt);
  }

  private applyMode(): void {
    const panes = panesFor(this.mode);
    this.container.dataset.mode = this.mode;
    setIcon(this.modeAction, MODE_ICONS[this.mode]);
    this.modeAction.setAttribute('aria-label', MODE_LABELS[this.mode]);
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
    if (!file || !vaultRoot) return [];
    const problems = collectDiagnostics({
      xml: text,
      absPath: join(vaultRoot, file.path),
      keys: this.completionEnv()?.keys(),
      idsIn: this.idReader,
    });
    return problemRanges(text.split('\n'), problems);
  }

  /** Called by the plugin when a vault file changes. */
  dependsOnAbsolutePath(absPath: string): boolean {
    return this.dependencies.has(absPath);
  }

  /** Re-render after something the topic references (not the topic itself) changed. */
  async refresh(): Promise<void> {
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
      file.extension.toLowerCase() === 'ditamap'
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
    const hasSelection = (this.previewSelection()?.toString() ?? '') !== '';
    const menu = new Menu();
    menu.addItem((item) => item.setTitle('Copy').setIcon('copy').setDisabled(!hasSelection).onClick(() => void this.copySelection()));
    menu.addItem((item) => item.setTitle('Select all').setIcon('text-select').onClick(() => this.selectAllInPreview()));
    menu.showAtMouseEvent(evt);
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
    this.openRelative(href, evt);
  }

  /** Open a file named by a path relative to this document, in a new tab when Ctrl/Cmd is held. */
  private openRelative(href: string, evt: MouseEvent): void {
    if (!this.file) return;
    const [path] = href.split('#');
    const target = this.app.vault.getAbstractFileByPath(normalizePath(join(dirname(this.file.path), decodeURIComponent(path))));
    if (target instanceof TFile) {
      void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(target);
    }
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
      else this.showSource(place.line ?? 0, place.col ?? 0);
      return;
    }
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile)) {
      new Notice(`File not found: ${rel}`);
      return;
    }
    void this.app.workspace.getLeaf(evt ? Keymap.isModEvent(evt) : false).openFile(target, {
      eState: place.id ? { ditaId: place.id } : { ditaLine: place.line ?? 0, ditaCol: place.col ?? 0 },
    });
  }

  /** Put the caret on the element that carries `id` in this file. */
  private revealId(id: string): void {
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
    if (!visible) this.setMode('split');
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
