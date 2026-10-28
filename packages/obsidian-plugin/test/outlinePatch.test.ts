import { strict as assert } from 'assert';
import { installOutlinePatch, refreshOutlines } from '../src/outlinePatch';
import type { OutlineSource } from '../src/outlinePatch';

// A stand-in for Obsidian's Outline view: the two methods the patch wraps.
// Each test gets its own class, as the patch changes the prototype.
function makeOutlineClass() {
  return class FakeOutline {
    file: { path: string } | null = null;
    leaf = {};
    updates = 0;
    getHeadings(): unknown[] {
      return this.file?.path.endsWith('.md') ? ['markdown heading'] : [];
    }
    findCorrespondingLeaf(): unknown {
      return 'markdown leaf';
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

const source: OutlineSource = {
  isDita: (file) => /\.dita(map)?$/.test(file.path),
  headings: (file) => [{ heading: file.path, level: 1, position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } } }],
  leafFor: () => 'dita leaf' as never,
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
