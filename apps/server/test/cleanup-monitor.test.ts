import { afterEach, describe, expect, it, vi } from 'vitest';
import { CleanupMonitor } from '../src/cleanup/monitor.js';

describe('CleanupMonitor', () => {
  afterEach(() => vi.useRealTimers());

  it('scans immediately and hourly and refreshes the dashboard without cleanup notifications', async () => {
    vi.useFakeTimers();
    const scans = vi.fn()
      .mockResolvedValueOnce([{ id: 'cleanup-one', kind: 'stale-agent', label: 'Stale', detail: 'old' }])
      .mockResolvedValueOnce([]);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const monitor = new CleanupMonitor({ scan: scans }, { refresh } as never, 60 * 60 * 1_000);

    monitor.start();
    await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
    await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalledTimes(2);
    monitor.stop();
  });
});
