import { strict as assert } from 'assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderBookXml } from '../src/bookRender';
import { renderSiteXml } from '../src/siteRender';
import { renderTopicXml } from '../src/editor/topicRender';
import { parseDitamap, preprocessEntities } from '../src/parser/ditaParser';
import {
  PROFILE_ATTRS,
  ditavalAction,
  isEmptyFilter,
  isExcluded,
  parseDitaval,
  profileGroups,
  profileKey,
  profileValuesOf,
  profileValuesOfKeys,
  pruneExcluded,
} from '../src/profiling';
import type { ProfileFilter } from '../src/profiling';

const ditaval = (body: string): ProfileFilter => ({ ditaval: parseDitaval(`<val>${body}</val>`) });
const hidden = (...pairs: string[]): ProfileFilter => ({ hidden: new Set(pairs) });

describe('parseDitaval', () => {
  it('reads include, exclude, flag and passthrough rules, with and without a value', () => {
    const d = parseDitaval(
      '<val><prop att="audience" val="a" action="exclude"/><prop att="audience" val="b" action="include"/>' +
        '<prop att="platform" action="exclude"/><prop att="product" val="p" action="flag"/>' +
        '<prop att="otherprops" val="o" action="passthrough"/></val>',
    );
    assert.equal(d.error, undefined);
    assert.deepEqual(d.rules, [
      { att: 'audience', val: 'a', action: 'exclude' },
      { att: 'audience', val: 'b', action: 'include' },
      { att: 'platform', action: 'exclude' },
      { att: 'product', val: 'p', action: 'flag' },
      { att: 'otherprops', val: 'o', action: 'passthrough' },
    ]);
  });

  it('ignores revprop, style-conflict and props that name no attribute or a bad action', () => {
    const d = parseDitaval(
      '<val><style-conflict foreground-conflict-color="red"/><revprop val="r" action="flag"/>' +
        '<prop val="x" action="exclude"/><prop att="audience" val="y"/><prop att="audience" val="z" action="shred"/></val>',
    );
    assert.deepEqual(d.rules, []);
    assert.equal(d.error, undefined);
  });

  it('keeps the rules before a well-formedness error and reports it, without throwing', () => {
    const d = parseDitaval('<val><prop att="audience" val="a" action="exclude"/><prop att="audience" val="b" action="exclude"></val>');
    assert.ok(d.error, 'an error is reported');
    assert.deepEqual(d.rules[0], { att: 'audience', val: 'a', action: 'exclude' });
    assert.ok(!d.rules.some((r) => r.val === 'later'));
  });

  it('survives text that is not XML at all', () => {
    const d = parseDitaval('not xml');
    assert.deepEqual(d.rules, []);
  });

  it('reads the fixture style: comments and a prolog', () => {
    const d = parseDitaval('<?xml version="1.0" encoding="UTF-8"?>\n<val>\n<!-- 注释 -->\n<prop att="audience" val="internal" action="exclude"/>\n</val>');
    assert.equal(d.rules.length, 1);
  });
});

describe('ditavalAction', () => {
  const d = parseDitaval(
    '<val><prop att="audience" action="exclude"/><prop att="audience" val="admin" action="include"/><prop att="status" val="draft" action="exclude"/></val>',
  );

  it('prefers the rule for the value, then the attribute default, then include', () => {
    assert.equal(ditavalAction(d, 'audience', 'admin'), 'include');
    assert.equal(ditavalAction(d, 'audience', 'guest'), 'exclude');
    assert.equal(ditavalAction(d, 'platform', 'linux'), 'include');
    assert.equal(ditavalAction(undefined, 'audience', 'guest'), 'include');
  });

  it('never acts on attributes DITA-OT does not filter on', () => {
    assert.equal(ditavalAction(d, 'status', 'draft'), 'include');
  });
});

describe('profileValuesOf', () => {
  it('splits every attribute on whitespace and ignores empty ones', () => {
    assert.deepEqual(profileValuesOf({ audience: ' a  b ', platform: 'linux', product: '  ' }), {
      audience: ['a', 'b'],
      platform: ['linux'],
    });
    assert.deepEqual(profileValuesOf(undefined), {});
    assert.deepEqual(profileValuesOf({ id: 'x', outputclass: 'y' }), {});
  });

  it('expands props="name(value ...)" into the specialised attribute and keeps bare values on props', () => {
    assert.deepEqual(profileValuesOf({ props: 'audience(admin guest) platform(linux) internal-only' }), {
      audience: ['admin', 'guest'],
      platform: ['linux'],
      props: ['internal-only'],
    });
  });

  it('adds generalised values to the attribute they specialise', () => {
    // Order within an attribute carries no meaning; only the set of values does.
    assert.deepEqual(profileValuesOf({ audience: 'a', props: 'audience(b)' }).audience.sort(), ['a', 'b']);
  });
});

