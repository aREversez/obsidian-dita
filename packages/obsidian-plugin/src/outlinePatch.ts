// Lets the core Outline pane list the headings of .dita and .ditamap files.
//
// There is no public hook for this. The Outline view builds its list from
// `metadataCache.getFileCache(file).headings`, which Obsidian fills for
// Markdown only, and it returns an empty list for any file whose extension is
// not "md" before it even looks. So the one way in is to wrap two methods on
// the Outline view's prototype:
//
//   getHeadings()           what to list for `this.file`
//   findCorrespondingLeaf() which pane a click on a row should scroll
//
// Both wrappers pass every other file straight to the original. The wrapping
// is guarded: if a future Obsidian renames or drops either method nothing is
// wrapped and the Outline simply shows "No headings found" for DITA files, as
// it did before. Nothing here may throw into the Outline.

import type { App, TFile, WorkspaceLeaf } from 'obsidian';
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
  requestUpdate?: () => void;
}

/** What the plugin supplies: which files are DITA, their headings, and where they are shown. */
export interface OutlineSource {
  isDita(file: TFile): boolean;
  headings(file: TFile): OutlineHeading[];
  /** The pane showing `file` in the DITA view that a row of `outline` should scroll. */
  leafFor(outline: OutlineViewLike, file: TFile): WorkspaceLeaf | null;
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
    proto.getHeadings = ownGetHeadings;
    proto.findCorrespondingLeaf = ownFindLeaf;
    restore = () => {
      // Another plugin may have wrapped ours since; leave its wrapper alone
      // (ours then passes through, as `active` is false).
      if (proto.getHeadings === ownGetHeadings) proto.getHeadings = getHeadings;
      if (proto.findCorrespondingLeaf === ownFindLeaf) proto.findCorrespondingLeaf = findLeaf;
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
