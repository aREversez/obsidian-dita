// The conditional-processing state, with a fake page instead of a rendered one:
// the controller asks the page for its profiled elements and nothing else, so
// the tests hand it elements that know which profiling values they carry.

import { strict as assert } from 'assert';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileSystemAdapter } from 'obsidian';
import type { App } from 'obsidian';
import { ProfileController } from '../src/profileController';
import type { ProfileControllerHost } from '../src/profileController';

/** The stub's adapter takes the vault root; the real one reads it from the vault. */
function adapterAt(root: string): FileSystemAdapter {
  return new (FileSystemAdapter as unknown as new (root: string) => FileSystemAdapter)(root);
}

/** One profiled element of the page, with the values its data-profile-keys names. */
class Profiled {
  out = false;

  constructor(
    readonly keys: string,
    readonly parent?: Profiled,
  ) {}

  getAttribute(name: string): string | null {
    return name === 'data-profile-keys' ? this.keys : null;
  }

  get classList() {
    const self = this;
    return {
      toggle(name: string, on: boolean): void {
        assert.equal(name, 'profile-filtered-out', 'the filter hides with one class');
        self.out = on;
      },
    };
  }

  get parentElement(): Profiled | undefined {
    return this.parent;
  }

  /** Asked only about the class the controller just put on a hidden element. */
  closest(selector: string): Profiled | undefined {
    assert.equal(selector, '.profile-filtered-out');
    let node: Profiled | undefined = this;
    while (node) {
      if (node.out) return node;
      node = node.parent;
    }
    return undefined;
  }
}

function page(elements: readonly Profiled[]) {
  const classes = new Map<string, boolean>();
  const body = {
    classList: {
      toggle(name: string, on: boolean): void {
        classes.set(name, on);
      },
    },
    querySelectorAll(selector: string) {
      assert.equal(selector, '[data-profile-keys]');
      return { forEach: (cb: (el: Profiled) => void) => elements.forEach(cb) };
    },
  };
  return { body: body as unknown as HTMLElement, classes };
}

function fakeAction() {
  const classes: Array<[string, boolean]> = [];
  const attributes = new Map<string, string>();
  const el = {
    toggleClass(name: string, on: boolean): void {
      classes.push([name, on]);
    },
    setAttribute(name: string, value: string): void {
      attributes.set(name, value);
    },
  };
  return {
    el: el as unknown as HTMLElement,
    active: () => classes.filter(([name]) => name === 'is-active').at(-1)?.[1] ?? false,
    label: () => attributes.get('aria-label'),
    hideClass: (name: string) => classes.filter(([cls]) => cls === name).at(-1)?.[1],
  };
}

function controller(options: { adapter: FileSystemAdapter; body?: HTMLElement }) {
  const action = fakeAction();
  const dependencies: string[] = [];
  const calls: string[] = [];
  const host: ProfileControllerHost = {
    app: { vault: { adapter: options.adapter } } as unknown as App,
    body: () => options.body,
    container: () => undefined,
    action: () => action.el,
    isIgnoredClick: () => false,
    isMapFile: () => false,
    mode: () => 'reading',
    addDependency: (path) => dependencies.push(`+${path}`),
    removeDependency: (path) => dependencies.push(`-${path}`),
    markStale: () => calls.push('markStale'),
    render: () => calls.push('render'),
    refreshFind: () => calls.push('refreshFind'),
    saveLayout: () => calls.push('saveLayout'),
  };
  return { controller: new ProfileController(host), action, dependencies, calls };
}

let root = '';
let adapter: FileSystemAdapter;
const docs = () => join(root, 'docs.ditaval');
const other = () => join(root, 'other.ditaval');

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dita-profile-'));
  writeFileSync(docs(), '<val>\n  <prop att="audience" val="internal" action="exclude"/>\n</val>\n', 'utf-8');
  writeFileSync(other(), '<val>\n  <prop att="platform" val="linux" action="exclude"/>\n</val>\n', 'utf-8');
  adapter = adapterAt(root);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ProfileController before the page exists', () => {
  it('keeps a saved state that arrives before the panel and the page', () => {
    const c = controller({ adapter });
    c.controller.restore({ ditaval: 'docs.ditaval', hidden: ['audience:internal'] });

    assert.equal(c.controller.state.ditaval, 'docs.ditaval');
    assert.deepEqual(c.controller.state.hidden, ['audience:internal']);
    assert.equal(c.controller.hasDitaval(), true);
    assert.equal(c.controller.isDefault, false);
    assert.ok(c.controller.filter()?.hidden?.has('audience:internal'));
    assert.equal(c.action.label(), undefined, 'the header waits for attach()');
  });

  it('reads the chosen .ditaval without a page to apply it to', () => {
    const c = controller({ adapter });
    c.controller.restore({ ditaval: 'docs.ditaval' });
    assert.deepEqual(c.controller.filter()?.ditaval?.rules, [{ att: 'audience', action: 'exclude', val: 'internal' }]);
    assert.equal(c.controller.dependency, docs());
  });
});

