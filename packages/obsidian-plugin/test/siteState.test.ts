import { strict as assert } from 'assert';
import { join, resolve } from 'path';
import { sitePageFromState, sitePageToState } from '../src/siteState';

const root = join('/', 'vault');

describe('sitePageToState', () => {
  it('keeps the path inside the vault, with forward slashes', () => {
    assert.equal(sitePageToState(root, resolve(root, 'topics', 'a.dita')), 'topics/a.dita');
    assert.equal(sitePageToState(root, resolve(root, 'a.dita')), 'a.dita');
  });

  it('keeps nothing for a path outside the vault, or the vault itself', () => {
    assert.equal(sitePageToState(root, resolve(root, '..', 'other', 'a.dita')), undefined);
    assert.equal(sitePageToState(root, root), undefined);
  });

  it('keeps a file whose name starts with two dots', () => {
    assert.equal(sitePageToState(root, resolve(root, '..draft.dita')), '..draft.dita');
  });
});

describe('sitePageFromState', () => {
  it('gives back the absolute path in this vault', () => {
    assert.equal(sitePageFromState(root, 'topics/a.dita'), resolve(root, 'topics', 'a.dita'));
  });

  it('round-trips what sitePageToState kept', () => {
    const page = resolve(root, 'topics', 'sub dir', 'a.dita');
    assert.equal(sitePageFromState(root, sitePageToState(root, page)), page);
  });

  it('refuses anything that is not a path inside the vault', () => {
    assert.equal(sitePageFromState(root, '../other/a.dita'), undefined);
    assert.equal(sitePageFromState(root, 'topics/../../a.dita'), undefined);
    assert.equal(sitePageFromState(root, resolve('/', 'etc', 'passwd')), undefined);
    assert.equal(sitePageFromState(root, ''), undefined);
    assert.equal(sitePageFromState(root, undefined), undefined);
    assert.equal(sitePageFromState(root, 7), undefined);
    assert.equal(sitePageFromState(root, { path: 'a.dita' }), undefined);
  });
});
