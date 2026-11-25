export const pollWhileVisible = (task: () => void | Promise<void>, intervalMs: number, immediate = true, hiddenIntervalMs?: number) => {
  let stopped = false;
  let running = false;
  let rerunRequested = false;
  let timer: number | undefined;

  const clearTimer = () => {
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (stopped) return;
    const delay = document.visibilityState === 'visible' ? intervalMs : hiddenIntervalMs;
    if (delay !== undefined) timer = window.setTimeout(() => void run(), delay);
  };
  const run = async () => {
    clearTimer();
    if (stopped || (document.visibilityState !== 'visible' && hiddenIntervalMs === undefined)) return;
    if (running) {
      rerunRequested ||= document.visibilityState === 'visible';
      return;
    }
    running = true;
    try { await task(); }
    finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        void run();
      } else schedule();
    }
  };
  const visibilityChanged = () => {
    if (document.visibilityState === 'visible') void run();
    else schedule();
  };

  document.addEventListener('visibilitychange', visibilityChanged);
  if (immediate) void run();
  else schedule();

  // keep manual refreshes inside the same pending-request owner
  const stop = () => {
    stopped = true;
    clearTimer();
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
  return Object.assign(stop, { refresh: run });
};
