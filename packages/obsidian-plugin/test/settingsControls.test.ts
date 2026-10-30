import { strict as assert } from 'assert';
import { DEFAULT_SETTINGS, PREVIEW_DELAY_RANGE } from '../src/settings';
import { applyControlValue, readControlValue, settingDefinitions } from '../src/settingsControls';
import { MODE_LABELS, TOPIC_MODES } from '../src/viewMode';

describe('declarative settings', () => {
  it('describes the two settings with the limits the imperative tab uses', () => {
    const defs = settingDefinitions();
    assert.equal(defs.length, 2);

    const [mode, delay] = defs;
    assert.equal(mode.control.type, 'dropdown');
    assert.equal(mode.control.key, 'defaultMode');
    assert.deepEqual(
      Object.keys((mode.control as { options: Record<string, string> }).options),
      [...TOPIC_MODES],
    );
    assert.equal((mode.control as { options: Record<string, string> }).options.split, MODE_LABELS.split);

    assert.equal(delay.control.type, 'slider');
    assert.equal(delay.control.key, 'previewDelayMs');
    const slider = delay.control as { min: number; max: number; step: number };
    assert.deepEqual([slider.min, slider.max, slider.step], [PREVIEW_DELAY_RANGE.min, PREVIEW_DELAY_RANGE.max, 50]);
  });

  it('reads a value by key and nothing for an unknown key', () => {
    const s = { ...DEFAULT_SETTINGS, defaultMode: 'source' as const, previewDelayMs: 450 };
    assert.equal(readControlValue(s, 'defaultMode'), 'source');
    assert.equal(readControlValue(s, 'previewDelayMs'), 450);
    assert.equal(readControlValue(s, 'nope'), undefined);
  });

  it('applies a valid value and rejects an invalid one without touching the rest', () => {
    const s = { ...DEFAULT_SETTINGS };
    assert.equal(applyControlValue(s, 'defaultMode', 'split'), true);
    assert.equal(s.defaultMode, 'split');
    assert.equal(applyControlValue(s, 'previewDelayMs', 800), true);
    assert.equal(s.previewDelayMs, 800);

    // A site view does not exist for a topic, so it cannot be the default.
    assert.equal(applyControlValue(s, 'defaultMode', 'site'), false);
    assert.equal(s.defaultMode, 'split');
    assert.equal(applyControlValue(s, 'previewDelayMs', 'fast'), false);
    assert.equal(s.previewDelayMs, 800);
    assert.equal(applyControlValue(s, 'previewDelayMs', 99999), true);
    assert.equal(s.previewDelayMs, PREVIEW_DELAY_RANGE.max);
    assert.equal(applyControlValue(s, 'other', 1), false);
  });
});
