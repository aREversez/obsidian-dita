// Lets the core Outline pane list the headings of .dita and .ditamap files.
//
// There is no public hook for this. The Outline view builds its list from
// `metadataCache.getFileCache(file).headings`, which Obsidian fills for
// Markdown only, and it returns an empty list for any file whose extension is
// not "md" before it even looks. So the one way in is to wrap methods on the
// Outline view's prototype:
//
//   getHeadings()           what to list for `this.file`
//   findCorrespondingLeaf() which pane a click on a row should scroll
//   findActiveHeading()     which row is the current one (optional, see below)
//
// The wrappers pass every other file straight to the original. The wrapping
// is guarded: if a future Obsidian renames or drops either of the first two
// nothing is wrapped and the Outline simply shows "No headings found" for DITA
// files, as it did before. Without the third the list works and no row is
// marked as current. Nothing here may throw into the Outline.
//
// The Outline marks the current row when it redraws and when a Markdown view
// reports a caret or scroll move. A DITA view reports neither, so it calls
// markActiveHeading() itself when it moves.

import type { App, TFile, WorkspaceLeaf } from 'obsidian';
import { activeHeadingIndex } from './outlineHeadings';
import type { OutlineHeading } from './outlineHeadings';

export const OUTLINE_VIEW_TYPE = 'outline';

/** The parts of the Outline view this module relies on (Obsidian does not type them). */
export interface OutlineViewLike {
  file: TFile | null;
  leaf: WorkspaceLeaf;
  // Properties, not methods: they are read off the prototype and put back, so
  // they must not look like methods that lose their `this` when detached.
  getHeadings: (this: OutlineViewLike) => unknown[];
  findCorrespondingLeaf: (this: OutlineViewLike) => WorkspaceLeaf | null;
  /** The row of the current heading for an owner view (a Markdown view, for Obsidian), or null. */
  findActiveHeading?: (this: OutlineViewLike, owner: unknown) => unknown;
  /** Mark a row (what findActiveHeading returns) as the current one; null clears it. */
  setHighlightedItem?: (this: OutlineViewLike, row: unknown) => void;
  /** The rows: `root.vChildren.children`, each row again holding its sub-rows the same way. */
  tree?: { root?: unknown };
  requestUpdate?: () => void;
}

/** What the plugin supplies: which files are DITA, their headings, and where they are shown. */
export interface OutlineSource {
  isDita(file: TFile): boolean;
  headings(file: TFile): OutlineHeading[];
  /** The pane showing `file` in the DITA view that a row of `outline` should scroll. */
  leafFor(outline: OutlineViewLike, file: TFile): WorkspaceLeaf | null;
  /**
   * The line (zero-based) of `file` that the DITA view `outline` follows is at:
   * the caret's, or the top of the preview. Undefined when no line stands for
   * the view (no pane, or a pane showing something other than this file's text).
   */
  activeLine(outline: OutlineViewLike, file: TFile): number | undefined;
}

/** A row of the Outline's tree, as far as this module reads one. */
interface OutlineRow {
  heading?: unknown;
  vChildren?: { children?: unknown };
}

/** The rows of the tree, depth first, so in the order of the headings they were built from. */
function outlineRows(tree: OutlineViewLike['tree']): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (parent: unknown): void => {
    const children = (parent as OutlineRow | undefined)?.vChildren?.children;
    if (!Array.isArray(children)) return;
    for (const child of children as OutlineRow[]) {
      rows.push(child);
      walk(child);
    }
  };
  walk(tree?.root);
  return rows;
}

function hasPosition(heading: unknown): heading is OutlineHeading {
  const line = (heading as Partial<OutlineHeading> | undefined)?.position?.start?.line;
  return typeof line === 'number' && typeof (heading as OutlineHeading).position.end?.line === 'number';
}

/**
 * The row that owns `line`, or null. The rows are read for their headings
 * (those this plugin handed the Outline), so what is marked is what is listed,
 * even for the moment between an edit and the redraw it causes.
 */
export function rowAtLine(tree: OutlineViewLike['tree'], line: number | undefined): unknown {
  if (line === undefined) return null;
  const rows = outlineRows(tree).filter((row) => hasPosition(row.heading));
  const at = activeHeadingIndex(rows.map((row) => row.heading as OutlineHeading), line);
  return at < 0 ? null : rows[at];
}

/**
 * Which pane a click on an Outline row scrolls, with the original's rules: an
 * Outline linked to a group of panes ("Open linked outline") looks only in
 * that group; an ordinary one, which has no group, follows the active file
 * view. `recent` stands in for the latter. Nothing found is null, and the
 * Outline then opens the file in a pane of its own.
 */
export function pickOutlineLeaf<T>(
  showing: readonly T[],
  group: string | null | undefined,
  groupOf: (leaf: T) => string | null | undefined,
  recent: T | null,
): T | null {
  if (group) return showing.find((leaf) => groupOf(leaf) === group) ?? null;
  return showing.find((leaf) => leaf === recent) ?? showing[0] ?? null;
}

/**
 * `isDeferred` and `loadIfDeferred` exist from Obsidian 1.7.2. Before that no
 * pane is ever deferred, so reading them off an untyped view is right for
 * every version this plugin supports.
 */
interface MaybeDeferredLeaf {
  isDeferred?: boolean;
  loadIfDeferred?: () => Promise<void>;
}

