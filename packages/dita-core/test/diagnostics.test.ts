import { strict as assert } from 'assert';
import { resolve } from 'path';
import { collectDiagnostics, DiagnosticsInput } from '../src/diagnostics';

const DOC = resolve('/vault/docs/topic.dita');

function diag(xml: string, over: Partial<DiagnosticsInput> = {}) {
  return collectDiagnostics({ xml, absPath: DOC, fileExists: () => true, ...over });
}

const messages = (xml: string, over: Partial<DiagnosticsInput> = {}) => diag(xml, over).map((d) => d.message);

describe('diagnostics: well-formedness', () => {
  it('reports nothing for a clean topic', () => {
    assert.deepEqual(diag('<topic id="t"><title>Intro</title><body><p>Text</p></body></topic>'), []);
  });

  it('accepts entities a DITA DTD would declare, and a DOCTYPE', () => {
    const xml = '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN" "topic.dtd">\n<topic><title>A&nbsp;B &copy; C</title></topic>';
    assert.deepEqual(diag(xml), []);
  });

  it('reports a mismatched close tag on its own line, underlining the tag', () => {
    const xml = '<topic>\n  <title>x</title>\n  <body><p>text</para></body>\n</topic>';
    const [d, ...rest] = diag(xml);
    assert.equal(rest.length, 0);
    assert.equal(d.severity, 'error');
    assert.match(d.message, /Unexpected close tag/);
    assert.equal(d.startLine, 2);
    assert.equal(d.startCol, 15); // the '<' of </para>
    assert.equal(d.endCol, 22); // just past its '>'
  });

  it('reports an unclosed root tag at the end of the file', () => {
    const [d] = diag('<topic>\n  <title>x</title>');
    assert.equal(d.severity, 'error');
    assert.match(d.message, /Unclosed root tag/);
  });

  it('keeps positions after a multi-line DOCTYPE on their real lines', () => {
    const xml = '<!DOCTYPE topic PUBLIC "-//OASIS//DTD DITA Topic//EN"\n  "topic.dtd">\n<topic>\n  <title>x</title>\n  <body><p>a</para></body>\n</topic>';
    const [d] = diag(xml);
    assert.equal(d.startLine, 4);
    assert.equal(d.startCol, 12);
  });

  it('stops at the XML error instead of guessing positions past it', () => {
    const xml = '<topic>\n  <title>x</title>\n  <p href="missing.dita">a</para>\n</topic>';
    const all = diag(xml, { fileExists: () => false });
    assert.equal(all.length, 1);
    assert.equal(all[0].severity, 'error');
  });
});

describe('diagnostics: duplicate ids', () => {
  it('marks the second use and names the first line (1-based)', () => {
    const xml = '<topic>\n  <p id="a">one</p>\n  <p id="a">two</p>\n</topic>';
    const [d, ...rest] = diag(xml);
    assert.equal(rest.length, 0);
    assert.equal(d.severity, 'warning');
    assert.equal(d.message, 'Duplicate id "a"; first used on line 2');
    assert.equal(d.startLine, 2);
    assert.equal(d.startCol, 2);
  });

  it('catches two uses on the same line', () => {
    const xml = '<topic><p id="a"/><p id="a"/></topic>';
    assert.deepEqual(diag(xml).map((d) => d.startCol), [18]);
  });

  it('lets a nested topic reuse ids: an id is unique within its own topic', () => {
    const xml = '<concept id="c"><title>T</title><conbody><p id="x">a</p></conbody>'
      + '<concept id="d"><title>U</title><conbody><p id="x">b</p></conbody></concept></concept>';
    assert.deepEqual(messages(xml), []);
  });

  it('still catches a repeat inside the nested topic, and a repeated topic id', () => {
    const inner = '<concept id="d"><title>U</title><conbody><p id="y"/><p id="y"/></conbody></concept>';
    assert.deepEqual(messages(`<concept id="c"><title>T</title>${inner}</concept>`), ['Duplicate id "y"; first used on line 1']);
    const twins = '<concept id="c"><title>T</title><concept id="d"><title>U</title></concept><concept id="d"><title>V</title></concept></concept>';
    assert.deepEqual(messages(twins), ['Duplicate id "d"; first used on line 1']);
  });
});

describe('diagnostics: own-document anchors', () => {
  it('resolves #id against this file', () => {
    assert.deepEqual(diag('<topic><title>x</title><p href="#intro">a</p><p id="intro"/></topic>'), []);
  });

  it('reports a #id that no element defines', () => {
    const xml = '<topic>\n  <title>x</title>\n  <p href="#nope">a</p>\n</topic>';
    assert.deepEqual(messages(xml), ['No element with id "nope" in this file']);
  });
});

