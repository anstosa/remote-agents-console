import { describe, expect, it } from 'vitest';
import {
  createPaneOutputBatcher,
  paneOutputBatchIntervalMs,
  paneOutputBatchMaxBytes,
  type PaneOutputBatchClock
} from '../src/pane-output-batcher.js';

// deterministic clock for exact fixed-deadline batching contracts
class TestClock implements PaneOutputBatchClock {
  private time = 0;
  private nextTimer = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  // expose the current monotonic test time
  now = () => this.time;

  // retain one callback at its exact deadline
  setTimer = (callback: () => void, delayMs: number) => {
    const timer = this.nextTimer++;
    this.timers.set(timer, { at: this.time + delayMs, callback });
    return timer;
  };

  // cancel only the requested callback
  clearTimer = (timer: unknown) => { this.timers.delete(timer as number); };

  // run every due callback in deadline order
  advance = (elapsedMs: number) => {
    const target = this.time + elapsedMs;
    // callbacks can schedule another deadline inside this advance
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      // stop when no due timer remains
      if (next === undefined) break;
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
    }
    this.time = target;
  };
}

describe('pane output batcher', () => {
  it('sends the idle leading byte immediately and uses one fixed trailing deadline', () => {
    const clock = new TestClock();
    const sent: Buffer[] = [];
    const batcher = createPaneOutputBatcher(bytes => sent.push(Buffer.from(bytes)), { clock });

    expect(paneOutputBatchIntervalMs).toBe(50);
    batcher.push(Buffer.from('A'));
    clock.advance(10);
    batcher.push(Buffer.from('B'));
    clock.advance(10);
    batcher.push(Buffer.from('C'));
    clock.advance(paneOutputBatchIntervalMs - 21);
    expect(sent.map(String)).toEqual(['A']);
    clock.advance(1);
    expect(sent.map(String)).toEqual(['A', 'BC']);

    clock.advance(paneOutputBatchIntervalMs + 1);
    batcher.push(Buffer.from('D'));
    expect(sent.map(String)).toEqual(['A', 'BC', 'D']);
  });

  it('copies retained bytes and flushes the production size cap without waiting', () => {
    const clock = new TestClock();
    const sent: Buffer[] = [];
    const batcher = createPaneOutputBatcher(bytes => sent.push(Buffer.from(bytes)), { clock });

    batcher.push(Buffer.from('lead'));
    clock.advance(1);
    const retained = Buffer.from('copy');
    batcher.push(retained);
    retained.fill('x');
    clock.advance(paneOutputBatchIntervalMs - 1);
    expect(sent.map(String)).toEqual(['lead', 'copy']);

    clock.advance(1);
    batcher.push(Buffer.alloc(paneOutputBatchMaxBytes, 0x61));
    expect(sent.at(-1)?.length).toBe(paneOutputBatchMaxBytes);
    expect(batcher.pendingBytes()).toBe(0);
  });

  it('flushes on demand and cancels discarded or closed trailing bytes exactly once', () => {
    const clock = new TestClock();
    const sent: Buffer[] = [];
    const batcher = createPaneOutputBatcher(bytes => sent.push(Buffer.from(bytes)), { clock });

    batcher.push(Buffer.from('lead'));
    batcher.push(Buffer.from('input-boundary'));
    batcher.flush();
    expect(sent.map(String)).toEqual(['lead', 'input-boundary']);
    batcher.push(Buffer.from('discarded'));
    batcher.discard();
    clock.advance(paneOutputBatchIntervalMs * 2);
    expect(sent.map(String)).toEqual(['lead', 'input-boundary']);

    batcher.push(Buffer.from('new-leading'));
    batcher.push(Buffer.from('closed-tail'));
    batcher.close();
    batcher.close();
    clock.advance(paneOutputBatchIntervalMs * 2);
    expect(sent.map(String)).toEqual(['lead', 'input-boundary', 'new-leading']);
  });
});
