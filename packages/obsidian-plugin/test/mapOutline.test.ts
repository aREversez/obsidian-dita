import { strict as assert } from 'assert';
import { outlineEntryPosition } from '../src/mapOutline';

describe('outlineEntryPosition', () => {
  const text = [
    '<map>',
    '  <title>Guide</title>',
    '  <chapter href="a.dita" navtitle="Alpha"/>',
    '  <topicref href="sub/b.dita#b/child"/>',
    '</map>',
  ].join('\n');

  it('finds the href line and the column inside the quotes', () => {
    assert.deepEqual(outlineEntryPosition(text, 'a.dita'), { line: 2, col: 17 });
    assert.deepEqual(outlineEntryPosition(text, 'sub/b.dita#b/child'), { line: 3, col: 18 });
  });

  it('matches a percent-encoded href', () => {
    const encoded = '<map><topicref href="my%20topic.dita"/></map>';
    assert.deepEqual(outlineEntryPosition(encoded, 'my topic.dita'), { line: 0, col: 21 });
  });

  it('returns undefined for an entry that came from a submap', () => {
    assert.equal(outlineEntryPosition(text, 'sub/deep.dita'), undefined);
  });

  it('ignores other reference attributes', () => {
    const withConref = '<map><topicref href="a.dita" conref="b.dita"/></map>';
    assert.equal(outlineEntryPosition(withConref, 'b.dita'), undefined);
  });
});
