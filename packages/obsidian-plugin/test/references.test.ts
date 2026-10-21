import { strict as assert } from 'assert';
import { positionOfId, referenceAt } from '../src/references';

const xml = ['<topic id="t">', '  <p><xref href="a.dita#x" keyref="k"/></p>', '  <image href="img/a.png"/>', '</topic>'].join('\n');

describe('referenceAt', () => {
  it('finds an href under the pointer', () => {
    const at = xml.indexOf('a.dita');
    assert.deepEqual(referenceAt(xml, at + 2), { kind: 'file', attribute: 'href', value: 'a.dita#x' });
  });

  it('finds a keyref', () => {
    const at = xml.indexOf('keyref');
    assert.deepEqual(referenceAt(xml, at + 3), { kind: 'key', attribute: 'keyref', value: 'k' });
  });

  it('accepts the whole name="value" span, closing quote included', () => {
    const at = xml.indexOf('img/a.png');
    assert.ok(referenceAt(xml, at - 1));
    assert.ok(referenceAt(xml, at + 'img/a.png'.length + 1));
  });

  it('finds conref and conrefend', () => {
    const text = '<p conref="a.dita#p1" conrefend="a.dita#p2"/>';
    assert.deepEqual(referenceAt(text, text.indexOf('a.dita#p1')), { kind: 'file', attribute: 'conref', value: 'a.dita#p1' });
    assert.deepEqual(referenceAt(text, text.indexOf('a.dita#p2')), { kind: 'file', attribute: 'conrefend', value: 'a.dita#p2' });
  });

  it('finds a conkeyref', () => {
    const text = '<p conkeyref="k/p1"/>';
    assert.deepEqual(referenceAt(text, text.indexOf('k/p1')), { kind: 'key', attribute: 'conkeyref', value: 'k/p1' });
  });

  it('finds an attribute on a tag that wraps over lines', () => {
    const text = '<xref\n  href="a.dita"\n  >go</xref>';
    assert.deepEqual(referenceAt(text, text.indexOf('a.dita')), { kind: 'file', attribute: 'href', value: 'a.dita' });
  });

  it('ignores plain text, comments, CDATA and closing tags', () => {
    const text = 'href="a.dita"\n<!-- href="b.dita" -->\n<![CDATA[ href="c.dita" ]]>\n</p>';
    for (const needle of ['a.dita', 'b.dita', 'c.dita']) {
      assert.equal(referenceAt(text, text.indexOf(needle)), undefined, needle);
    }
  });

  it('ignores attributes that are not references', () => {
    const text = '<p id="text" scope="local">x</p>';
    assert.equal(referenceAt(text, text.indexOf('"text"')), undefined);
    assert.equal(referenceAt(text, text.indexOf('local')), undefined);
  });

  it('ignores an empty value', () => {
    const text = '<xref href=""/>';
    assert.equal(referenceAt(text, text.indexOf('href')), undefined);
  });

  it('ignores a caret after the tag has ended', () => {
    assert.equal(referenceAt('<p href="a.dita">x</p>', 17), undefined);
  });
});

describe('positionOfId', () => {
  const topic = '<topic>\n  <p id="intro">x</p>\n</topic>';

  it('points at the opening tag of the element', () => {
    assert.deepEqual(positionOfId(topic, 'intro'), { line: 1, col: 2 });
  });

  it('accepts single quotes and spaces around the equals sign', () => {
    assert.deepEqual(positionOfId("<p id = 'x'>", 'x'), { line: 0, col: 0 });
  });

  it('escapes regular-expression characters in the id', () => {
    const text = '<p id="a.b">x</p>';
    assert.deepEqual(positionOfId(text, 'a.b'), { line: 0, col: 0 });
    assert.equal(positionOfId(text, 'aXb'), undefined);
  });

  it('returns undefined when no element has the id', () => {
    assert.equal(positionOfId(topic, 'outro'), undefined);
  });
});
