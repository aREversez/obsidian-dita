import { strict as assert } from 'assert';
import { HeadingTracker, activeHeadingIndex, ditaHeadings } from '../src/outlineHeadings';

const topic = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE concept PUBLIC "-//OASIS//DTD DITA Concept//EN"',
  '  "concept.dtd">',
  '<concept id="c">',
  '  <title>Deploy&nbsp;guide</title>',
  '  <conbody>',
  '    <section>',
  '      <title>Plan</title>',
  '      <p>text</p>',
  '    </section>',
  '    <section>',
  '      <p>an untitled section</p>',
  '      <example><title>Sample</title></example>',
  '    </section>',
  '  </conbody>',
  '  <concept id="inner">',
  '    <title>Inner topic</title>',
  '    <conbody><section><title>Deep</title></section></conbody>',
  '  </concept>',
  '</concept>',
  '',
].join('\n');

const outline = (text: string, isMap = false, keys?: ReadonlyMap<string, string>) =>
  (ditaHeadings(text, isMap, keys) ?? []).map((h) => `${h.level}|${h.heading}|${h.position.start.line}`);

describe('ditaHeadings: topics', () => {
  it('lists the title, titled sections and examples, and nested topics, nested by level', () => {
    assert.deepEqual(outline(topic), [
      '1|Deploy\u00a0guide|3', // the core turns &nbsp; into its character
      '2|Plan|6',
      '2|Sample|12', // the untitled section adds no heading; its example moves up a level
      '2|Inner topic|15',
      '3|Deep|17',
    ]);
  });

  it('keeps line numbers right after a two-line DOCTYPE', () => {
    const lines = topic.split('\n');
    for (const h of ditaHeadings(topic, false) ?? []) {
      assert.ok(lines[h.position.start.line].slice(h.position.start.col).startsWith('<'), h.heading);
    }
  });

  it('gives offsets that point at the element in the text', () => {
    const plan = (ditaHeadings(topic, false) ?? []).find((h) => h.heading === 'Plan');
    assert.ok(plan);
    assert.ok(topic.slice(plan.position.start.offset).startsWith('<section>'));
    assert.ok(topic.slice(0, plan.position.end.offset).endsWith('</section>'));
  });

  it('names a topic without a title by its id', () => {
    assert.deepEqual(outline('<topic id="lonely"><body/></topic>'), ['1|lonely|0']);
  });

  it('survives a byte order mark', () => {
    assert.deepEqual(outline('\uFEFF<topic id="t"><title>T</title></topic>'), ['1|T|0']);
  });

  it('caps the level at 6', () => {
    let xml = '';
    for (let i = 1; i <= 8; i++) xml += `<topic id="t${i}"><title>T${i}</title>`;
    xml += '</topic>'.repeat(8);
    const levels = (ditaHeadings(xml, false) ?? []).map((h) => h.level);
    assert.deepEqual(levels, [1, 2, 3, 4, 5, 6, 6, 6]);
  });

  it('returns undefined for text that does not parse', () => {
    assert.equal(ditaHeadings('<topic id="t"><title>T</title>\n<body>', false), undefined);
    assert.equal(ditaHeadings('', false), undefined);
  });
});

