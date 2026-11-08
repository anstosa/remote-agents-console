import { afterEach, describe, expect, it, vi } from 'vitest';
import { LatestViewportScheduler, PaneViewportCoordinator, paneViewportGraceMs, type PaneGeometry, type PaneViewport } from '../src/logs/viewport-scheduler.js';

const geometry = (cols: number, rows: number, clientLimit?: PaneViewport): PaneGeometry => ({ cols, rows, ...(clientLimit === undefined ? {} : { clientLimit }) });
const unpinNothing = async () => true;

describe('latest viewport scheduling', () => {
  it('applies a newer full-height viewport after an older resize already started', async () => {
    let releaseShortResize: (() => void) | undefined;
    const shortResize = new Promise<void>(resolve => { releaseShortResize = resolve; });
    const resized: Array<[number, number]> = [];
    const shown: number[] = [];
    const scheduler = new LatestViewportScheduler(async (cols, rows) => {
      resized.push([cols, rows]);
      if (rows === 30) await shortResize;
      return true;
    }, history => shown.push(history));

    const short = scheduler.schedule({ cols: 120, rows: 30, history: 0 });
    await Promise.resolve();
    const full = scheduler.schedule({ cols: 220, rows: 90, history: 0 });
    releaseShortResize?.();
    await Promise.all([short, full]);

    expect(resized).toEqual([[120, 30], [220, 90]]);
    expect(shown).toEqual([0]);
  });

  it('skips superseded viewport requests that have not started resizing', async () => {
    const resized: Array<[number, number]> = [];
    const scheduler = new LatestViewportScheduler(async (cols, rows) => { resized.push([cols, rows]); return true; }, () => {});

    const first = scheduler.schedule({ cols: 120, rows: 30, history: 0 });
    const latest = scheduler.schedule({ cols: 220, rows: 90, history: 0 });
    await Promise.all([first, latest]);

    expect(resized).toEqual([[220, 90]]);
  });
});

