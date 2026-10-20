export interface Replacement {
  from: number;
  to: number;
  insert: string;
}

/**
 * The smallest single replacement that turns `oldText` into `newText`: common
 * prefix and suffix are kept. Used when the file changes on disk while it is
 * open, so the editor's cursor, selection and scroll position survive instead
 * of being reset by a whole-document replace. Returns undefined when equal.
 */
export function minimalReplacement(oldText: string, newText: string): Replacement | undefined {
  if (oldText === newText) return undefined;
  const max = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  // Never split a surrogate pair: back off if the boundary is inside one.
  if (start > 0 && isHighSurrogate(oldText.charCodeAt(start - 1))) start--;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  if (endOld < oldText.length && endOld > start && isHighSurrogate(oldText.charCodeAt(endOld - 1))) {
    endOld++;
    endNew++;
  }
  return { from: start, to: endOld, insert: newText.slice(start, endNew) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
