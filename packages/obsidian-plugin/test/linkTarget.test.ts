import { strict as assert } from 'assert';
import { join } from 'path';
import { isExternalHref, resolveLinkTarget } from '../src/linkTarget';

const root = join('/', 'vault');

describe('resolveLinkTarget', () => {
  it('resolves a link relative to the document it is in', () => {
    assert.deepEqual(resolveLinkTarget(root, 'topics/overview.dita', 'how-it-works.dita'), { path: 'topics/how-it-works.dita', fragment: '' });
    assert.deepEqual(resolveLinkTarget(root, 'topics/overview.dita', '../common/keys.ditamap'), { path: 'common/keys.ditamap', fragment: '' });
    assert.deepEqual(resolveLinkTarget(root, 'book.ditamap', 'topics/a.dita'), { path: 'topics/a.dita', fragment: '' });
  });

  it('keeps the fragment, undecoded', () => {
    assert.deepEqual(resolveLinkTarget(root, 'topics/a.dita', 'b.dita#b/step%201'), { path: 'topics/b.dita', fragment: 'b/step%201' });
  });

  it('decodes the path, as the file is named', () => {
    assert.deepEqual(resolveLinkTarget(root, 'topics/a.dita', 'my%20topic.dita'), { path: 'topics/my topic.dita', fragment: '' });
  });

  it('is relative to a topic of a book, not to the map, when it is given', () => {
    const base = join(root, 'topics', 'deep', 'x.dita');
    assert.deepEqual(resolveLinkTarget(root, 'book.ditamap', 'y.dita', base), { path: 'topics/deep/y.dita', fragment: '' });
    // an absolute target (how a book names its members) stands as it is
    assert.deepEqual(resolveLinkTarget(root, 'book.ditamap', join(root, 'topics', 'z.dita') + '#z', base), { path: 'topics/z.dita', fragment: 'z' });
  });

  it('names no file for a fragment on the same page, an empty href, or a path out of the vault', () => {
    assert.equal(resolveLinkTarget(root, 'topics/a.dita', '#section'), undefined);
    assert.equal(resolveLinkTarget(root, 'topics/a.dita', ''), undefined);
    assert.equal(resolveLinkTarget(root, 'topics/a.dita', '../../outside.dita'), undefined);
    assert.equal(resolveLinkTarget(root, 'topics/a.dita', '..'), undefined);
  });
});

describe('isExternalHref', () => {
  it('knows web and mail links', () => {
    assert.ok(isExternalHref('https://example.com/a'));
    assert.ok(isExternalHref('HTTP://example.com'));
    assert.ok(isExternalHref('mailto:a@b.c'));
    assert.ok(!isExternalHref('topics/a.dita'));
    assert.ok(!isExternalHref('#id'));
  });
});
