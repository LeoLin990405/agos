export interface RefCountedPollerOptions<Handle> {
  run: () => void;
  shouldRunScheduled: () => boolean;
  intervalMs: number;
  setIntervalFn: (callback: () => void, intervalMs: number) => Handle;
  clearIntervalFn: (handle: Handle) => void;
  scheduleStart?: (callback: () => void) => void;
}

/**
 * Schedules one polling loop for the first subscriber and tears it down after
 * the last subscriber leaves. Deferral lets a StrictMode probe cancel cleanly.
 */
export function createRefCountedPoller<Handle>({
  run,
  shouldRunScheduled,
  intervalMs,
  setIntervalFn,
  clearIntervalFn,
  scheduleStart = queueMicrotask,
}: RefCountedPollerOptions<Handle>): { acquire: () => () => void } {
  let subscribers = 0;
  let timer: Handle | undefined;
  let generation = 0;

  const start = (): void => {
    const expectedGeneration = ++generation;
    scheduleStart(() => {
      if (subscribers === 0 || generation !== expectedGeneration || timer !== undefined) return;
      run();
      timer = setIntervalFn(() => {
        if (shouldRunScheduled()) run();
      }, intervalMs);
    });
  };

  const stop = (): void => {
    generation += 1;
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  };

  return {
    acquire(): () => void {
      subscribers += 1;
      if (subscribers === 1) start();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers = Math.max(0, subscribers - 1);
        if (subscribers === 0) stop();
      };
    },
  };
}
