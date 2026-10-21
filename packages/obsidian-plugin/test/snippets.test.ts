import { strict as assert } from 'assert';
import { CARET, insertStructure, wrapSelection } from '../src/snippets';
import { STRUCTURES, WRAPS } from '../src/snippetsData';

describe('wrapSelection', () => {
  it('wraps the selection and keeps it selected inside the new element', () => {
    const bold = WRAPS.find((w) => w.id === 'b');
    assert.ok(bold);
    const edit = wrapSelection('text', bold);
    assert.equal(edit.insert, '<b>text</b>');
    assert.equal(edit.caret, 3);
    assert.equal(edit.select, 4);
  });

  it('leaves the caret between the tags when nothing is selected', () => {
    const codeph = WRAPS.find((w) => w.id === 'codeph');
    assert.ok(codeph);
    const edit = wrapSelection('', codeph);
    assert.equal(edit.insert, '<codeph></codeph>');
    assert.equal(edit.caret, '<codeph>'.length);
    assert.equal(edit.select, 0);
  });

  it('offers unique ids and paired tags', () => {
    assert.equal(new Set(WRAPS.map((w) => w.id)).size, WRAPS.length);
    for (const wrap of WRAPS) {
      assert.ok(wrap.open.startsWith('<'), wrap.id);
      assert.equal(wrap.close, `</${wrap.open.slice(1, -1)}>`, wrap.id);
    }
  });
});

describe('insertStructure', () => {
  it('indents the template like the current line', () => {
    const step = STRUCTURES.find((s) => s.id === 'step');
    assert.ok(step);
    const text = '<topic>\n  <ol>';
    const edit = insertStructure(text, text.length, step.template);
    assert.equal(edit.insert, '<step>\n    <cmd></cmd>\n  </step>');
    assert.equal(edit.caret, '<step>\n    <cmd>'.length);
  });

  it('adds no indentation at the start of a line', () => {
    const note = STRUCTURES.find((s) => s.id === 'note');
    assert.ok(note);
    const edit = insertStructure('', 0, note.template);
    assert.equal(edit.insert, '<note>\n  <p></p>\n</note>');
    assert.equal(edit.caret, '<note>\n  <p>'.length);
  });

  it('puts the caret at the end when a template has no marker', () => {
    const edit = insertStructure('', 0, '<a/>');
    assert.equal(edit.insert, '<a/>');
    assert.equal(edit.caret, 4);
  });

  it('removes the marker from the inserted text', () => {
    const edit = insertStructure('', 0, `<x>${CARET}</x>`);
    assert.equal(edit.insert, '<x></x>');
    assert.equal(edit.caret, 3);
  });

  it('offers unique structures that all place the caret', () => {
    assert.equal(new Set(STRUCTURES.map((s) => s.id)).size, STRUCTURES.length);
    for (const structure of STRUCTURES) assert.ok(structure.template.includes(CARET), structure.id);
  });
});
