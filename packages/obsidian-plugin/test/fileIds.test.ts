import { strict as assert } from 'assert';
import { createIdReader } from '../src/fileIds';

describe('id reader', () => {
  it('reads and caches ids until the file stamp changes', () => {
    let reads = 0;
    let stamp = '1';
    const reader = createIdReader(
      () => {
        reads++;
        return '<topic id="one"><p id="two"/></topic>';
      },
      () => stamp,
    );
    assert.deepEqual(reader('/a.dita'), ['one', 'two']);
    assert.deepEqual(reader('/a.dita'), ['one', 'two']);
    assert.equal(reads, 1);
    stamp = '2';
    assert.deepEqual(reader('/a.dita'), ['one', 'two']);
    assert.equal(reads, 2);
  });

  it('does not read a file that is gone', () => {
    let reads = 0;
    const reader = createIdReader(
      () => {
        reads++;
        return '';
      },
      () => '?',
    );
    assert.equal(reader('/gone.dita'), undefined);
    assert.equal(reads, 0);
  });

  it('returns undefined when reading fails', () => {
    const reader = createIdReader(
      () => {
        throw new Error('boom');
      },
      () => '1',
    );
    assert.equal(reader('/a.dita'), undefined);
  });

  it('does not grow past its bound', () => {
    let reads = 0;
    const reader = createIdReader(
      () => {
        reads++;
        return '<p id="x"/>';
      },
      (path) => path,
    );
    for (let i = 0; i < 250; i++) reader(`/f${i}.dita`);
    const before = reads;
    assert.deepEqual(reader('/f249.dita'), ['x']);
    assert.equal(reads, before);
    // The oldest entry was evicted, so this one is read again.
    assert.deepEqual(reader('/f0.dita'), ['x']);
    assert.equal(reads, before + 1);
  });
});
