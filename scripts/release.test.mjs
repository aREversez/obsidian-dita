import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bumpVersions, checkRelease } from './release-lib.mjs';

const manifest = {
  id: 'dita-viewer',
  name: 'DITA Viewer',
  version: '0.2.0',
  minAppVersion: '1.5.0',
  description: 'Read DITA topics.',
  author: 'someone',
  isDesktopOnly: true,
};
const good = () => ({ manifest: { ...manifest }, versions: { '0.1.0': '1.5.0', '0.2.0': '1.5.0' }, pluginVersion: '0.2.0', tag: '0.2.0' });
const problemsOf = (change) => {
  const input = good();
  change(input);
  return checkRelease(input);
};

describe('checkRelease', () => {
  it('accepts a consistent release, with or without a tag', () => {
    assert.deepEqual(checkRelease(good()), []);
    assert.deepEqual(checkRelease({ ...good(), tag: undefined }), []);
  });

  it('rejects a tag that is not the manifest version, including a leading v', () => {
    assert.match(problemsOf((i) => (i.tag = 'v0.2.0')).join('\n'), /must equal the manifest version/);
    assert.match(problemsOf((i) => (i.tag = '0.2.1')).join('\n'), /must equal the manifest version/);
  });

  it('rejects a package.json that is at another version', () => {
    assert.match(problemsOf((i) => (i.pluginVersion = '0.1.0')).join('\n'), /package\.json is at 0\.1\.0/);
  });

  it('requires the current version in versions.json with the manifest minAppVersion', () => {
    assert.match(problemsOf((i) => delete i.versions['0.2.0']).join('\n'), /needs "0\.2\.0": "1\.5\.0"/);
    assert.match(problemsOf((i) => (i.versions['0.2.0'] = '1.4.0')).join('\n'), /needs "0\.2\.0": "1\.5\.0"/);
    assert.match(problemsOf((i) => (i.versions = [])).join('\n'), /must be an object/);
    assert.match(problemsOf((i) => (i.versions.latest = '1.5.0')).join('\n'), /"latest"/);
  });

  it('rejects versions that are not x.y.z', () => {
    for (const v of ['v0.2.0', '0.2', '0.2.0-beta']) {
      assert.match(problemsOf((i) => (i.manifest.version = v)).join('\n'), /must be x\.y\.z/, v);
    }
    assert.match(problemsOf((i) => (i.manifest.minAppVersion = '1.5')).join('\n'), /minAppVersion/);
  });

  it('checks the fields the directory requires', () => {
    for (const key of ['id', 'name', 'description', 'author']) {
      assert.match(problemsOf((i) => (i.manifest[key] = '')).join('\n'), new RegExp(`"${key}"`), key);
    }
    assert.match(problemsOf((i) => delete i.manifest.isDesktopOnly).join('\n'), /isDesktopOnly/);
  });

  it('applies the directory rules for the id and the description', () => {
    assert.match(problemsOf((i) => (i.manifest.id = 'my-obsidian-dita')).join('\n'), /"obsidian"/);
    assert.match(problemsOf((i) => (i.manifest.id = 'dita-plugin')).join('\n'), /"plugin"/);
    assert.match(problemsOf((i) => (i.manifest.id = 'Dita Viewer')).join('\n'), /lowercase/);
    assert.match(problemsOf((i) => (i.manifest.description = 'x'.repeat(251))).join('\n'), /limit is 250/);
    assert.match(problemsOf((i) => (i.manifest.description = 'No full stop')).join('\n'), /full stop/);
  });

  it('reports every problem at once', () => {
    const all = problemsOf((i) => {
      i.tag = 'v9';
      i.pluginVersion = '0.0.1';
      i.manifest.author = '';
    });
    assert.equal(all.length, 3);
  });
});

describe('bumpVersions', () => {
  it('sets the version and adds it to versions.json with the current minAppVersion', () => {
    const next = bumpVersions({ manifest: { ...manifest, version: '0.1.0' }, versions: { '0.1.0': '1.5.0' } }, '0.2.0');
    assert.equal(next.manifest.version, '0.2.0');
    assert.deepEqual(next.versions, { '0.1.0': '1.5.0', '0.2.0': '1.5.0' });
    assert.equal(next.manifest.id, 'dita-viewer');
  });

  it('does not mutate its input, and refuses a version that is not x.y.z', () => {
    const input = { manifest: { ...manifest }, versions: { '0.2.0': '1.5.0' } };
    bumpVersions(input, '0.3.0');
    assert.equal(input.manifest.version, '0.2.0');
    assert.deepEqual(input.versions, { '0.2.0': '1.5.0' });
    assert.throws(() => bumpVersions(input, 'v0.3.0'), /not x\.y\.z/);
  });

  it('a bumped release passes the check', () => {
    const next = bumpVersions({ manifest, versions: { '0.2.0': '1.5.0' } }, '0.3.0');
    assert.deepEqual(checkRelease({ ...next, pluginVersion: '0.3.0', tag: '0.3.0' }), []);
  });
});