describe('diagnostics: files', () => {
  const exists = (p: string) => p === resolve('/vault/docs/exists.dita') || p === resolve('/vault/docs/img/a.png');

  it('reports a relative href to nothing', () => {
    const xml = '<topic>\n  <title>x</title>\n  <p><xref href="missing.dita">a</xref></p>\n</topic>';
    assert.deepEqual(messages(xml, { fileExists: exists }), ['File not found: missing.dita']);
  });

  it('accepts an existing target and decodes percent escapes', () => {
    assert.deepEqual(messages('<topic><title>x</title><p><xref href="exists.dita">a</xref></p></topic>', { fileExists: exists }), []);
    assert.deepEqual(messages('<topic><title>x</title><p><image href="img/a.png"/></p></topic>', { fileExists: exists }), []);
    assert.deepEqual(messages('<topic><title>x</title><p><xref href="my%20topic.dita">a</xref></p></topic>', { fileExists: (p) => p === resolve('/vault/docs/my topic.dita') }), []);
  });

  it('leaves external targets alone: a scheme, an absolute path, or scope="external"', () => {
    const xml = '<topic><title>x</title><p>'
      + '<xref href="https://example.com/a">a</xref>'
      + '<xref href="mailto:a@b.c">b</xref>'
      + '<xref href="/etc/hosts">c</xref>'
      + '<xref href="www.example.com" scope="external">d</xref>'
      + '</p></topic>';
    assert.deepEqual(messages(xml, { fileExists: () => false }), []);
  });

  it('does not require a peer target to exist next to this file', () => {
    const xml = '<topic><title>x</title><p><xref href="other.dita" scope="peer">a</xref></p></topic>';
    assert.deepEqual(messages(xml, { fileExists: () => false }), []);
  });

  it('checks conref and conrefend like href', () => {
    const xml = '<topic><title>x</title><body>'
      + '<p conref="missing.dita#p1">a</p>'
      + '<p conrefend="missing.dita#p2">b</p>'
      + '</body></topic>';
    assert.deepEqual(messages(xml, { fileExists: () => false }), ['File not found: missing.dita', 'File not found: missing.dita']);
  });

  it('checks an anchor inside another DITA file through idsIn', () => {
    const other = resolve('/vault/docs/other.dita');
    const xml = '<topic><title>x</title><p><xref href="other.dita#intro">a</xref></p></topic>';
    const idsIn = (p: string) => (p === other ? ['other', 'intro'] : undefined);
    assert.deepEqual(messages(xml, { idsIn }), []);
    assert.deepEqual(messages('<topic><title>x</title><p><xref href="other.dita#nope">a</xref></p></topic>', { idsIn }), [
      'No element with id "nope" in other.dita',
    ]);
  });

  it('does not read a non-DITA target for ids', () => {
    let asked = 0;
    const xml = '<topic><title>x</title><p><xref href="a.html#top">a</xref></p></topic>';
    assert.deepEqual(messages(xml, { idsIn: () => { asked++; return []; } }), []);
    assert.equal(asked, 0);
  });

  it('checks topicrefs in a map', () => {
    const map = resolve('/vault/maps/guide.ditamap');
    const issues = collectDiagnostics({
      xml: '<map><title>G</title><topicref href="missing.dita"/></map>',
      absPath: map,
      fileExists: () => false,
    });
    assert.deepEqual(issues.map((d) => d.message), ['File not found: missing.dita']);
  });
});

describe('diagnostics: keys', () => {
  const keys = new Map([['product', 'Acme']]);

  it('reports a keyref to a key no map defines', () => {
    const xml = '<topic><title>x</title><p><ph keyref="brand">a</ph></p></topic>';
    assert.deepEqual(messages(xml, { keys }), ['Key "brand" is not defined by the maps near this document']);
  });

  it('accepts a defined key, with or without an element id after it', () => {
    assert.deepEqual(messages('<topic><title>x</title><p><ph keyref="product">a</ph></p></topic>', { keys }), []);
    assert.deepEqual(messages('<topic><title>x</title><p><ph conkeyref="product/name">a</ph></p></topic>', { keys }), []);
  });

  it('checks conkeyref against the same key space', () => {
    assert.deepEqual(messages('<topic><title>x</title><p><ph conkeyref="brand/name">a</ph></p></topic>', { keys }), [
      'Key "brand" is not defined by the maps near this document',
    ]);
  });

  it('has nothing to check against when no key space was found, so it stays quiet', () => {
    const xml = '<topic><title>x</title><p><ph keyref="brand">a</ph><ph conkeyref="brand/n">b</ph></p></topic>';
    assert.deepEqual(messages(xml), []);
    assert.deepEqual(messages(xml, { keys: new Map() }), []);
  });

  it('does not also report the href that a keyref overrides', () => {
    const xml = '<topic><title>x</title><p><xref keyref="product" href="missing.dita">a</xref></p></topic>';
    assert.deepEqual(messages(xml, { keys, fileExists: () => false }), []);
  });
});

