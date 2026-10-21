// Where the reuse badge is drawn, and whether a pointer is on it.
//
// The badge is a background of the reused element itself: dita-content.css
// paints it, and the custom properties it reads are the geometry's single
// source of truth. A background cannot take a cursor or a click of its own,
// so the same box is recomputed here and hit-tested against the pointer.
// The numbers below are only fallbacks for a stylesheet that did not load.

export type ConrefKind = 'block' | 'inline' | 'cell';

export interface BadgeBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far outside the badge a click still counts: the icon is small. */
const SLOP = 3;

const FALLBACK = {
  blockSize: 16,
  blockOffset: 3,
  cellSize: 15,
  cellOffset: 2,
  inlineSize: 11,
  inlineOffset: 1,
} as const;

export function conrefKindOf(el: Element): ConrefKind {
  const kind = el.getAttribute('data-conref');
  return kind === 'inline' || kind === 'cell' ? kind : 'block';
}

function px(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function px0(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The icon's box in client coordinates. Background positions are relative to
 * the padding box (background-origin's default), so the border widths come off
 * first; the inline variant is anchored to the right edge and centred, the
 * other two sit at the top-left with the offsets the stylesheet sets.
 */
export function badgeBox(
  rect: { left: number; top: number; right: number; bottom: number },
  style: CSSStyleDeclaration,
  kind: ConrefKind,
): BadgeBox {
  const borderLeft = px0(style.borderLeftWidth);
  const borderTop = px0(style.borderTopWidth);
  const borderRight = px0(style.borderRightWidth);
  const borderBottom = px0(style.borderBottomWidth);

  if (kind === 'inline') {
    const size = px(style, '--conref-icon-inline-size', FALLBACK.inlineSize);
    const offset = px(style, '--conref-icon-inline-offset', FALLBACK.inlineOffset);
    const right = rect.right - borderRight - offset;
    const centre = (rect.top + borderTop + rect.bottom - borderBottom) / 2;
    return { left: right - size, top: centre - size / 2, right, bottom: centre + size / 2 };
  }

  const cell = kind === 'cell';
  const size = cell ? px(style, '--conref-icon-cell-size', FALLBACK.cellSize) : px(style, '--conref-icon-block-size', FALLBACK.blockSize);
  const offset = cell ? px(style, '--conref-icon-cell-offset', FALLBACK.cellOffset) : px(style, '--conref-icon-block-offset', FALLBACK.blockOffset);
  const left = rect.left + borderLeft + offset;
  const top = rect.top + borderTop + offset;
  return { left, top, right: left + size, bottom: top + size };
}

/** True when the pointer at (x, y) is on the badge, give or take `SLOP`. */
export function badgeHit(box: BadgeBox, x: number, y: number): boolean {
  return x >= box.left - SLOP && x <= box.right + SLOP && y >= box.top - SLOP && y <= box.bottom + SLOP;
}
