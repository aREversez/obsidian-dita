// The four ways a DITA file can be shown, mirroring Markdown in Obsidian:
//   reading  the formatted preview only
//   source   the XML source only, editable
//   split    source and preview side by side, the preview following the edits
//   book     a whole .ditamap's topics merged into one reading page
// Kept free of Obsidian imports so the rules are unit-tested.

export type ViewMode = 'reading' | 'source' | 'split' | 'book';

/** Every mode. `book` only applies to a .ditamap; see modesFor. */
export const VIEW_MODES: readonly ViewMode[] = ['reading', 'source', 'split', 'book'];

/** The modes a .dita topic can be shown in; a topic has no book. */
export const TOPIC_MODES: readonly ViewMode[] = ['reading', 'source', 'split'];

/** Modes offered for a file: maps also get the book view. */
export function modesFor(isMap: boolean): readonly ViewMode[] {
  return isMap ? VIEW_MODES : TOPIC_MODES;
}

export const MODE_LABELS: Readonly<Record<ViewMode, string>> = {
  reading: 'Reading view',
  source: 'Source mode',
  split: 'Live preview (side by side)',
  book: 'Book view',
};

/** Icon ids from Obsidian's bundled Lucide set. */
export const MODE_ICONS: Readonly<Record<ViewMode, string>> = {
  reading: 'book-open',
  source: 'code',
  split: 'separator-vertical',
  book: 'book',
};

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);
}

export function parseViewMode(value: unknown, fallback: ViewMode): ViewMode {
  return isViewMode(value) ? value : fallback;
}

/**
 * The one-key toggle (like Markdown's reading/editing switch): reading goes to
 * source; source, split and book all go back to reading.
 */
export function toggleMode(mode: ViewMode): ViewMode {
  return mode === 'reading' ? 'source' : 'reading';
}

export interface PaneVisibility {
  editor: boolean;
  preview: boolean;
}

export function panesFor(mode: ViewMode): PaneVisibility {
  return {
    editor: mode === 'source' || mode === 'split',
    preview: mode !== 'source',
  };
}