describe('diagnostics: positions with named entities', () => {
  it('puts an XML error on the right tag when entities come before it on the line', () => {
    const xml = '<concept id="c"><title>A&nbsp;&nbsp;&nbsp;B&mdash;C</title><conbody><p>x</q></conbody></concept>';
    const [d] = diag(xml);
    assert.equal(d.severity, 'error');
    assert.equal(xml.slice(d.startCol, d.endCol), '</q>');
  });

  it('puts a warning on the right tag when entities come before it on the line', () => {
    const xml = '<topic><title>A&nbsp;B</title><p>&copy; <xref href="gone.dita">x</xref></p></topic>';
    const [d] = diag(xml, { fileExists: () => false });
    assert.equal(xml.slice(d.startCol, d.endCol), '<xref href="gone.dita">');
  });

  it('leaves entities in CDATA and comments alone', () => {
    assert.deepEqual(messages('<topic><title>x</title><p><!-- &nope; --></p><codeblock><![CDATA[&nope;]]></codeblock></topic>'), []);
  });
});

describe('diagnostics: a tag left open', () => {
  it('blames the tag missing its ">" rather than the tag that follows it', () => {
    const xml = '<concept id="a"\n  <title>Alpha</title>\n  <conbody/>\n</concept>';
    const [d, ...rest] = diag(xml);
    assert.equal(rest.length, 0);
    assert.equal(d.severity, 'error');
    assert.equal(d.message, 'The <concept> tag is missing its closing ">"');
    assert.deepEqual([d.startLine, d.startCol, d.endLine, d.endCol], [0, 0, 0, 15]);
  });

  it('still reports an ordinary mismatch on the tag itself', () => {
    const xml = '<topic>\n  <p>x</q>\n</topic>';
    const [d] = diag(xml);
    assert.equal(d.message.includes('missing its closing'), false);
    assert.equal(d.startLine, 1);
  });
});

describe('diagnostics: topic/element fragments', () => {
  const ids = (list: string[]) => ({ idsIn: () => list });

  it('accepts topicid/elementid when both exist', () => {
    const xml = '<topic><title>x</title><p><xref href="b.dita#b/target">a</xref><p conref="b.dita#b/target"/></p></topic>';
    assert.deepEqual(messages(xml, ids(['b', 'target'])), []);
  });

  it('names the half that is missing', () => {
    const xml = '<topic><title>x</title><p><xref href="b.dita#b/nope">a</xref><xref href="b.dita#zz/target">b</xref></p></topic>';
    assert.deepEqual(messages(xml, ids(['b', 'target'])), [
      'No element with id "nope" in b.dita',
      'No element with id "zz" in b.dita',
    ]);
  });

  it('applies the same rule to #topicid/elementid inside this file', () => {
    const own = '<concept id="c"><title>x</title><conbody><p id="p1"/><p><xref href="#c/p1">a</xref><xref href="#c/p9">b</xref></p></conbody></concept>';
    assert.deepEqual(messages(own), ['No element with id "p9" in this file']);
  });
});

describe('diagnostics: dependencies', () => {
  it('collects every reference target, existing or not', () => {
    const collect = new Set<string>();
    const xml = '<topic><title>x</title><body>'
      + '<p><xref href="other.dita#intro">a</xref></p>'
      + '<p><image href="img/a.png"/></p>'
      + '<p conref="missing.dita#p1">b</p>'
      + '</body></topic>';
    diag(xml, {
      collectDependencies: collect,
      idsIn: () => ['intro'],
      fileExists: (p) => p === resolve('/vault/docs/other.dita'),
    });
    assert.deepEqual([...collect].sort(), [
      resolve('/vault/docs/img/a.png'),
      resolve('/vault/docs/missing.dita'),
      resolve('/vault/docs/other.dita'),
    ].sort());
  });

  it('leaves external references and same-file anchors out', () => {
    const collect = new Set<string>();
    const xml = '<topic><title>x</title><body>'
      + '<p href="#own"/><p id="own"/>'
      + '<p><xref href="https://example.com/a">a</xref></p>'
      + '<p><xref href="other.dita" scope="peer">b</xref></p>'
      + '</body></topic>';
    diag(xml, { collectDependencies: collect, fileExists: () => false });
    assert.deepEqual([...collect], []);
  });

  it('collects the maps the key space came from', () => {
    const collect = new Set<string>();
    const map = resolve('/vault/maps/keys.ditamap');
    diag('<topic><title>x</title><p><ph keyref="product">a</ph></p></topic>', {
      collectDependencies: collect,
      keys: new Map([['product', 'Acme']]),
      keyFiles: [map],
    });
    assert.deepEqual([...collect], [map]);
  });
});

describe('diagnostics: ordering', () => {
  it('sorts by position, whatever the checks found first', () => {
    const xml = '<topic>\n  <p keyref="gone"/>\n  <p id="a"/>\n  <p id="a"/>\n</topic>';
    const lines = diag(xml, { keys: new Map([['other', 'x']]) }).map((d) => d.startLine);
    assert.deepEqual(lines, [1, 3]);
  });
});
