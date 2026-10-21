import { strict as assert } from 'assert';
import { complete, CompletionEnv, CompletionResult } from '../src/completion';
import { CHILD_HINTS, ENUM_VALUES } from '../src/completionData';
import { MAP_STANDARD_TAG_TO_BASETYPE } from '../src/parser/mapTagMap';
import { STANDARD_TAG_TO_BASETYPE } from '../src/parser/standardTagMap';

function env(over: Partial<CompletionEnv> = {}): CompletionEnv {
  return {
    isMap: false,
    keys: () => new Map([['product', 'Acme Suite'], ['version', '3.2'], ['same', 'same']]),
    files: (kind) => (kind === 'image' ? ['img/a.png', 'img/b.svg'] : ['topics/a.dita', 'maps/m.ditamap']),
    idsIn: (f) => (f === 'other.dita' ? ['other', 'other/step1', 'other/note1'] : undefined),
    ...over,
  };
}

/** Complete at the `|` in `marked`. */
async function at(marked: string, e: CompletionEnv = env()): Promise<{ r: CompletionResult | undefined; text: string; offset: number }> {
  const offset = marked.indexOf('|');
  const text = marked.replace('|', '');
  return { r: await complete(text, offset, e), text, offset };
}

const labels = (r: CompletionResult | undefined): string[] => (r?.suggestions ?? []).map((s) => s.label);
/** Labels in the order a host that sorts by boost would list them. */
const ranked = (r: CompletionResult | undefined): string[] =>
  [...(r?.suggestions ?? [])].sort((a, b) => b.boost - a.boost || a.label.localeCompare(b.label)).map((s) => s.label);

describe('completion: no context', () => {
  it('offers nothing in plain text, comments, or after a closed tag', async () => {
    for (const m of ['<p>hello |', '<!-- x| -->', '<p>a</p>|', '']) assert.equal((await at(m)).r, undefined, m);
  });
});

describe('completion: elements', () => {
  it('after "<" offers every known element, replacing from the "<"', async () => {
    const { r, offset } = await at('<concept><conbody><|');
    assert.ok(r);
    assert.equal(r.from, offset);
    for (const name of ['p', 'section', 'codeblock', 'note', 'topicref'.replace('topicref', 'xref')]) assert.ok(labels(r).includes(name), name);
    assert.equal(new Set(labels(r)).size, labels(r).length, 'no duplicates');
  });

  it('the replace range covers what was typed after "<"', async () => {
    const { r, offset } = await at('<concept><conbody><sec|');
    assert.equal(r!.from, offset - 3);
  });

  it('ranks the usual children of the enclosing element first', async () => {
    assert.deepEqual(ranked((await at('<ul><|')).r).slice(0, 1), ['li']);
    assert.deepEqual(ranked((await at('<dl><|')).r).slice(0, 2), ['dlhead', 'dlentry']);
    assert.deepEqual(ranked((await at('<table><tgroup><|')).r).slice(0, 3), ['colspec', 'thead', 'tbody']);
    assert.ok(ranked((await at('<task><taskbody><|')).r).slice(0, 4).includes('steps'));
    assert.deepEqual(ranked((await at('<steps><|')).r).slice(0, 2), ['step', 'stepsection']);
    assert.equal(ranked((await at('<step><|')).r)[0], 'cmd');
  });

  it('ranks by the innermost OPEN element, ignoring closed ones', async () => {
    const { r } = await at('<ul><li>one</li><|');
    assert.equal(ranked(r)[0], 'li');
    const { r: r2 } = await at('<conbody><section><p>x</p></section><|');
    assert.ok(ranked(r2).slice(0, 8).includes('p') && ranked(r2).slice(0, 8).includes('section'));
  });

  it('inline-capable parents lead with phrase elements', async () => {
    const top = ranked((await at('<p>text <|')).r).slice(0, 6);
    assert.ok(top.includes('ph') && top.includes('xref') && top.includes('keyword'), top.join());
  });

  it('hints never hide anything: an unlisted parent still gets the full vocabulary', async () => {
    const { r } = await at('<some-specialization><|');
    assert.equal(labels(r).length, Object.keys(STANDARD_TAG_TO_BASETYPE).length);
  });

  it('with nothing open, offers topic roots first (topics) or map roots (maps)', async () => {
    assert.deepEqual(ranked((await at('<?xml version="1.0"?>\n<|')).r).slice(0, 3), ['concept', 'task', 'reference']);
    const m = await at('<|', env({ isMap: true }));
    assert.deepEqual(ranked(m.r).slice(0, 2), ['map', 'bookmap']);
  });

  it('uses the map vocabulary in a ditamap', async () => {
    const { r } = await at('<map><|', env({ isMap: true }));
    assert.equal(labels(r).length >= Object.keys(MAP_STANDARD_TAG_TO_BASETYPE).length, true);
    assert.ok(ranked(r).slice(0, 6).includes('topicref'));
    assert.ok(!labels(r).includes('codeblock'), 'topic-only elements are not offered in a map');
    assert.deepEqual(ranked((await at('<bookmap><|', env({ isMap: true }))).r).slice(0, 2), ['booktitle', 'bookmeta']);
  });

  it('every hint is a string list with no duplicates', () => {
    for (const [parent, kids] of Object.entries(CHILD_HINTS)) {
      assert.equal(new Set(kids).size, kids.length, `${parent} lists a child twice`);
    }
  });

  it('boosts stay in the range CodeMirror accepts', async () => {
    const { r } = await at('<p><|');
    for (const s of r!.suggestions) assert.ok(s.boost >= -99 && s.boost <= 99, s.label);
  });
});

