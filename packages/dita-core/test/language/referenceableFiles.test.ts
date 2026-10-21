import * as assert from 'assert';
import { join, sep } from 'path';
import {
  collectReferenceableFiles,
  toRelativeHref,
} from '../../src/language/referenceableFiles';
import type { ReadDir, WalkEntry } from '../../src/language/referenceableFiles';

/**
 * The folder walk behind href/conref completion.
 *
 * Tested through an injected reader rather than through vscode or through real
 * directories, because the rules are the point and none of them are observable
 * from a running editor: whether the walk stops at depth 3 or 4, whether it
 * prunes `out` only at the top or at every level, whether an abandoned request
 * stops reading directories or merely hides the results -- all of these look
 * like "completion shows some files" from the outside.
 *
 * The injected reader also means no fixture directories on disk, so the tests
 * can include shapes a real checkout should never contain (a 240-file folder,
 * an unreadable directory, an `out/` full of generated .dita).
 */
describe('collectReferenceableFiles', () => {
  /** Absolute root of the synthetic tree, built with the platform separator so
   *  it matches what the walk's own join() produces. */
  const ROOT = join(sep, 'docs');

  const f = (name: string): WalkEntry => ({ name, isDirectory: false });
  const d = (name: string): WalkEntry => ({ name, isDirectory: true });
  const at = (...parts: string[]): string => join(ROOT, ...parts);

  type Tree = Map<string, WalkEntry[]>;

  interface Harness {
    readDir: ReadDir;
    /** Every directory the walk actually asked for, in order. The point of
     *  recording this: "the deep file is not in the results" is a much weaker
     *  claim than "the walk never read that directory". */
    reads: string[];
  }

  function harnessFor(tree: Tree): Harness {
    const reads: string[] = [];
    return {
      reads,
      readDir: (dir: string): WalkEntry[] => {
        reads.push(dir);
        const entries = tree.get(dir);
        // Mirrors readdirSync/readDirectory on a path that is not a directory:
        // the walk must survive it, not propagate it into completion.
        if (!entries) throw new Error(`ENOENT: no such directory ${dir}`);
        return entries;
      },
    };
  }

  function tree(spec: Array<[string, WalkEntry[]]>): Tree {
    return new Map(spec);
  }

  /** Runs fn with console.warn captured, so "it warned once" becomes an
   *  assertion instead of noise in the test output. */
  async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(' '));
    };
    try {
      return { value: await fn(), warnings };
    } finally {
      console.warn = original;
    }
  }

  it('offers files in the document folder and three levels below, and never reads the fourth', async () => {
    const h = harnessFor(
      tree([
        [at(), [f('a.dita'), d('l1')]],
        [at('l1'), [f('b.dita'), d('l2')]],
        [at('l1', 'l2'), [f('c.dita'), d('l3')]],
        [at('l1', 'l2', 'l3'), [f('d.dita'), d('l4')]],
        [at('l1', 'l2', 'l3', 'l4'), [f('e.dita')]],
      ]),
    );

    const results = await collectReferenceableFiles(ROOT, h.readDir);

    assert.deepStrictEqual(results.sort(), [
      'a.dita',
      'l1/b.dita',
      'l1/l2/c.dita',
      'l1/l2/l3/d.dita',
    ]);
    // The depth limit has to stop the traversal, not filter its output: a walk
    // that read l4 and dropped e.dita would still have paid for the read, which
    // is the cost this whole change exists to remove.
    assert.ok(!h.reads.includes(at('l1', 'l2', 'l3', 'l4')), `read too deep: ${h.reads.join(', ')}`);
  });

  it('prunes dot-entries, node_modules and out at every level, not just the top', async () => {
    const h = harnessFor(
      tree([
        [at(), [d('.hidden'), f('.gitignore'), d('node_modules'), d('out'), d('keep')]],
        [at('.hidden'), [f('x.dita')]],
        [at('node_modules'), [f('pkg.dita')]],
        [at('out'), [f('generated.dita')]],
        // The same names nested, where a top-level-only check would miss them.
        // `out` is DITA-OT's generated output: real .dita files that are copies
        // of sources, so offering them means the user references a build
        // artifact that the next transform overwrites.
        [at('keep'), [f('ok.dita'), d('out'), d('node_modules'), d('.git')]],
        [at('keep', 'out'), [f('nested.dita')]],
        [at('keep', 'node_modules'), [f('deep.dita')]],
        [at('keep', '.git'), [f('deeper.dita')]],
      ]),
    );

    const results = await collectReferenceableFiles(ROOT, h.readDir);

    assert.deepStrictEqual(results, ['keep/ok.dita']);
    assert.deepStrictEqual(h.reads, [at(), at('keep')]);
  });

  it('matches the referenceable extensions case-insensitively and rejects near-misses', async () => {
    const h = harnessFor(
      tree([
        [
          at(),
          [
            // Case-insensitive on purpose: CI runs this on ubuntu, where a
            // glob-based search for *.dita would not match TOPIC.DITA.
            f('TOPIC.DITA'),
            f('Map.Ditamap'),
            f('data.XML'),
            // Near-misses that a looser pattern would let through.
            f('notes.ditaval'),
            f('custom.css'),
            f('topology.png'),
            f('README'),
            f('topic.dita.bak'),
          ],
        ],
      ]),
    );

    const results = await collectReferenceableFiles(ROOT, h.readDir);

    assert.deepStrictEqual(results, ['TOPIC.DITA', 'Map.Ditamap', 'data.XML']);
  });

  it('keeps depth-first order, which is what decides who survives the cap', async () => {
    const h = harnessFor(
      tree([
        [at(), [f('z.dita'), d('mid'), f('a.dita')]],
        [at('mid'), [f('m.dita')]],
      ]),
    );

    const results = await collectReferenceableFiles(ROOT, h.readDir);

    // Not sorted, and not breadth-first (which would give z, a, mid/m): the cap
    // makes order observable, so the order the walk this replaced produced is
    // part of the behaviour being preserved.
    assert.deepStrictEqual(results, ['z.dita', 'mid/m.dita', 'a.dita']);
  });

  it('treats the result cap as a bound on descent, not on the list length', async () => {
    const h = harnessFor(
      tree([
        [at(), [d('many'), d('later')]],
        // One directory holding more matches than the cap: all of them are
        // offered, exactly as the walk this replaces did (it checked the count
        // on entry to a directory, never per file). A measurement of a real
        // 30 x 60 document set returned 240 for a cap of 200.
        [at('many'), [f('m1.dita'), f('m2.dita'), f('m3.dita')]],
        [at('later'), [f('never.dita')]],
      ]),
    );

    const results = await collectReferenceableFiles(ROOT, h.readDir, { maxResults: 2 });

    assert.deepStrictEqual(results, ['many/m1.dita', 'many/m2.dita', 'many/m3.dita']);
    // ...but once the cap is reached the walk stops descending, so `later` is
    // never read at all.
    assert.ok(!h.reads.includes(at('later')), `read past the cap: ${h.reads.join(', ')}`);
  });

  it('honours maxDepth, including 0 for "this folder only"', async () => {
    const h = harnessFor(
      tree([
        [at(), [f('here.dita'), d('sub')]],
        [at('sub'), [f('below.dita')]],
      ]),
    );

    const results = await collectReferenceableFiles(ROOT, h.readDir, { maxDepth: 0 });

    assert.deepStrictEqual(results, ['here.dita']);
    assert.deepStrictEqual(h.reads, [at()]);
  });

  it('loses only the unreadable directory subtree, and warns once about it', async () => {
    // `gone` is announced as a directory but has no entry in the tree, so the
    // reader throws for it exactly as readdirSync throws for a folder that
    // vanished between listing its parent and reading it.
    const h = harnessFor(tree([[at(), [f('before.dita'), d('gone'), f('after.dita')]]]));

    const { value, warnings } = await captureWarnings(() => collectReferenceableFiles(ROOT, h.readDir));

    // The siblings on both sides survive: one unreadable folder in a document
    // set must not cost the user the whole completion list.
    assert.deepStrictEqual(value, ['before.dita', 'after.dita']);
    assert.strictEqual(warnings.length, 1, `expected exactly one warning, got: ${warnings.join(' | ')}`);
    assert.ok(warnings[0].includes('ENOENT'), `warning should carry the cause: ${warnings[0]}`);
  });

  it('returns nothing but still warns when the document folder itself cannot be read', async () => {
    const h = harnessFor(tree([]));

    const { value, warnings } = await captureWarnings(() => collectReferenceableFiles(ROOT, h.readDir));

    assert.deepStrictEqual(value, []);
    assert.strictEqual(warnings.length, 1);
  });

  it('awaits an async reader, which is the whole reason the walk is a promise', async () => {
    const h = harnessFor(
      tree([
        [at(), [f('a.dita'), d('sub')]],
        [at('sub'), [f('b.dita')]],
      ]),
    );
    // Resolve on a later tick: if the walk did not await, it would iterate a
    // Promise instead of entries and the results would be empty.
    const readDir: ReadDir = async (dir: string): Promise<WalkEntry[]> => {
      await new Promise((r) => setTimeout(r, 0));
      return h.readDir(dir) as WalkEntry[];
    };

    const results = await collectReferenceableFiles(ROOT, readDir);

    assert.deepStrictEqual(results.sort(), ['a.dita', 'sub/b.dita']);
  });

  it('stops between directories once the request is cancelled', async () => {
    const h = harnessFor(
      tree([
        [at(), [d('one'), d('two'), d('three')]],
        [at('one'), [f('1.dita')]],
        [at('two'), [f('2.dita')]],
        [at('three'), [f('3.dita')]],
      ]),
    );
    let cancelled = false;
    const readDir: ReadDir = (dir: string): WalkEntry[] => {
      const entries = h.readDir(dir) as WalkEntry[];
      // Cancel as if the user had typed the next character while the walk was
      // inside the second subdirectory. From the third read on, the walk must
      // stop -- and the check is per entry as well as per directory, so `two`'s
      // own file is dropped even though its directory was already read.
      if (h.reads.length === 3) cancelled = true;
      return entries;
    };

    const results = await collectReferenceableFiles(ROOT, readDir, { isCancelled: () => cancelled });

    assert.deepStrictEqual(results, ['one/1.dita']);
    // The claim worth making is that the remaining directory was never read. A
    // walk that finished the traversal and truncated the list would pass a
    // results-only assertion while still costing the full traversal -- which is
    // the cost this change exists to remove.
    assert.deepStrictEqual(h.reads, [at(), at('one'), at('two')]);
  });
});

describe('toRelativeHref', () => {
  const ROOT = join(sep, 'docs');

  it('emits forward slashes whatever the platform separator is', () => {
    const nested = join(ROOT, 'topics', 'sub', 'a.dita');

    assert.strictEqual(toRelativeHref(ROOT, nested), 'topics/sub/a.dita');
  });

  it('keeps a file in the base folder bare, with no ./ prefix', () => {
    assert.strictEqual(toRelativeHref(ROOT, join(ROOT, 'a.dita')), 'a.dita');
  });

  it('would express an outside-the-base file with .., which the walk never produces', () => {
    // Documenting the boundary rather than testing a reachable case: the walk
    // only ever descends from baseDir, so nothing it hands this function can be
    // above it. Worth stating because an href containing `..` escapes the
    // document folder, and completion inserting one would be a real bug -- the
    // e2e test asserts no offered label starts with `..`.
    assert.strictEqual(toRelativeHref(join(ROOT, 'topics'), join(ROOT, 'test.ditamap')), '../test.ditamap');
  });
});
