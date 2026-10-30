import { strict as assert } from 'assert';
import { installOutlinePatch, markActiveHeading, pickOutlineLeaf, refreshOutlines } from '../src/outlinePatch';
import type { OutlineSource } from '../src/outlinePatch';

// A stand-in for Obsidian's Outline view: the methods the patch wraps.
// Each test gets its own class, as the patch changes the prototype.
function makeOutlineClass() {
  return class FakeOutline {
    file: { path: string } | null = null;
    leaf = {};
    tree: unknown = undefined;
    highlighted: unknown = 'unset';
    updates = 0;
    getHeadings(): unknown[] {
      return this.file?.path.endsWith('.md') ? ['markdown heading'] : [];
    }
    findCorrespondingLeaf(): unknown {
      return 'markdown leaf';
    }
    findActiveHeading(_owner: unknown): unknown {
      return 'markdown row';
    }
    setHighlightedItem(row: unknown): void {
      this.highlighted = row;
    }
    requestUpdate(): void {
      this.updates++;
    }
  };
}
type FakeOutline = InstanceType<ReturnType<typeof makeOutlineClass>>;

type Handler = () => void;

function fakeApp(leaves: unknown[]) {
  const handlers = new Map<string, Handler[]>();
  const workspace = {
    getLeavesOfType: (type: string) => (type === 'outline' ? leaves : []),
    onLayoutReady: (fn: Handler) => fn(),
    on: (name: string, fn: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      return { name, fn };
    },
    offref: (ref: { name: string; fn: Handler }) => {
      handlers.set(ref.name, (handlers.get(ref.name) ?? []).filter((f) => f !== ref.fn));
    },
  };
  return { app: { workspace } as never, fire: (name: string) => (handlers.get(name) ?? []).forEach((f) => f()), handlers };
}

// The line the DITA view is at, which a test sets.
let currentLine: number | undefined;
beforeEach(() => {
  currentLine = undefined;
});

const source: OutlineSource = {
  isDita: (file) => /\.dita(map)?$/.test(file.path),
  headings: (file) => [{ heading: file.path, level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } }],
  leafFor: () => 'dita leaf' as never,
  activeLine: () => currentLine,
};

const file = (path: string) => ({ path }) as never;

describe('Outline patch', () => {
  it('lists DITA headings and leaves other files to Obsidian', () => {
    const view = new (makeOutlineClass())();
    installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source);
    view.file = { path: 'a.dita' };
    assert.equal((view.getHeadings() as Array<{ heading: string }>)[0].heading, 'a.dita');
    assert.equal(view.findCorrespondingLeaf(), 'dita leaf');
    view.file = { path: 'note.md' };
    assert.deepEqual(view.getHeadings(), ['markdown heading']);
    assert.equal(view.findCorrespondingLeaf(), 'markdown leaf');
  });

  it('redraws the Outline panes that are already open when it installs', () => {
    const view = new (makeOutlineClass())();
    installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source);
    assert.equal(view.updates, 1);
  });

  it('undoes itself', () => {
    const Outline = makeOutlineClass();
    const view = new Outline();
    const originalGetHeadings = Outline.prototype.getHeadings;
    const uninstall = installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source);
    uninstall();
    view.file = { path: 'a.dita' };
    assert.deepEqual(view.getHeadings(), []);
    assert.equal(view.findCorrespondingLeaf(), 'markdown leaf');
    assert.equal(Outline.prototype.getHeadings, originalGetHeadings);
  });

  it('leaves a wrapper another plugin put over it in place, and passes through it', () => {
    const Outline = makeOutlineClass();
    const view = new Outline();
    const uninstall = installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source);
    const ours = Outline.prototype.getHeadings;
    const theirs = function (this: FakeOutline) {
      return ours.call(this);
    };
    Outline.prototype.getHeadings = theirs;
    uninstall();
    assert.equal(Outline.prototype.getHeadings, theirs);
    view.file = { path: 'a.dita' };
    assert.deepEqual(view.getHeadings(), []);
  });

  it('waits for the Outline to exist, and stops listening once it has wrapped it', () => {
    const leaves: unknown[] = [];
    const { app, fire } = fakeApp(leaves);
    installOutlinePatch(app, source);
    const Outline = makeOutlineClass();
    const view = new Outline();
    leaves.push({ isDeferred: false, view });
    fire('layout-change');
    view.file = { path: 'a.dita' };
    assert.equal((view.getHeadings() as unknown[]).length, 1);
    // Wrapping twice would stack wrappers; a later layout change does nothing.
    const wrapped = Outline.prototype.getHeadings;
    fire('active-leaf-change');
    assert.equal(Outline.prototype.getHeadings, wrapped);
  });

  it('loads a deferred Outline pane before wrapping it', async () => {
    const view = new (makeOutlineClass())();
    const leaf = {
      isDeferred: true,
      view: {},
      loadIfDeferred: async () => {
        leaf.isDeferred = false;
        leaf.view = view;
      },
    };
    installOutlinePatch(fakeApp([leaf]).app, source);
    await new Promise((r) => setTimeout(r, 0));
    view.file = { path: 'a.dita' };
    assert.equal((view.getHeadings() as unknown[]).length, 1);
  });

  it('does nothing when the Outline view has a different shape', () => {
    class Different {
      file = { path: 'a.dita' };
    }
    const view = new Different();
    assert.doesNotThrow(() => installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source)());
    assert.equal((view as unknown as { getHeadings?: unknown }).getHeadings, undefined);
  });

  it('shows no headings, instead of throwing into the Outline, when the source fails', () => {
    const view = new (makeOutlineClass())();
    const original = console.error;
    console.error = () => undefined;
    try {
      installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, {
        ...source,
        headings: () => {
          throw new Error('boom');
        },
      });
      view.file = { path: 'a.dita' };
      assert.deepEqual(view.getHeadings(), []);
    } finally {
      console.error = original;
    }
  });
});

