// Maps between source lines and vertical positions in the rendered preview.
//
// The renderer stamps elements with data-line (0-based source line they start
// on). The view measures those elements into Anchors; these functions turn a
// source position into a preview scroll offset by interpolating between the
// two anchors that surround it, so scrolling the editor moves the preview
// smoothly instead of jumping from element to element.

export interface Anchor {
  /** 0-based source line the element starts on. */
  line: number;
  /** Distance of the element's top from the top of the scrollable preview, in px. */
  top: number;
}

/**
 * One anchor per distinct line, sorted by line, keeping the topmost position
 * for a line several elements start on (a <p> and its first <b>). Anchors
 * whose position would run backwards (a hoisted element, e.g. conref content
 * that lands elsewhere on the page) are dropped so interpolation stays monotonic.
 */
export function normalizeAnchors(anchors: readonly Anchor[]): Anchor[] {
  const byLine = new Map<number, number>();
  for (const a of anchors) {
    if (!Number.isFinite(a.line) || !Number.isFinite(a.top)) continue;
    const prev = byLine.get(a.line);
    if (prev === undefined || a.top < prev) byLine.set(a.line, a.top);
  }
  const sorted = [...byLine.entries()].sort((x, y) => x[0] - y[0]);
  const out: Anchor[] = [];
  for (const [line, top] of sorted) {
    if (out.length > 0 && top < out[out.length - 1].top) continue;
    out.push({ line, top });
  }
  return out;
}

/**
 * Preview scroll offset that corresponds to `line` (may be fractional: 12.5 is
 * halfway down line 12). Before the first anchor it clamps to the first one's
 * proportional share of the way from the top; past the last it clamps to it.
 * Returns undefined when there are no anchors.
 */
export function previewOffsetForLine(anchors: readonly Anchor[], line: number): number | undefined {
  const a = normalizeAnchors(anchors);
  if (a.length === 0) return undefined;
  if (line <= a[0].line) {
    // Linear from the top of the page to the first element.
    return a[0].line <= 0 ? a[0].top : a[0].top * Math.max(0, line / a[0].line);
  }
  const last = a[a.length - 1];
  if (line >= last.line) return last.top;
  // Binary search for the last anchor with anchor.line <= line.
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid].line <= line) lo = mid;
    else hi = mid - 1;
  }
  const from = a[lo];
  const to = a[lo + 1];
  const t = (line - from.line) / (to.line - from.line);
  return from.top + t * (to.top - from.top);
}

/** True when `offset` lies inside the visible band, with `margin` px kept clear at the bottom. */
export function isOffsetVisible(offset: number, scrollTop: number, viewportHeight: number, margin = 0): boolean {
  return offset >= scrollTop && offset <= scrollTop + viewportHeight - margin;
}