describe('completion: closing tags', () => {
  it('"</" offers the innermost open element', async () => {
    const { r, offset } = await at('<concept><conbody><p>hi</|');
    assert.deepEqual(r!.suggestions.map((s) => [s.label, s.insert, s.kind]), [['p', 'p>', 'closeTag']]);
    assert.equal(r!.from, offset);
  });

  it('skips elements that are already closed', async () => {
    const { r } = await at('<conbody><p>a</p></|');
    assert.equal(r!.suggestions[0].label, 'conbody');
  });

  it('offers nothing when no element is open', async () => {
    assert.equal((await at('<a>x</a></|')).r, undefined);
  });
});

describe('completion: attributes', () => {
  it('after a tag name offers the tag-specific attributes first, as name="" with the caret inside', async () => {
    const { r } = await at('<note |');
    const top = ranked(r).slice(0, 2);
    assert.deepEqual(top, ['type', 'othertype']);
    const type = r!.suggestions.find((s) => s.label === 'type')!;
    assert.equal(type.insert, 'type=""');
    assert.equal(type.cursor, 6, 'caret between the quotes');
  });

  it('replaces what was typed of the name', async () => {
    const { r, offset } = await at('<xref hr|');
    assert.equal(r!.from, offset - 2);
    assert.ok(labels(r).includes('href'));
  });

  it('does not offer attributes already on the tag', async () => {
    const { r } = await at('<note type="warning" |');
    assert.ok(!labels(r).includes('type'));
    assert.ok(labels(r).includes('othertype'));
    const { r: r2 } = await at('<xref href="a.dita" scope="local" |');
    assert.ok(!labels(r2).includes('href') && !labels(r2).includes('scope'));
  });

  it('knows attributes inside a multi-line tag', async () => {
    const { r } = await at('<image\n   href="a.png"\n   |');
    assert.ok(!labels(r).includes('href') && labels(r).includes('width'));
  });

  it('asks the host to continue with value completion only where values can be completed', async () => {
    const { r } = await at('<xref |');
    const by = (n: string) => r!.suggestions.find((s) => s.label === n)!;
    assert.equal(by('href').continueAfter, true);
    assert.equal(by('keyref').continueAfter, true);
    assert.equal(by('scope').continueAfter, true);
    assert.equal(by('outputclass').continueAfter, false);
  });

  it('universal attributes are offered on any element', async () => {
    const { r } = await at('<whatever |');
    for (const a of ['id', 'conref', 'keyref', 'outputclass', 'props']) assert.ok(labels(r).includes(a), a);
  });
});

