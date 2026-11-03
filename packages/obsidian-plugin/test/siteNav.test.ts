// The site view's state: which page the reader asked for, which one is on
// screen, stepping through the manifest and the two header buttons. The sidebar
// tree and the preview are reachable through the host only, so the tests lend
// them recording stand-ins.

import { strict as assert } from 'assert';
import type { SiteNavEntry } from '@dita-viewer/core';
import type { App, HoverParent, TFile } from 'obsidian';
import type { RenderSiteResult } from '../src/renderFile';
import { SiteNav } from '../src/siteNav';
import type { SiteNavHost } from '../src/siteNav';
import type { ViewMode } from '../src/viewMode';

const ROOT = '/vault';

/** The sidebar: every method returns it, and the few values read back are its own. */
function sidebar(): HTMLElement {
  const el: Record<string, unknown> = { dataset: {}, scrollTop: 0, isConnected: true };
  const self: HTMLElement = new Proxy(el, {
    get: (target, name) => (name in target ? target[name as string] : () => self),
    set: (target, name, value) => {
      target[name as string] = value;
      return true;
    },
  }) as unknown as HTMLElement;
  return self;
}

/** A header button that remembers what was asked of it. */
function action() {
  const classes = new Map<string, boolean>();
  const attributes = new Map<string, string>();
  const el = {
    toggleClass(name: string, on: boolean): void {
      classes.set(name, on);
    },
    setAttribute(name: string, value: string): void {
      attributes.set(name, value);
    },
  };
  return {
    el: el as unknown as HTMLElement,
    disabled: () => classes.get('is-disabled'),
    hidden: () => classes.get('dita-hidden'),
    label: () => attributes.get('aria-label'),
  };
}

function scene(options: { mode?: ViewMode; anchor?: (id: string) => unknown } = {}) {
  const prev = action();
  const next = action();
  const scrolled: number[] = [];
  const renders: string[] = [];
  const frames: FrameRequestCallback[] = [];
  let mode: ViewMode = options.mode ?? 'site';
  const host: SiteNavHost = {
    app: { workspace: { trigger: () => {} } } as unknown as App,
    hoverParent: {} as HoverParent,
    el: sidebar(),
    prevAction: prev.el,
    nextAction: next.el,
    file: () => ({ path: 'book.ditamap', basename: 'book' }) as unknown as TFile,
    mode: () => mode,
    vaultRoot: () => ROOT,
    shadow: () => ({ getElementById: (id: string) => options.anchor?.(id) }) as unknown as ShadowRoot,
    markStale: () => {},
    render: () => renders.push('render'),
    setPreviewScroll: (top) => scrolled.push(top),
    nextFrame: (cb) => frames.push(cb),
    openSource: () => {},
  };
  return {
    nav: new SiteNav(host),
    prev,
    next,
    scrolled,
    renders,
    setMode: (m: ViewMode) => {
      mode = m;
    },
    flush: () => frames.splice(0).forEach((cb) => cb(0)),
  };
}

const PAGES = [
  { path: `${ROOT}/topics/a.dita`, title: 'Alpha' },
  { path: `${ROOT}/topics/b.dita`, title: 'Beta' },
  { path: `${ROOT}/topics/c.dita`, title: 'Gamma' },
];

/** What one site render hands back, with a group heading in front of the topics. */
function result(current?: string): RenderSiteResult {
  const entries: SiteNavEntry[] = [
    { title: 'Part one', depth: 0, isGroup: true },
    ...PAGES.map((page) => ({ absPath: page.path, title: page.title, depth: 1 })),
  ];
  return { html: '', dependencies: new Set(), title: 'Book', entries, current };
}

