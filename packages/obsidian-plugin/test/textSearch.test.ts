import { strict as assert } from 'assert';
import { MAX_MATCHES, buildIndex, findMatches, locate } from '../src/textSearch';

const inline = (...texts: string[]) => texts.map((text) => ({ text, breakBefore: false }));

describe('findMatches', () => {
  it('finds every match, case-insensitively by default', () => {
    assert.deepEqual(findMatches('Foo foo FOO', 'foo', false), [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
  });

  it('can match case', () => {
    assert.deepEqual(findMatches('Foo foo FOO', 'foo', true), [{ start: 4, end: 7 }]);
  });

  it('takes the query literally, not as a pattern', () => {
    assert.deepEqual(findMatches('a.c abc a+c', 'a.c', false), [{ start: 0, end: 3 }]);
    assert.deepEqual(findMatches('(x) [y] $z', '(x)', false), [{ start: 0, end: 3 }]);
  });

  it('matches a phrase across any whitespace, as the reader sees it', () => {
    assert.equal(findMatches('quick\n    brown   fox', 'quick brown fox', false).length, 1);
    assert.equal(findMatches('quick brown', 'quick   brown', false).length, 1);
  });

  it('finds nothing for an empty or blank query', () => {
    assert.deepEqual(findMatches('abc', '', false), []);
    assert.deepEqual(findMatches('abc', '   ', false), []);
  });

  it('works for text that is not Latin, and for characters outside the BMP', () => {
    assert.deepEqual(findMatches('幂等性 与 幂等', '幂等', false), [
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ]);
    assert.deepEqual(findMatches('a😀b😀', '😀', false), [
      { start: 1, end: 3 },
      { start: 4, end: 6 },
    ]);
  });

  it('stops at the cap', () => {
    assert.equal(findMatches('a'.repeat(MAX_MATCHES + 500), 'a', false).length, MAX_MATCHES);
  });
});

describe('buildIndex', () => {
  it('joins parts of one block as they are', () => {
    const index = buildIndex(inline('the ', 'quick', ' fox'));
    assert.equal(index.text, 'the quick fox');
    assert.deepEqual(index.starts, [0, 4, 9]);
  });

  it('keeps a match from running from one block into the next', () => {
    const index = buildIndex([
      { text: 'end of one', breakBefore: false },
      { text: 'start of two', breakBefore: true },
    ]);
    assert.equal(findMatches(index.text, 'one start', false).length, 0);
    assert.equal(findMatches(index.text, 'end of one', false).length, 1);
  });
});

describe('locate', () => {
  const index = buildIndex([
    { text: 'the ', breakBefore: false },
    { text: 'quick', breakBefore: false },
    { text: ' fox', breakBefore: false },
  ]);

  it('maps the start of a match to the part it begins in', () => {
    assert.deepEqual(locate(index, 0, 'start'), { part: 0, offset: 0 });
    assert.deepEqual(locate(index, 4, 'start'), { part: 1, offset: 0 });
    assert.deepEqual(locate(index, 6, 'start'), { part: 1, offset: 2 });
  });

  it('maps the end of a match to the part it ends in, even at the very end of a part', () => {
    assert.deepEqual(locate(index, 4, 'end'), { part: 0, offset: 4 }); // "the " ends exactly at the boundary
    assert.deepEqual(locate(index, 9, 'end'), { part: 1, offset: 5 });
    assert.deepEqual(locate(index, 13, 'end'), { part: 2, offset: 4 });
  });

  it('turns a match across parts into two ends in the right nodes', () => {
    const [m] = findMatches(index.text, 'quick fox', false);
    assert.deepEqual(locate(index, m.start, 'start'), { part: 1, offset: 0 });
    assert.deepEqual(locate(index, m.end, 'end'), { part: 2, offset: 4 });
  });
});
