import * as assert from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectMapKeys, KeyHrefDef } from '../../src/editor/keySpace';

const read = (p: string, enc: 'utf-8') => readFileSync(p, enc);

function keydef(keys: string, value?: string): string {
  const meta = value ? `<topicmeta><keywords><keyword>${value}</keyword></keywords></topicmeta>` : '';
  return `<keydef keys="${keys}">${meta}</keydef>`;
}

describe('collectMapKeys', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'keyspace-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeMap(name: string, body: string): string {
    const p = join(root, name);
    writeFileSync(p, `<?xml version="1.0"?><map>${body}</map>`);
    return p;
  }

  it('reads a keydef value from its keyword', () => {
    const m = writeMap('a.ditamap', keydef('brand', 'Acme'));
    const into = new Map<string, string>();
    collectMapKeys(m, into, read);
    assert.strictEqual(into.get('brand'), 'Acme');
  });

  it('defines every name in a space-separated keys attribute, not one key called "a b"', () => {
    const m = writeMap('a.ditamap', keydef('brand company', 'Acme'));
    const into = new Map<string, string>();
    collectMapKeys(m, into, read);
    assert.strictEqual(into.get('brand'), 'Acme');
    assert.strictEqual(into.get('company'), 'Acme');
    assert.strictEqual(into.has('brand company'), false);
  });

  it('splits on any run of whitespace, including newlines and tabs', () => {
    const m = writeMap('a.ditamap', keydef('one\n  two\tthree', 'V'));
    const into = new Map<string, string>();
    collectMapKeys(m, into, read);
    assert.deepStrictEqual([...into.keys()].sort(), ['one', 'three', 'two']);
  });

  it('applies the same split to a topicref that carries keys', () => {
    const m = writeMap(
      'a.ditamap',
      '<topicref keys="x y" href="t.dita"><topicmeta><linktext>Title</linktext></topicmeta></topicref>',
    );
    const into = new Map<string, string>();
    collectMapKeys(m, into, read);
    assert.strictEqual(into.get('x'), 'Title');
    assert.strictEqual(into.get('y'), 'Title');
  });

  it('keeps the first definition of a key, per name, in document order', () => {
    const m = writeMap('a.ditamap', keydef('a b', 'first') + keydef('b c', 'second'));
    const into = new Map<string, string>();
    collectMapKeys(m, into, read);
    assert.strictEqual(into.get('a'), 'first');
    assert.strictEqual(into.get('b'), 'first');
    assert.strictEqual(into.get('c'), 'second');
  });

  it('does not overwrite a key already present in the target map', () => {
    const m = writeMap('a.ditamap', keydef('brand', 'Later'));
    const into = new Map<string, string>([['brand', 'Earlier']]);
    collectMapKeys(m, into, read);
    assert.strictEqual(into.get('brand'), 'Earlier');
  });

  it('falls back to the key name when the definition has no value', () => {
    const m = writeMap('a.ditamap', keydef('p q'));
    const into = new Map<string, string>();
    collectMapKeys(m, into, read);
    assert.strictEqual(into.get('p'), 'p');
    assert.strictEqual(into.get('q'), 'q');
  });

  it('follows referenced ditamaps', () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'brand.ditamap'), `<map>${keydef('logo alt', 'Acme')}</map>`);
    const m = writeMap('all.ditamap', '<mapref href="sub/brand.ditamap" format="ditamap"/>');
    const into = new Map<string, string>();
    collectMapKeys(m, into, read);
    assert.strictEqual(into.get('logo'), 'Acme');
    assert.strictEqual(into.get('alt'), 'Acme');
  });
});

describe('collectMapKeys href capture (for conkeyref)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'keyspace-href-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeMap(name: string, body: string): string {
    const p = join(root, name);
    writeFileSync(p, `<?xml version="1.0"?><map>${body}</map>`);
    return p;
  }

  it('records the keydef href for every name a space-separated keys list defines', () => {
    const m = writeMap('a.ditamap', '<keydef keys="a b" href="shared/t.dita"/>');
    const into = new Map<string, string>();
    const defs = new Map<string, KeyHrefDef>();
    collectMapKeys(m, into, read, defs);
    assert.strictEqual(defs.get('a')?.href, 'shared/t.dita');
    assert.strictEqual(defs.get('b')?.href, 'shared/t.dita');
  });

  it('anchors the href to the defining map\'s directory, not the topic\'s', () => {
    mkdirSync(join(root, 'maps'));
    const p = join(root, 'maps', 'a.ditamap');
    writeFileSync(p, '<?xml version="1.0"?><map><keydef keys="k" href="../t.dita"/></map>');
    const defs = new Map<string, KeyHrefDef>();
    collectMapKeys(p, new Map<string, string>(), read, defs);
    assert.strictEqual(defs.get('k')?.baseDir, join(root, 'maps'));
  });

  it('rebases an included submap\'s keydef href to the outer map directory', () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'brand.ditamap'), '<map><keydef keys="k" href="topic.dita"/></map>');
    const m = writeMap('all.ditamap', '<mapref href="sub/brand.ditamap" format="ditamap"/>');
    const defs = new Map<string, KeyHrefDef>();
    collectMapKeys(m, new Map<string, string>(), read, defs);
    // href is re-based by expandDitamapRefs to the map collectMapKeys was given,
    // so it resolves against dirname(all.ditamap) == root.
    assert.strictEqual(defs.get('k')?.href, 'sub/topic.dita');
    assert.strictEqual(defs.get('k')?.baseDir, root);
  });

  it('keeps the first definition\'s href, per name, in document order', () => {
    const m = writeMap('a.ditamap', '<keydef keys="k" href="first.dita"/><keydef keys="k" href="second.dita"/>');
    const defs = new Map<string, KeyHrefDef>();
    collectMapKeys(m, new Map<string, string>(), read, defs);
    assert.strictEqual(defs.get('k')?.href, 'first.dita');
  });

  it('records a defined key that carries no href (undefined href, not a missing entry)', () => {
    const m = writeMap('a.ditamap', '<keydef keys="brand"><topicmeta><keywords><keyword>Acme</keyword></keywords></topicmeta></keydef>');
    const into = new Map<string, string>();
    const defs = new Map<string, KeyHrefDef>();
    collectMapKeys(m, into, read, defs);
    assert.strictEqual(into.get('brand'), 'Acme');
    assert.ok(defs.has('brand'));
    assert.strictEqual(defs.get('brand')?.href, undefined);
  });
});
