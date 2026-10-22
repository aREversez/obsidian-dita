import { strict as assert } from 'assert';
import { join } from 'path';
import { mapMayAffect } from '../src/mapScope';

describe('mapMayAffect', () => {
  const vault = join('/vault');

  it('a map affects documents in its folder and below', () => {
    assert.equal(mapMayAffect(join(vault, 'docs', 'a.ditamap'), join(vault, 'docs', 't.dita')), true);
    assert.equal(mapMayAffect(join(vault, 'docs', 'a.ditamap'), join(vault, 'docs', 'sub', 'deep', 't.dita')), true);
    assert.equal(mapMayAffect(join(vault, 'a.ditamap'), join(vault, 'docs', 't.dita')), true);
  });

  it('but not documents beside or above it', () => {
    assert.equal(mapMayAffect(join(vault, 'docs', 'a.ditamap'), join(vault, 'other', 't.dita')), false);
    assert.equal(mapMayAffect(join(vault, 'docs', 'sub', 'a.ditamap'), join(vault, 'docs', 't.dita')), false);
  });

  it('is not fooled by a folder whose name starts the same', () => {
    assert.equal(mapMayAffect(join(vault, 'docs', 'a.ditamap'), join(vault, 'docs-old', 't.dita')), false);
  });
});
