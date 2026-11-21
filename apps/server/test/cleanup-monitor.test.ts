import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanupMonitor } from '../src/cleanup/monitor.js';

describe('CleanupMonitor', () => {
  afterEach(() => vi.useRealTimers());

  // the watcher can publish a cleanup task but cannot execute one
  it('scans immediately and hourly and publishes suggestions without executing cleanup', async () => {
    vi.useFakeTimers();
    const scan = vi.fn().mockResolvedValue([{ id: 'idle', kind: 'stale-agent', label: 'Idle agent', detail: 'Idle for more than 24 hours' }]);
    const cleanup = vi.fn();
    const refresh = vi.fn().mockResolvedValue(undefined);
    const service = { scan, cleanup };
    const monitor = new CleanupMonitor(service, { refresh } as never, 60 * 60 * 1_000);

    monitor.start();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalledTimes(2);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