function deferral(leaf: WorkspaceLeaf): MaybeDeferredLeaf {
  return leaf;
}

function isPatchable(proto: unknown): proto is OutlineViewLike {
  const p = proto as Partial<OutlineViewLike> | null;
  return !!p && typeof p.getHeadings === 'function' && typeof p.findCorrespondingLeaf === 'function';
}

/** The Outline views that are loaded (a deferred leaf has no view to wrap or refresh yet). */
function loadedOutlines(app: App): OutlineViewLike[] {
  return app.workspace
    .getLeavesOfType(OUTLINE_VIEW_TYPE)
    .filter((leaf) => !deferral(leaf).isDeferred)
    .map((leaf) => leaf.view as unknown as OutlineViewLike);
}

/** Ask the Outline panes showing `file` (any file when null) to redraw from the current headings. */
export function refreshOutlines(app: App, file: TFile | null): void {
  for (const view of loadedOutlines(app)) {
    if (file && view.file !== file) continue;
    try {
      view.requestUpdate?.();
    } catch {
      // The Outline is not ours; a failed redraw there must not reach the caller.
    }
  }
}

/**
 * Ask the Outline panes showing `file` to mark the row of the heading its DITA
 * view is at now. Called when that view's caret or scroll moves.
 */
export function markActiveHeading(app: App, file: TFile): void {
  for (const view of loadedOutlines(app)) {
    if (view.file !== file) continue;
    if (typeof view.findActiveHeading !== 'function' || typeof view.setHighlightedItem !== 'function') continue;
    try {
      view.setHighlightedItem(view.findActiveHeading(null));
    } catch {
      // The Outline is not ours; a failed mark there must not reach the caller.
    }
  }
}

/**
 * Wrap the Outline view's methods as soon as one exists, and again on each
 * layout change until that has happened. Returns the function that undoes it.
 */
export function installOutlinePatch(app: App, source: OutlineSource): () => void {
  let active = true;
  let patched = false;
  let restore: (() => void) | undefined;
  const loading = new WeakSet<WorkspaceLeaf>();

  const wrap = (proto: OutlineViewLike): void => {
    const getHeadings = proto.getHeadings;
    const findLeaf = proto.findCorrespondingLeaf;
    const findActive = proto.findActiveHeading;
    const ownGetHeadings = function (this: OutlineViewLike): unknown[] {
      try {
        if (active && this.file && source.isDita(this.file)) return source.headings(this.file);
      } catch (e) {
        console.error('DITA Viewer: could not list headings for the Outline', e);
        return [];
      }
      return getHeadings.call(this);
    };
    const ownFindLeaf = function (this: OutlineViewLike): WorkspaceLeaf | null {
      try {
        if (active && this.file && source.isDita(this.file)) return source.leafFor(this, this.file);
      } catch (e) {
        console.error('DITA Viewer: could not find the pane for the Outline', e);
        return null;
      }
      return findLeaf.call(this);
    };
    // Obsidian calls this with the Markdown view that owns the file, which a
    // DITA file never has, so for one the owner is ignored and the row comes
    // from the line the DITA view is at.
    const ownFindActive =
      typeof findActive === 'function'
        ? function (this: OutlineViewLike, owner: unknown): unknown {
            try {
              if (active && this.file && source.isDita(this.file)) {
                return rowAtLine(this.tree, source.activeLine(this, this.file));
              }
            } catch (e) {
              console.error('DITA Viewer: could not find the current heading for the Outline', e);
              return null;
            }
            return findActive.call(this, owner);
          }
        : undefined;
    proto.getHeadings = ownGetHeadings;
    proto.findCorrespondingLeaf = ownFindLeaf;
    if (ownFindActive) proto.findActiveHeading = ownFindActive;
    restore = () => {
      // Another plugin may have wrapped ours since; leave its wrapper alone
      // (ours then passes through, as `active` is false).
      if (proto.getHeadings === ownGetHeadings) proto.getHeadings = getHeadings;
      if (proto.findCorrespondingLeaf === ownFindLeaf) proto.findCorrespondingLeaf = findLeaf;
      if (ownFindActive && proto.findActiveHeading === ownFindActive) proto.findActiveHeading = findActive;
    };
  };

  const attempt = (): void => {
    if (!active || patched) return;
    for (const leaf of app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)) {
      // Side panes restored from the last session load only when first shown.
      if (deferral(leaf).isDeferred) {
        // Once per leaf: if loading it did not take, asking again would loop.
        if (!loading.has(leaf)) {
          loading.add(leaf);
          void deferral(leaf).loadIfDeferred?.().then(attempt, () => undefined);
        }
        continue;
      }
      const proto: unknown = Object.getPrototypeOf(leaf.view);
      if (!isPatchable(proto)) {
        console.warn('DITA Viewer: the Outline view has changed shape; DITA headings stay off the Outline.');
        patched = true; // do not look again and log again
        return;
      }
      wrap(proto);
      patched = true;
      // A DITA file may already be open in the Outline.
      refreshOutlines(app, null);
      return;
    }
  };

  app.workspace.onLayoutReady(attempt);
  const layoutRef = app.workspace.on('layout-change', attempt);
  const leafRef = app.workspace.on('active-leaf-change', attempt);

  return () => {
    active = false;
    app.workspace.offref(layoutRef);
    app.workspace.offref(leafRef);
    restore?.();
    refreshOutlines(app, null);
  };
}
