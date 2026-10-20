export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Debounced {
  /** Run after `ms` of quiet; each call restarts the wait. */
  (): void;
  /** Run now if one is pending. */
  flush(): void;
  cancel(): void;
  pending(): boolean;
}

export function debounce(fn: () => void, getDelayMs: () => number, scheduler: Scheduler = realScheduler): Debounced {
  let handle: unknown;
  let waiting = false;
  const run = (): void => {
    waiting = false;
    handle = undefined;
    fn();
  };
  const d = (() => {
    if (waiting) scheduler.clear(handle);
    waiting = true;
    handle = scheduler.set(run, getDelayMs());
  }) as Debounced;
  d.flush = () => {
    if (!waiting) return;
    scheduler.clear(handle);
    run();
  };
  d.cancel = () => {
    if (!waiting) return;
    scheduler.clear(handle);
    waiting = false;
    handle = undefined;
  };
  d.pending = () => waiting;
  return d;
}
