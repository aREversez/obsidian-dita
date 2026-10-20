import * as assert from 'assert';
import { DitaNode } from '../../src/parser/domTypes';
import { renderElement, RenderContext } from '../../src/render/renderer';
import { KeyHrefDef } from '../../src/editor/keySpace';
import { resolveConkeyref } from '../../src/editor/conkeyref';

/**
 * P3 renderer wiring: conkeyref is the key-based analogue of a direct conref.
 * These tests drive renderElement with an injected resolveConkeyref so the
 * substitution / precedence / fallback / cycle rules are checked in isolation
 * from file IO (the factory + disk integration is covered in
 * conkeyrefRenderIntegration.test.ts).
 */

const sr = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
function el(tagName: string, attributes: Record<string, string>, children: DitaNode[] = []): DitaNode {
  return { type: 'element', tagName, baseType: `topic/${tagName}`, attributes, children, sourceRange: sr };
}
function txt(text: string): DitaNode {
  return { type: 'text', text, children: [], sourceRange: sr };
}

function ctx(over: Partial<RenderContext> = {}): RenderContext {
  return { headingLevel: 1, asWebviewUri: (p) => p, documentDir: '/proj', ...over };
}

describe('renderElement conkeyref handling', () => {
  it('substitutes the conkeyref target in place of the referencing element', () => {
    const target = el('p', { id: 'shared' }, [txt('FromKey')]);
    const ref = el('p', { conkeyref: 'brand/shared' }, [txt('PLACEHOLDER')]);
    const html = renderElement(ref, ctx({ resolveConkeyref: () => target }));
    assert.ok(html.includes('FromKey'), html);
    assert.ok(!html.includes('PLACEHOLDER'), html);
  });

  it('prefers a resolvable conkeyref over a co-located conref (conkeyref wins)', () => {
    const keyTarget = el('p', { id: 'k' }, [txt('FromKey')]);
    const conrefTarget = el('p', { id: 'c' }, [txt('FromConref')]);
    const ref = el('p', { conkeyref: 'brand/shared', conref: 'other.dita#c' }, [txt('X')]);
    const html = renderElement(ref, ctx({
      resolveConkeyref: () => keyTarget,
      resolveConref: () => conrefTarget,
    }));
    assert.ok(html.includes('FromKey'), html);
    assert.ok(!html.includes('FromConref'), html);
  });

  it('falls back to the conref when the conkeyref cannot be resolved', () => {
    const conrefTarget = el('p', { id: 'c' }, [txt('FromConref')]);
    const ref = el('p', { conkeyref: 'missing/shared', conref: 'other.dita#c' }, [txt('X')]);
    const html = renderElement(ref, ctx({
      resolveConkeyref: () => undefined,
      resolveConref: () => conrefTarget,
    }));
    assert.ok(html.includes('FromConref'), html);
  });

  it('renders literal content when neither conkeyref nor conref resolves', () => {
    const ref = el('p', { conkeyref: 'missing/shared' }, [txt('LITERAL')]);
    const html = renderElement(ref, ctx({ resolveConkeyref: () => undefined }));
    assert.ok(html.includes('LITERAL'), html);
  });

  it('does not re-resolve a conkeyref already on the branch (cycle guard)', () => {
    let called = false;
    const ref = el('p', { conkeyref: 'brand/shared' }, [txt('LITERAL')]);
    const html = renderElement(ref, ctx({
      conrefChain: new Set(['brand/shared']),
      resolveConkeyref: () => { called = true; return el('p', {}, [txt('FromKey')]); },
    }));
    assert.strictEqual(called, false, 'resolveConkeyref must not run for a visited conkeyref');
    assert.ok(html.includes('LITERAL'), html);
  });

  it('leaves the conkeyref attribute off the substituted output', () => {
    // Same-type merge keeps the referencing element's own attributes minus the
    // content-reference ones; a resolved conkeyref must not survive into HTML.
    const target = el('p', { id: 'shared' }, [txt('FromKey')]);
    const ref = el('p', { conkeyref: 'brand/shared' }, [txt('X')]);
    const html = renderElement(ref, ctx({ resolveConkeyref: () => target }));
    assert.ok(!html.includes('conkeyref'), html);
  });
});

// The two unit tests that drove resolveConkeyref's old `visited` parameter are
// gone; the cycle rule now lives in the renderer. The test above only proves
// the guard is *consulted* for a pre-seeded chain. This one proves the chain is
// actually *populated* as the renderer descends, using the real resolver, so a
// genuine A <-> B conkeyref loop terminates instead of recursing forever.
describe('renderElement conkeyref cycles (real resolveConkeyref)', () => {
  // A cycle only exists if the substituted content itself contains a
  // conkeyref: the target element's own children are rendered after the swap,
  // and one of them points back. s1 (in A) holds a ref into s2 (in B), and s2
  // holds a ref back into s1.
  const defs = new Map<string, KeyHrefDef>([
    ['a', { href: 'a.dita', baseDir: '/maps' }],
    ['b', { href: 'b.dita', baseDir: '/maps' }],
  ]);
  const s1 = el('section', { id: 's1' }, [el('p', { conkeyref: 'b/s2' }, [txt('A-LITERAL')])]);
  const s2 = el('section', { id: 's2' }, [el('p', { conkeyref: 'a/s1' }, [txt('B-LITERAL')])]);
  const topicA = el('topic', { id: 'aT' }, [el('body', {}, [s1])]);
  const topicB = el('topic', { id: 'bT' }, [el('body', {}, [s2])]);
  const load = (_baseDir: string, href: string): DitaNode | undefined =>
    href === 'a.dita' ? topicA : href === 'b.dita' ? topicB : undefined;

  it('terminates when A\'s conkeyref leads into B, whose content points back into A', () => {
    const html = renderElement(s1, ctx({ resolveConkeyref: (v) => resolveConkeyref(v, defs, load) }));
    assert.ok(html.includes('LITERAL'), `expected the loop to stop at literal content: ${html}`);
  });

  it('terminates when a section\'s content refers back to the section itself', () => {
    const inner = el('p', { conkeyref: 'a/self' }, [txt('SELF-LITERAL')]);
    const self = el('section', { id: 'self' }, [inner]);
    const topic = el('topic', { id: 'aT' }, [el('body', {}, [self])]);
    const html = renderElement(self, ctx({
      resolveConkeyref: (v) => resolveConkeyref(v, defs, (_b, h) => (h === 'a.dita' ? topic : undefined)),
    }));
    assert.ok(html.includes('SELF-LITERAL'), html);
  });
});
