import { strict as assert } from 'assert';
import { MODE_ICONS, MODE_LABELS, TOPIC_MODES, VIEW_MODES, modesFor, panesFor, parseViewMode, previewKindFor, toggleMode } from '../src/viewMode';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';

describe('view modes', () => {
  it('parses known modes and falls back for anything else', () => {
    assert.equal(parseViewMode('source', 'reading'), 'source');
    assert.equal(parseViewMode('split', 'reading'), 'split');
    assert.equal(parseViewMode('site', 'reading'), 'site');
    assert.equal(parseViewMode('book', 'reading'), 'book');
    for (const bad of [undefined, null, 'edit', '', 3, {}, 'READING']) {
      assert.equal(parseViewMode(bad, 'reading'), 'reading');
    }
  });

  it('offers site and book views only for maps', () => {
    assert.deepEqual(modesFor(true), VIEW_MODES);
    assert.deepEqual(modesFor(false), TOPIC_MODES);
    assert.ok(VIEW_MODES.includes('site'));
    assert.ok(VIEW_MODES.includes('book'));
    assert.equal(TOPIC_MODES.includes('site'), false);
    assert.equal(TOPIC_MODES.includes('book'), false);
  });

  it('toggle goes reading -> source, and source, split, site or book -> reading', () => {
    assert.equal(toggleMode('reading'), 'source');
    assert.equal(toggleMode('source'), 'reading');
    assert.equal(toggleMode('split'), 'reading');
    assert.equal(toggleMode('site'), 'reading');
    assert.equal(toggleMode('book'), 'reading');
  });

  it('shows the editor and/or preview per mode', () => {
    assert.deepEqual(panesFor('reading'), { editor: false, preview: true });
    assert.deepEqual(panesFor('source'), { editor: true, preview: false });
    assert.deepEqual(panesFor('split'), { editor: true, preview: true });
    assert.deepEqual(panesFor('site'), { editor: false, preview: true });
    assert.deepEqual(panesFor('book'), { editor: false, preview: true });
  });

  it('preview kind separates the topic outline, a site page and a merged book', () => {
    assert.equal(previewKindFor('reading'), 'topic');
    assert.equal(previewKindFor('source'), 'topic');
    assert.equal(previewKindFor('split'), 'topic');
    assert.equal(previewKindFor('site'), 'site');
    assert.equal(previewKindFor('book'), 'book');
  });

  it('every mode has a label and an icon', () => {
    for (const m of VIEW_MODES) {
      assert.ok(MODE_LABELS[m].length > 0);
      assert.ok(MODE_ICONS[m].length > 0);
    }
  });
});

describe('settings', () => {
  it('uses defaults for missing or garbage data', () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings('x'), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings({ defaultMode: 'nope', previewDelayMs: 'fast' }), DEFAULT_SETTINGS);
  });

  it('keeps valid values and clamps the delay', () => {
    assert.deepEqual(normalizeSettings({ defaultMode: 'split', previewDelayMs: 500 }), { defaultMode: 'split', previewDelayMs: 500 });
    assert.equal(normalizeSettings({ previewDelayMs: 5 }).previewDelayMs, 100);
    assert.equal(normalizeSettings({ previewDelayMs: 999999 }).previewDelayMs, 2000);
    assert.equal(normalizeSettings({ previewDelayMs: NaN }).previewDelayMs, DEFAULT_SETTINGS.previewDelayMs);
    assert.equal(normalizeSettings({ previewDelayMs: 250.6 }).previewDelayMs, 251);
  });

  it('does not make site or book view the default for topics', () => {
    assert.equal(normalizeSettings({ defaultMode: 'site' }).defaultMode, DEFAULT_SETTINGS.defaultMode);
    assert.equal(normalizeSettings({ defaultMode: 'book' }).defaultMode, DEFAULT_SETTINGS.defaultMode);
  });
});
