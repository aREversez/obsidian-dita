// The five ways a DITA file can be shown, mirroring Markdown in Obsidian:
//   reading  the formatted preview only
//   source   the XML source only, editable
//   split    source and preview side by side, the preview following the edits
//   site     a .ditamap as one topic per page with a sidebar
//   book     a whole .ditamap's topics merged into one reading page
// Kept free of Obsidian imports so the rules are unit-tested.

export type ViewMode = 'reading' | 'source' | 'split' | 'site' | 'book';

/** Every mode. `site` and `book` only apply to a .ditamap; see modesFor. */
export const VIEW_MODES: readonly ViewMode[] = ['reading', 'source', 'split', 'site', 'book'];

/** The modes a .dita topic can be shown in; a topic has no site or book. */
export const TOPIC_MODES: readonly ViewMode[] = ['reading', 'source', 'split'];

/** Modes offered for a file: maps also get the site and book views. */
export function modesFor(isMap: boolean): readonly ViewMode[] {
  return isMap ? VIEW_MODES : TOPIC_MODES;
}

/**
 * What the preview pane shows in a mode. A mode change that crosses these
 * boundaries needs a fresh render even though both sides use the preview pane.
 */
export type PreviewKind = 'topic' | 'site' | 'book';

export function previewKindFor(mode: ViewMode): PreviewKind {
  if (mode === 'site') return 'site';
  if (mode === 'book') return 'book';
  return 'topic';
}

export const MODE_LABELS: Readonly<Record<ViewMode, string>> = {
  reading: 'Reading view',
  source: 'Source mode',
  split: 'Live preview (side by side)',
  site: 'Site view',
  book: 'Book view',
};

/** Icon ids from Obsidian's bundled Lucide set. */
export const MODE_ICONS: Readonly<Record<ViewMode, string>> = {
  reading: 'book-open',
  source: 'code',
  split: 'separator-vertical',
  site: 'panel-left',
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
 * source; source, split, site and book all go back to reading.
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