describe('profileValuesOfKeys', () => {
  it('reads what the renderer writes, in the renderer\'s own encoding', () => {
    assert.deepEqual(profileValuesOfKeys('audience:admin,audience:a%20b,platform:linux'), {
      audience: ['admin', 'a', 'b'],
      platform: ['linux'],
    });
    assert.deepEqual(profileValuesOfKeys(null), {});
    assert.deepEqual(profileValuesOfKeys(''), {});
    assert.deepEqual(profileValuesOfKeys('broken,%E0%A4%A:x,:x'), {});
  });

  it('rejoins a props group the renderer split on its inner space', () => {
    assert.deepEqual(profileValuesOfKeys('props:audience(admin,props:guest)'), { audience: ['admin', 'guest'] });
  });

  // The renderer is a verbatim copy and cannot export its attribute list, so
  // this is what keeps PROFILE_ATTRS honest.
  it('agrees with the real renderer for every profiling attribute, including a split props group', () => {
    const attrs: Record<string, string> = {
      platform: 'linux mac',
      product: 'pro',
      audience: 'admin',
      otherprops: 'beta',
      base: 'core',
      importance: 'high',
      rev: '2',
      status: 'changed',
      props: 'region(emea apac) plain',
    };
    const attrText = Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    const { html } = renderTopicXml({
      xml: `<topic id="t"><title>T</title><body><p ${attrText}>text</p></body></topic>`,
      docDir: __dirname,
      keyMap: new Map(),
      asWebviewUri: (p) => p,
      headingLevel: 1,
    });
    const match = /data-profile-keys="([^"]*)"/.exec(html);
    assert.ok(match, 'the profiled paragraph carries data-profile-keys');
    const fromHtml = profileValuesOfKeys(match[1].replace(/&amp;/g, '&'));
    assert.deepEqual(fromHtml, profileValuesOf(attrs));
    for (const name of PROFILE_ATTRS) {
      assert.ok(name in attrs || name === 'props', `${name} is exercised`);
    }
    assert.ok(Object.keys(fromHtml).length >= PROFILE_ATTRS.length, 'every attribute produced values');
  });
});

describe('isExcluded', () => {
  it('leaves everything when there is no filter or the filter removes nothing', () => {
    assert.equal(isExcluded({ audience: ['a'] }, undefined), false);
    assert.equal(isExcluded({ audience: ['a'] }, {}), false);
    assert.equal(isExcluded({ audience: ['a'] }, ditaval('<prop att="audience" val="a" action="flag"/>')), false);
    assert.equal(isEmptyFilter(undefined), true);
    assert.equal(isEmptyFilter(ditaval('<prop att="audience" val="a" action="include"/>')), true);
    assert.equal(isEmptyFilter(hidden('audience:a')), false);
  });

  it('removes an element whose only value is excluded', () => {
    assert.equal(isExcluded({ audience: ['internal'] }, ditaval('<prop att="audience" val="internal" action="exclude"/>')), true);
  });

  it('keeps an element that has any value which is not excluded', () => {
    const f = ditaval('<prop att="audience" val="internal" action="exclude"/>');
    assert.equal(isExcluded({ audience: ['internal', 'admin'] }, f), false);
  });

  it('applies the attribute default to values without a rule of their own', () => {
    const f = ditaval('<prop att="audience" action="exclude"/><prop att="audience" val="admin" action="include"/>');
    assert.equal(isExcluded({ audience: ['guest'] }, f), true);
    assert.equal(isExcluded({ audience: ['guest', 'admin'] }, f), false);
  });

  it('removes an element when any one attribute removes it', () => {
    const f = ditaval('<prop att="platform" val="windows" action="exclude"/><prop att="audience" val="admin" action="include"/>');
    assert.equal(isExcluded({ platform: ['windows'], audience: ['admin'] }, f), true);
    assert.equal(isExcluded({ platform: ['linux'], audience: ['admin'] }, f), false);
  });

  it('does not touch an element with no value for the filtered attribute', () => {
    assert.equal(isExcluded({}, ditaval('<prop att="audience" action="exclude"/>')), false);
    assert.equal(isExcluded({ platform: ['x'] }, ditaval('<prop att="audience" action="exclude"/>')), false);
  });

  it('filters through a generalised attribute and through bare props values', () => {
    const f = ditaval('<prop att="region" val="emea" action="exclude"/><prop att="props" val="internal-only" action="exclude"/>');
    assert.equal(isExcluded(profileValuesOf({ props: 'region(emea)' }), f), true);
    assert.equal(isExcluded(profileValuesOf({ props: 'region(emea apac)' }), f), false);
    assert.equal(isExcluded(profileValuesOf({ props: 'internal-only' }), f), true);
  });

  it('combines hand-picked values with the file, and lets them reach attributes the file ignores', () => {
    const both: ProfileFilter = {
      ditaval: parseDitaval('<val><prop att="audience" val="a" action="exclude"/></val>'),
      hidden: new Set([profileKey('status', 'draft')]),
    };
    assert.equal(isExcluded({ audience: ['a'] }, both), true);
    assert.equal(isExcluded({ status: ['draft'] }, both), true);
    assert.equal(isExcluded({ status: ['draft', 'final'] }, both), false);
    assert.equal(isExcluded({ audience: ['b'] }, both), false);
  });

  it('applies the same all-values rule to hand-picked values', () => {
    const f = hidden('audience:a');
    assert.equal(isExcluded({ audience: ['a'] }, f), true);
    assert.equal(isExcluded({ audience: ['a', 'b'] }, f), false);
  });
});

