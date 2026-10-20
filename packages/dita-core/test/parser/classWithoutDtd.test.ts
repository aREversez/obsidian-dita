import * as assert from 'assert';
import { parseDita } from '../../src/parser/ditaParser';

/**
 * Specializations whose source carries @class but no DTD: the parser must pick
 * the most specific type it knows, not the topmost ancestor (topic/li for a
 * task/step specialization would lose the step rendering).
 */

const body = (inner: string) =>
  `<topic id="t" class="- topic/topic "><title class="- topic/title ">T</title><body class="- topic/body ">${inner}</body></topic>`;

function baseTypeOf(inner: string): string | undefined {
  const doc = parseDita(body(inner));
  const b = doc.root.children.find((c) => c.type === 'element' && c.tagName === 'body')!;
  return b.children.find((c) => c.type === 'element')!.baseType;
}

describe('specialized elements with @class and no DTD', () => {
  it('a highlight-domain specialization resolves like the standard <b>, not its topic/ph ancestor', () => {
    assert.strictEqual(baseTypeOf('<mybold class="- topic/ph hi-d/b my-d/mybold ">B</mybold>'), 'topic/b');
  });

  it('a programming-domain specialization resolves like the standard element it extends', () => {
    assert.strictEqual(baseTypeOf('<mycmd class="- topic/keyword pr-d/apiname my-d/mycmd ">C</mycmd>'), 'topic/apiname');
  });

  it('a task step specialization resolves like the standard <step> (topic/li)', () => {
    assert.strictEqual(baseTypeOf('<mystep class="- topic/li task/step my-d/mystep ">S</mystep>'), 'topic/li');
  });

  it('a direct specialization of a topic type still resolves to it', () => {
    assert.strictEqual(baseTypeOf('<mynote class="- topic/note my-d/mynote ">N</mynote>'), 'topic/note');
  });

  it('a custom domain token that merely shares a standard element name is not mistaken for it', () => {
    assert.strictEqual(baseTypeOf('<mybold class="- topic/ph my-d/b ">B</mybold>'), 'topic/ph');
  });

  it('an unknown intermediate class falls back to the nearest known ancestor', () => {
    assert.strictEqual(baseTypeOf('<deep class="- topic/p my-d/mid my-d/deep ">D</deep>'), 'topic/p');
  });

  it('a standard tag name still wins over its class attribute', () => {
    assert.strictEqual(baseTypeOf('<note class="- topic/note ">N</note>'), 'topic/note');
  });

  it('an element with neither a known tag nor @class has no baseType', () => {
    assert.strictEqual(baseTypeOf('<plain>x</plain>'), undefined);
  });
});