describe('ProfileController hidden count', () => {
  it('counts a hidden element once, not again inside a hidden block', () => {
    const outer = new Profiled('audience:internal');
    const inner = new Profiled('audience:internal', outer);
    const kept = new Profiled('platform:linux');
    const c = controller({ adapter, body: page([outer, inner, kept]).body });
    c.controller.restore({ hidden: ['audience:internal'] });

    assert.equal(outer.out, true);
    assert.equal(inner.out, true, 'the block is hidden with its children');
    assert.equal(kept.out, false);
    assert.equal(c.action.label(), 'Conditional processing · 1 hidden');
  });

  it('keeps an element that still carries a value in force', () => {
    const both = new Profiled('audience:internal,audience:public');
    const c = controller({ adapter, body: page([both]).body });
    c.controller.restore({ hidden: ['audience:internal'] });

    assert.equal(both.out, false, 'only one of its audience values is hidden');
    assert.equal(c.action.label(), 'Conditional processing', 'nothing was hidden');
  });

  it('hides the tinted boxes with the highlight switch', () => {
    const p = page([new Profiled('audience:internal')]);
    const c = controller({ adapter, body: p.body });

    c.controller.restore({ hidden: ['audience:internal'], highlight: false });
    assert.equal(p.classes.get('hide-profiling'), true);
    c.controller.restore({ hidden: ['audience:internal'], highlight: true });
    assert.equal(p.classes.get('hide-profiling'), false);
  });

  it('forgets the count when the page is gone', () => {
    const c = controller({ adapter, body: page([new Profiled('audience:internal')]).body });
    c.controller.restore({ ditaval: 'docs.ditaval' });
    assert.match(c.action.label() ?? '', / · 1 hidden$/);

    c.controller.reset();
    assert.equal(c.action.label(), 'Conditional processing · docs.ditaval');
    assert.equal(c.action.active(), true, 'the chosen file is still in force');
  });
});

describe('ProfileController header button', () => {
  it('stays dark while nothing is filtered', () => {
    const c = controller({ adapter, body: page([new Profiled('platform:linux')]).body });
    c.controller.restore({});

    assert.equal(c.action.active(), false);
    assert.equal(c.action.label(), 'Conditional processing');
  });

  it('names the file and the count of what it hid', () => {
    const c = controller({ adapter, body: page([new Profiled('audience:internal')]).body });
    c.controller.restore({ ditaval: 'docs.ditaval' });

    assert.equal(c.action.active(), true);
    assert.equal(c.action.label(), 'Conditional processing · docs.ditaval · 1 hidden');
  });

  it('says why a missing .ditaval is not in force', () => {
    const c = controller({ adapter, body: page([]).body });
    c.controller.restore({ ditaval: 'gone.ditaval' });

    assert.equal(c.action.active(), true, 'the failure is worth a lit button');
    assert.equal(c.action.label(), 'Conditional processing · gone.ditaval · The DITAVAL file does not exist.');
  });

  it('drops a saved path outside the vault instead of watching it', () => {
    const c = controller({ adapter, body: page([]).body });
    c.controller.restore({ ditaval: '../outside.ditaval' });

    assert.equal(c.controller.state.ditaval, undefined);
    assert.deepEqual(c.dependencies, []);
    assert.equal(c.action.label(), 'Conditional processing');
  });

  it('hides itself with the preview', () => {
    const c = controller({ adapter });
    c.controller.setVisible(false);
    assert.equal(c.action.hideClass('dita-hidden'), true);
    c.controller.setVisible(true);
    assert.equal(c.action.hideClass('dita-hidden'), false);
  });
});

describe('ProfileController dependencies', () => {
  it('watches the chosen file and swaps it when the choice changes', () => {
    const c = controller({ adapter });
    c.controller.restore({ ditaval: 'docs.ditaval' });
    assert.equal(c.controller.dependency, docs());

    c.controller.restore({ ditaval: 'other.ditaval' });
    assert.deepEqual(c.dependencies, [`+${docs()}`, `-${docs()}`, `+${other()}`], 'the old one goes before the new one comes');
    assert.equal(c.controller.dependency, other());

    c.controller.restore({});
    assert.deepEqual(c.dependencies, [`+${docs()}`, `-${docs()}`, `+${other()}`, `-${other()}`]);
    assert.equal(c.controller.dependency, undefined);
  });
});
