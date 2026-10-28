// The source editor holds its text \n-separated whatever the file uses
// (CodeMirror splits on \r\n, \r and \n when it loads), while Obsidian writes
// back exactly the string getViewData() returns and compares it with what it
// read from disk. These keep the two sides apart: the editor always gets
// \n-only text, and the file gets its own ending back.
//
// One ending per file: a file that mixes them is written back with CRLF
// throughout if it has any CRLF at all, and one that uses only \r (old Mac)
// comes back with \n.

export type Eol = '\n' | '\r\n';

/** The ending a file is written with: CRLF if the text has any, else \n. */
export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** The editor's form of the text: every ending as \n. */
export function toLf(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/** The file's form of the editor's text. */
export function withEol(text: string, eol: Eol): string {
  return eol === '\n' ? text : toLf(text).replace(/\n/g, eol);
}
