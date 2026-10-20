import { strict as assert } from 'assert';
import { debounce, Scheduler } from '../src/debounce';

function manualScheduler() {
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const s: Scheduler = {
    set: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clear: (h) => void timers.delete(h as number),
  };
  return { s, timers, fireAll: () => [...timers.values()].forEach((t) => (timers.clear(), t.fn())) };
}

describe('debounce', () => {
  it('runs once after a burst, restarting the wait on every call', () => {
    const m = manualScheduler();
    let runs = 0;
    const d = debounce(() => runs++, () => 300, m.s);
    d();
    d();
    d();
    assert.equal(m.timers.size, 1, 'earlier timers were cleared');
    assert.equal(runs, 0);
    m.fireAll();
    assert.equal(runs, 1);
    assert.equal(d.pending(), false);
  });

  it('reads the delay at call time, so a settings change applies', () => {
    const m = manualScheduler();
    let delay = 300;
    const d = debounce(() => undefined, () => delay, m.s);
    d();
    assert.equal([...m.timers.values()][0].ms, 300);
    delay = 800;
    d();
    assert.equal([...m.timers.values()][0].ms, 800);
  });

  it('flush runs a pending call immediately, and is a no-op otherwise', () => {
    const m = manualScheduler();
    let runs = 0;
    const d = debounce(() => runs++, () => 300, m.s);
    d.flush();
    assert.equal(runs, 0);
    d();
    d.flush();
    assert.equal(runs, 1);
    assert.equal(m.timers.size, 0);
  });

  it('cancel drops a pending call', () => {
    const m = manualScheduler();
    let runs = 0;
    const d = debounce(() => runs++, () => 300, m.s);
    d();
    d.cancel();
    m.fireAll();
    assert.equal(runs, 0);
    assert.equal(d.pending(), false);
  });
});
