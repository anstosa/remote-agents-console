import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushSubscription } from 'web-push';

// retain the external provider mock across module loading
const webpush = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn()
}));

// retain real local key generation while replacing external delivery
vi.mock('web-push', async importOriginal => {
  const original = await importOriginal<typeof import('web-push')>();
  return { default: { ...original.default, ...webpush } };
});

import { PushService } from '../src/push-service.js';

const savedEnvironment = {
  file: process.env.RAC_PUSH_SUBSCRIPTIONS_FILE,
  privateKey: process.env.RAC_VAPID_PRIVATE_KEY,
  publicKey: process.env.RAC_VAPID_PUBLIC_KEY
};
const fixtureDirectories: string[] = [];

// build one valid browser subscription
const subscription = (name: string): PushSubscription => ({
  endpoint: `https://push.example.test/${name}`,
  keys: { auth: `auth-${name}`, p256dh: `p256dh-${name}` }
});

// build one isolated enabled service
const enabledService = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-push-'));
  fixtureDirectories.push(directory);
  const file = join(directory, 'subscriptions.json');
  process.env.RAC_PUSH_SUBSCRIPTIONS_FILE = file;
  const service = new PushService();
  await service.initialize();
  return { file, service };
};

// build one provider-shaped failure
const providerFailure = (statusCode?: number, headers: Record<string, string> = {}, secrets = {}) => Object.assign(new Error('provider detail'), {
  headers,
  statusCode,
  ...secrets
});

// wait until an asynchronous provider call reaches the mock
const waitForCalls = async (count: number) => {
  // bound the test-side readiness poll
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // return as soon as delivery starts
    if (webpush.sendNotification.mock.calls.length >= count) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`expected ${count} provider calls`);
};

