// The few words the conditional-processing panel composes itself. No DOM and
// no Obsidian imports, so the wording is unit-tested.

const LABELS: Readonly<Record<string, string>> = { otherprops: 'Other props' };

/** "audience" -> "Audience"; names an author invented are shown as written. */
export function attributeLabel(att: string): string {
  return LABELS[att] ?? att.charAt(0).toUpperCase() + att.slice(1);
}

/** The status line under the panel's values. */
export function statusText(count: number): string {
  if (count === 0) return 'Nothing is hidden.';
  return count === 1 ? '1 element is hidden.' : `${count} elements are hidden.`;
}