const heading = (name: string, start: number, end: number) => ({
  heading: name,
  level: 1,
  position: { start: { line: start, col: 0, offset: 0 }, end: { line: end, col: 0, offset: 0 } },
});
type RowSpec = { heading: unknown; kids?: RowSpec[] };
type Row = { heading: unknown; vChildren: { children: Row[] } };
const rowOf = (spec: RowSpec): Row => ({ heading: spec.heading, vChildren: { children: (spec.kids ?? []).map(rowOf) } });
const treeOf = (specs: RowSpec[]) => ({ root: { vChildren: { children: specs.map(rowOf) } } });

// A topic 0-20 with two sections, the second holding an example.
const outlineTree = () => {
  const tree = treeOf([
    {
      heading: heading('Topic', 0, 20),
      kids: [{ heading: heading('Plan', 2, 6) }, { heading: heading('Run', 8, 16), kids: [{ heading: heading('Sample', 10, 12) }] }],
    },
  ]);
  const [topic] = tree.root.vChildren.children;
  const [plan, run] = topic.vChildren.children;
  return { tree, topic, plan, run, sample: run.vChildren.children[0] };
};

describe('Outline patch: the current heading', () => {
  it('is the row of the innermost heading around the line the DITA view is at', () => {
    const view = new (makeOutlineClass())();
    installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source);
    const { tree, topic, plan, run, sample } = outlineTree();
    view.file = { path: 'a.dita' };
    view.tree = tree;
    const at = (line: number) => {
      currentLine = line;
      return view.findActiveHeading({});
    };
    assert.equal(at(4), plan);
    assert.equal(at(9), run);
    assert.equal(at(11), sample);
    assert.equal(at(14), run); // after the example ended
    assert.equal(at(18), topic); // after both sections ended
  });

  it('ignores the owner Obsidian passes, which is never a Markdown view for a DITA file', () => {
    const view = new (makeOutlineClass())();
    installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source);
    const { tree, plan } = outlineTree();
    view.file = { path: 'a.dita' };
    view.tree = tree;
    currentLine = 4;
    assert.equal(view.findActiveHeading(null), plan);
    assert.equal(view.findActiveHeading({ getMode: () => 'source' }), plan);
  });

  it('is null when no line stands for the view, or the line is above every heading', () => {
    const view = new (makeOutlineClass())();
    installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source);
    view.file = { path: 'a.dita' };
    view.tree = treeOf([{ heading: heading('Topic', 3, 20) }]);
    assert.equal(view.findActiveHeading(null), null);
    currentLine = 1;
    assert.equal(view.findActiveHeading(null), null);
  });

  it('leaves other files to Obsidian', () => {
    const view = new (makeOutlineClass())();
    installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source);
    view.file = { path: 'note.md' };
    currentLine = 4;
    assert.equal(view.findActiveHeading('owner'), 'markdown row');
  });

  it('survives a tree of another shape, and a source that fails', () => {
    const view = new (makeOutlineClass())();
    installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, {
      ...source,
      activeLine: () => {
        throw new Error('boom');
      },
    });
    view.file = { path: 'a.dita' };
    const original = console.error;
    console.error = () => undefined;
    try {
      assert.equal(view.findActiveHeading(null), null);
    } finally {
      console.error = original;
    }
    const other = new (makeOutlineClass())();
    installOutlinePatch(fakeApp([{ isDeferred: false, view: other }]).app, source);
    other.file = { path: 'a.dita' };
    currentLine = 4;
    for (const tree of [undefined, {}, { root: {} }, { root: { vChildren: { children: [{ heading: 'text' }] } } }]) {
      other.tree = tree;
      assert.equal(other.findActiveHeading(null), null);
    }
  });

  it('is wrapped only where the Outline has it, and the rest still works', () => {
    class NoActive {
      file: { path: string } | null = { path: 'a.dita' };
      leaf = {};
      getHeadings(): unknown[] {
        return [];
      }
      findCorrespondingLeaf(): unknown {
        return null;
      }
    }
    const view = new NoActive();
    installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source);
    assert.equal(view.getHeadings().length, 1);
    assert.equal((view as unknown as { findActiveHeading?: unknown }).findActiveHeading, undefined);
  });

  it('is undone with the rest, unless another plugin wrapped it since', () => {
    const Outline = makeOutlineClass();
    const original = Outline.prototype.findActiveHeading;
    const view = new Outline();
    installOutlinePatch(fakeApp([{ isDeferred: false, view }]).app, source)();
    assert.equal(Outline.prototype.findActiveHeading, original);

    const Other = makeOutlineClass();
    const uninstall = installOutlinePatch(fakeApp([{ isDeferred: false, view: new Other() }]).app, source);
    const theirs = function () {
      return 'theirs';
    };
    Other.prototype.findActiveHeading = theirs;
    uninstall();
    assert.equal(Other.prototype.findActiveHeading, theirs);
  });
});