describe('profileGroups', () => {
  it('collects every attribute and value once, sorted', () => {
    const groups = profileGroups([
      { platform: ['mac', 'linux'], audience: ['b'] },
      { audience: ['a', 'b'] },
      {},
    ]);
    assert.deepEqual(groups, [
      { att: 'audience', values: ['a', 'b'] },
      { att: 'platform', values: ['linux', 'mac'] },
    ]);
  });

  it('keeps values that are turned off even when nothing carries them any more', () => {
    const groups = profileGroups([{ audience: ['a'] }], ['audience:gone', 'platform:linux', 'nocolon']);
    assert.deepEqual(groups, [
      { att: 'audience', values: ['a', 'gone'] },
      { att: 'platform', values: ['linux'] },
    ]);
  });
});

describe('pruneExcluded', () => {
  const parse = (xml: string) => parseDitamap(preprocessEntities(xml)).root;
  const hrefs = (root: ReturnType<typeof parse>): string[] => {
    const out: string[] = [];
    const walk = (n: typeof root): void => {
      if (n.attributes?.href) out.push(n.attributes.href);
      n.children.forEach(walk);
    };
    walk(root);
    return out;
  };
  const f = ditaval('<prop att="audience" val="internal" action="exclude"/>');

  it('drops a filtered topicref together with its sub-topicrefs', () => {
    const root = parse(
      '<map><topicref href="a.dita"/><topicref href="b.dita" audience="internal"><topicref href="b1.dita"/></topicref><topicref href="c.dita"/></map>',
    );
    assert.equal(pruneExcluded(root, f), 1);
    assert.deepEqual(hrefs(root), ['a.dita', 'c.dita']);
  });

  it('keeps a child that has its own attribute value which is not excluded', () => {
    const root = parse(
      '<map><topicref href="p.dita" audience="admin"><topicref href="k.dita"/><topicref href="x.dita" audience="internal"/></topicref></map>',
    );
    pruneExcluded(root, f);
    assert.deepEqual(hrefs(root), ['p.dita', 'k.dita']);
  });

  it('changes nothing without an active filter', () => {
    const root = parse('<map><topicref href="a.dita" audience="internal"/></map>');
    assert.equal(pruneExcluded(root, undefined), 0);
    assert.equal(pruneExcluded(root, {}), 0);
    assert.deepEqual(hrefs(root), ['a.dita']);
  });
});

describe('map views with a filter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dita-profiling-'));
  mkdirSync(join(dir, 'topics'));
  const topic = (id: string): string => `<topic id="${id}"><title>T-${id}</title><body><p>text ${id}</p></body></topic>`;
  for (const id of ['one', 'two', 'three']) writeFileSync(join(dir, 'topics', `${id}.dita`), topic(id));
  const xml =
    '<map><title>Guide</title><topicref href="topics/one.dita"/>' +
    '<topicref href="topics/two.dita" audience="internal"/><topicref href="topics/three.dita"/></map>';
  const filter = ditaval('<prop att="audience" val="internal" action="exclude"/>');

  it('book view leaves out the filtered topic and does not list it as a member', () => {
    const all = renderBookXml({ xml, docDir: dir });
    const some = renderBookXml({ xml, docDir: dir, filter });
    assert.equal(all.members.length, 3);
    assert.equal(some.members.length, 2);
    assert.match(all.html, /T-two/);
    assert.doesNotMatch(some.html, /T-two/);
    assert.match(some.html, /T-one/);
    assert.match(some.html, /T-three/);
  });

  it('site view drops the filtered topic from the sidebar and from page order', () => {
    const r = renderSiteXml({ xml, docDir: dir, filter });
    assert.deepEqual(
      r.entries.map((e) => e.title),
      ['T-one', 'T-three'],
    );
    assert.equal(r.members.length, 2);
  });

  it('site view falls back to the first kept topic when the current page was filtered out', () => {
    const two = join(dir, 'topics', 'two.dita');
    const r = renderSiteXml({ xml, docDir: dir, filter, current: two });
    assert.equal(r.current, join(dir, 'topics', 'one.dita'));
  });
});
