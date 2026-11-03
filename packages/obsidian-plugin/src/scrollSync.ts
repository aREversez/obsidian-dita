// Two-way scroll sync between the source editor and the preview, in split view.
//
// The preview's elements carry the source line they start on (data-line), so
// they can be measured into Anchors and the two panes can be lined up at any
// position, not just element by element. That mapping is in syncLines.ts; this
// is the state that drives it: which pane moved, the frame that follows it,
// and the echo guards that keep the two from chasing each other.
//
// The view owns the mode and the frames; everything DOM here is asked for
// through the host, so a popout window's frames are the ones used.

import { Anchor, EchoGuard, isOffsetVisible, lineForPreviewOffset, previewOffsetForLine } from './syncLines';
import type { SourceEditor } from './sourceEditor';
import type { ViewMode } from './viewMode';

/** After the preview is told to jump to a line, ignore the editor's own scroll echo for this long. */
const QUIET_MS = 250;

/**
 * A heading counts as the one the preview is at once its top is this close to
 * the top of the pane. Scrolling to a row of the Outline puts the heading right
 * at the top, give or take the pixel rounding of a scroll position, and that
 * row has to be the one marked, not the row above it.
 */
const OUTLINE_REACH_PX = 8;

export interface ScrollSyncHost {
  /** The preview's scroll container. */
  readonly scroller: HTMLElement;
  /** The preview's shadow root: where the stamped elements are measured. */
  readonly shadow: ShadowRoot;
  editor(): SourceEditor | undefined;
  mode(): ViewMode;
  /** Run `cb` before the next paint of the window this view is in. */
  nextFrame(cb: FrameRequestCallback): number;
  cancelFrame(id: number): void;
}

export class ScrollSync {
  private syncFrame = 0;
  private syncEditorFrame = 0;
  private quietUntil = 0;
  /** Our own scroll moves of the preview and of the editor, so their echoes are not taken for the user's. */
  private readonly previewEcho = new EchoGuard();
  private readonly editorEcho = new EchoGuard();

  constructor(private readonly host: ScrollSyncHost) {}

  // ── the editor drives the preview ──

  /** The editor scrolled: line up the preview, unless this was our own move. */
  queueFromEditor(): void {
    if (!this.isSplit() || this.syncFrame || this.quietActive()) return;
    const editor = this.host.editor();
    if (!editor) return;
    if (this.editorEcho.isEcho(editor.view.scrollDOM.scrollTop)) return;
    this.syncFrame = this.host.nextFrame(() => {
      this.syncFrame = 0;
      this.syncPreviewToEditor();
    });
  }

  /** Line the two panes up right now: they were just made visible and need no frame to settle. */
  syncNow(): void {
    this.syncPreviewToEditor();
  }

  private syncPreviewToEditor(): void {
    const editor = this.editorInSplit();
    if (!editor) return;
    const sc = editor.view.scrollDOM;
    // The ends line up exactly, whatever the two documents' proportions.
    if (sc.scrollTop <= 0) {
      this.setPreviewScroll(0);
      return;
    }
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) {
      this.setPreviewScroll(this.host.scroller.scrollHeight);
      return;
    }
    const offset = previewOffsetForLine(this.measureAnchors(), editor.topLine());
    if (offset !== undefined) this.setPreviewScroll(offset);
  }

  // ── the preview drives the editor ──

  /** The preview was scrolled (by the user): bring the editor to the same place. */
  queueFromPreview(): void {
    if (!this.isSplit() || this.syncEditorFrame || this.quietActive()) return;
    if (this.previewEcho.isEcho(this.host.scroller.scrollTop)) return;
    this.syncEditorFrame = this.host.nextFrame(() => {
      this.syncEditorFrame = 0;
      this.syncEditorToPreview();
    });
  }

  private syncEditorToPreview(): void {
    const editor = this.editorInSplit();
    if (!editor) return;
    const sc = this.host.scroller;
    const ed = editor.view.scrollDOM;
    if (sc.scrollTop <= 0) {
      ed.scrollTop = 0;
    } else if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1) {
      // The ends line up exactly, as they do when the editor leads.
      ed.scrollTop = ed.scrollHeight;
    } else {
      const line = lineForPreviewOffset(this.measureAnchors(), sc.scrollTop);
      if (line === undefined) return;
      editor.scrollToTopLine(line);
    }
    this.editorEcho.expect(ed.scrollTop);
  }

  // ── positions ──

  /** The caret moved: bring its line into the preview if it is out of sight. */
  revealLine(line: number): void {
    if (!this.isSplit() || this.quietActive()) return;
    const offset = previewOffsetForLine(this.measureAnchors(), line);
    if (offset === undefined) return;
    const h = this.host.scroller.clientHeight;
    if (!isOffsetVisible(offset, this.host.scroller.scrollTop, h, h * 0.2)) {
      this.setPreviewScroll(Math.max(0, offset - h * 0.3));
    }
  }

  /** The preview offset that shows `line`, or undefined when nothing on the page has a line. */
  offsetForLine(line: number): number | undefined {
    return previewOffsetForLine(this.measureAnchors(), line);
  }

  /** The source line at the top of the preview, whole, or undefined when nothing there has a line. */
  lineAtPreviewTop(): number | undefined {
    const line = lineForPreviewOffset(this.measureAnchors(), this.host.scroller.scrollTop + OUTLINE_REACH_PX);
    return line === undefined ? undefined : Math.floor(line);
  }

  /** Move the preview by code, noting where it ends up so its scroll event is known for an echo. */
  setPreviewScroll(top: number): void {
    this.host.scroller.scrollTop = top;
    this.previewEcho.expect(this.host.scroller.scrollTop);
  }

  /**
   * The preview is about to be scrolled to a line by a reveal: the editor's own
   * scroll that follows is not the user's, so ignore it for a moment.
   */
  quiet(): void {
    this.quietUntil = performance.now() + QUIET_MS;
  }

  destroy(): void {
    if (this.syncFrame) this.host.cancelFrame(this.syncFrame);
    if (this.syncEditorFrame) this.host.cancelFrame(this.syncEditorFrame);
    this.syncFrame = 0;
    this.syncEditorFrame = 0;
  }

  private isSplit(): boolean {
    return this.host.mode() === 'split';
  }

  /** Still inside a reveal's quiet window, when the panes must not follow each other. */
  private quietActive(): boolean {
    return performance.now() < this.quietUntil;
  }

  private editorInSplit(): SourceEditor | undefined {
    return this.isSplit() ? this.host.editor() : undefined;
  }

  /**
   * One anchor per element stamped with its source line, at its position in the
   * scrolled preview.
   */
  private measureAnchors(): Anchor[] {
    const scroller = this.host.scroller;
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const anchors: Anchor[] = [];
    this.host.shadow.querySelectorAll('[data-line]').forEach((el) => {
      // A line the conditional-processing filter hides has no position to follow.
      if (el.getClientRects().length === 0) return;
      anchors.push({ line: Number(el.getAttribute('data-line')), top: el.getBoundingClientRect().top - base });
    });
    return anchors;
  }
}
