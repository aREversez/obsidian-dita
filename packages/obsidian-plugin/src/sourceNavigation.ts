// Source navigation: every jump that puts text in front of the reader.
//
// A link, a keyref, a reuse badge, an outline row, a book section or the
// Outline pane all end here, and all of them resolve to a place in a source
// file: this one (the caret moves, and the source pane opens when only the
// preview was showing) or another (a leaf takes the position through ephemeral
// state). A reveal that had to switch views leaves a way back, which the view
// shows as a header button; so does a jump that arrived with the file itself.
//
// The view owns the editor, the mode and the header button; this asks for them
// through the host and keeps only what a pending jump needs.

import { App, Keymap, Notice, TFile, normalizePath } from 'obsidian';
import { decodeHrefPart, getKeyDefs, splitRefFragment } from '@dita-viewer/core';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { badgeBox, badgeHit, conrefKindOf } from './conrefJump';
import { fragmentOf, keyNameOf, pathOf } from './linkTarget';
import { outlineEntryPosition } from './mapOutline';
import { positionOfId } from './references';
import type { SourceReference } from './references';
import type { SourceEditor } from './sourceEditor';
import { panesFor } from './viewMode';
import type { ViewMode } from './viewMode';

/** Where a jump puts the reader: a line, a column, and/or an element id. */
interface RevealPlace {
  line?: number;
  col?: number;
  id?: string;
}

export interface SourceNavigationHost {
  readonly app: App;
  file(): TFile | null;
  mode(): ViewMode;
  vaultRoot(): string | undefined;
  editor(): SourceEditor | undefined;
  /** The key space this file's keyrefs resolve against, the one the preview renders with. */
  keys(): ReadonlyMap<string, string> | undefined;
  /** The text as it would be saved, which is what the outline tree's positions count in. */
  getViewData(): string;
  setMode(mode: ViewMode): void;
  /** Show the header Back button for `mode`, or hide it when undefined. */
  showBackTo(mode: ViewMode | undefined): void;
  /** The preview's host element, whose class marks a reuse badge under the pointer. */
  previewHost(): HTMLElement | undefined;
  /** Revealing scrolls the editor, and the echo would scroll the preview back. */
  quietSync(): void;
  /** Where a source line sits in the preview, when the preview can tell. */
  offsetForLine(line: number): number | undefined;
  setPreviewScroll(top: number): void;
  nextFrame(cb: FrameRequestCallback): void;
  /** A leaf opened one of our views: it should be looking at the source. */
  setSourceMode(view: unknown): void;
}

export class SourceNavigation {
  /** A reveal requested through ephemeral state, applied once the text is loaded. */
  private pending?: RevealPlace;
  /** The view to offer as "Back" after a reveal switched this pane to split. */
  private returnMode?: ViewMode;

  constructor(private readonly host: SourceNavigationHost) {}

  /** The view "Back" returns to, if a reveal replaced one. */
  get backMode(): ViewMode | undefined {
    return this.returnMode;
  }

  /**
   * Where to put the caret when another view opens this file (conref jump,
   * Ctrl/Cmd+click): a line and column, an element id, or a plain line.
   */
  request(state: unknown): void {
    const saved = (state ?? {}) as { ditaLine?: unknown; ditaCol?: unknown; ditaId?: unknown; line?: unknown };
    const line = typeof saved.ditaLine === 'number' && Number.isFinite(saved.ditaLine) ? saved.ditaLine : undefined;
    const col = typeof saved.ditaCol === 'number' && Number.isFinite(saved.ditaCol) ? saved.ditaCol : undefined;
    const id = typeof saved.ditaId === 'string' && saved.ditaId ? saved.ditaId : undefined;
    if (line === undefined && id === undefined) {
      // A plain `line` is how Obsidian's own Outline (and a link to a line) asks for a position.
      if (typeof saved.line === 'number' && Number.isFinite(saved.line)) this.goToLine(saved.line);
      return;
    }
    this.pending = { line, col, id };
    this.applyPending();
  }

  /** Apply a reveal that arrived with the file (setEphemeralState) once its text is here. */
  applyPending(): void {
    const pending = this.pending;
    const editor = this.host.editor();
    if (!pending || !editor) return;
    // An id is looked up in the text, so wait until the file's text is in the
    // editor; setViewData calls this again once it is.
    if (pending.id && editor.getText() === '') return;
    this.pending = undefined;
    if (pending.id) {
      this.revealId(pending.id);
      return;
    }
    this.showSource(pending.line ?? 0, pending.col ?? 0);
  }

  /** A deliberate mode change or another file ends the "Back to ..." offer. */
  clearBack(): void {
    this.returnMode = undefined;
    this.updateBackAction();
  }

  /** The file's own state is gone (the pane is being emptied): no jump is waiting, and no way back. */
  reset(): void {
    this.pending = undefined;
    this.clearBack();
  }

  /** Show the header Back button if a reveal left a view to go back to. */
  updateBackAction(): void {
    this.host.showBackTo(this.returnMode);
  }

