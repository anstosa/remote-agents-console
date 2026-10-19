import { safeError } from "./fs.mjs";

export const RESTART_WATCHDOG_TIMEOUT_MS = 180_000;

const systemClock = {
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer)
};

// bound one RAC replacement through its fresh-runtime proof
export async function withRestartWatchdog(action, options = {}) {
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? RESTART_WATCHDOG_TIMEOUT_MS;
  const controller = new AbortController();
  let deadline;
  let timer;
  let proved = false;
  let expire;
  const expired = new Promise((resolvePromise) => { expire = resolvePromise; });
  const start = () => {
    // arm the deadline only once at the mutation boundary
    if (deadline !== undefined) return deadline;
    deadline = clock.now() + timeoutMs;
    timer = clock.setTimer(() => {
      // ignore a timer already disarmed by fresh proof
      if (proved) return;
      // select expiry before cancellation settles forward work
      expire({ kind: "expired" });
      controller.abort(safeError("restart-watchdog-expired"));
    }, timeoutMs);
    return deadline;
  };
  // preserve immediate arming for ordinary helper callers
  if (!options.deferStart) start();
  const markProved = () => {
    // reject proof arriving after the deadline won
    if (controller.signal.aborted || deadline === undefined) return false;
    proved = true;
    clock.clearTimer(timer);
    return true;
  };
  const context = {
    signal: controller.signal,
    clock,
    start,
    markProved,
    get deadline() {
      return deadline;
    }
  };
  const forward = Promise.resolve().then(() => action(context));
  const outcome = forward.then(
    (value) => ({ kind: "completed", value }),
    (error) => ({ kind: "failed", error })
  );
  try {
    const winner = await Promise.race([outcome, expired]);
    // wait for ignored cancellation before starting recovery
    if (winner.kind === "expired") {
      await outcome;
      throw safeError("restart-watchdog-expired");
    }
    // preserve an early forward failure
    if (winner.kind === "failed") {
      throw winner.error;
    }
    return winner.value;
  } finally {
    // disarm on every terminal path
    clock.clearTimer(timer);
  }
}
