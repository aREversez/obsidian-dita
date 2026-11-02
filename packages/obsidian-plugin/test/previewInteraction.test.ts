// What a click on a link in the rendered page does in the site view: a link to
// another page of the map turns the page, anything else opens the file as it
// always did. The page and the editor are reachable through the host only, so
// the tests lend recording stand-ins.

import { strict as assert } from 'assert';
import { join, resolve } from 'path';
import { Keymap, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { PreviewInteraction } from '../src/previewInteraction';
import type { PreviewInteractionHost } from '../src/previewInteraction';
import type { SiteNav } from '../src/siteNav';
import type { SourceNavigation } from '../src/sourceNavigation';
import type { ViewMode } from '../src/viewMode';

const ROOT = join('/', 'vault');
const MAP = 'maps/book.ditamap';
const page = (rel: string) => resolve(ROOT, rel);

/** A link in the page, as the click handler reads it. */
function link(attributes: Record<string, string>) {
  return { getAttribute: (name: string) => attributes[name] ?? null, closest: () => null };
}

function scene(options: { mode?: ViewMode; pages?: string[]; current?: string } = {}) {
  const opened: Array<{ path: string; newLeaf: boolean }> = [];
  const turned: Array<{ page: string; anchor?: string }> = [];
  const scrolled: number[] = [];
  const pages = new Set((options.pages ?? []).map(page));
  const vault = new Map<string, TFile>();
  const known = (path: string) => {
    const file = new TFile();
    file.path = path;
    vault.set(path, file);
  };
  known('topics/a.dita');
  known('topics/b.dita');
  const site = {
    current: options.current === undefined ? undefined : page(options.current),
    hasPage: (absPath: string) => pages.has(absPath),
    openPage: (absPath: string, anchor?: string) => turned.push({ page: absPath, anchor }),
    scrollToAnchor: () => {},
  };
  const host: PreviewInteractionHost = {
    app: {
      vault: { getAbstractFileByPath: (path: string) => vault.get(path) ?? null },
      workspace: {
        getLeaf: (newLeaf: boolean) => ({ openFile: async (file: TFile) => void opened.push({ path: file.path, newLeaf }) }),
      },
    } as unknown as App,
    file: () => ({ path: MAP }) as unknown as TFile,
    mode: () => options.mode ?? 'site',
    vaultRoot: () => ROOT,
    body: () => undefined,
    shadow: () => undefined,
    host: () => undefined,
    container: () => undefined,
    scroller: () => undefined,
    editor: () => undefined,
    site: () => site as unknown as SiteNav,
    nav: () => ({ conrefBadge: () => undefined, openSource: () => {} }) as unknown as SourceNavigation,
    setPreviewScroll: (top) => scrolled.push(top),
    quietSync: () => {},
    goBack: () => {},
    backMode: () => undefined,
  };
  const interaction = new PreviewInteraction(host);
  /** Click a related link (an `a` whose real target is in data-dita-href). */
  const click = (href: string): { prevented: boolean } => {
    const result = { prevented: false };
    const target = link({ 'data-dita-href': href });
    interaction.onClick({
      target: { closest: (selector: string) => (selector === 'a[data-dita-href]' ? target : null) },
      preventDefault: () => {
        result.prevented = true;
      },
    } as unknown as MouseEvent);
    return result;
  };
  return { click, opened, turned, scrolled };
}

describe('a link in the site view', () => {
  it('to another page of the map turns the page', () => {
    const s = scene({ pages: ['topics/a.dita', 'topics/b.dita'], current: 'topics/a.dita' });
    assert.ok(s.click('../topics/b.dita').prevented);
    assert.deepEqual(s.turned, [{ page: page('topics/b.dita'), anchor: undefined }]);
    assert.deepEqual(s.opened, []);
  });

  it('to an element of another page turns the page and asks for the element', () => {
    const s = scene({ pages: ['topics/a.dita', 'topics/b.dita'], current: 'topics/a.dita' });
    s.click('../topics/b.dita#step%201');
    assert.deepEqual(s.turned, [{ page: page('topics/b.dita'), anchor: 'step 1' }]);
  });

  it('to the page on screen stays on it', () => {
    const s = scene({ pages: ['topics/a.dita'], current: 'topics/a.dita' });
    s.click('../topics/a.dita');
    assert.deepEqual(s.turned, []);
    assert.deepEqual(s.scrolled, [0]);
    assert.deepEqual(s.opened, []);
  });

  it('to a file the map does not show opens it as before', () => {
    const s = scene({ pages: ['topics/a.dita'], current: 'topics/a.dita' });
    s.click('../topics/b.dita');
    assert.deepEqual(s.turned, []);
    assert.deepEqual(s.opened, [{ path: 'topics/b.dita', newLeaf: false }]);
  });

  describe('with Ctrl/Cmd held', () => {
    const modEvent = Keymap as unknown as { isModEvent: () => boolean };
    const original = modEvent.isModEvent;
    beforeEach(() => {
      modEvent.isModEvent = () => true;
    });
    afterEach(() => {
      modEvent.isModEvent = original;
    });

    it('to a page of the map opens it in a tab of its own', () => {
      const s = scene({ pages: ['topics/b.dita'], current: 'topics/a.dita' });
      s.click('../topics/b.dita');
      assert.deepEqual(s.turned, []);
      assert.deepEqual(s.opened, [{ path: 'topics/b.dita', newLeaf: true }]);
    });
  });
});

describe('a link outside the site view', () => {
  it('opens the file, even when it is a page of the map', () => {
    for (const mode of ['reading', 'split', 'book'] as ViewMode[]) {
      const s = scene({ mode, pages: ['topics/b.dita'], current: 'topics/a.dita' });
      s.click('../topics/b.dita');
      assert.deepEqual(s.turned, [], mode);
      assert.deepEqual(s.opened, [{ path: 'topics/b.dita', newLeaf: false }], mode);
    }
  });
});