// exercise delivery and storage contracts
describe('PushService', () => {
  // reset provider state and isolate credentials
  beforeEach(() => {
    webpush.sendNotification.mockReset();
    webpush.setVapidDetails.mockReset();
    delete process.env.RAC_PUSH_SUBSCRIPTIONS_FILE;
    delete process.env.RAC_VAPID_PRIVATE_KEY;
    delete process.env.RAC_VAPID_PUBLIC_KEY;
  });

  // restore caller state and remove temporary stores
  afterEach(async () => {
    vi.restoreAllMocks();
    // remove every isolated subscription store
    for (const directory of fixtureDirectories.splice(0)) await rm(directory, { force: true, recursive: true });
    // restore the caller's environment
    if (savedEnvironment.file === undefined) delete process.env.RAC_PUSH_SUBSCRIPTIONS_FILE;
    else process.env.RAC_PUSH_SUBSCRIPTIONS_FILE = savedEnvironment.file;
    // restore the caller's private key
    if (savedEnvironment.privateKey === undefined) delete process.env.RAC_VAPID_PRIVATE_KEY;
    else process.env.RAC_VAPID_PRIVATE_KEY = savedEnvironment.privateKey;
    // restore the caller's public key
    if (savedEnvironment.publicKey === undefined) delete process.env.RAC_VAPID_PUBLIC_KEY;
    else process.env.RAC_VAPID_PUBLIC_KEY = savedEnvironment.publicKey;
  });

  // retain only complete secure subscriptions
  it('validates and stores subscriptions by endpoint', async () => {
    const { file, service } = await enabledService();
    const valid = subscription('valid');
    expect(await service.subscribe(valid)).toBe(true);
    expect(await service.subscribe({ ...valid, endpoint: 'http://push.example.test/insecure' })).toBe(false);
    expect(await service.subscribe({ endpoint: 'https://push.example.test/missing', keys: { auth: '', p256dh: 'key' } })).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      [valid.endpoint]: valid,
      'https://push.example.test/missing': { endpoint: 'https://push.example.test/missing', keys: { auth: '', p256dh: 'key' } }
    });
    expect(webpush.setVapidDetails).not.toHaveBeenCalled();
  });

  // initialize and reuse a managed identity without any environment credentials
  it('automatically enables push and reuses its identity across service instances', async () => {
    const { service: first } = await enabledService();
    const service = new PushService();
    expect(service.enabled).toBe(false);
    await Promise.all([service.initialize(), service.initialize()]);
    expect(service.enabled).toBe(true);
    expect(service.publicKey).toBe(first.publicKey);
    await service.notify({ kind: 'cleanup', title: 'Cleanup', body: 'Removed stale state', tag: 'runtime-cleanup', url: '/#cleanup' });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  // avoid signing one instance's subscriptions with another instance's identity
  it('passes its own persisted credentials on every delivery without changing global sender state', async () => {
    const { service: first } = await enabledService();
    const { service: second } = await enabledService();
    expect(first.publicKey).not.toBe(second.publicKey);
    await first.subscribe(subscription('first-instance'));
    await second.subscribe(subscription('second-instance'));
    const message = { kind: 'cleanup' as const, title: 'Cleanup', body: 'Removed', tag: 'isolated-identity', url: '/' };
    await first.notify(message);
    await second.notify(message);
    expect(webpush.sendNotification.mock.calls.map(call => call[2]?.vapidDetails?.publicKey)).toEqual([first.publicKey, second.publicKey]);
    expect(webpush.setVapidDetails).not.toHaveBeenCalled();
  });

  // add timing metadata and explicit Android delivery options
  it('sends the complete wire payload and delivery options to every subscription', async () => {
    const { service } = await enabledService();
    const first = subscription('first');
    const second = subscription('second');
    await service.subscribe(first);
    await service.subscribe(second);
    webpush.sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123);
    const message = { kind: 'question' as const, title: 'Question', body: 'Choose a path', tag: 'agent-status-7', url: '/#agent=7', worktreeId: 'worktree-3' };
    await service.notify(message);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    const expectedPayload = JSON.stringify({ ...message, sentAt: 1_700_000_000_123 });
    const expectedOptions = {
      TTL: 3_600,
      timeout: 10_000,
      topic: createHash('sha256').update(message.tag).digest('base64url').slice(0, 32),
      urgency: 'high',
      vapidDetails: { subject: 'mailto:admin@localhost', publicKey: service.publicKey, privateKey: expect.any(String) }
    };
    expect(webpush.sendNotification).toHaveBeenNthCalledWith(1, first, expectedPayload, expectedOptions);
    expect(webpush.sendNotification).toHaveBeenNthCalledWith(2, second, expectedPayload, expectedOptions);
    expect(JSON.parse(expectedPayload).sentAt).toEqual(expect.any(Number));
  });

  // vary urgency and retention by event kind while preserving tag coalescing
  it('uses high urgency for actionable events, normal for cleanup, and a stable topic independent of kind', async () => {
    const { service } = await enabledService();
    await service.subscribe(subscription('options'));
    webpush.sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    const actionable = [
      { kind: 'question' as const, title: 'Question', body: 'Choose', tag: 'shared-status', url: '/#agent=1' },
      { kind: 'finished' as const, title: 'Done', body: 'Ready', tag: 'shared-status', url: '/#agent=1' },
      { kind: 'review' as const, title: 'Review', body: 'Ready', tag: 'review-1', url: '/#agent=1', worktreeId: 'one' },
      { kind: 'schedule' as const, title: 'Schedule', body: 'Failed', tag: 'schedule-1', url: '/' }
    ];
    // send each actionable kind
    for (const message of actionable) await service.notify(message);
    await service.notify({ kind: 'cleanup', title: 'Cleanup', body: 'Removed', tag: 'runtime-cleanup', url: '/#cleanup' });
    const options = webpush.sendNotification.mock.calls.map(call => call[2]);
    expect(options.slice(0, 4).map(value => value?.urgency)).toEqual(['high', 'high', 'high', 'high']);
    expect(options[4]?.urgency).toBe('normal');
    expect(options[0]?.TTL).toBe(3_600);
    expect(options[1]?.TTL).toBe(900);
    expect(options[0]?.topic).toBe(options[1]?.topic);
    expect(options.every(value => typeof value?.topic === 'string' && value.topic.length <= 32 && /^[\w-]+$/u.test(value.topic))).toBe(true);
  });

  // prune only subscriptions rejected as missing or expired
  it.each([404, 410])('prunes subscriptions after provider status %i', async statusCode => {
    const { file, service } = await enabledService();
    const expired = subscription(`expired-${statusCode}`);
    await service.subscribe(expired);
    webpush.sendNotification.mockRejectedValue(providerFailure(statusCode));
    await service.notify({ kind: 'finished', title: 'Done', body: 'Ready', tag: 'agent-status-9', url: '/#agent=9' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({});
  });

  // preserve subscriptions without retrying authentication failures
  it.each([401, 403])('keeps subscriptions and does not retry provider auth status %i', async statusCode => {
    const { file, service } = await enabledService();
    const retained = subscription(`retained-${statusCode}`);
    await service.subscribe(retained);
    webpush.sendNotification.mockRejectedValue(providerFailure(statusCode));
    await service.notify({ kind: 'finished', title: 'Done', body: 'Ready', tag: 'agent-status-9', url: '/#agent=9' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [retained.endpoint]: retained });
    expect(webpush.sendNotification).toHaveBeenCalledOnce();
  });

  // retry network, timeout, throttle, and server failures within the fixed bound
  it.each([undefined, 408, 429, 503])('retries transient provider status %s and stops after success', async statusCode => {
    const { service } = await enabledService();
    await service.subscribe(subscription(`retry-${statusCode ?? 'network'}`));
    webpush.sendNotification
      .mockRejectedValueOnce(providerFailure(statusCode, { 'Retry-After': '0' }))
      .mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} });
    await service.notify({ kind: 'question', title: 'Question', body: 'Choose', tag: `retry-${statusCode}`, url: '/' });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  // cap repeated transient attempts
  it('stops after three transient provider attempts', async () => {
    const { service } = await enabledService();
    await service.subscribe(subscription('bounded-retry'));
    webpush.sendNotification.mockRejectedValue(providerFailure(503, { 'retry-after': '0' }));
    await service.notify({ kind: 'question', title: 'Question', body: 'Choose', tag: 'bounded-retry', url: '/' });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(3);
  });

  // refuse an excessive provider delay instead of retrying prematurely
  it('does not retry before an unreasonable Retry-After delay', async () => {
    const { service } = await enabledService();
    await service.subscribe(subscription('long-retry'));
    webpush.sendNotification.mockRejectedValue(providerFailure(429, { 'Retry-After': '31' }));
    await service.notify({ kind: 'question', title: 'Question', body: 'Choose', tag: 'long-retry', url: '/' });
    expect(webpush.sendNotification).toHaveBeenCalledOnce();
  });

  // keep provider diagnostics free of subscription and payload secrets
  it('logs only provider status, attempt, event kind, and an endpoint fingerprint', async () => {
    const { service } = await enabledService();
    const secretSubscription = subscription('secret-endpoint');
    await service.subscribe(secretSubscription);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    webpush.sendNotification.mockRejectedValue(providerFailure(403, {}, { body: 'secret-provider-body' }));
    await service.notify({ kind: 'question', title: 'Secret title', body: 'secret-message-body', tag: 'secret-tag', url: '/' });
    expect(warning).toHaveBeenCalledWith('[push] provider request failed', {
      attempt: 1,
      endpointFingerprint: expect.stringMatching(/^[\w-]{12}$/u),
      kind: 'question',
      retry: false,
      status: 403
    });
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).not.toContain(secretSubscription.endpoint);
    expect(logged).not.toContain(secretSubscription.keys.auth);
    expect(logged).not.toContain(secretSubscription.keys.p256dh);
    expect(logged).not.toContain('secret-provider-body');
    expect(logged).not.toContain('secret-message-body');
  });

  // preserve corrupt stores and recover after a later valid snapshot
  it('propagates parse failures without overwriting subscriptions and recovers on the next snapshot', async () => {
    const { file, service } = await enabledService();
    const retained = subscription('parse-secret');
    await service.subscribe(retained);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeFile(file, 'private-corrupt-content');
    await expect(service.notify({ kind: 'question', title: 'Question', body: 'Choose', tag: 'parse-recovery', url: '/' })).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(file, 'utf8')).toBe('private-corrupt-content');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith('[push] subscription store failed', { code: 'SyntaxError', operation: 'parse' });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-corrupt-content');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(retained.endpoint);
    await writeFile(file, JSON.stringify({ [retained.endpoint]: retained }));
    webpush.sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await service.notify({ kind: 'question', title: 'Question', body: 'Choose', tag: 'parse-recovery', url: '/' });
    expect(webpush.sendNotification).toHaveBeenCalledOnce();
  });

  // propagate non-absence read failures without creating a replacement store
  it('does not treat subscription read failures as an empty store', async () => {
    const { file, service } = await enabledService();
    const secret = subscription('read-secret');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mkdir(file);
    await expect(service.subscribe(secret)).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'EISDIR' });
    expect(diagnostic).toHaveBeenCalledWith('[push] subscription store failed', { code: 'EISDIR', operation: 'read' });
    const logged = JSON.stringify(diagnostic.mock.calls);
    expect(logged).not.toContain(secret.endpoint);
    expect(logged).not.toContain(secret.keys.auth);
  });

  // prune several expired endpoints in one notification
  it('prunes multiple provider-expired endpoints', async () => {
    const { file, service } = await enabledService();
    await service.subscribe(subscription('expired-first'));
    await service.subscribe(subscription('expired-second'));
    webpush.sendNotification.mockRejectedValue(providerFailure(410));
    await service.notify({ kind: 'finished', title: 'Done', body: 'Ready', tag: 'multi-prune', url: '/' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({});
  });

  // preserve concurrent registrations while pruning an old snapshot
  it('does not drop a registration added while provider pruning is in flight', async () => {
    const { file, service } = await enabledService();
    const expired = subscription('overlap-expired');
    const added = subscription('overlap-added');
    await service.subscribe(expired);
    let rejectDelivery!: (error: unknown) => void;
    webpush.sendNotification.mockImplementationOnce(async () => await new Promise((_resolve, reject) => { rejectDelivery = reject; }));
    const notifying = service.notify({ kind: 'finished', title: 'Done', body: 'Ready', tag: 'overlap', url: '/' });
    await waitForCalls(1);
    await service.subscribe(added);
    rejectDelivery(providerFailure(410));
    await notifying;
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [added.endpoint]: added });
  });

  // preserve refreshed credentials rejected only for an older snapshot
  it('does not prune a subscription refreshed during delivery', async () => {
    const { file, service } = await enabledService();
    const previous = subscription('refreshed');
    const refreshed = { ...previous, keys: { auth: 'new-auth', p256dh: 'new-p256dh' } };
    await service.subscribe(previous);
    let rejectDelivery!: (error: unknown) => void;
    webpush.sendNotification.mockImplementationOnce(async () => await new Promise((_resolve, reject) => { rejectDelivery = reject; }));
    const notifying = service.notify({ kind: 'finished', title: 'Done', body: 'Ready', tag: 'refresh', url: '/' });
    await waitForCalls(1);
    await service.subscribe(refreshed);
    rejectDelivery(providerFailure(410));
    await notifying;
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [refreshed.endpoint]: refreshed });
  });

  // clear the latest marker and store queue after a prune write failure
  it('recovers after pruning cannot write the subscription store', async () => {
    const { file, service } = await enabledService();
    const retained = subscription('prune-write-failure');
    await service.subscribe(retained);
    await mkdir(`${file}.next`);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    webpush.sendNotification.mockRejectedValueOnce(providerFailure(410));
    const message = { kind: 'finished' as const, title: 'Done', body: 'Ready', tag: 'prune-write-recovery', url: '/' };
    await expect(service.notify(message)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ [retained.endpoint]: retained });
    expect(diagnostic).toHaveBeenCalledWith('[push] subscription store failed', { code: 'EISDIR', operation: 'write' });
    const logged = JSON.stringify(diagnostic.mock.calls);
    expect(logged).not.toContain(file);
    expect(logged).not.toContain(retained.keys.auth);
    await rm(`${file}.next`, { recursive: true });
    webpush.sendNotification.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} });
    await service.notify(message);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
  });

  // preserve provider acceptance order for notifications with the same endpoint and topic
  it('waits for an older in-flight provider request before sending a newer same-topic event', async () => {
    const { service } = await enabledService();
    const retained = subscription('delivery-queue');
    await service.subscribe(retained);
    let resolveOld!: (result: { statusCode: number; body: string; headers: Record<string, string> }) => void;
    webpush.sendNotification.mockImplementationOnce(async () => await new Promise<{ statusCode: number; body: string; headers: Record<string, string> }>(resolve => { resolveOld = resolve; }));
    webpush.sendNotification.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} });
    const old = service.notify({ kind: 'question', title: 'Old', body: 'Old state', tag: 'queued-topic', url: '/' });
    await waitForCalls(1);
    const current = service.notify({ kind: 'finished', title: 'Current', body: 'Current state', tag: 'queued-topic', url: '/' });
    // settle the newer snapshot and queue append without a timing guess
    await service.subscribe(retained);
    expect(webpush.sendNotification).toHaveBeenCalledOnce();
    resolveOld({ statusCode: 201, body: '', headers: {} });
    await Promise.all([old, current]);
    const titles = webpush.sendNotification.mock.calls.map(call => JSON.parse(call[1] as string).title as string);
    expect(titles).toEqual(['Old', 'Current']);
  });

  // keep an older retry eligible when a newer snapshot fails before publication
  it('does not let a newer failed snapshot suppress an older retry', async () => {
    const { file, service } = await enabledService();
    const retained = subscription('failed-newer-snapshot');
    await service.subscribe(retained);
    let rejectOld!: (error: unknown) => void;
    webpush.sendNotification.mockImplementationOnce(async () => await new Promise((_resolve, reject) => { rejectOld = reject; }));
    webpush.sendNotification.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} });
    const old = service.notify({ kind: 'question', title: 'Old', body: 'Old state', tag: 'failed-snapshot-topic', url: '/' });
    await waitForCalls(1);
    await writeFile(file, 'corrupt-newer-snapshot');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const newer = service.notify({ kind: 'finished', title: 'Current', body: 'Current state', tag: 'failed-snapshot-topic', url: '/' });
    await expect(newer).rejects.toBeInstanceOf(SyntaxError);
    rejectOld(providerFailure(503, { 'Retry-After': '0' }));
    await old;
    const titles = webpush.sendNotification.mock.calls.map(call => JSON.parse(call[1] as string).title as string);
    expect(titles).toEqual(['Old', 'Old']);
    expect(diagnostic).toHaveBeenCalledWith('[push] subscription store failed', { code: 'SyntaxError', operation: 'parse' });
  });

  // suppress an older same-topic retry after a newer event starts
  it('does not retry stale events after a newer same-topic notification', async () => {
    const { service } = await enabledService();
    const retained = subscription('stale-retry');
    await service.subscribe(retained);
    let rejectOld!: (error: unknown) => void;
    // hold only the first old provider request
    webpush.sendNotification.mockImplementationOnce(async () => await new Promise((_resolve, reject) => { rejectOld = reject; }));
    // resolve current delivery or any incorrect old retry
    webpush.sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    const old = service.notify({ kind: 'question', title: 'Old', body: 'Old state', tag: 'same-topic', url: '/' });
    await waitForCalls(1);
    const current = service.notify({ kind: 'finished', title: 'Current', body: 'Current state', tag: 'same-topic', url: '/' });
    // wait past the newer successful snapshot before releasing the old request
    await service.subscribe(retained);
    rejectOld(providerFailure(503, { 'Retry-After': '0' }));
    await Promise.all([old, current]);
    const titles = webpush.sendNotification.mock.calls.map(call => JSON.parse(call[1] as string).title as string);
    expect(titles).toEqual(['Old', 'Current']);
  });

  // release a coalescing queue immediately when a long retry is superseded
  it('does not let superseded Retry-After backoff delay the newer same-topic event', async () => {
    const { service } = await enabledService();
    const retained = subscription('superseded-long-backoff');
    await service.subscribe(retained);
    let rejectOld!: (error: unknown) => void;
    // hold only the first old provider request
    webpush.sendNotification.mockImplementationOnce(async () => await new Promise((_resolve, reject) => { rejectOld = reject; }));
    // resolve current delivery or any incorrect old retry
    webpush.sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    const old = service.notify({ kind: 'question', title: 'Old', body: 'Old state', tag: 'long-backoff-topic', url: '/' });
    await waitForCalls(1);
    rejectOld(providerFailure(429, { 'Retry-After': '30' }));
    // let the provider rejection enter backoff before superseding it
    await new Promise<void>(resolve => setImmediate(resolve));
    const current = service.notify({ kind: 'finished', title: 'Current', body: 'Current state', tag: 'long-backoff-topic', url: '/' });
    await Promise.all([old, current]);
    const titles = webpush.sendNotification.mock.calls.map(call => JSON.parse(call[1] as string).title as string);
    expect(titles).toEqual(['Old', 'Current']);
  });
});