describe('ditaHeadings: maps', () => {
  const map = [
    '<map>',
    '  <title>Guide</title>',
    '  <keydef keys="product" href="keys.dita"/>',
    '  <topicref href="intro.dita" navtitle="Introduction">',
    '    <topicref href="deep.dita"/>',
    '  </topicref>',
    '  <topichead navtitle="Reference">',
    '    <topicref href="api.dita" navtitle="API"/>',
    '  </topichead>',
    '</map>',
  ].join('\n');

  it('lists the map title, then the topicref hierarchy under it, without key definitions', () => {
    assert.deepEqual(outline(map, true), [
      '1|Guide|1',
      '2|Introduction|3',
      '3|deep.dita|4',
      '2|Reference|6',
      '3|API|7',
    ]);
  });

  const bookmap = [
    '<bookmap>',
    '  <booktitle><mainbooktitle>Manual</mainbooktitle></booktitle>',
    '  <frontmatter>',
    '    <mapref href="keys.ditamap" processing-role="resource-only"/>',
    '    <preface href="p.dita" navtitle="Preface"/>',
    '  </frontmatter>',
    '  <chapter href="c.dita" navtitle="Chapter"/>',
    '  <backmatter><booklists><glossarylist/></booklists></backmatter>',
    '</bookmap>',
  ].join('\n');

  it('titles a bookmap by its booktitle and drops containers and resource-only references', () => {
    assert.deepEqual(outline(bookmap, true), ['1|Manual|1', '2|Preface|4', '2|Chapter|6']);
  });

  it('lists a map with no title from level 1', () => {
    assert.deepEqual(outline('<map><topicref href="a.dita" navtitle="A"/></map>', true), ['1|A|0']);
  });

  it('drops what a resource-only container holds, as the attribute cascades', () => {
    const xml = [
      '<map>',
      '  <topicgroup processing-role="resource-only">',
      '    <topicref href="k.dita" navtitle="Keys"/>',
      '  </topicgroup>',
      '  <topicref href="a.dita" navtitle="A"/>',
      '</map>',
    ].join('\n');
    assert.deepEqual(outline(xml, true), ['1|A|4']);
  });

  it('lets an explicit normal put an entry back into the book', () => {
    const xml = [
      '<map>',
      '  <topicgroup processing-role="resource-only">',
      '    <topicref href="k.dita" navtitle="Keys"/>',
      '    <topicref href="a.dita" navtitle="A" processing-role="normal"/>',
      '  </topicgroup>',
      '</map>',
    ].join('\n');
    assert.deepEqual(outline(xml, true), ['1|A|3']);
  });
});

describe('ditaHeadings: key references in titles', () => {
  const keys = new Map([
    ['product-name', 'Acme Flow Engine'],
    ['version', '2.4'],
  ]);

  const bookmap = [
    '<bookmap>',
    '  <booktitle><mainbooktitle><ph keyref="product-name"/> Manual</mainbooktitle></booktitle>',
    '  <chapter href="c.dita" navtitle="Chapter"/>',
    '</bookmap>',
  ].join('\n');

  it('fills a key into the map title, as the preview shows it', () => {
    assert.deepEqual(outline(bookmap, true, keys), ['1|Acme Flow Engine Manual|1', '2|Chapter|2']);
  });

  it('adds nothing for a key when no key space is given', () => {
    assert.deepEqual(outline(bookmap, true), ['1|Manual|1', '2|Chapter|2']);
  });

  it('fills a key into a topic title and into a navtitle', () => {
    const topic = '<topic id="t"><title>Install <ph keyref="product-name"/></title></topic>';
    assert.deepEqual(outline(topic, false, keys), ['1|Install Acme Flow Engine|0']);
    const map = [
      '<map>',
      '  <topicref href="a.dita">',
      '    <topicmeta><navtitle>Version <ph keyref="version"/></navtitle></topicmeta>',
      '  </topicref>',
      '</map>',
    ].join('\n');
    assert.deepEqual(outline(map, true, keys), ['1|Version 2.4|1']);
  });

  it('leaves a name alone when the key is not defined', () => {
    const xml = [
      '<map>',
      '  <topicref href="a.dita">',
      '    <topicmeta><navtitle>Version <ph keyref="missing"/></navtitle></topicmeta>',
      '  </topicref>',
      '</map>',
    ].join('\n');
    assert.deepEqual(outline(xml, true, keys), ['1|Version|1']);
  });
});

