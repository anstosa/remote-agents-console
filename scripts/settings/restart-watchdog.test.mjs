import assert from "node:assert/strict";
import test from "node:test";
import { RESTART_WATCHDOG_TIMEOUT_MS, withRestartWatchdog } from "./restart-watchdog.mjs";

// provide one deterministic timer controlled by each test
function manualClock(start = 10_000) {
  let now = start;
  let timer;
  let sequence = 0;
  return {
    now: () => now,
    setTimer: (callback, delay) => {
      const selected = { id: ++sequence, callback, at: now + delay };
      timer = selected;
      return selected.id;
    },
    clearTimer: (id) => {
      // clear only the currently armed timer
      if (timer?.id === id) timer = undefined;
    },
    advance: (milliseconds) => {
      now += milliseconds;
      const due = timer?.at <= now ? timer : undefined;
      // fire each armed timer at most once
      if (due !== undefined) {
        timer = undefined;
        due.callback();
      }
    },
    pending: () => timer !== undefined
  };
}

test("restart watchdog defaults to exactly three minutes", () => {
  assert.equal(RESTART_WATCHDOG_TIMEOUT_MS, 180_000);
});

test("restart watchdog cancels after success just before the deadline", async () => {
  const clock = manualClock();
  const result = await withRestartWatchdog(async ({ deadline, signal }) => {
    assert.equal(deadline, clock.now() + RESTART_WATCHDOG_TIMEOUT_MS);
    clock.advance(RESTART_WATCHDOG_TIMEOUT_MS - 1);
    assert.equal(signal.aborted, false);
    return "proved";
  }, { clock });

  assert.equal(result, "proved");
  assert.equal(clock.pending(), false);
  clock.advance(1);
});

test("restart watchdog aborts at the deadline and waits for ignored cancellation to settle", async () => {
  const clock = manualClock();
  let release;
  let signal;
  let settled = false;
  const operation = withRestartWatchdog(async (context) => {
    signal = context.signal;
    await new Promise((resolvePromise) => { release = resolvePromise; });
    settled = true;
  }, { clock });
  await Promise.resolve();

  clock.advance(RESTART_WATCHDOG_TIMEOUT_MS);
  await Promise.resolve();
  assert.equal(signal.aborted, true);
  assert.equal(settled, false);

  release();
  await assert.rejects(operation, { code: "restart-watchdog-expired" });
  assert.equal(settled, true);
  assert.equal(clock.pending(), false);
});

test("fresh proof disarms the watchdog while forward work finishes", async () => {
  const clock = manualClock();
  let release;
  let signal;
  const operation = withRestartWatchdog(async (context) => {
    signal = context.signal;
    context.markProved();
    await new Promise((resolvePromise) => { release = resolvePromise; });
    return "applied";
  }, { clock });
  await Promise.resolve();

  assert.equal(clock.pending(), false);
  clock.advance(RESTART_WATCHDOG_TIMEOUT_MS);
  assert.equal(signal.aborted, false);
  release();
  assert.equal(await operation, "applied");
});
