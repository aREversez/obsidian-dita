import { strict as assert } from 'assert';
import { detectEol, toLf, withEol } from '../src/lineEndings';
import { minimalReplacement } from '../src/textDiff';

describe('lineEndings', () => {
  it('detects CRLF when the text has any, else LF', () => {
    assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
    assert.equal(detectEol('a\nb\n'), '\n');
    assert.equal(detectEol('a\r\nb\nc'), '\r\n'); // mixed: one ending for the file
    assert.equal(detectEol('a\rb'), '\n'); // lone CR is not CRLF
    assert.equal(detectEol(''), '\n');
  });

  it('turns every ending into \\n for the editor', () => {
    assert.equal(toLf('a\r\nb\rc\nd'), 'a\nb\nc\nd');
    const lf = 'a\nb';
    assert.equal(toLf(lf), lf);
  });

  it('gives a file its own ending back, and round-trips an untouched CRLF file', () => {
    const disk = '<topic>\r\n  <title>A</title>\r\n</topic>\r\n';
    const eol = detectEol(disk);
    assert.equal(withEol(toLf(disk), eol), disk);
    assert.equal(withEol('a\nb\n', '\n'), 'a\nb\n');
  });

  it('does not double the \\r of text that already has CRLF', () => {
    assert.equal(withEol('a\r\nb', '\r\n'), 'a\r\nb');
  });

  it('makes a reload of an unchanged CRLF file a no-op for the editor', () => {
    const disk = '<topic>\r\n  <title>A</title>\r\n  <body/>\r\n</topic>\r\n';
    const editorText = toLf(disk);
    // Compared raw, the CRLF text differs from the editor's from the first line end on.
    assert.ok(minimalReplacement(editorText, disk));
    assert.equal(minimalReplacement(editorText, toLf(disk)), undefined);
  });

  it('merges an edit in a CRLF file as just that edit', () => {
    const disk = 'a\r\nb\r\nc\r\n';
    const edited = 'a\r\nB\r\nc\r\n';
    assert.deepEqual(minimalReplacement(toLf(disk), toLf(edited)), { from: 2, to: 3, insert: 'B' });
  });
});
