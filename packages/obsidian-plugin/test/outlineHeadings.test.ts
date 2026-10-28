import { strict as assert } from 'assert';
import { HeadingTracker, ditaHeadings } from '../src/outlineHeadings';

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

const outline = (text: string, isMap = false) =>
  (ditaHeadings(text, isMap) ?? []).map((h) => `${h.level}|${h.heading}|${h.position.start.line}`);

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

  it('holds a bounded number of files', () => {
    const tracker = new HeadingTracker();
    for (let i = 0; i < 80; i++) tracker.headingsFor(`f${i}.dita`, `<topic id="t${i}"><title>T${i}</title></topic>`, false);
    assert.deepEqual(tracker.lastKnown('f0.dita'), []);
    assert.equal(tracker.lastKnown('f79.dita')[0]?.heading, 'T79');
  });
});
