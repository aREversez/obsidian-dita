import * as assert from 'assert';
import { DitaNode } from '../../src/parser/domTypes';
import { buildRenderContext } from '../../src/editor/renderContext';

/**
 * P2 shared render-context factory. Three call sites (renderTopicXml for
 * book/site, DitaViewerProvider for single-topic preview, ditaDiffProvider
 * for the diff panel) each used to hand-assemble the same conref/key
 * resolvers. The whole point of buildRenderContext is that the key
 * resolvers are wired identically everywhere, so a later change (conkeyref)
 * lands in one place. This test is the regression guard: for one input, the
 * resolvers the factory produces give the same answer regardless of the
 * peripheral flags (indexLabel / book extras) the sites differ on.
 *
 * Same-document conrefs (#id) and key lookups are used because they never
 * touch the file system, so the assertion is pure and deterministic.
 */

const sourceRange = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };

function node(baseType: string, attributes: Record<string, string>, children: DitaNode[] = []): DitaNode {
  return { type: 'element', baseType, attributes, children, sourceRange };
}

// <topic id="t"><p id="p1">hi</p></topic>
const p1 = node('topic/p', { id: 'p1' }, [{ type: 'text', text: 'hi', children: [], sourceRange }]);
const root = node('topic/topic', { id: 't' }, [p1]);

function baseInput(over: Partial<Parameters<typeof buildRenderContext>[0]> = {}) {
  return {
    docDir: '/proj',
    ownRoot: root,
    titleMap: new Map<string, string>([['t', 'Topic T']]),
    keyMap: new Map<string, string>([['brand', 'Acme']]),
    asWebviewUri: (p: string) => p,
    headingLevel: 1,
    uiLanguage: 'en',
    ...over,
  };
}

describe('buildRenderContext (P2 shared factory)', () => {
  it('wires resolveKey to the key map', () => {
    const { ctx } = buildRenderContext(baseInput());
    assert.strictEqual(ctx.resolveKey!('brand'), 'Acme');
    assert.strictEqual(ctx.resolveKey!('missing'), undefined);
  });

  it('wires resolveConref to find a same-document target', () => {
    const { ctx } = buildRenderContext(baseInput());
    assert.strictEqual(ctx.resolveConref!('#p1'), p1);
  });

  it('wires resolveTitle: local titleMap first, then the file resolver', () => {
    const { ctx } = buildRenderContext(baseInput());
    assert.strictEqual(ctx.resolveTitle!('t'), 'Topic T');
  });

  it('produces IDENTICAL resolver behaviour across the three site shapes', () => {
    // book shape (extras on), preview shape (indexLabel only), diff shape
    // (no indexLabel): the key resolvers must be byte-identical.
    const book = buildRenderContext(baseInput({ includeIndexLabel: true, suppressIndexterm: false, collectDependencies: new Set<string>() }));
    const preview = buildRenderContext(baseInput({ includeIndexLabel: true }));
    const diff = buildRenderContext(baseInput({ includeIndexLabel: false }));
    for (const other of [preview, diff]) {
      assert.strictEqual(book.ctx.resolveConref!('#p1'), other.ctx.resolveConref!('#p1'));
      assert.strictEqual(book.ctx.resolveKey!('brand'), other.ctx.resolveKey!('brand'));
      assert.strictEqual(book.ctx.resolveTitle!('t'), other.ctx.resolveTitle!('t'));
    }
  });

  it('omits indexLabel when the site does not want it (diff), sets it otherwise', () => {
    const withLabel = buildRenderContext(baseInput({ includeIndexLabel: true }));
    const without = buildRenderContext(baseInput({ includeIndexLabel: false }));
    assert.ok(withLabel.ctx.indexLabel, 'indexLabel present when asked');
    assert.strictEqual(without.ctx.indexLabel, undefined, 'indexLabel absent for diff');
  });
});
