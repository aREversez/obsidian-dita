import * as assert from 'assert';
import { parseDita, preprocessEntities } from '../../src/parser/ditaParser';
describe('ditaParser', () => {
  it('should parse a minimal topic with title and shortdesc', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">
<topic id="test">
  <title>Test Title</title>
  <shortdesc>A short description.</shortdesc>
</topic>`;
    const doc = parseDita(xml);
    assert.strictEqual(doc.root.tagName, 'topic');
    assert.strictEqual(doc.root.baseType, 'topic/topic');
    const elements = doc.root.children.filter(
      (c) => c.type === 'element',
    );
    assert.strictEqual(elements.length, 2);

    const title = elements[0];
    assert.strictEqual(title.baseType, 'topic/title');
    assert.strictEqual(title.children[0].text, 'Test Title');

    const shortdesc = elements[1];
    assert.strictEqual(shortdesc.baseType, 'topic/shortdesc');
  });

  it('should map tagName to baseType via STANDARD_TAG_TO_BASETYPE', () => {
    const xml = `<topic id="t"><body><p>para</p><note type="warning">note</note></body></topic>`;
    const doc = parseDita(xml);
    const body = doc.root.children[0];
    assert.strictEqual(body.baseType, 'topic/body');
    const p = body.children[0];
    assert.strictEqual(p.baseType, 'topic/p');
    const note = body.children[1];
    assert.strictEqual(note.baseType, 'topic/note');
    assert.strictEqual(note.attributes?.type, 'warning');
  });

  it('should fall back to class attribute when tag is not in standard map', () => {
    const xml = `<topic id="t"><body><customElement class="- topic/p mydomain/myelem ">text</customElement></body></topic>`;
    const doc = parseDita(xml);
    const body = doc.root.children[0];
    const custom = body.children[0];
    assert.strictEqual(custom.tagName, 'customElement');
    assert.strictEqual(custom.baseType, 'topic/p');
    assert.deepStrictEqual(custom.classTokens, ['-', 'topic/p', 'mydomain/myelem']);
  });

  it('should set baseType to undefined for unknown tag without class', () => {
    const xml = `<topic id="t"><body><unknown>text</unknown></body></topic>`;
    const doc = parseDita(xml);
    const body = doc.root.children[0];
    const unknown = body.children[0];
    assert.strictEqual(unknown.tagName, 'unknown');
    assert.strictEqual(unknown.baseType, undefined);
  });

  it('should handle lists properly', () => {
    const xml = `<topic id="t"><body><ol><li>one</li><li>two</li></ol></body></topic>`;
    const doc = parseDita(xml);
    const body = doc.root.children[0];
    const ol = body.children[0];
    assert.strictEqual(ol.baseType, 'topic/ol');
    assert.strictEqual(ol.children.length, 2);
    assert.strictEqual(ol.children[0].baseType, 'topic/li');
  });

  it('should parse CALS table structure', () => {
    const xml = `<topic id="t"><body><table><tgroup cols="2"><colspec colname="c1"/><thead><row><entry>H1</entry></row></thead><tbody><row><entry>D1</entry></row></tbody></tgroup></table></body></topic>`;
    const doc = parseDita(xml);
    const body = doc.root.children[0];
    const table = body.children[0];
    assert.strictEqual(table.baseType, 'topic/table');
    const tgroup = table.children[0];
    assert.strictEqual(tgroup.baseType, 'topic/tgroup');
  });

  it('should preserve sourceRange on elements', () => {
    const xml = `<topic id="t"><title>Hello</title></topic>`;
    const doc = parseDita(xml);
    assert.ok(doc.root.sourceRange.startLine >= 0);
    const title = doc.root.children[0];
    assert.ok(title.sourceRange.startLine >= 0);
    assert.ok(title.sourceRange.endLine >= title.sourceRange.startLine);
  });

  // The preview's click-to-highlight matches the editor cursor against
  // [startLine,startCol]..[endLine,endCol], and the cursor sits inside the
  // tag's source text whenever a line is clicked to locate it. sax's
  // line/column only update on newlines and at onopentag point just PAST
  // the tag's '>', so ranges used to start there: a self-closing element
  // (<p conref/>) got a zero-width range beyond its own text and matched no
  // click on its own line at all.
  it('should span a self-closing element over its whole tag text', () => {
    const xml = `<topic id="t"><body><p conref="c.dita#cid/p_xyc_g22_pgc"/></body></topic>`;
    const doc = parseDita(xml);
    const p = doc.root.children[0].children[0];
    assert.strictEqual(p.sourceRange.startLine, 0);
    assert.strictEqual(p.sourceRange.startCol, xml.indexOf('<p'));
    assert.strictEqual(p.sourceRange.endLine, 0);
    // endCol is half-open: one past the tag's own '>'. So every cursor column
    // inside the tag's text (col < endCol) resolves to this element, and a
    // click on the '>' itself is included by the < comparison too.
    assert.strictEqual(p.sourceRange.endCol, xml.indexOf('/>') + 2, 'end col is one past the tag >');
  });

  it('should start an element range at its \'<\' even when the cursor is mid-tag', () => {
    const xml = `<topic id="t">
  <body>
    <p id="x">text</p>
  </body>
</topic>`;
    const doc = parseDita(xml);
    // Whitespace between tags is preserved as text nodes — find <p> by id.
    const body = doc.root.children.find((c) => c.tagName === 'body')!;
    const p = body.children.find((c) => c.tagName === 'p')!;
    assert.strictEqual(p.sourceRange.startLine, 2);
    assert.strictEqual(p.sourceRange.startCol, 4, 'start col points at the < of <p id="x">');
    // endCol is a line-relative column, half-open past the </p> '>'. The
    // </p> sits on the same line as <p>, whose line starts at this offset.
    const lineStart = xml.lastIndexOf('\n', xml.indexOf('<p')) + 1;
    const closeGt = xml.lastIndexOf('</p>') + 3; // global offset of </p>'s '>'
    assert.strictEqual(p.sourceRange.endLine, 2);
    assert.strictEqual(p.sourceRange.endCol, closeGt + 1 - lineStart, 'end col is one past the </p> >');
  });

  it('should keep a multi-line open tag\'s range on the line its \'<\' sits on', () => {
    const xml = `<topic id="t"><p
  conref="c.dita#cid/x"
  props="hint">text</p></topic>`;
    const doc = parseDita(xml);
    const p = doc.root.children[0];
    assert.strictEqual(p.sourceRange.startLine, 0);
    assert.strictEqual(p.sourceRange.startCol, xml.indexOf('<p'));
  });

  it('should handle inline formatting elements', () => {
    const xml = `<topic id="t"><body><p><b>bold</b> and <i>italic</i></p></body></topic>`;
    const doc = parseDita(xml);
    const body = doc.root.children[0];
    const p = body.children[0];
    assert.strictEqual(p.children[0].baseType, 'topic/b');
    assert.strictEqual(p.children[2].baseType, 'topic/i');
  });

  it('should handle codeblock and pre', () => {
    const xml = `<topic id="t"><body><codeblock>code here</codeblock><pre>pre text</pre></body></topic>`;
    const doc = parseDita(xml);
    const body = doc.root.children[0];
    assert.strictEqual(body.children[0].baseType, 'topic/codeblock');
    assert.strictEqual(body.children[1].baseType, 'topic/pre');
  });

  it('should preserve CDATA section content', () => {
    const xml = `<topic id="t"><body><codeblock><![CDATA[if (a < b) { return "x & y"; }]]></codeblock></body></topic>`;
    const doc = parseDita(xml);
    const body = doc.root.children[0];
    const codeblock = body.children[0];
    const text = codeblock.children
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    assert.ok(text.includes('if (a < b)'), `CDATA content should be kept, got: ${text}`);
    assert.ok(text.includes('"x & y"'), 'special chars inside CDATA should survive');
  });

  it('should map hyphenated standard tags to their baseTypes', () => {
    const xml = `<topic id="t"><body><p><draft-comment>todo</draft-comment></p></body><related-links><link href="a.dita"/></related-links></topic>`;
    const doc = parseDita(xml);
    const body = doc.root.children[0];
    const draft = body.children[0].children[0];
    assert.strictEqual(draft.baseType, 'topic/draft-comment');
    const relatedLinks = doc.root.children[1];
    assert.strictEqual(relatedLinks.baseType, 'topic/related-links');
  });

  it('should map prolog to topic/prolog without relying on @class', () => {
    const xml = `<topic id="t"><title>T</title><prolog><author>Jane</author><metadata><keywords><keyword>k</keyword></keywords></metadata></prolog><body><p>body</p></body></topic>`;
    const doc = parseDita(xml);
    const prolog = doc.root.children.find((c) => c.tagName === 'prolog');
    assert.ok(prolog, 'prolog element should exist');
    assert.strictEqual(prolog!.baseType, 'topic/prolog');
  });

  it('should map task module tags to their topic/* base types', () => {
    const xml = `<task id="t"><title>T</title><taskbody>
      <context><p>ctx</p></context>
      <steps><step><cmd>Do it</cmd><info>details</info></step></steps>
      <steps-unordered><step><cmd>Or this</cmd></step></steps-unordered>
      <result><p>done</p></result>
    </taskbody></task>`;
    const doc = parseDita(xml);
    assert.strictEqual(doc.root.baseType, 'topic/topic');
    const taskbody = doc.root.children.find((c) => c.tagName === 'taskbody')!;
    assert.strictEqual(taskbody.baseType, 'topic/body');
    const els = (n: typeof doc.root) => n.children.filter((c) => c.type === 'element');
    const [context, steps, stepsUnordered, result] = els(taskbody);
    assert.strictEqual(context.baseType, 'topic/section');
    assert.strictEqual(steps.baseType, 'topic/ol');
    assert.strictEqual(stepsUnordered.baseType, 'topic/ul');
    assert.strictEqual(result.baseType, 'topic/section');
    const step = els(steps)[0];
    assert.strictEqual(step.baseType, 'topic/li');
    assert.strictEqual(els(step)[0].baseType, 'topic/ph'); // cmd
    assert.strictEqual(els(step)[1].baseType, 'topic/itemgroup'); // info
  });

  it('should map concept and reference module tags to their topic/* base types', () => {
    const conceptDoc = parseDita(`<concept id="c"><title>C</title><conbody><p>x</p></conbody></concept>`);
    assert.strictEqual(conceptDoc.root.baseType, 'topic/topic');
    assert.strictEqual(conceptDoc.root.children[1].baseType, 'topic/body');

    const refDoc = parseDita(
      `<reference id="r"><refbody><properties><property><proptype>a</proptype><propvalue>b</propvalue></property></properties></refbody></reference>`,
    );
    const refbody = refDoc.root.children[0];
    assert.strictEqual(refbody.baseType, 'topic/body');
    const properties = refbody.children[0];
    assert.strictEqual(properties.baseType, 'topic/simpletable');
    assert.strictEqual(properties.children[0].baseType, 'topic/strow');
    assert.strictEqual(properties.children[0].children[0].baseType, 'topic/stentry');
  });

  // ── preprocessEntities tests ──

  it('should strip DOCTYPE with PUBLIC ID and no internal subset', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">
<topic id="t"><title>Test</title></topic>`;
    const processed = preprocessEntities(xml);
    assert.ok(!processed.includes('<!DOCTYPE'), 'DOCTYPE should be stripped');
    assert.ok(processed.includes('<topic'), 'topic element should remain');
    const doc = parseDita(processed);
    assert.strictEqual(doc.root.tagName, 'topic');
  });

  it('should strip DOCTYPE with internal subset and resolve entities', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd" [
  <!ENTITY product "MyProduct">
  <!ENTITY version "2.0">
]>
<topic id="t"><title>&product; &version;</title></topic>`;
    const processed = preprocessEntities(xml);
    assert.ok(!processed.includes('<!DOCTYPE'), 'DOCTYPE should be stripped');
    assert.ok(!processed.includes('&product;'), 'entity should be resolved');
    assert.ok(processed.includes('MyProduct'), 'entity value should appear');
    assert.ok(processed.includes('2.0'), 'entity value should appear');
    const doc = parseDita(processed);
    assert.strictEqual(doc.root.tagName, 'topic');
  });

  it('should strip DOCTYPE with only internal subset (no PUBLIC ID)', () => {
    const xml = `<!DOCTYPE topic [
  <!ENTITY foo "bar">
]>
<topic id="t"><p>&foo;</p></topic>`;
    const processed = preprocessEntities(xml);
    assert.ok(!processed.includes('<!DOCTYPE'), 'DOCTYPE should be stripped');
    assert.ok(processed.includes('bar'), 'entity should be resolved');
    const doc = parseDita(processed);
    assert.strictEqual(doc.root.tagName, 'topic');
  });

  // Text of the document's root, concatenated -- what a reader would see.
  const textOf = (xml: string): string => {
    const walk = (n: { type: string; text?: string; children?: unknown[] }): string =>
      n.type === 'text' ? (n.text ?? '') : ((n.children ?? []) as Array<typeof n>).map(walk).join('');
    return walk(parseDita(preprocessEntities(xml)).root as never);
  };

  it('should keep undeclared entity references visible as literal text instead of silently deleting them', () => {
    // Deleting them made e.g. an external-subset &product; vanish without a
    // trace ("Run  with ..."); showing the literal reference at least
    // signals that something failed to resolve. Must still parse.
    const xml = `<topic id="t"><p>Text with &undeclared; entity</p></topic>`;
    assert.strictEqual(textOf(xml), 'Text with &undeclared; entity');
  });

  it('should resolve the ISO/HTML technical entities that were previously deleted (&le; &ge; &ne; &alpha; &infin; &rArr; &thinsp;)', () => {
    const xml = `<topic id="t"><p>a&le;b&ge;c&ne;d &alpha;&infin; &rArr; x&thinsp;y</p></topic>`;
    assert.strictEqual(textOf(xml), 'a\u2264b\u2265c\u2260d \u03b1\u221e \u21d2 x\u2009y');
  });

  it('should escape table entities whose value is markup-significant (&AMP; must not become a bare ampersand)', () => {
    const xml = `<topic id="t"><p>a &AMP; b</p></topic>`;
    assert.strictEqual(textOf(xml), 'a & b');
  });

  it('should resolve entities declared with single quotes', () => {
    const xml = `<!DOCTYPE topic [ <!ENTITY pn 'Acme'> ]>\n<topic id="t"><title>&pn; Guide</title></topic>`;
    assert.strictEqual(textOf(xml), 'Acme Guide');
  });

  it('should not treat parameter-entity declarations (<!ENTITY % name ...>) as general entities', () => {
    const xml = `<!DOCTYPE topic [ <!ENTITY % pe "x"> <!ENTITY g "G"> ]>\n<topic id="t"><p>&g;</p></topic>`;
    assert.strictEqual(textOf(xml), 'G');
  });

  it('should leave CDATA content verbatim (no entity substitution or deletion)', () => {
    const xml = `<topic id="t"><body><codeblock><![CDATA[a &foo; b &nbsp; c &copy;]]></codeblock></body></topic>`;
    assert.strictEqual(textOf(xml), 'a &foo; b &nbsp; c &copy;');
  });

  it('should leave comment content verbatim', () => {
    const xml = `<topic id="t"><p><!-- &foo; -->x</p></topic>`;
    assert.ok(preprocessEntities(xml).includes('<!-- &foo; -->'));
    assert.strictEqual(textOf(xml), 'x');
  });

  it('should expand an entity whose declared value itself references another declared entity', () => {
    const xml = `<!DOCTYPE topic [ <!ENTITY outer "[&inner;]"> <!ENTITY inner "in"> ]>\n<topic id="t"><p>&outer;</p></topic>`;
    assert.strictEqual(textOf(xml), '[in]');
  });

  it('should not loop forever on self-referential entity declarations', () => {
    const xml = `<!DOCTYPE topic [ <!ENTITY a "&a;x"> ]>\n<topic id="t"><p>&a;</p></topic>`;
    assert.doesNotThrow(() => preprocessEntities(xml));
  });

  it('should substitute well-known ISO character entities', () => {
    const xml = `<topic id="t"><p>A&nbsp;B &mdash; &copy;&nbsp;2026 &hellip; 5&nbsp;&plusmn;&nbsp;1</p></topic>`;
    const processed = preprocessEntities(xml);
    assert.ok(processed.includes('A\u00a0B'), 'nbsp should become U+00A0');
    assert.ok(processed.includes('\u2014'), 'mdash should become em dash');
    assert.ok(processed.includes('\u00a9\u00a02026'), 'copy should become \u00a9');
    assert.ok(processed.includes('\u2026'), 'hellip should become ellipsis');
    assert.ok(processed.includes('\u00b1'), 'plusmn should become \u00b1');
    const doc = parseDita(processed);
    assert.strictEqual(doc.root.tagName, 'topic');
  });

  it('should let declared entities take precedence over the ISO table', () => {
    const xml = `<!DOCTYPE topic [
  <!ENTITY copy "Custom Copy">
]>
<topic id="t"><p>&copy;</p></topic>`;
    const processed = preprocessEntities(xml);
    assert.ok(processed.includes('Custom Copy'), 'declared entity value should win');
    assert.ok(!processed.includes('\u00a9'), 'ISO fallback should not apply');
  });

  it('should preserve built-in XML entities', () => {
    const xml = `<topic id="t"><p>&lt;tag&gt; &amp; &quot;stuff&quot;</p></topic>`;
    const processed = preprocessEntities(xml);
    assert.ok(processed.includes('&amp;'), 'amp entity should be preserved');
    assert.ok(processed.includes('&lt;'), 'lt entity should be preserved');
    assert.ok(processed.includes('&gt;'), 'gt entity should be preserved');
    assert.ok(processed.includes('&quot;'), 'quot entity should be preserved');
    const doc = parseDita(processed);
    assert.strictEqual(doc.root.tagName, 'topic');
  });

  it('should resolve entity whose name contains a regex metacharacter exactly', () => {
    const xml = `<!DOCTYPE topic [
  <!ENTITY my.ent "DOT">
]>
<topic id="t"><p>&my.ent; but not &myxent;</p></topic>`;
    const processed = preprocessEntities(xml);
    assert.ok(processed.includes('DOT'), 'exact entity should be resolved');
    // With an unescaped RegExp, "my.ent" would also match "myxent"
    assert.ok(!processed.includes('&myxent;') || !processed.includes('DOT but not DOT'),
      'metacharacter must not make the pattern match other names');
    assert.ok(!/DOT but not DOT/.test(processed), 'only the exact name should be replaced');
  });

  it('should keep $-patterns in entity values literal', () => {
    const xml = `<!DOCTYPE topic [
  <!ENTITY price "$&amp; and $' cost">
]>
<topic id="t"><p>&price;</p></topic>`;
    const processed = preprocessEntities(xml);
    // String.replace would expand $& to the matched text without a
    // function replacement — the raw value must appear untouched.
    assert.ok(processed.includes("$&amp; and $' cost"), `expected literal value, got: ${processed}`);
    assert.ok(!processed.includes('&price;'), 'entity reference should be gone');
  });

  it('should parse DITA file with DOCTYPE and entity refs used in conref target', () => {
    // Simulates a typical conref target file
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd" [
  <!ENTITY prod "SuperApp">
]>
<topic id="conref">
  <title>Reuse</title>
  <body>
    <p id="note_script">Run &prod; with <filepath>.fscript</filepath></p>
  </body>
</topic>`;
    const processed = preprocessEntities(xml);
    const doc = parseDita(processed);
    assert.strictEqual(doc.root.tagName, 'topic');
    // Find element with id="note_script"
    const findEl = (node: typeof doc.root, id: string): typeof doc.root | undefined => {
      if (node.attributes?.id === id) return node;
      for (const child of node.children || []) {
        if (child.type === 'element') {
          const found = findEl(child, id);
          if (found) return found;
        }
      }
      return undefined;
    };
    const el = findEl(doc.root, 'note_script');
    assert.ok(el, 'should find element with id=note_script');
    assert.strictEqual(el!.baseType, 'topic/p');
  });
});
