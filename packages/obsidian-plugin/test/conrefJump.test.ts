import { strict as assert } from 'assert';
import { badgeBox, badgeHit, conrefKindOf } from '../src/conrefJump';

function style(props: Record<string, string>, border = '0px'): CSSStyleDeclaration {
  return {
    borderLeftWidth: border,
    borderTopWidth: border,
    borderRightWidth: border,
    borderBottomWidth: border,
    getPropertyValue: (name: string) => props[name] ?? '',
  } as unknown as CSSStyleDeclaration;
}

const rect = { left: 10, top: 20, right: 110, bottom: 60 };

describe('conref badge geometry', () => {
  it('reads the kind from the attribute, defaulting to block', () => {
    assert.equal(conrefKindOf({ getAttribute: () => 'inline' } as unknown as Element), 'inline');
    assert.equal(conrefKindOf({ getAttribute: () => 'cell' } as unknown as Element), 'cell');
    assert.equal(conrefKindOf({ getAttribute: () => 'block' } as unknown as Element), 'block');
    assert.equal(conrefKindOf({ getAttribute: () => null } as unknown as Element), 'block');
  });

  it('puts the block badge at the top-left offset, inside the border', () => {
    const box = badgeBox(rect, style({ '--conref-icon-block-size': '16px', '--conref-icon-block-offset': '3px' }, '1px'), 'block');
    assert.deepEqual(box, { left: 14, top: 24, right: 30, bottom: 40 });
  });

  it('uses the cell offsets for a table cell', () => {
    const box = badgeBox(rect, style({ '--conref-icon-cell-size': '15px', '--conref-icon-cell-offset': '2px' }), 'cell');
    assert.deepEqual(box, { left: 12, top: 22, right: 27, bottom: 37 });
  });

  it('anchors the inline badge to the right edge, vertically centred', () => {
    const box = badgeBox(rect, style({ '--conref-icon-inline-size': '11px', '--conref-icon-inline-offset': '1px' }), 'inline');
    assert.deepEqual(box, { left: 98, top: 34.5, right: 109, bottom: 45.5 });
  });

  it('falls back to the stylesheet defaults when the properties are missing', () => {
    const box = badgeBox(rect, style({}), 'block');
    assert.deepEqual(box, { left: 13, top: 23, right: 29, bottom: 39 });
  });

  it('hits with a little slop around the icon', () => {
    const box = { left: 10, top: 10, right: 20, bottom: 20 };
    assert.equal(badgeHit(box, 15, 15), true);
    assert.equal(badgeHit(box, 7, 10), true);
    assert.equal(badgeHit(box, 6, 10), false);
    assert.equal(badgeHit(box, 23, 20), true);
    assert.equal(badgeHit(box, 24, 20), false);
  });
});
