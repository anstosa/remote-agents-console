export const paneOutputBatchIntervalMs = 50;
export const paneOutputBatchMaxBytes = 64 * 1024;

export type PaneOutputBatchClock = Readonly<{
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (timer: unknown) => void;
}>;

export type PaneOutputBatcher = Readonly<{
  push: (bytes: Buffer) => void;
  flush: () => void;
  discard: () => void;
  close: () => void;
  pendingBytes: () => number;
}>;

export type PaneOutputBatcherOptions = Readonly<{
  intervalMs?: number;
  maxBytes?: number;
  clock?: PaneOutputBatchClock;
}>;

const defaultClock: PaneOutputBatchClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

// coalesce only trailing live output while keeping idle-leading bytes immediate
export const createPaneOutputBatcher = (
  send: (bytes: Buffer) => void,
  options: PaneOutputBatcherOptions = {}
): PaneOutputBatcher => {
  const intervalMs = options.intervalMs ?? paneOutputBatchIntervalMs;
  const maxBytes = options.maxBytes ?? paneOutputBatchMaxBytes;
  const clock = options.clock ?? defaultClock;
  const chunks: Buffer[] = [];
  let queuedBytes = 0;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let ended = false;

  // cancel the one fixed trailing deadline
  const cancelTimer = () => {
    // leave an absent timer inert
    if (timer === undefined) return;
    clock.clearTimer(timer);
    timer = undefined;
  };

  // send every retained byte once in original order
  const flush = () => {
    // closed or empty batchers have no output to send
    if (ended || queuedBytes === 0) return;
    cancelTimer();
    const bytes = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, queuedBytes);
    chunks.length = 0;
    queuedBytes = 0;
    lastSentAt = clock.now();
    send(bytes);
  };

  // forget a superseded batch and let the next live byte lead immediately
  const discard = () => {
    cancelTimer();
    chunks.length = 0;
    queuedBytes = 0;
    lastSentAt = Number.NEGATIVE_INFINITY;
  };

  // retain one output chunk behind the fixed next-send deadline
  const push = (bytes: Buffer) => {
    // ignore empty output and calls after exact cleanup
    if (ended || bytes.length === 0) return;
    const now = clock.now();
    // preserve the first output after an idle interval
    if (queuedBytes === 0 && now - lastSentAt >= intervalMs) {
      lastSentAt = now;
      send(bytes);
      return;
    }
    // copy because the control client retains ownership of its source buffer
    chunks.push(Buffer.from(bytes));
    queuedBytes += bytes.length;
    // bound retained memory and large-output latency independently of the timer
    if (queuedBytes >= maxBytes) {
      flush();
      return;
    }
    // more output joins the existing fixed deadline rather than extending it
    if (timer === undefined) {
      const remaining = Math.max(0, intervalMs - (now - lastSentAt));
      timer = clock.setTimer(() => { timer = undefined; flush(); }, remaining);
    }
  };

  // release timers and retained bytes without sending after session cleanup
  const close = () => {
    // keep cleanup idempotent
    if (ended) return;
    discard();
    ended = true;
  };

  return { push, flush, discard, close, pendingBytes: () => queuedBytes };
};
