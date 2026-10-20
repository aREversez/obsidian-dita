import { strict as assert } from 'assert';
import { minimalReplacement } from '../src/textDiff';

const apply = (s: string, r: { from: number; to: number; insert: string }): string => s.slice(0, r.from) + r.insert + s.slice(r.to);

describe('minimalReplacement', () => {
  it('returns undefined for equal text', () => {
    assert.equal(minimalReplacement('abc', 'abc'), undefined);
    assert.equal(minimalReplacement('', ''), undefined);
  });

  it('replaces only the changed middle', () => {
    assert.deepEqual(minimalReplacement('<p>hello world</p>', '<p>hello there</p>'), { from: 9, to: 14, insert: 'there' });
  });

  it('handles pure insertion, deletion, and whole replacement', () => {
    assert.deepEqual(minimalReplacement('ab', 'aXb'), { from: 1, to: 1, insert: 'X' });
    assert.deepEqual(minimalReplacement('aXb', 'ab'), { from: 1, to: 2, insert: '' });
    assert.deepEqual(minimalReplacement('', 'abc'), { from: 0, to: 0, insert: 'abc' });
    assert.deepEqual(minimalReplacement('abc', ''), { from: 0, to: 3, insert: '' });
    assert.deepEqual(minimalReplacement('abc', 'xyz'), { from: 0, to: 3, insert: 'xyz' });
  });

  it('does not let prefix and suffix overlap (repeated characters)', () => {
    const r = minimalReplacement('aaa', 'aaaa')!;
    assert.equal(apply('aaa', r), 'aaaa');
    const r2 = minimalReplacement('abab', 'ab')!;
    assert.equal(apply('abab', r2), 'ab');
  });

  it('never splits a surrogate pair', () => {
    // 😀 = D83D DE00, 😁 = D83D DE01: same high surrogate, different low.
    const a = 'x😀y';
    const b = 'x😁y';
    const r = minimalReplacement(a, b)!;
    assert.equal(apply(a, r), b);
    assert.equal(r.from, 1, 'replacement starts at the pair, not between its halves');
    assert.equal(r.to, 3);
  });

  it('is a correct patch for random edits', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const alphabet = ['a', 'b', '<', '>', '\n', '中', '😀'];
    const rand = (len: number): string => Array.from({ length: len }, () => alphabet[rnd(alphabet.length)]).join('');
    for (let i = 0; i < 300; i++) {
      const a = rand(rnd(12));
      const b = rand(rnd(12));
      const r = minimalReplacement(a, b);
      assert.equal(r === undefined ? a : apply(a, r), b, JSON.stringify([a, b]));
    }
  });
});
