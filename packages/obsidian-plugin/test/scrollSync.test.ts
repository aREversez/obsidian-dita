// The sync is state, not drawing: which pane moved, the frame that follows it,
// and the echoes it has to ignore. Everything DOM-ish reaches it through the
// host, so the tests lend it scroll boxes and stamped elements instead of a
// rendered preview.

import { strict as assert } from 'assert';
import { ScrollSync } from '../src/scrollSync';
import type { ScrollSyncHost } from '../src/scrollSync';
import type { SourceEditor } from '../src/sourceEditor';
import type { ViewMode } from '../src/viewMode';

/** A scroll box: the numbers the sync reads, plus the viewport's top edge. */
class Box {
  scrollTop = 0;

  constructor(
    readonly clientHeight: number,
    readonly scrollHeight: number,
  ) {}

  getBoundingClientRect(): { top: number } {
    return { top: 0 };
  }
}

interface Stamp {
  line: number;
  /** Distance from the top of the page. */
  offset: number;
  hidden?: boolean;
}

function scene(options: { mode?: ViewMode; stamps?: readonly Stamp[]; topLine?: number } = {}) {
  const scroller = new Box(400, 2000);

  // An element sits a fixed distance down the page, so its rect moves with the box.
  const nodes = (options.stamps ?? []).map((stamp) => ({
    getAttribute: (name: string) => (name === 'data-line' ? String(stamp.line) : null),
    getClientRects: () => (stamp.hidden ? [] : [{}]),
    getBoundingClientRect: () => ({ top: stamp.offset - scroller.scrollTop }),
  }));
  const shadow = {
    querySelectorAll: () => ({ forEach: (cb: (node: (typeof nodes)[number]) => void) => nodes.forEach(cb) }),
  };

  const editorScroll = new Box(300, 1200);
  const scrolledTo: number[] = [];
  const editor = {
    view: { scrollDOM: editorScroll },
    topLine: () => options.topLine ?? 0,
    // A line 10 is 400px down, matching PAGE.
    scrollToTopLine: (line: number) => {
      scrolledTo.push(line);
      editorScroll.scrollTop = line * 40;
    },
  };

  let mode: ViewMode = options.mode ?? 'split';
  const frames: FrameRequestCallback[] = [];
  const cancelled: number[] = [];
  const host: ScrollSyncHost = {
    scroller: scroller as unknown as HTMLElement,
    shadow: shadow as unknown as ShadowRoot,
    editor: () => editor as unknown as SourceEditor,
    mode: () => mode,
    nextFrame: (cb) => frames.push(cb),
    cancelFrame: (id) => cancelled.push(id),
  };

  return {
    sync: new ScrollSync(host),
    scroller,
    editorScroll,
    scrolledTo,
    frames,
    cancelled,
    setMode: (next: ViewMode) => {
      mode = next;
    },
    /** Run the one frame that was asked for, the way the window would. */
    flush: () => frames.splice(0).forEach((cb) => cb(0)),
  };
}

const PAGE: Stamp[] = [
  { line: 0, offset: 0 },
  { line: 10, offset: 400 },
  { line: 20, offset: 800 },
];

describe('ScrollSync from the editor', () => {
  it('moves the preview to the editor top line, one frame later', () => {
    const s = scene({ stamps: PAGE, topLine: 10 });
    s.editorScroll.scrollTop = 400;
    s.sync.queueFromEditor();
    assert.equal(s.scroller.scrollTop, 0, 'nothing moves before the frame');
    s.flush();
    assert.equal(s.scroller.scrollTop, 400);
  });

  it('coalesces a burst of scroll events into one frame', () => {
    const s = scene({ stamps: PAGE, topLine: 10 });
    s.editorScroll.scrollTop = 400;
    s.sync.queueFromEditor();
    s.sync.queueFromEditor();
    s.sync.queueFromEditor();
    assert.equal(s.frames.length, 1);
    s.flush();
    assert.equal(s.scroller.scrollTop, 400);
    s.sync.queueFromEditor();
    assert.equal(s.frames.length, 1, 'the next scroll is picked up again');
  });

  it('lines the ends up exactly, whatever the documents look like', () => {
    const s = scene({ stamps: PAGE, topLine: 0 });
    s.sync.syncNow();
    assert.equal(s.scroller.scrollTop, 0);

    s.editorScroll.scrollTop = 900;
    s.sync.syncNow();
    assert.equal(s.scroller.scrollTop, s.scroller.scrollHeight);
  });

  it('does nothing outside split view', () => {
    const s = scene({ stamps: PAGE, mode: 'reading', topLine: 10 });
    s.scroller.scrollTop = 777;
    s.sync.queueFromEditor();
    assert.equal(s.frames.length, 0);
    s.sync.syncNow();
    assert.equal(s.scroller.scrollTop, 777);
  });
});

