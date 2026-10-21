import { strict as assert } from 'assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCompletionEnv } from '../src/completionEnv';

describe('completionEnv', () => {
  const root = mkdtempSync(join(tmpdir(), 'dita-env-'));
  mkdirSync(join(root, 'topics'));
  mkdirSync(join(root, 'img'));
  writeFileSync(join(root, 'topics', 'a.dita'), '<concept id="a"><conbody><p id="p1"/></conbody></concept>');
  writeFileSync(join(root, 'topics', 'b.dita'), '<concept id="b"/>');
  writeFileSync(join(root, 'img', 'x.png'), '');
  writeFileSync(join(root, 'img', 'notes.txt'), '');
  writeFileSync(join(root, 'm.ditamap'), '<map><keydef keys="prod"><topicmeta><keywords><keyword>Acme</keyword></keywords></topicmeta></keydef></map>');
  const env = createCompletionEnv({ absPath: join(root, 'topics', 'a.dita'), vaultRoot: root, isMap: false, ttl: 0 });

  it('lists topics and images relative to the document', async () => {
    assert.deepEqual([...(await env.files('topic'))].sort(), ['a.dita', 'b.dita']);
    assert.deepEqual(await env.files('image'), []);
    const top = createCompletionEnv({ absPath: join(root, 'x.dita'), vaultRoot: root, isMap: false, ttl: 0 });
    assert.deepEqual(await top.files('image'), ['img/x.png']);
  });

  it('reads ids from a sibling file, and refuses to leave the vault', () => {
    assert.deepEqual(env.idsIn('a.dita'), ['a', 'p1']);
    assert.equal(env.idsIn('missing.dita'), undefined);
    assert.equal(env.idsIn('../../../../etc/passwd'), undefined);
  });

  it('never throws when keys cannot be read', () => {
    assert.ok(env.keys() instanceof Map);
  });
});
