// Which files completion offers for an href/conref value, and how the folder
// tree is walked to find them.
//
// Its own module for the same reason mapTreeRefresh.ts exists: this walk used
// to live inside the completion provider, which imports vscode, so none of its
// rules were reachable from plain mocha -- and the rules are the whole
// behaviour. Depth limit, pruned directory names, which extensions count, the
// result cap: every one of them is a trade-off that looks identical in a
// screenshot and differs in whether completion stays usable in a large
// document set.
//
// The reader is injected rather than called here. That is what keeps the
// module loadable without the vscode API (the unit tests run without it) and
// what let the runtime version switch from readdirSync to
// workspace.fs.readDirectory without touching a single rule below.

import { join, normalize, relative } from 'path';

/** One directory entry, reduced to the two facts the walk needs. */
export interface WalkEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * Reads one directory. May be async -- the runtime implementation goes through
 * vscode.workspace.fs.readDirectory, and the traversal awaiting it is what
 * keeps typing an href from blocking the extension host.
 */
export type ReadDir = (dir: string) => Promise<WalkEntry[]> | WalkEntry[];

/**
 * Directory names never worth descending into. `out` is where DITA-OT writes
 * generated .dita/.xml, which are real files matching the extension rule but
 * are copies of sources the user would never mean to reference; `node_modules`
 * is here because a document set that lives next to a build tree otherwise
 * spends its whole result cap on it.
 *
 * Checked against the entry name at every level, not just the top one, and
 * against directories and files alike -- matching the walk this was extracted
 * from, which tested the name before it knew what the entry was.
 */
const PRUNED_ENTRY_NAMES = new Set(['node_modules', 'out']);

/**
 * Extensions completion offers. Case-insensitive on purpose: document sets do
 * contain `TOPIC.DITA`, and a glob-based search would match that only on the
 * case-insensitive file systems -- this project's CI runs the same code on
 * ubuntu, windows and macos.
 */
const REFERENCEABLE_EXT = /\.(dita|ditamap|xml)$/i;

/** How many directory levels below the document's own folder are searched. */
export const REFERENCEABLE_MAX_DEPTH = 3;

/**
 * Soft bound on the result list.
 *
 * Deliberately soft, and deliberately unchanged: the walk this replaces checked
 * the count once per directory rather than once per file, so a single directory
 * holding more matching files than the cap yields all of them (a measurement of
 * a 30 x 60 document set returned 240, not 200). Tightening that would change
 * which files completion offers, and this change is about not blocking the
 * extension host -- not about re-deciding the cap. Pinned by a test so the
 * behaviour is a choice on the record rather than an accident.
 */
export const REFERENCEABLE_MAX_RESULTS = 200;

export interface CollectOptions {
  maxDepth?: number;
  maxResults?: number;
  /**
   * Checked between directory reads. Completion requests are abandoned every
   * time the user types another character, and a traversal that keeps walking
   * after that is pure waste -- the answer is already unwanted.
   */
  isCancelled?: () => boolean;
}

/**
 * Lists referenceable files under `baseDir`, as href strings relative to it.
 *
 * Depth-first, in the order the reader yields entries -- both preserved from
 * the recursive version this replaces, because the soft result cap makes order
 * observable: whichever files are reached first are the ones offered when the
 * cap binds.
 */
export async function collectReferenceableFiles(
  baseDir: string,
  readDir: ReadDir,
  options: CollectOptions = {},
): Promise<string[]> {
  const maxDepth = options.maxDepth ?? REFERENCEABLE_MAX_DEPTH;
  const maxResults = options.maxResults ?? REFERENCEABLE_MAX_RESULTS;
  const isCancelled = options.isCancelled ?? ((): boolean => false);
  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || results.length >= maxResults || isCancelled()) return;
    let entries: WalkEntry[];
    try {
      entries = await readDir(dir);
    } catch (e) {
      // Unreadable, missing or just-deleted directory: skip this subtree and
      // keep the rest. Completion degrading to "fewer suggestions" beats
      // throwing into VS Code's completion pipeline, and the synchronous walk
      // this replaces swallowed readdirSync failures the same way.
      console.warn(`Failed to read directory ${dir}:`, e instanceof Error ? e.message : e);
      return;
    }
    for (const entry of entries) {
      if (isCancelled()) return;
      if (entry.name.startsWith('.') || PRUNED_ENTRY_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(full, depth + 1);
      } else if (REFERENCEABLE_EXT.test(entry.name)) {
        results.push(toRelativeHref(baseDir, full));
      }
      // No per-entry try/catch any more: the only thing that used to throw per
      // entry was the statSync that decided file-vs-directory, and the injected
      // reader now supplies that answer up front.
    }
  }

  await walk(baseDir, 0);
  return results;
}

/**
 * Turns an absolute path into the string completion inserts.
 *
 * Relative because href/conref values are resolved against the referencing
 * document's folder, and forward-slashed because they are XML attribute values
 * in a DITA document, not Windows paths -- a `\` in an href would be a literal
 * backslash to every consumer of that document.
 */
export function toRelativeHref(baseDir: string, fullPath: string): string {
  return normalize(relative(baseDir, fullPath)).replace(/\\/g, '/');
}