describe('ScrollSync from the preview', () => {
  it('scrolls the editor to the line at the top of the preview', () => {
    const s = scene({ stamps: PAGE });
    s.scroller.scrollTop = 400;
    s.sync.queueFromPreview();
    s.flush();
    assert.deepEqual(s.scrolledTo, [10]);
  });

  it('ignores the editor scroll that its own move caused', () => {
    const s = scene({ stamps: PAGE });
    s.scroller.scrollTop = 400;
    s.sync.queueFromPreview();
    s.flush();
    assert.equal(s.editorScroll.scrollTop, 400, 'the editor now sits where it was sent');

    s.sync.queueFromEditor();
    assert.equal(s.frames.length, 0, 'the editor echoing our move is not a scroll to follow');
  });

  it('ignores the preview scroll that its own move caused', () => {
    const s = scene({ stamps: PAGE });
    s.sync.revealLine(20);
    assert.equal(s.scroller.scrollTop, 680, 'scrolled to the line, less a margin');

    s.sync.queueFromPreview();
    assert.equal(s.frames.length, 0);
  });

  it('brings the caret line into the preview only when it is out of sight', () => {
    const visible = scene({ stamps: [{ line: 5, offset: 100 }] });
    visible.sync.revealLine(5);
    assert.equal(visible.scroller.scrollTop, 0, 'already near the top');

    const below = scene({ stamps: [{ line: 50, offset: 380 }] });
    below.sync.revealLine(50);
    assert.equal(below.scroller.scrollTop, 260, '380, less 30% of the 400px pane');
  });
});

describe('ScrollSync quiet window', () => {
  it('stops both panes from following after a reveal', () => {
    const s = scene({ stamps: PAGE, topLine: 10 });
    s.sync.quiet();
    s.sync.queueFromEditor();
    s.scroller.scrollTop = 400;
    s.sync.queueFromPreview();
    s.sync.revealLine(0);
    assert.equal(s.frames.length, 0);
    assert.equal(s.scroller.scrollTop, 400);
  });
});

describe('ScrollSync measurements', () => {
  it('the line at the top counts a heading a few pixels below it', () => {
    const s = scene({
      stamps: [
        { line: 0, offset: 0 },
        { line: 4, offset: 108 },
      ],
    });
    s.scroller.scrollTop = 100;
    assert.equal(s.sync.lineAtPreviewTop(), 4, 'the heading scrolled to is the one marked');
    s.scroller.scrollTop = 60;
    assert.equal(s.sync.lineAtPreviewTop(), 2);
  });

  it('a line the filter hid is not an anchor', () => {
    const s = scene({ stamps: [{ line: 5, offset: 100, hidden: true }] });
    assert.equal(s.sync.offsetForLine(5), undefined);
    assert.equal(s.sync.lineAtPreviewTop(), undefined);
  });

  it('syncs nothing on a page that carries no line', () => {
    const s = scene();
    assert.equal(s.sync.offsetForLine(3), undefined);
    s.scroller.scrollTop = 40;
    assert.equal(s.sync.lineAtPreviewTop(), undefined);
  });
});

describe('ScrollSync teardown', () => {
  it('cancels the frame it was waiting for', () => {
    const s = scene({ stamps: PAGE, topLine: 10 });
    s.editorScroll.scrollTop = 400;
    s.sync.queueFromEditor();
    s.sync.destroy();
    assert.deepEqual(s.cancelled, [1]);
    assert.equal(s.scroller.scrollTop, 0, 'nothing moved');
  });
});