describe('completion: attribute values', () => {
  it('enumerated attributes offer their values; a tag-specific list wins', async () => {
    assert.ok(labels((await at('<note type="|')).r).includes('warning'));
    assert.deepEqual(labels((await at('<xref scope="|')).r), [...ENUM_VALUES.scope]);
    assert.ok(labels((await at('<topicref processing-role="|')).r).includes('resource-only'));
    assert.ok(labels((await at('<p importance="|')).r).includes('required'));
  });

  it('replaces what was typed of the value', async () => {
    const { r, offset } = await at('<note type="wa|');
    assert.equal(r!.from, offset - 2);
  });

  it('returns nothing for free-text attributes', async () => {
    assert.equal((await at('<p outputclass="|')).r, undefined);
    assert.equal((await at('<p id="|')).r, undefined);
  });

  it('keyref offers the key space, with values as detail', async () => {
    const { r } = await at('<keyword keyref="|');
    assert.deepEqual(labels(r).sort(), ['product', 'same', 'version']);
    assert.equal(r!.suggestions.find((s) => s.label === 'product')!.detail, 'Acme Suite');
    assert.equal(r!.suggestions.find((s) => s.label === 'same')!.detail, undefined, 'no detail when the value is the key');
  });

  it('keyref with an empty key space offers nothing; keys= is not a reference', async () => {
    assert.equal((await at('<ph keyref="|', env({ keys: () => new Map() }))).r, undefined);
    assert.equal((await at('<keydef keys="|')).r, undefined);
  });

  it('conkeyref completes the key only, not after the slash', async () => {
    assert.ok(labels((await at('<p conkeyref="pro|')).r).includes('product'));
    assert.equal((await at('<p conkeyref="product/|')).r, undefined);
  });

  it('href offers topics and maps; image/object href offers images instead', async () => {
    assert.deepEqual(labels((await at('<xref href="|')).r), ['topics/a.dita', 'maps/m.ditamap']);
    assert.deepEqual(labels((await at('<topicref href="|', env({ isMap: true }))).r), ['topics/a.dita', 'maps/m.ditamap']);
    assert.deepEqual(labels((await at('<image href="|')).r), ['img/a.png', 'img/b.svg']);
    assert.deepEqual(labels((await at('<conbody><p><image href="img/|')).r), ['img/a.png', 'img/b.svg']);
  });

  it('a file reference replaces the whole value typed so far', async () => {
    const { r, offset } = await at('<xref href="topics/a|');
    assert.equal(r!.from, offset - 'topics/a'.length);
  });

  it('after "#" offers ids from the target file, replacing only the fragment', async () => {
    const { r, offset } = await at('<xref href="other.dita#|');
    assert.deepEqual(labels(r), ['other', 'other/step1', 'other/note1']);
    assert.equal(r!.from, offset);
    const { r: r2, offset: o2 } = await at('<xref href="other.dita#other/st|');
    assert.equal(r2!.from, o2 - 2, 'after the last slash');
  });

  it('"#" alone points at ids in this document', async () => {
    const { r } = await at('<concept id="c1"><conbody><p id="intro">x</p><xref href="#|');
    assert.ok(labels(r).includes('c1') && labels(r).includes('intro'));
  });

  it('an unreadable target file offers no ids', async () => {
    assert.equal((await at('<xref href="missing.dita#|')).r, undefined);
  });

  it('conref and conrefend complete like href', async () => {
    assert.ok(labels((await at('<p conref="|')).r).includes('topics/a.dita'));
    assert.ok(labels((await at('<p conref="other.dita#|')).r).includes('other/step1'));
  });

  it('awaits an asynchronous file listing', async () => {
    const e = env({ files: async () => ['x.dita'] });
    assert.deepEqual(labels((await at('<xref href="|', e)).r), ['x.dita']);
  });
});
