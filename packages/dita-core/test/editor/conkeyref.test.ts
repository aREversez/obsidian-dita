import * as assert from 'assert';
import { DitaNode } from '../../src/parser/domTypes';
import { KeyHrefDef } from '../../src/editor/keySpace';
import { resolveConkeyref } from '../../src/editor/conkeyref';

const RANGE = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };

function el(tagName: string, attributes: Record<string, string> = {}, children: DitaNode[] = []): DitaNode {
  return { type: 'element', tagName, baseType: `topic/${tagName}`, attributes, children, sourceRange: RANGE };
}
function txt(text: string): DitaNode {
  return { type: 'text', text, children: [], sourceRange: RANGE };
}

// A target topic: <topic id="theTopic"><body><p id="shared">Reuse me</p></body></topic>
function targetTopic(): DitaNode {
  return el('topic', { id: 'theTopic' }, [
    el('body', {}, [el('p', { id: 'shared' }, [txt('Reuse me')])]),
  ]);
}

// loadTopic that serves one canned root for the "shared.dita" href and nothing
// for any other file, so "target file missing" is exercised deterministically
// without touching the filesystem.
function loaderFor(byHref: Record<string, DitaNode | undefined>) {
  return (_baseDir: string, href: string): DitaNode | undefined => byHref[href];
}

describe('resolveConkeyref', () => {
  const defs = new Map<string, KeyHrefDef>([
    ['brand', { href: 'shared.dita', baseDir: '/maps' }],
    ['textonly', { baseDir: '/maps' }], // defined, no resource
  ]);
  const load = loaderFor({ 'shared.dita': targetTopic() });

  it('resolves key/elementid to the addressed element', () => {
    const node = resolveConkeyref('brand/shared', defs, load);
    assert.strictEqual(node?.tagName, 'p');
    assert.strictEqual(node?.attributes?.id, 'shared');
  });

  it('resolves the key/topicid/elementid form to the element id', () => {
    const node = resolveConkeyref('brand/theTopic/shared', defs, load);
    assert.strictEqual(node?.attributes?.id, 'shared');
  });

  it('resolves a bare key to the whole target topic', () => {
    const node = resolveConkeyref('brand', defs, load);
    assert.strictEqual(node?.tagName, 'topic');
    assert.strictEqual(node?.attributes?.id, 'theTopic');
  });

  it('returns undefined when the key is not defined', () => {
    assert.strictEqual(resolveConkeyref('nosuch/shared', defs, load), undefined);
  });

  it('returns undefined when the key is defined but has no href', () => {
    assert.strictEqual(resolveConkeyref('textonly/shared', defs, load), undefined);
  });

  it('returns undefined when the addressed id is not in the target', () => {
    assert.strictEqual(resolveConkeyref('brand/missing', defs, load), undefined);
  });

  it('returns undefined when the target file cannot be loaded', () => {
    const defs2 = new Map<string, KeyHrefDef>([['gone', { href: 'nope.dita', baseDir: '/maps' }]]);
    assert.strictEqual(resolveConkeyref('gone/shared', defs2, load), undefined);
  });

  // Cycle protection lives in the renderer, not in this function: see
  // conkeyrefRender.test.ts ("does not re-resolve a conkeyref already on the
  // branch"), which asserts resolveConrefForNode never calls this for a value
  // already on the conrefChain. A conkeyref that also carries a direct @conref
  // falls back to it (DITA 1.3 spec behaviour), exercised above.

  it('returns undefined for an empty value', () => {
    assert.strictEqual(resolveConkeyref('', defs, load), undefined);
  });
});

// A key's href may carry a fragment ("file.dita#topicid/elemid"). The real
// loader (renderContext.ts) strips it before reading the file, so the pure
// resolver has to apply it itself.
describe('resolveConkeyref with a fragment on the key href', () => {
  const topic = () =>
    el('topic', { id: 'common' }, [
      el('body', {}, [
        el('p', { id: 'legal' }, [txt('LEGAL')]),
        el('p', { id: 'other' }, [txt('OTHER')]),
      ]),
    ]);
  const load = (_baseDir: string, href: string): DitaNode | undefined =>
    href.split('#')[0] === 'common.dita' ? topic() : undefined;

  it('bare key resolves to the element named by href#topicid/elemid, not the whole topic', () => {
    const defs = new Map<string, KeyHrefDef>([['legal', { href: 'common.dita#common/legal', baseDir: '/maps' }]]);
    const node = resolveConkeyref('legal', defs, load);
    assert.strictEqual(node?.attributes?.id, 'legal');
  });

  it('bare key whose href names only the topic still resolves to the topic', () => {
    const defs = new Map<string, KeyHrefDef>([['common', { href: 'common.dita#common', baseDir: '/maps' }]]);
    const node = resolveConkeyref('common', defs, load);
    assert.strictEqual(node?.attributes?.id, 'common');
  });

  it('an explicit key/elementid wins over the fragment on the key href', () => {
    const defs = new Map<string, KeyHrefDef>([['legal', { href: 'common.dita#common/legal', baseDir: '/maps' }]]);
    const node = resolveConkeyref('legal/other', defs, load);
    assert.strictEqual(node?.attributes?.id, 'other');
  });

  it('a fragment naming a missing element is unresolvable, so the caller can fall back', () => {
    const defs = new Map<string, KeyHrefDef>([['legal', { href: 'common.dita#common/nope', baseDir: '/maps' }]]);
    assert.strictEqual(resolveConkeyref('legal', defs, load), undefined);
  });
});
