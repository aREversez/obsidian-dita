// What the stub promises the other tests: the members they reach, and a
// failure by name for everything else.

import { strict as assert } from 'assert';

// require, not a namespace import: that one copies the members into a plain
// object, and the throw below has to come from the stub itself.
const stub = require('obsidian') as typeof import('obsidian');

describe('obsidian stub', () => {
  it('answers require() with the members the tests reach', () => {
    assert.equal(typeof stub.Notice, 'function');
    assert.equal(typeof stub.FileSystemAdapter, 'function');
    assert.equal(typeof stub.SuggestModal, 'function');
    assert.equal(typeof stub.Keymap.isModEvent, 'function');
    assert.equal(stub.moment.locale(), 'en');
  });

  it('throws by name for a member it does not provide', () => {
    const missing = stub as unknown as Record<string, unknown>;
    assert.throws(() => missing['MarkdownRenderer'], /obsidian stub: "MarkdownRenderer" is not provided/);
  });
});
