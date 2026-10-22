import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = await readFile(new URL('../../web/public/sw.js', import.meta.url), 'utf8');

// exercise the shipped worker without a browser notification provider
function worker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const focus = vi.fn().mockResolvedValue(undefined);
  const navigate = vi.fn().mockResolvedValue({ focus });
  const openWindow = vi.fn().mockResolvedValue(undefined);
  const cachedPreference = vi.fn().mockResolvedValue(undefined);
  const clients = { claim: vi.fn(), matchAll: vi.fn().mockResolvedValue([{ url: 'https://agents.example.com/', navigate, focus }]), openWindow };
  const self = {
    // retain registered event handlers
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    skipWaiting: vi.fn(), clients, location: { origin: 'https://agents.example.com' }, registration: { showNotification }
  };
  runInNewContext(source, { self, clients, URL, caches: { match: cachedPreference } });
  // await the worker lifetime promise
  const dispatch = async (name: string, event: Record<string, unknown>) => {
    const waitUntil = vi.fn();
    listeners.get(name)!({ ...event, waitUntil });
    await Promise.all(waitUntil.mock.calls.map(([promise]) => promise));
    return waitUntil;
  };
  return { dispatch, showNotification, navigate, focus, openWindow, cachedPreference };
}

// preserve immediate display and durable routing
describe('push service worker', () => {
  // honor the browser's cached opt-out without suppressing visible alerts
  it.each([false, true])('displays notifications with cached sound muting set to %s', async muted => {
    const { dispatch, showNotification, cachedPreference } = worker();
    cachedPreference.mockResolvedValue(muted ? {} : undefined);
    await dispatch('push', { data: { json: () => ({ title: 'Done' }) } });
    expect(showNotification).toHaveBeenCalledWith('Done', expect.objectContaining({ silent: muted }));
  });

  // preserve push delivery when browser preference storage is unavailable
  it('displays notifications when the sound preference cache fails', async () => {
    const { dispatch, showNotification, cachedPreference } = worker();
    cachedPreference.mockRejectedValue(new Error('cache unavailable'));
    await dispatch('push', { data: { json: () => ({ title: 'Done' }) } });
    expect(showNotification).toHaveBeenCalledWith('Done', expect.objectContaining({ silent: false }));
  });

  // keep delivery independent of an open app or a fetch
  it('displays an actionable push inside the worker lifetime', async () => {
    const { dispatch, showNotification } = worker();
    const waitUntil = await dispatch('push', { data: { json: () => ({ title: 'Question', body: 'Continue?', kind: 'question', tag: 'worktree-status-wt', worktreeId: 'project:/worktree', url: '/#agent=old' }) } });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(showNotification).toHaveBeenCalledWith('Question', expect.objectContaining({
      body: 'Continue?', tag: 'worktree-status-wt', requireInteraction: true,
      data: { url: '/#worktree=project%3A%2Fworktree', kind: 'question', worktreeId: 'project:/worktree' }
    }));
  });

  // retain already queued payloads from older senders
  it('displays a legacy payload with the existing defaults', async () => {
    const { dispatch, showNotification } = worker();
    await dispatch('push', {});
    expect(showNotification).toHaveBeenCalledWith('Remote Agent Console', expect.objectContaining({ body: 'An agent is ready.', requireInteraction: false, data: { url: '/', kind: undefined, worktreeId: undefined } }));
  });

  // show when the event occurred rather than when it finally arrived
  it('displays the original event timestamp', async () => {
    const { dispatch, showNotification } = worker();
    const sentAt = Date.now() - 60_000;
    await dispatch('push', { data: { json: () => ({ title: 'Done', kind: 'finished', sentAt }) } });
    expect(showNotification).toHaveBeenCalledWith('Done', expect.objectContaining({ timestamp: sentAt }));
  });

  // reject malformed timestamps while preserving visible delivery
  it.each([undefined, null, '123', -1, NaN, Infinity])('ignores an invalid timestamp %s without dropping the push', async sentAt => {
    const { dispatch, showNotification } = worker();
    await dispatch('push', { data: { json: () => ({ title: 'Done', sentAt }) } });
    expect(showNotification).toHaveBeenCalledWith('Done', expect.objectContaining({ timestamp: undefined }));
  });

  // keep notification clicks anchored to the worktree
  it('navigates and focuses an existing console window', async () => {
    const { dispatch, navigate, focus, openWindow } = worker();
    const close = vi.fn();
    await dispatch('notificationclick', { notification: { close, data: { worktreeId: 'wt', url: '/#agent=old' } } });
    expect(close).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith('https://agents.example.com/#worktree=wt');
    expect(focus).toHaveBeenCalledOnce();
    expect(openWindow).not.toHaveBeenCalled();
  });
});