describe('HeadingTracker', () => {
  it('re-parses only when the text changes', () => {
    const tracker = new HeadingTracker();
    const first = tracker.headingsFor('a.dita', topic, false);
    assert.equal(tracker.headingsFor('a.dita', topic, false), first);
    const edited = tracker.headingsFor('a.dita', topic.replace('Plan', 'Plans'), false);
    assert.notEqual(edited, first);
    assert.ok(edited.some((h) => h.heading === 'Plans'));
  });

  it('keeps the last good headings while the text is half-typed', () => {
    const tracker = new HeadingTracker();
    const good = tracker.headingsFor('a.dita', topic, false);
    assert.equal(tracker.headingsFor('a.dita', topic + '<oops', false), good);
    assert.equal(tracker.lastKnown('a.dita'), good);
  });

  it('is empty for a file it never parsed, or one that never parsed', () => {
    const tracker = new HeadingTracker();
    assert.deepEqual(tracker.lastKnown('none.dita'), []);
    assert.deepEqual(tracker.headingsFor('b.dita', '', false), []);
  });

  it('forgets a file on request', () => {
    const tracker = new HeadingTracker();
    tracker.headingsFor('a.dita', topic, false);
    tracker.forget('a.dita');
    assert.deepEqual(tracker.lastKnown('a.dita'), []);
  });

  it('parses again when the key space it was given changes', () => {
    const tracker = new HeadingTracker();
    const xml = '<map><title><ph keyref="product"/></title></map>';
    const first = new Map([['product', 'A']]);
    const second = new Map([['product', 'B']]);
    const a = tracker.headingsFor('m.ditamap', xml, true, first);
    assert.equal(a[0]?.heading, 'A');
    assert.equal(tracker.headingsFor('m.ditamap', xml, true, first), a);
    assert.equal(tracker.headingsFor('m.ditamap', xml, true, second)[0]?.heading, 'B');
  });

  it('holds a bounded number of files', () => {
    const tracker = new HeadingTracker();
    for (let i = 0; i < 80; i++) tracker.headingsFor(`f${i}.dita`, `<topic id="t${i}"><title>T${i}</title></topic>`, false);
    assert.deepEqual(tracker.lastKnown('f0.dita'), []);
    assert.equal(tracker.lastKnown('f79.dita')[0]?.heading, 'T79');
  });
});

describe('activeHeadingIndex', () => {
  // Rows of `topic`: Deploy guide 3-19, Plan 6-9, Sample 12-12, Inner topic 15-18, Deep 17-17.
  const inTopic = (line: number) => activeHeadingIndex(ditaHeadings(topic, false) ?? [], line);

  it('is the innermost row whose element spans the line', () => {
    assert.equal(inTopic(8), 1); // in Plan
    assert.equal(inTopic(12), 2); // in Sample, which sits inside the topic
    assert.equal(inTopic(17), 4); // Deep is inside Inner topic, which is inside the topic
    assert.equal(inTopic(16), 3); // Inner topic's own title
  });

  it('goes back to the enclosing row when a nested one has ended', () => {
    assert.equal(inTopic(18), 3); // Inner topic's closing tag, after Deep ended
    assert.equal(inTopic(14), 0); // </conbody>, after both sections ended
    assert.equal(inTopic(11), 0); // the untitled section has no row of its own
  });

  it('is -1 above the first row', () => {
    assert.equal(inTopic(2), -1); // the DOCTYPE
    assert.equal(activeHeadingIndex([], 0), -1);
  });

  it('follows the topicref hierarchy of a map', () => {
    const map = [
      '<map>',
      '  <title>Guide</title>',
      '  <keydef keys="product" href="keys.dita"/>',
      '  <topicref href="intro.dita" navtitle="Introduction">',
      '    <topicref href="deep.dita"/>',
      '  </topicref>',
      '  <topichead navtitle="Reference">',
      '    <topicref href="api.dita" navtitle="API"/>',
      '  </topichead>',
      '</map>',
    ].join('\n');
    const rows = ditaHeadings(map, true) ?? [];
    const names = (line: number) => rows[activeHeadingIndex(rows, line)]?.heading;
    assert.equal(names(4), 'deep.dita');
    assert.equal(names(5), 'Introduction'); // </topicref>, after the child ended
    assert.equal(names(7), 'API');
    assert.equal(names(8), 'Reference');
    assert.equal(names(2), 'Guide'); // the key definition has no row: the nearest one above
    assert.equal(names(0), undefined);
  });

  it('gives a line in a bookmap wrapper no row of its own the nearest row above', () => {
    const bookmap = [
      '<bookmap>',
      '  <booktitle><mainbooktitle>Manual</mainbooktitle></booktitle>',
      '  <frontmatter>',
      '    <mapref href="keys.ditamap" processing-role="resource-only"/>',
      '    <preface href="p.dita" navtitle="Preface"/>',
      '  </frontmatter>',
      '  <chapter href="c.dita" navtitle="Chapter"/>',
      '</bookmap>',
    ].join('\n');
    const rows = ditaHeadings(bookmap, true) ?? [];
    const names = (line: number) => rows[activeHeadingIndex(rows, line)]?.heading;
    assert.equal(names(2), 'Manual'); // <frontmatter>
    assert.equal(names(3), 'Manual'); // the resource-only reference is not a row
    assert.equal(names(4), 'Preface');
    assert.equal(names(6), 'Chapter');
  });
});