describe('SiteNav pages', () => {
  it('takes the manifest: which entries have a page, and which page is current', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');

    assert.equal(s.nav.mapPath, 'book.ditamap');
    assert.equal(s.nav.current, PAGES[0].path);
    assert.equal(s.nav.hasPage(PAGES[1].path), true);
    assert.equal(s.nav.hasPage(`${ROOT}/topics/gone.dita`), false, 'a group heading has no page');
  });

  it('asks for a page before the first render, as a saved state does', () => {
    const s = scene();
    s.nav.restore(PAGES[2].path);
    assert.equal(s.nav.current, PAGES[2].path);
    assert.equal(s.nav.shown, undefined, 'nothing is on screen yet');

    s.nav.applyResult(result(PAGES[2].path), 'book.ditamap');
    assert.equal(s.nav.shown, PAGES[2].path);
  });

  it('shows the page the render settled on, which is the first when the asked-for one is gone', () => {
    const s = scene();
    s.nav.restore(`${ROOT}/topics/gone.dita`);
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');
    assert.equal(s.nav.current, PAGES[0].path);
    assert.equal(s.nav.shown, PAGES[0].path);
  });

  it('forgets a restored page with the rest of the map state', () => {
    const s = scene();
    s.nav.restore(PAGES[1].path);
    s.nav.reset();
    assert.equal(s.nav.current, undefined);
  });

  it('opens a page: it starts at the top and asks for a render', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');
    s.nav.openPage(PAGES[1].path);

    assert.equal(s.nav.current, PAGES[1].path);
    assert.deepEqual(s.scrolled, [0]);
    assert.equal(s.renders.length, 1);
  });

  it('a click on the page already shown only scrolls, to the anchor or the top', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');
    s.nav.openPage(PAGES[0].path);
    assert.deepEqual(s.scrolled, [0]);
    assert.equal(s.renders.length, 0);
  });

  it('scrolls to the anchor once the new page is in the DOM', () => {
    const seen: string[] = [];
    const s = scene({
      anchor: (id) => {
        seen.push(id);
        return {
          scrollIntoView: () => seen.push(`scroll:${id}`),
        };
      },
    });
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');
    s.nav.openPage(PAGES[1].path, 'section%201');

    s.nav.applyPendingAnchor();
    s.flush();
    assert.deepEqual(seen, ['section 1', 'scroll:section 1']);
  });

  it('a page that failed to render forgets the anchor it asked for', () => {
    const seen: string[] = [];
    const s = scene({ anchor: (id) => ({ scrollIntoView: () => seen.push(id) }) });
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');
    s.nav.openPage(PAGES[1].path, 'section-1');
    s.nav.clearPendingAnchor();

    s.nav.applyPendingAnchor();
    s.flush();
    assert.deepEqual(seen, []);
  });

  it('does nothing away from the site view', () => {
    const s = scene({ mode: 'reading' });
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');
    s.nav.openPage(PAGES[1].path);

    assert.equal(s.nav.current, PAGES[0].path);
    assert.deepEqual(s.scrolled, []);
    assert.equal(s.renders.length, 0);
  });

  it('steps through the manifest and stops at both ends', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');

    s.nav.step(1);
    assert.equal(s.nav.current, PAGES[1].path);
    s.nav.step(1);
    assert.equal(s.nav.current, PAGES[2].path);
    s.nav.step(1);
    assert.equal(s.nav.current, PAGES[2].path, 'no page past the last');
    s.nav.step(-1);
    assert.equal(s.nav.current, PAGES[1].path);
  });

  it('a failed render leaves the state on the page still on screen', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');
    s.nav.openPage(PAGES[2].path);

    s.nav.revertToShown();
    assert.equal(s.nav.current, PAGES[0].path);
    assert.equal(s.next.label(), 'Next topic: Beta');
  });

  it('reverting when nothing moved changes nothing', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[1].path), 'book.ditamap');
    s.nav.revertToShown();

    assert.equal(s.nav.current, PAGES[1].path);
  });

  it('reset forgets the map, its pages and its titles', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[1].path), 'book.ditamap');
    s.nav.titleCache.set(PAGES[0].path, { stamp: '1', title: 'Alpha' });

    s.nav.reset();
    assert.equal(s.nav.current, undefined);
    assert.equal(s.nav.mapPath, undefined);
    assert.equal(s.nav.hasPage(PAGES[0].path), false);
    assert.equal(s.nav.titleCache.size, 0);
    assert.equal(s.prev.disabled(), true, 'no page to step back to');
    assert.equal(s.next.disabled(), true);
  });
});

describe('SiteNav header buttons', () => {
  it('on the first page: no previous, and the next one by name', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[0].path), 'book.ditamap');

    assert.equal(s.prev.disabled(), true);
    assert.equal(s.prev.label(), 'Previous topic');
    assert.equal(s.next.disabled(), false);
    assert.equal(s.next.label(), 'Next topic: Beta');
  });

  it('in the middle: both neighbours by name', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[1].path), 'book.ditamap');

    assert.equal(s.prev.label(), 'Previous topic: Alpha');
    assert.equal(s.next.label(), 'Next topic: Gamma');
  });

  it('on the last page: no next', () => {
    const s = scene();
    s.nav.applyResult(result(PAGES[2].path), 'book.ditamap');

    assert.equal(s.prev.disabled(), false);
    assert.equal(s.next.disabled(), true);
    assert.equal(s.next.label(), 'Next topic');
  });

  it('outside the site view both are hidden', () => {
    const s = scene({ mode: 'reading' });
    s.nav.applyResult(result(PAGES[1].path), 'book.ditamap');

    assert.equal(s.prev.hidden(), true);
    assert.equal(s.next.hidden(), true);
  });
});
