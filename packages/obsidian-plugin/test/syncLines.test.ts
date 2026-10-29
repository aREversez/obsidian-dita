import { strict as assert } from 'assert';
import { EchoGuard, isOffsetVisible, lineForPreviewOffset, normalizeAnchors, previewOffsetForLine } from '../src/syncLines';

const A = [
  { line: 2, top: 100 },
  { line: 6, top: 300 },
  { line: 10, top: 340 },
];

describe('previewOffsetForLine', () => {
  it('returns undefined without anchors', () => {
    assert.equal(previewOffsetForLine([], 3), undefined);
  });

  it('is exact on an anchor line', () => {
    assert.equal(previewOffsetForLine(A, 2), 100);
    assert.equal(previewOffsetForLine(A, 6), 300);
    assert.equal(previewOffsetForLine(A, 10), 340);
  });

  it('interpolates between anchors, including fractional lines', () => {
    assert.equal(previewOffsetForLine(A, 4), 200);
    assert.equal(previewOffsetForLine(A, 8), 320);
    assert.equal(previewOffsetForLine(A, 4.5), 225);
  });

  it('clamps to the last anchor past the end', () => {
    assert.equal(previewOffsetForLine(A, 500), 340);
  });

  it('before the first anchor, scales from the top of the page', () => {
    assert.equal(previewOffsetForLine(A, 0), 0);
    assert.equal(previewOffsetForLine(A, 1), 50);
    assert.equal(previewOffsetForLine(A, -5), 0);
  });

  it('a first anchor on line 0 anchors the top', () => {
    assert.equal(previewOffsetForLine([{ line: 0, top: 24 }, { line: 4, top: 124 }], 0), 24);
    assert.equal(previewOffsetForLine([{ line: 0, top: 24 }, { line: 4, top: 124 }], 2), 74);
  });

  it('is monotonic non-decreasing in line', () => {
    let prev = -Infinity;
    for (let l = 0; l <= 12; l += 0.25) {
      const v = previewOffsetForLine(A, l)!;
      assert.ok(v >= prev, `line ${l}: ${v} < ${prev}`);
      prev = v;
    }
  });
});

describe('normalizeAnchors', () => {
  it('sorts, and keeps the topmost position for a repeated line', () => {
    assert.deepEqual(
      normalizeAnchors([{ line: 5, top: 80 }, { line: 1, top: 10 }, { line: 5, top: 60 }]),
      [{ line: 1, top: 10 }, { line: 5, top: 60 }],
    );
  });

  it('drops an anchor that runs backwards (hoisted content) and non-finite values', () => {
    assert.deepEqual(
      normalizeAnchors([{ line: 1, top: 10 }, { line: 2, top: 500 }, { line: 3, top: 40 }, { line: 4, top: 600 }, { line: NaN, top: 1 }, { line: 9, top: Infinity }]),
      [{ line: 1, top: 10 }, { line: 2, top: 500 }, { line: 4, top: 600 }],
    );
  });
});

describe('isOffsetVisible', () => {
  it('tests the visible band with a bottom margin', () => {
    assert.equal(isOffsetVisible(150, 100, 400), true);
    assert.equal(isOffsetVisible(99, 100, 400), false);
    assert.equal(isOffsetVisible(500, 100, 400), true);
    assert.equal(isOffsetVisible(500, 100, 400, 50), false);
  });
});

describe('lineForPreviewOffset', () => {
  it('returns undefined without anchors', () => {
    assert.equal(lineForPreviewOffset([], 50), undefined);
  });

  it('interpolates between the anchors around the offset', () => {
    assert.equal(lineForPreviewOffset(A, 200), 4); // halfway from line 2 (100) to line 6 (300)
    assert.equal(lineForPreviewOffset(A, 320), 8);
  });

  it('is the inverse of previewOffsetForLine', () => {
    for (const line of [0.5, 1, 2, 3.25, 6, 7.5, 9.9]) {
      const offset = previewOffsetForLine(A, line) as number;
      assert.ok(Math.abs((lineForPreviewOffset(A, offset) as number) - line) < 1e-9, `line ${line}`);
    }
  });

  it('clamps above the first anchor in proportion, and below the last to it', () => {
    assert.equal(lineForPreviewOffset(A, 50), 1); // half of the way to line 2
    assert.equal(lineForPreviewOffset(A, 0), 0);
    assert.equal(lineForPreviewOffset(A, 5000), 10);
  });

  it('copes with anchors that share a height (an empty element)', () => {
    const same = [{ line: 1, top: 10 }, { line: 4, top: 100 }, { line: 5, top: 100 }, { line: 9, top: 200 }];
    assert.equal(lineForPreviewOffset(same, 100), 5); // the later of the two, which is the visible one
    assert.equal(lineForPreviewOffset(same, 150), 7);
    assert.equal(lineForPreviewOffset(same, 55), 2.5);
  });
});

describe('EchoGuard', () => {
  it('knows the scroll event that follows its own move, and only that', () => {
    const guard = new EchoGuard();
    assert.equal(guard.isEcho(120, 0), false); // nothing expected yet
    guard.expect(120, 0);
    assert.equal(guard.isEcho(120, 16), true);
    assert.equal(guard.isEcho(121, 16), true); // rounding to device pixels
    assert.equal(guard.isEcho(160, 16), false); // the user scrolled somewhere else
  });

  it('stops treating a position as an echo after a while', () => {
    const guard = new EchoGuard();
    guard.expect(120, 0);
    assert.equal(guard.isEcho(120, 600), false);
  });
});
