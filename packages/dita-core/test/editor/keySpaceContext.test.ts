import * as assert from 'assert';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildKeySpace } from '../../src/editor/keySpace';

const read = (p: string, enc: 'utf-8') => readFileSync(p, enc);

function kd(keys: string, value: string): string {
  return `<keydef keys="${keys}"><topicmeta><keywords><keyword>${value}</keyword></keywords></topicmeta></keydef>`;
}

// The shape this feature exists for: one all-in-one map that pulls in several
// brand keydef maps which define the SAME keys with different values. Which
// value a keyref gets must follow the chosen context map, as in Oxygen's
// DITA Maps Manager context.
describe('buildKeySpace', () => {
  let root: string;
  let brandA: string;
  let brandB: string;
  let brandC: string;
  let allInOne: string;
  let common: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'keyspace-ctx-'));
    const w = (name: string, body: string) => {
      const p = join(root, name);
      writeFileSync(p, `<?xml version="1.0"?><map>${body}</map>`);
      return p;
    };
    brandA = w('brandA.ditamap', kd('product', 'Alpha') + kd('logo', 'a.svg'));
    brandB = w('brandB.ditamap', kd('product', 'Beta') + kd('logo', 'b.svg'));
    brandC = w('brandC.ditamap', kd('product', 'Gamma'));
    common = w('common.ditamap', kd('company', 'Acme Corp'));
    allInOne = w(
      'all.ditamap',
      '<mapref href="brandA.ditamap" format="ditamap"/>' +
        '<mapref href="brandB.ditamap" format="ditamap"/>' +
        '<mapref href="brandC.ditamap" format="ditamap"/>' +
        kd('company', 'Acme Corp'),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('without a context, merges the ancestor maps, first definition winning (unchanged behavior)', () => {
    const space = buildKeySpace(undefined, [brandB, brandA, common], read);
    assert.strictEqual(space.status, 'none');
    assert.strictEqual(space.keys.get('product'), 'Beta');
    assert.strictEqual(space.keys.get('company'), 'Acme Corp');
  });

  it('uses the chosen brand map for a key several maps define differently', () => {
    const a = buildKeySpace(brandA, [brandB, brandA, brandC, allInOne], read);
    const b = buildKeySpace(brandB, [brandB, brandA, brandC, allInOne], read);
    const c = buildKeySpace(brandC, [brandB, brandA, brandC, allInOne], read);
    assert.strictEqual(a.status, 'active');
    assert.strictEqual(a.keys.get('product'), 'Alpha');
    assert.strictEqual(b.keys.get('product'), 'Beta');
    assert.strictEqual(c.keys.get('product'), 'Gamma');
  });

  it('replaces the ancestor scan: a key only an ancestor map defines is not visible', () => {
    const space = buildKeySpace(brandA, [brandA, common], read);
    assert.strictEqual(space.keys.get('product'), 'Alpha');
    assert.strictEqual(space.keys.has('company'), false);
  });

  it('with the all-in-one map as context, follows its mapref order for conflicting keys', () => {
    const space = buildKeySpace(allInOne, [brandC, brandB], read);
    assert.strictEqual(space.keys.get('product'), 'Alpha');
    assert.strictEqual(space.keys.get('company'), 'Acme Corp');
    assert.strictEqual(space.keys.get('logo'), 'a.svg');
  });

  it('lists the context map and the maps it pulls in as sources, and no ancestor map', () => {
    const space = buildKeySpace(allInOne, [common], read);
    assert.ok(space.files.includes(allInOne));
    assert.ok(space.files.includes(brandA) && space.files.includes(brandB) && space.files.includes(brandC));
    assert.strictEqual(space.files.includes(common), false);
    assert.strictEqual(new Set(space.files).size, space.files.length, 'no file listed twice');
  });

  it('falls back to the ancestor scan, reporting "missing", when the context file is gone', () => {
    const gone = join(root, 'deleted.ditamap');
    const space = buildKeySpace(gone, [brandB], read);
    assert.strictEqual(space.status, 'missing');
    assert.strictEqual(space.keys.get('product'), 'Beta');
    assert.ok(space.files.includes(gone), 'a file that reappears must invalidate the cached key space');
  });

  it('does not silently fall back when the context map itself is unparseable', () => {
    const bad = join(root, 'bad.ditamap');
    writeFileSync(bad, '<map><keydef keys="x"');
    const errors: string[] = [];
    const space = buildKeySpace(bad, [brandB], read, (p) => errors.push(p));
    assert.strictEqual(space.status, 'active');
    assert.strictEqual(space.keys.has('product'), false, 'ancestor keys must not leak in');
    assert.deepStrictEqual(errors, [bad]);
  });

  it('skips an unparseable ancestor map without losing the others (unchanged behavior)', () => {
    const bad = join(root, 'bad.ditamap');
    writeFileSync(bad, '<map><keydef keys="x"');
    const errors: string[] = [];
    const space = buildKeySpace(undefined, [bad, brandB], read, (p) => errors.push(p));
    assert.strictEqual(space.keys.get('product'), 'Beta');
    assert.deepStrictEqual(errors, [bad]);
  });
});
