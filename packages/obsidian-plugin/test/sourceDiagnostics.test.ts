import { strict as assert } from 'assert';
import { DitaDiagnostic } from '@dita-viewer/core';
import { problemRanges } from '../src/sourceDiagnostics';

function issue(startLine: number, startCol: number, endLine: number, endCol: number, severity: 'error' | 'warning' = 'error'): DitaDiagnostic {
  return { severity, message: 'problem', startLine, startCol, endLine, endCol };
}

describe('problem ranges', () => {
  it('converts 0-based line/column pairs to document offsets', () => {
    const [range] = problemRanges(['<topic>', '  <p>', '</topic>'], [issue(1, 2, 1, 5)]);
    assert.deepEqual([range.from, range.to], [10, 13]);
  });

  it('keeps a range that spans lines', () => {
    const [range] = problemRanges(['a', 'b', 'c'], [issue(0, 1, 2, 0)]);
    assert.deepEqual([range.from, range.to], [1, 4]);
  });

  it('clamps a position past the end of its line', () => {
    const [range] = problemRanges(['abc'], [issue(0, 9, 0, 12)]);
    assert.deepEqual([range.from, range.to], [2, 3]);
  });

  it('never produces an empty range', () => {
    const [range] = problemRanges(['abc'], [issue(0, 1, 0, 1)]);
    assert.deepEqual([range.from, range.to], [1, 2]);
  });

  it('stops at the document length when the text ends with a newline', () => {
    const [range] = problemRanges(['abc', ''], [issue(1, 0, 1, 0)]);
    assert.deepEqual([range.from, range.to], [3, 4]);
  });

  it('drops problems when there is no text to underline', () => {
    assert.deepEqual(problemRanges([], [issue(0, 0, 0, 1)]), []);
    assert.deepEqual(problemRanges([''], [issue(0, 0, 0, 1)]), []);
  });

  it('keeps the message and severity', () => {
    const [range] = problemRanges(['<a>'], [{ severity: 'warning', message: 'Missing', startLine: 0, startCol: 1, endLine: 0, endCol: 2 }]);
    assert.equal(range.severity, 'warning');
    assert.equal(range.message, 'Missing');
  });
});
