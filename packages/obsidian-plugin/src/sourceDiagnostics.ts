// Core diagnostics in the shape the source editor decorates with.
//
// Free of Obsidian and CodeMirror imports so the position arithmetic is
// unit-tested: the core speaks 0-based line/column pairs, the editor speaks
// document offsets.

import { DitaDiagnostic } from '@dita-viewer/core';

export interface ProblemRange {
  /** Document offsets; `to` is exclusive. */
  from: number;
  to: number;
  severity: 'error' | 'warning';
  message: string;
}

/** Offset of the first character of every line. */
function lineStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1; // the '\n' that split() removed
  }
  return starts;
}

/**
 * Where each problem sits in the document. A position past the end of its
 * line (the source changed under an older diagnostic set) is clamped to the
 * line rather than dropped: a squiggle in the wrong place is better than one
 * that silently disappears.
 */
export function problemRanges(lines: readonly string[], problems: readonly DitaDiagnostic[]): ProblemRange[] {
  const starts = lineStarts(lines);
  const total = (starts[starts.length - 1] ?? 0) + (lines[lines.length - 1] ?? '').length;
  const clamp = (line: number, col: number): number => {
    const index = Math.min(Math.max(0, line), lines.length - 1);
    return (starts[index] ?? 0) + Math.min(Math.max(0, col), (lines[index] ?? '').length);
  };
  return problems.flatMap((p) => {
    // An empty document has nowhere to put a squiggle, and a range past the
    // end would make the editor reject the decoration set.
    if (total === 0) return [];
    let from = clamp(p.startLine, p.startCol);
    let to = clamp(p.endLine, p.endCol);
    if (from >= total) from = total - 1;
    if (to <= from) to = Math.min(total, from + 1);
    if (to > total) to = total;
    return [{ from, to, severity: p.severity, message: p.message }];
  });
}