describe('pane viewport coordination', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the window at the browser size through the release grace, then restores it', async () => {
    vi.useFakeTimers();
    const applied: Array<[number, number]> = [];
    let unpins = 0;
    const coordinator = new PaneViewportCoordinator();
    const lease = coordinator.acquire('socket:@1', async () => geometry(220, 80), async (cols, rows) => { applied.push([cols, rows]); return true; }, async () => { unpins += 1; return true; });

    await lease.resize(62, 41);
    await lease.release();
    await vi.advanceTimersByTimeAsync(paneViewportGraceMs - 1);
    expect(applied).toEqual([[62, 41]]);
    await vi.advanceTimersByTimeAsync(1);

    expect(applied).toEqual([[62, 41], [220, 80]]);
    expect(unpins).toBe(1);
  });

  it('never restores a release whose window a new viewer claimed within the grace', async () => {
    vi.useFakeTimers();
    const applied: Array<[number, number]> = [];
    let unpins = 0;
    const coordinator = new PaneViewportCoordinator();
    const read = async () => geometry(220, 80);
    const apply = async (cols: number, rows: number) => { applied.push([cols, rows]); return true; };
    const unpin = async () => { unpins += 1; return true; };
    const first = coordinator.acquire('socket:@1', read, apply, unpin);
    expect(first.held).toBe(false);
    await first.resize(62, 41);
    await first.release();
    await vi.advanceTimersByTimeAsync(1_000);

    const returning = coordinator.acquire('socket:@1', read, apply, unpin);
    expect(returning.held).toBe(true);
    await vi.advanceTimersByTimeAsync(paneViewportGraceMs);
    expect(applied).toEqual([[62, 41]]);
    expect(unpins).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // the returning viewer still restores the original size, not the browser's
    await returning.release();
    await vi.advanceTimersByTimeAsync(paneViewportGraceMs);
    expect(applied).toEqual([[62, 41], [220, 80]]);
    expect(unpins).toBe(1);
  });

  it('restores at once, with no grace, when a terminal is attached to the window', async () => {
    // a phone viewer leaving must hand the window back to the desktop `tmux attach` right away
    vi.useFakeTimers();
    const applied: Array<[number, number]> = [];
    let unpins = 0;
    const coordinator = new PaneViewportCoordinator();
    const lease = coordinator.acquire('socket:@1', async () => geometry(62, 41, { cols: 220, rows: 80 }), async (cols, rows) => { applied.push([cols, rows]); return true; }, async () => { unpins += 1; return true; });
    await lease.resize(220, 80);
    await lease.resize(62, 41);

    await lease.release();

    expect(applied).toEqual([[220, 80], [62, 41], [220, 80]]);
    expect(unpins).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores releases still in their grace at once on shutdown', async () => {
    vi.useFakeTimers();
    const applied: Array<[number, number]> = [];
    let unpins = 0;
    const coordinator = new PaneViewportCoordinator();
    const lease = coordinator.acquire('socket:@1', async () => geometry(220, 80), async (cols, rows) => { applied.push([cols, rows]); return true; }, async () => { unpins += 1; return true; });
    await lease.resize(62, 41);
    await lease.release();

    await coordinator.restoreAll();

    expect(applied).toEqual([[62, 41], [220, 80]]);
    expect(unpins).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores the original desktop pane after a mobile viewer disconnects', async () => {
    const applied: Array<[number, number]> = [];
    const coordinator = new PaneViewportCoordinator(0);
    const lease = coordinator.acquire('socket:%1', async () => geometry(220, 80), async (cols, rows) => { applied.push([cols, rows]); return true; }, unpinNothing);

    await expect(lease.resize(62, 41)).resolves.toBe(true);
    await lease.release();

    expect(applied).toEqual([[62, 41], [220, 80]]);
  });

  it('heals a pane already stuck at mobile dimensions after a desktop viewer connects', async () => {
    const applied: Array<[number, number]> = [];
    const coordinator = new PaneViewportCoordinator(0);
    const lease = coordinator.acquire('socket:%1', async () => geometry(62, 41), async (cols, rows) => { applied.push([cols, rows]); return true; }, unpinNothing);

    await expect(lease.resize(307, 70)).resolves.toBe(true);
    await lease.release();

    expect(applied).toEqual([[307, 70], [307, 70]]);
  });

  it('retries the largest known viewport during release after a transient resize failure', async () => {
    const applied: Array<[number, number]> = [];
    const coordinator = new PaneViewportCoordinator(0);
    let attempts = 0;
    const lease = coordinator.acquire('socket:%1', async () => geometry(62, 41), async (cols, rows) => {
      applied.push([cols, rows]);
      attempts += 1;
      return attempts > 1;
    }, unpinNothing);

    await expect(lease.resize(307, 70)).resolves.toBe(false);
    await lease.release();

    expect(applied).toEqual([[307, 70], [307, 70]]);
  });

  it('does not let a stale client restore over a newer viewport owner', async () => {
    const applied: Array<[number, number]> = [];
    const coordinator = new PaneViewportCoordinator(0);
    const first = coordinator.acquire('socket:%1', async () => geometry(220, 80), async (cols, rows) => { applied.push([cols, rows]); return true; }, unpinNothing);
    await first.resize(62, 41);
    const latest = coordinator.acquire('socket:%1', async () => geometry(62, 41), async (cols, rows) => { applied.push([cols, rows]); return true; }, unpinNothing);

    await first.release();
    await latest.resize(307, 70);
    await latest.release();

    expect(applied).toEqual([[62, 41], [307, 70], [307, 80]]);
  });

  it('shares one Size claim between two viewers of panes in the same window', async () => {
    // both pane streams key the claim by the window id, so two panes of one window
    // resolve to a single coordinator entry: the latest viewer drives the one pin, and only
    // that viewer's release restores the window and unpins it
    const applied: Array<[number, number]> = [];
    let unpins = 0;
    const coordinator = new PaneViewportCoordinator(0);
    const windowKey = 'socket:@3';
    const read = async () => geometry(220, 80);
    const apply = async (cols: number, rows: number) => { applied.push([cols, rows]); return true; };
    const unpin = async () => { unpins += 1; return true; };

    const first = coordinator.acquire(windowKey, read, apply, unpin);
    const second = coordinator.acquire(windowKey, read, apply, unpin);
    await first.resize(100, 30);   // superseded by the second viewer of the same window
    await second.resize(120, 40);  // the single claim tracks the latest viewer
    await first.release();          // the superseded viewer restores and unpins nothing
    await second.release();

    expect(applied).toEqual([[120, 40], [220, 80]]);
    expect(unpins).toBe(1);
  });

  it('lets a viewer of the window that does not drive the claim conform instead of failing', async () => {
    // two split panes of one window, mounted together: the first viewer is not the claim's driver,
    // but its resize and its re-clamp after the driver moves the window still succeed
    const applied: string[] = [];
    const coordinator = new PaneViewportCoordinator(0);
    const lease = (pane: string) => coordinator.acquire('socket:@3', async () => geometry(220, 80), async (cols, rows) => { applied.push(`${pane} ${cols}x${rows}`); return true; }, unpinNothing);
    const first = lease('%1');
    const second = lease('%2');

    await expect(Promise.all([first.resize(100, 30), second.resize(90, 20)])).resolves.toEqual([true, true]);
    await expect(first.ensure(100, 30)).resolves.toEqual({ ok: true, resized: true });
    await expect(second.ensure(90, 20)).resolves.toEqual({ ok: true, resized: true });

    expect(applied).toEqual(['%2 90x20', '%2 90x20']);
  });

  // two panes side by side in one window: each pane's own width, one shared height
  const splitWindow = (one: number, two: number, rows: number) => {
    const panes: Record<string, PaneViewport> = { '%1': { cols: one, rows }, '%2': { cols: two, rows } };
    const window = () => ({ cols: panes['%1']!.cols + panes['%2']!.cols + 1, rows: panes['%1']!.rows });
    const applied: string[] = [];
    return {
      applied,
      window,
      read: (pane: string) => async () => ({ ...panes[pane]!, window: window() }),
      apply: (pane: string) => async (cols: number, rows: number) => {
        applied.push(`${pane} ${cols}x${rows}`);
        panes[pane]!.cols = cols;
        for (const each of Object.values(panes)) each.rows = rows;
        return true;
      }
    };
  };

  it('hands the claim back to the earlier viewer when the driver leaves, with the grid it asked for', async () => {
    const split = splitWindow(150, 49, 50);
    let unpins = 0;
    const coordinator = new PaneViewportCoordinator(0);
    const lease = (pane: string) => coordinator.acquire('socket:@3', split.read(pane), split.apply(pane), async () => { unpins += 1; return true; });
    const first = lease('%1');
    await first.resize(120, 40);
    const second = lease('%2');
    await second.resize(60, 30);
    // the driver's grid left the earlier pane shorter
    expect(await split.read('%1')()).toMatchObject({ cols: 120, rows: 30 });

    await second.release();
    // nothing else asks: the hand-back itself sizes the pane again, and its next re-clamp reports it
    await expect(first.ensure(120, 40)).resolves.toEqual({ ok: true, resized: true });
    expect(await split.read('%1')()).toMatchObject({ cols: 120, rows: 40 });
    expect(unpins).toBe(0);
    // a released viewer neither drives nor restores again
    await expect(second.resize(50, 10)).resolves.toBe(false);
    await second.release();
    await first.release();

    expect(split.applied).toEqual(['%1 120x40', '%2 60x30', '%1 120x40', '%1 139x50']);
    expect(split.window()).toEqual({ cols: 200, rows: 50 });
    expect(unpins).toBe(1);
  });

  it('restores the window the claim found, whichever pane leaves last', async () => {
    // opened in one tick, so the second pane drives and the first conforms until it leaves
    const split = splitWindow(150, 49, 50);
    const coordinator = new PaneViewportCoordinator(0);
    const lease = (pane: string) => coordinator.acquire('socket:@3', split.read(pane), split.apply(pane), unpinNothing);
    const first = lease('%1');
    const second = lease('%2');
    await Promise.all([first.resize(140, 40), second.resize(40, 30)]);

    await second.release();
    await first.ensure(140, 40);
    await first.release();

    expect(split.applied).toEqual(['%2 40x30', '%1 140x40', '%1 159x50']);
    expect(split.window()).toEqual({ cols: 200, rows: 50 });
  });

  it('does not fail a driver that a newer viewer supersedes mid-resize', async () => {
    let readStarted!: () => void;
    let finishRead!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    const coordinator = new PaneViewportCoordinator(0);
    const first = coordinator.acquire('socket:@3', async () => { readStarted(); await new Promise<void>(resolve => { finishRead = resolve; }); return geometry(220, 80); }, async () => true, unpinNothing);
    const resizing = first.resize(100, 30);
    await started;
    coordinator.acquire('socket:@3', async () => geometry(220, 80), async () => true, unpinNothing);
    finishRead();

    await expect(resizing).resolves.toBe(true);
  });

  it('repairs pane geometry changed by an external tmux layout manager', async () => {
    const applied: Array<[number, number]> = [];
    let current = geometry(220, 80);
    const coordinator = new PaneViewportCoordinator(0);
    const lease = coordinator.acquire('socket:%1', async () => current, async (cols, rows) => {
      applied.push([cols, rows]);
      current = geometry(cols, rows);
      return true;
    }, unpinNothing);

    await expect(lease.resize(160, 50)).resolves.toBe(true);
    current = geometry(80, 54);
    await expect(lease.ensure(160, 50)).resolves.toEqual({ ok: true, resized: true });
    await expect(lease.ensure(160, 50)).resolves.toEqual({ ok: true, resized: false });

    expect(applied).toEqual([[160, 50], [160, 50]]);
  });

  it('never sizes a pane beyond what an attached terminal can show', async () => {
    const applied: Array<[number, number]> = [];
    const coordinator = new PaneViewportCoordinator(0);
    const lease = coordinator.acquire('socket:%1', async () => geometry(220, 80, { cols: 100, rows: 29 }), async (cols, rows) => { applied.push([cols, rows]); return true; }, unpinNothing);

    await expect(lease.resize(200, 50)).resolves.toBe(true);

    expect(applied).toEqual([[100, 29]]);
  });

  it('follows a terminal attaching to and detaching from the pane on the next tick', async () => {
    const applied: Array<[number, number]> = [];
    let current: PaneViewport = { cols: 220, rows: 80 };
    let terminal: PaneViewport | undefined;
    const coordinator = new PaneViewportCoordinator(0);
    const lease = coordinator.acquire('socket:%1', async () => geometry(current.cols, current.rows, terminal), async (cols, rows) => {
      applied.push([cols, rows]);
      current = { cols, rows };
      return true;
    }, unpinNothing);

    await expect(lease.resize(160, 50)).resolves.toBe(true);
    terminal = { cols: 100, rows: 29 };
    await expect(lease.ensure(160, 50)).resolves.toEqual({ ok: true, resized: true });
    await expect(lease.ensure(160, 50)).resolves.toEqual({ ok: true, resized: false });
    terminal = { cols: 100, rows: 28 };
    await expect(lease.ensure(160, 50)).resolves.toEqual({ ok: true, resized: true });
    terminal = undefined;
    await expect(lease.ensure(160, 50)).resolves.toEqual({ ok: true, resized: true });

    expect(applied).toEqual([[160, 50], [100, 29], [100, 28], [160, 50]]);
  });

  it('restores within the attached terminal and hands the window back to tmux on release', async () => {
    const applied: Array<[number, number]> = [];
    let unpinned = 0;
    const coordinator = new PaneViewportCoordinator(0);
    const lease = coordinator.acquire('socket:%1', async () => geometry(100, 29, { cols: 100, rows: 29 }), async (cols, rows) => { applied.push([cols, rows]); return true; }, async () => { unpinned += 1; return true; });

    await expect(lease.resize(62, 41)).resolves.toBe(true);
    await lease.release();

    expect(applied).toEqual([[62, 29], [100, 29]]);
    expect(unpinned).toBe(1);
  });

  it('leaves tmux alone when releasing a lease that never resized', async () => {
    const applied: Array<[number, number]> = [];
    let unpinned = 0;
    const coordinator = new PaneViewportCoordinator(0);
    const lease = coordinator.acquire('socket:%1', async () => geometry(220, 80), async (cols, rows) => { applied.push([cols, rows]); return true; }, async () => { unpinned += 1; return true; });

    await lease.release();

    expect(applied).toEqual([]);
    expect(unpinned).toBe(0);
  });

  it('still finishes a release when handing the window back throws', async () => {
    const coordinator = new PaneViewportCoordinator(0);
    const lease = coordinator.acquire('socket:%1', async () => geometry(220, 80), async () => true, async () => { throw new Error('tmux gone'); });

    await lease.resize(62, 41);
    await expect(lease.release()).resolves.toBeUndefined();
  });
});
