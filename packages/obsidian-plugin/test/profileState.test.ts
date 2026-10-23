import { strict as assert } from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildFilter,
  isDefaultProfileState,
  isValidDitavalPath,
  listDitavalFiles,
  loadDitaval,
  normalizeProfileState,
  resolveDitavalPath,
} from '../src/profileState';
import { attributeLabel, statusText } from '../src/profileLabels';

describe('normalizeProfileState', () => {
  it('gives a fresh pane the defaults for missing or garbage data', () => {
    for (const raw of [undefined, null, 42, 'x', [], {}]) {
      const s = normalizeProfileState(raw);
      assert.deepEqual(s, { hidden: [], highlight: true });
      assert.equal(isDefaultProfileState(s), true);
    }
  });

  it('keeps a valid state field by field', () => {
    const s = normalizeProfileState({ ditaval: 'common\\strict.ditaval', hidden: ['audience:a', 'platform:linux'], highlight: false });
    assert.deepEqual(s, { ditaval: 'common/strict.ditaval', hidden: ['audience:a', 'platform:linux'], highlight: false });
    assert.equal(isDefaultProfileState(s), false);
  });

  it('drops hidden entries that are not attribute:value strings, and duplicates', () => {
    const s = normalizeProfileState({ hidden: ['audience:a', 'audience:a', 'nocolon', ':novalue-att', 7, null, 'ok:1'] });
    assert.deepEqual(s.hidden, ['audience:a', 'ok:1']);
  });

  it('refuses a ditaval path that leaves the vault or is not a .ditaval', () => {
    for (const bad of ['../x.ditaval', 'a/../../x.ditaval', '/etc/x.ditaval', 'C:\\x.ditaval', 'a.xml', '', 5, null]) {
      assert.equal(normalizeProfileState({ ditaval: bad }).ditaval, undefined, String(bad));
    }
    assert.equal(normalizeProfileState({ ditaval: 'A/B.DITAVAL' }).ditaval, 'A/B.DITAVAL');
  });

  it('caps the number of hand-picked values', () => {
    const many = Array.from({ length: 900 }, (_, i) => `a:${i}`);
    assert.equal(normalizeProfileState({ hidden: many }).hidden.length, 500);
  });
});

describe('ditaval files on disk', () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'obsidian-dita-val-'));
    mkdirSync(join(vault, 'common'));
    mkdirSync(join(vault, '.obsidian'));
    mkdirSync(join(vault, 'node_modules'));
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  it('resolves a vault-relative path and refuses one that would leave the vault', () => {
    assert.equal(resolveDitavalPath(vault, 'common/x.ditaval'), join(vault, 'common', 'x.ditaval'));
    assert.equal(resolveDitavalPath(vault, '../x.ditaval'), undefined);
    assert.equal(resolveDitavalPath(vault, 'x.txt'), undefined);
    assert.equal(isValidDitavalPath('x.ditaval'), true);
  });

  it('loads and parses a file, tolerating a byte order mark', () => {
    const file = join(vault, 'common', 'x.ditaval');
    writeFileSync(file, '\uFEFF<?xml version="1.0"?><val><prop att="audience" val="a" action="exclude"/></val>');
    const r = loadDitaval(file);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.ditaval?.rules, [{ att: 'audience', val: 'a', action: 'exclude' }]);
  });

  it('reports a missing file, so creating it can bring the filter back', () => {
    const r = loadDitaval(join(vault, 'nope.ditaval'));
    assert.equal(r.missing, true);
    assert.match(r.error ?? '', /does not exist/);
    assert.equal(r.ditaval, undefined);
  });

  it('reports a file that is not well-formed but still returns the rules before the break', () => {
    const file = join(vault, 'bad.ditaval');
    writeFileSync(file, '<val><prop att="audience" val="a" action="exclude"/><prop att="x" val="y" action="exclude"></val>');
    const r = loadDitaval(file);
    assert.match(r.error ?? '', /not well-formed/);
    assert.equal(r.ditaval?.rules[0].val, 'a');
  });

  it('lists every .ditaval, sorted, skipping Obsidian and dependency folders', () => {
    for (const rel of ['b.ditaval', 'common/a.DITAVAL', '.obsidian/hidden.ditaval', 'node_modules/n.ditaval', 'common/notes.txt']) {
      writeFileSync(join(vault, rel), '<val/>');
    }
    assert.deepEqual(listDitavalFiles(vault), ['b.ditaval', 'common/a.DITAVAL']);
  });

  it('lists nothing for a vault that cannot be read', () => {
    assert.deepEqual(listDitavalFiles(join(vault, 'missing')), []);
  });
});

describe('buildFilter', () => {
  it('is undefined when there is neither a file nor a hand-picked value', () => {
    assert.equal(buildFilter(undefined, []), undefined);
  });

  it('carries both parts when there are', () => {
    const f = buildFilter({ rules: [] }, ['audience:a']);
    assert.ok(f?.ditaval);
    assert.deepEqual([...(f?.hidden ?? [])], ['audience:a']);
  });
});

describe('profile panel wording', () => {
  it('labels the standard attributes and leaves invented ones as written', () => {
    assert.equal(attributeLabel('audience'), 'Audience');
    assert.equal(attributeLabel('otherprops'), 'Other props');
    assert.equal(attributeLabel('region'), 'Region');
  });

  it('counts hidden elements in the singular and the plural', () => {
    assert.equal(statusText(0), 'Nothing is hidden.');
    assert.equal(statusText(1), '1 element is hidden.');
    assert.equal(statusText(12), '12 elements are hidden.');
  });
});
