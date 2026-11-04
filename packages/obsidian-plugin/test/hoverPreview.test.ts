// Where the popover opened over a preview link goes: Page Preview positions it
// from the pointer it remembers, and these hand it the point the request was
// made from. Positioning itself needs Obsidian's window, so the popover here
// is a stand-in that records the point it was given.

import { strict as assert } from 'assert';
import { anchorPopover, HoverPreview } from '../src/hoverPreview';
import type { HoverPreviewHost } from '../src/hoverPreview';
import type { HoverPopover, Point } from 'obsidian';

const AT: Point = { x: 320, y: 540 };

interface StandIn {
  staticPos: Point | null;
  targetEl?: Element | null;
  position: () => void;
}

function standIn(staticPos: Point | null = null) {
  let calls = 0;
  const popover: StandIn = {
    staticPos,
    position: () => {
      calls++;
    },
  };
  return { popover, calls: () => calls };
}

describe('anchorPopover', () => {
  it('gives a popover without a point the point of the request and positions it again', () => {
    const { popover, calls } = standIn();
    anchorPopover(popover as unknown as HoverPopover, AT);
    assert.equal(popover.staticPos, AT);
    assert.equal(calls(), 1);
  });

  it('leaves a popover that already has a point alone', () => {
    const own: Point = { x: 8, y: 900 };
    const { popover, calls } = standIn(own);
    anchorPopover(popover as unknown as HoverPopover, AT);
    assert.equal(popover.staticPos, own);
    assert.equal(calls(), 0);
  });

  it('keeps Obsidian placement when the popover cannot position itself', () => {
    const popover: { staticPos: Point | null } = { staticPos: null };
    assert.doesNotThrow(() => anchorPopover(popover as unknown as HoverPopover, AT));
    assert.equal(popover.staticPos, null);
  });

  it('keeps the point and does not throw when positioning fails', () => {
    const popover: StandIn = {
      staticPos: null,
      position: () => {
        throw new Error('hoverEl is not built yet');
      },
    };
    assert.doesNotThrow(() => anchorPopover(popover as unknown as HoverPopover, AT));
    assert.equal(popover.staticPos, AT);
  });
});

describe('HoverPreview hoverPopover', () => {
  const host = {} as HTMLElement;
  const make = (): HoverPreview => new HoverPreview({ host: () => host } as unknown as HoverPreviewHost);

  it('hands the preview link point to the preview popover', () => {
    const preview = make();
    (preview as unknown as { pointer: Point }).pointer = AT;
    const { popover, calls } = standIn();
    popover.targetEl = host;
    preview.hoverPopover = popover as unknown as HoverPopover;
    assert.equal(popover.staticPos, AT);
    assert.equal(calls(), 1);
  });

  it('leaves a popover the site navigation asked for alone', () => {
    const preview = make();
    (preview as unknown as { pointer: Point }).pointer = AT;
    const { popover, calls } = standIn();
    popover.targetEl = {} as Element;
    preview.hoverPopover = popover as unknown as HoverPopover;
    assert.equal(popover.staticPos, null);
    assert.equal(calls(), 0);
  });

  it('forgets the point once the pointer has left the preview', () => {
    const preview = make();
    (preview as unknown as { pointer: Point }).pointer = AT;
    preview.left();
    const { popover, calls } = standIn();
    popover.targetEl = host;
    preview.hoverPopover = popover as unknown as HoverPopover;
    assert.equal(popover.staticPos, null);
    assert.equal(calls(), 0);
  });
});
