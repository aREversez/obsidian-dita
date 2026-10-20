// The three ways a .dita file can be shown, mirroring Markdown in Obsidian:
//   reading  the formatted preview only
//   source   the XML source only, editable
//   split    source and preview side by side, the preview following the edits
// Kept free of Obsidian imports so the rules are unit-tested.

export type ViewMode = 'reading' | 'source' | 'split';

export const VIEW_MODES: readonly ViewMode[] = ['reading', 'source', 'split'];

export const MODE_LABELS: Readonly<Record<ViewMode, string>> = {
  reading: 'Reading view',
  source: 'Source mode',
  split: 'Live preview (side by side)',
};

/** Icon ids from Obsidian's bundled Lucide set. */
export const MODE_ICONS: Readonly<Record<ViewMode, string>> = {
  reading: 'book-open',
  source: 'code',
  split: 'separator-vertical',
};

export function isViewMode(value: unknown): value is ViewMode {
  return typeof value === 'string' && (VIEW_MODES as readonly string[]).includes(value);
}

export function parseViewMode(value: unknown, fallback: ViewMode): ViewMode {
  return isViewMode(value) ? value : fallback;
}

/**
 * The one-key toggle (like Markdown's reading/editing switch): reading goes to
 * source; source and split both go back to reading.
 */
export function toggleMode(mode: ViewMode): ViewMode {
  return mode === 'reading' ? 'source' : 'reading';
}

export interface PaneVisibility {
  editor: boolean;
  preview: boolean;
}

export function panesFor(mode: ViewMode): PaneVisibility {
  return { editor: mode !== 'reading', preview: mode !== 'source' };
}