  /** Ctrl/Cmd+click in the source: open the file or the key the attribute names. */
  openReference(ref: SourceReference, evt: MouseEvent): void {
    const file = this.host.file();
    const vaultRoot = this.host.vaultRoot();
    if (!file || !vaultRoot) return;
    const here = join(vaultRoot, file.path);

    if (ref.kind === 'key') {
      const key = keyNameOf(ref.value);
      const keys = this.host.keys();
      // getKeyDefs indexes its WeakMap by the map instance; the key space handed
      // out is the same Map, read-only only so callers do not mutate the cache.
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
  openSource(absPath: string, place: RevealPlace, evt?: MouseEvent): void {
    const vaultRoot = this.host.vaultRoot();
    if (!vaultRoot) return;
    const rel = relative(vaultRoot, absPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      new Notice('The target file is outside the vault.');
      return;
    }
    const path = normalizePath(rel);
    if (path === this.host.file()?.path) {
      if (place.id) this.revealId(place.id);
      else if (place.line !== undefined) this.showSource(place.line, place.col ?? 0);
      return;
    }
    const target = this.host.app.vault.getAbstractFileByPath(path);
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
    void this.host.app.workspace.getLeaf(evt ? Keymap.isModEvent(evt) : false).openFile(target, eState ? { eState } : undefined);
  }

  /** Put the caret on the element that carries `id` in this file. */
  revealId(fragment: string): void {
    const editor = this.host.editor();
    if (!editor) return;
    // A fragment is "topicid" or "topicid/elementid"; the caret goes to the
    // element, which is the part after the slash.
    const id = splitRefFragment(fragment).elementId;
    const pos = positionOfId(editor.getText(), id);
    if (!pos) {
      new Notice(`No element with id "${id}" in this file.`);
      return;
    }
    this.showSource(pos.line, pos.col);
  }

  /** Bring a source position into view, opening the editor pane when only the preview was showing. */
  showSource(line: number, col: number): void {
    const editor = this.host.editor();
    if (!editor) return;
    const visible = panesFor(this.host.mode()).editor;
    const previous = this.host.mode();
    if (!visible) {
      this.host.setMode('split');
      // Keep a way back to the outline, site or book the reader came from.
      this.returnMode = previous;
      this.updateBackAction();
    }
    // Revealing scrolls the editor; without this the echo would scroll the preview back.
    this.host.quietSync();
    const reveal = () => {
      editor.reveal(line, col);
      editor.focus();
    };
    // A pane that was hidden needs a frame to be laid out before it can scroll.
    if (visible) reveal();
    else this.host.nextFrame(reveal);
  }

  /**
   * Scroll to a source line the way the other panes do: put the caret there
   * when the source is showing, otherwise move the preview without switching
   * views. A view with nothing in its preview to scroll to (a map's outline
   * tree) falls back to showing the source.
   */
  goToLine(line: number): void {
    if (!this.host.editor()) return;
    if (panesFor(this.host.mode()).editor) {
      this.showSource(line, 0);
      return;
    }
    const offset = this.host.offsetForLine(line);
    if (offset === undefined) {
      this.showSource(line, 0);
      return;
    }
    this.host.setPreviewScroll(Math.max(0, offset));
  }

  /**
   * "Reveal in source" for an outline row: put the caret on the topicref in
   * this map. Rows spliced in from a referenced submap have no line in this
   * text, so those open the topic they name in the source instead.
   */
  revealOutlineEntry(href: string): void {
    const pos = outlineEntryPosition(this.host.getViewData(), href);
    if (pos) {
      this.showSource(pos.line, pos.col);
      return;
    }
    const file = this.host.file();
    if (!file || !href || href.startsWith('#')) return;
    const target = this.host.app.vault.getAbstractFileByPath(
      normalizePath(join(dirname(file.path), decodeHrefPart(href.split('#')[0]))),
    );
    if (target instanceof TFile) {
      this.openSourceBeside(target, 0, 0);
      return;
    }
    new Notice('The topic for this outline entry was not found.');
  }

  /** Show a file's source in a new pane beside this one; the outline or book stays put. */
  openSourceBeside(file: TFile, line: number, col: number): void {
    const leaf = this.host.app.workspace.getLeaf('split', 'vertical');
    const eState = {
      ditaLine: Number.isFinite(line) ? line : 0,
      ditaCol: Number.isFinite(col) ? col : 0,
    };
    void leaf.openFile(file, { eState }).then(() => this.host.setSourceMode(leaf.view));
  }

  /**
   * "Reveal in source" inside book or site view: open the topic in a split
   * beside the map, at the line of the element that was right-clicked. Those
   * views have no outline rows, so the clicked page/section is the target.
   */
  revealBookSection(section: Element, target: Element | null): void {
    const abs = section.getAttribute('data-dita-book-file');
    const vaultRoot = this.host.vaultRoot();
    if (!abs || !vaultRoot) return;
    const rel = relative(vaultRoot, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      new Notice('The topic is outside the vault.');
      return;
    }
    const file = this.host.app.vault.getAbstractFileByPath(normalizePath(rel));
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

  /** The reuse badge under the pointer, if any: a background cannot answer that itself. */
  conrefBadge(evt: MouseEvent): Element | undefined {
    const el = (evt.target as Element | null)?.closest('[data-conref]');
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) return undefined;
    const box = badgeBox(el.getBoundingClientRect(), win.getComputedStyle(el), conrefKindOf(el));
    return badgeHit(box, evt.clientX, evt.clientY) ? el : undefined;
  }

  /** The pointer over the badge's corner is the jump affordance. */
  onConrefHover(evt: PointerEvent): void {
    const host = this.host.previewHost();
    if (!host) return;
    host.classList.toggle('dv-conref-hot', this.conrefBadge(evt) !== undefined);
  }

  /** The badge was clicked (or Enter/Space pressed on it): open the reused element's source. */
  jumpToConref(el: Element, evt?: MouseEvent): void {
    const file = el.getAttribute('data-conref-file');
    const line = Number(el.getAttribute('data-conref-line'));
    const col = Number(el.getAttribute('data-conref-col') ?? 0);
    if (!file || !Number.isFinite(line)) return;
    this.openSource(file, { line, col: Number.isFinite(col) ? col : 0 }, evt);
  }
}