describe('markActiveHeading', () => {
  it('marks the current row in the panes showing that file, and only those', () => {
    const a = new (makeOutlineClass())();
    const b = new (makeOutlineClass())();
    const f = file('a.dita');
    const { app } = fakeApp([{ isDeferred: false, view: a }, { isDeferred: false, view: b }, { isDeferred: true, view: {} }]);
    installOutlinePatch(app, source);
    const { tree, plan } = outlineTree();
    a.file = f as never;
    a.tree = tree;
    b.file = file('b.dita') as never;
    currentLine = 4;
    markActiveHeading(app, f);
    assert.equal(a.highlighted, plan);
    assert.equal(b.highlighted, 'unset');
    currentLine = undefined;
    markActiveHeading(app, f);
    assert.equal(a.highlighted, null);
  });

  it('does nothing to an Outline that cannot mark a row, and does not throw into the caller', () => {
    class Bare {
      file = file('a.dita');
      leaf = {};
      getHeadings(): unknown[] {
        return [];
      }
      findCorrespondingLeaf(): unknown {
        return null;
      }
    }
    const bare = new Bare();
    const throwing = new (makeOutlineClass())();
    throwing.file = bare.file as never;
    throwing.setHighlightedItem = () => {
      throw new Error('boom');
    };
    const { app } = fakeApp([{ isDeferred: false, view: bare }, { isDeferred: false, view: throwing }]);
    assert.doesNotThrow(() => markActiveHeading(app, bare.file as never));
  });
});

describe('refreshOutlines', () => {
  it('asks only the panes showing that file to redraw', () => {
    const a = new (makeOutlineClass())();
    const b = new (makeOutlineClass())();
    const f = file('a.dita');
    a.file = f as never;
    b.file = file('b.dita') as never;
    const { app } = fakeApp([{ isDeferred: false, view: a }, { isDeferred: false, view: b }, { isDeferred: true, view: {} }]);
    refreshOutlines(app, f);
    assert.equal(a.updates, 1);
    assert.equal(b.updates, 0);
    refreshOutlines(app, null);
    assert.equal(a.updates, 2);
    assert.equal(b.updates, 1);
  });
});

describe('pickOutlineLeaf', () => {
  type Leaf = { name: string; group?: string };
  const a: Leaf = { name: 'a', group: 'g1' };
  const b: Leaf = { name: 'b' };
  const c: Leaf = { name: 'c', group: 'g2' };
  const groupOf = (l: Leaf) => l.group;

  it('takes the most recent pane for an Outline that is not linked, as in the usual sidebar layout', () => {
    assert.equal(pickOutlineLeaf([a, b, c], undefined, groupOf, c), c);
    assert.equal(pickOutlineLeaf([a, b, c], null, groupOf, b), b);
  });

  it('falls back to the first pane showing the file when the most recent one does not', () => {
    assert.equal(pickOutlineLeaf([a, b], undefined, groupOf, c), a);
    assert.equal(pickOutlineLeaf([a, b], undefined, groupOf, null), a);
  });

  it('looks only in its own group for a linked Outline, like the original', () => {
    assert.equal(pickOutlineLeaf([a, b, c], 'g2', groupOf, a), c);
    assert.equal(pickOutlineLeaf([a, b], 'g2', groupOf, a), null);
  });

  it('finds nothing when no pane shows the file', () => {
    assert.equal(pickOutlineLeaf([], undefined, groupOf, a), null);
    assert.equal(pickOutlineLeaf([], 'g1', groupOf, a), null);
  });
});
