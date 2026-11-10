import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/domain/models.js';
import { ConsoleEvents } from '../src/events.js';
import { AgentNotificationCoordinator, pushNotifications, type PushMessage } from '../src/notifications.js';
import { DashboardUpdates } from '../src/dashboard/updates.js';
import { PushDiagnostics } from '../src/push-diagnostics.js';

// retain real local key generation while replacing only the external sender
const webpush = vi.hoisted(() => ({ sendNotification: vi.fn(), setVapidDetails: vi.fn() }));
vi.mock('web-push', async importOriginal => {
  const original = await importOriginal<typeof import('web-push')>();
  return { default: { ...original.default, ...webpush } };
});

import { PushService } from '../src/push-service.js';

const directories: string[] = [];

// build one observed Agent state without any browser dependency
const agent = (attention: Agent['attention'], questionId?: string): Agent => ({
  id: 'agent-zero-window',
  transport: 'tmux',
  panel: 'terminal',
  pane: { paneId: '%1', sessionId: '$1', socketFingerprint: 'socket' },
  home: '/workspace',
  title: attention,
  kind: 'codex',
  attention,
  displayLabel: 'Zero Window',
  worktreeId: 'shared',
  ...(questionId === undefined ? {} : { question: { id: questionId, text: 'Continue?', choices: ['Yes'], source: 'structured', field: { kind: 'choice', choices: ['Yes'] } } })
});

// reset the external sender before each isolated composition
beforeEach(() => {
  webpush.sendNotification.mockReset();
  webpush.setVapidDetails.mockReset();
});

// restore timer behavior and remove private test stores
afterEach(async () => {
  vi.useRealTimers();
  // remove only stores created by this test file
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('zero-window notification delivery', () => {
  // prove the configured server cadence observes and delivers without page clients
  it.each([250, 500, 10_000])('generates question and completion events at %i ms cadence', async pollIntervalMs => {
    vi.useFakeTimers();
    const events = new ConsoleEvents();
    const provider = vi.fn(async (_message: PushMessage) => {});
    const coordinator = new AgentNotificationCoordinator(notification => provider(notification), Math.max(2_000, pollIntervalMs * 2));
    pushNotifications(events, coordinator, provider);
    let current = agent('working');
    const updates = new DashboardUpdates<{ generation: number }>();
    let generation = 0;
    updates.setLoader(async () => {
      events.emit({ type: 'agents', agents: [{ agent: current, queued: false, context: { projectName: 'RAC', worktreeName: 'Shared', multipleWorktrees: false }, quiet: false }] });
      return { generation: ++generation };
    });
    const timer = setInterval(() => void updates.refresh(), pollIntervalMs);

    await updates.refresh();
    expect(provider).not.toHaveBeenCalled();
    current = agent('question', 'question-zero-window');
    await vi.advanceTimersByTimeAsync(pollIntervalMs);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]?.[0]).toMatchObject({ eventId: 'question-zero-window', tag: 'agent-status-agent-zero-window' });

    current = agent('working');
    await vi.advanceTimersByTimeAsync(pollIntervalMs);
    current = agent('finished');
    await vi.advanceTimersByTimeAsync(pollIntervalMs);
    const completionId = coordinator.completionId(current);
    await vi.advanceTimersByTimeAsync(Math.max(2_000, pollIntervalMs * 2));
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[1]?.[0]).toMatchObject({ eventId: completionId, kind: 'finished', displayTag: 'rac-v1-agent-status-agent-zero-window' });

    clearInterval(timer);
    updates.close();
    coordinator.stop();
  });

  // keep overlapping observation work coalesced rather than fabricating duplicates
  it('keeps a slow dashboard observation pending across cadences', async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), 'rac-slow-observation-'));
    directories.push(directory);
    const diagnostics = new PushDiagnostics({ file: join(directory, 'push-diagnostics.json'), now: () => Date.now() });
    const observations: Array<{ stage: string; operationId: string; at: number; status: string }> = [];
    const updates = new DashboardUpdates<{ generation: number }>(value => JSON.stringify(value), {
      thresholdMs: 500,
      now: () => Date.now(),
      // capture the private slow-operation journal seam
      record: (stage, observation) => {
        observations.push({ stage, ...observation });
        void diagnostics.record(stage, { eventId: observation.operationId, status: observation.status }, observation.at);
      }
    });
    let loads = 0;
    let release!: () => void;
    updates.setLoader(async () => {
      loads += 1;
      await new Promise<void>(resolve => { release = resolve; });
      return { generation: loads };
    });

    const first = updates.refresh();
    const second = updates.refresh();
    expect(second).toBe(first);
    expect(loads).toBe(1);
    await vi.advanceTimersByTimeAsync(501);
    expect(observations).toEqual([{ stage: 'observation_started', operationId: expect.any(String), at: expect.any(Number), status: 'pending' }]);
    release();
    await first;
    expect(observations).toEqual([
      { stage: 'observation_started', operationId: expect.any(String), at: expect.any(Number), status: 'pending' },
      { stage: 'observation_settled', operationId: observations[0]!.operationId, at: expect.any(Number), status: 'settled' }
    ]);
    expect((await diagnostics.snapshot()).map(record => [record.stage, record.eventId, record.status])).toEqual([
      ['observation_started', observations[0]!.operationId, 'pending'],
      ['observation_settled', observations[0]!.operationId, 'settled']
    ]);

    // keep normal fast refreshes out of the bounded journal
    updates.setLoader(async () => ({ generation: 2 }));
    await updates.refresh();
    await vi.advanceTimersByTimeAsync(501);
    expect(observations).toHaveLength(2);
    expect(await diagnostics.snapshot()).toHaveLength(2);
    updates.close();
  });

  // prove zero-window observation reaches the real provider sender and journal
  it('records correlated generation and provider acceptance without page clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-zero-window-'));
    directories.push(directory);
    const subscriptionsFile = join(directory, 'push-subscriptions.json');
    const diagnostics = new PushDiagnostics({ file: join(directory, 'push-diagnostics.json') });
    const push = new PushService({ file: subscriptionsFile, diagnostics });
    await push.initialize();
    await push.subscribe({ endpoint: 'https://push.example.test/closed-android', keys: { auth: 'fixture-auth', p256dh: 'fixture-key' } });
    webpush.sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    const events = new ConsoleEvents();
    const coordinator = new AgentNotificationCoordinator(notification => push.notify(notification), 2_000);
    pushNotifications(events, coordinator, message => push.notify(message));
    let current = agent('working');
    const updates = new DashboardUpdates<{ generation: number }>();
    let generation = 0;
    updates.setLoader(async () => {
      events.emit({ type: 'agents', agents: [{ agent: current, queued: false, context: { projectName: 'RAC', worktreeName: 'Shared', multipleWorktrees: false }, quiet: false }] });
      return { generation: ++generation };
    });

    await updates.refresh();
    current = agent('question', 'closed-app-question');
    await updates.refresh();
    // wait only for the real provider boundary reached by best-effort coordinator delivery
    for (let attempt = 0; attempt < 100 && webpush.sendNotification.mock.calls.length === 0; attempt += 1) await new Promise<void>(resolve => setTimeout(resolve, 5));
    expect(webpush.sendNotification).toHaveBeenCalledOnce();
    let records = await diagnostics.snapshot();
    // wait for provider-result journaling to settle after sender acceptance
    for (let attempt = 0; attempt < 100 && !records.some(record => record.stage === 'provider_accepted'); attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      records = await diagnostics.snapshot();
    }

    const payload = JSON.parse(webpush.sendNotification.mock.calls[0]![1] as string) as Record<string, unknown>;
    expect(payload).toMatchObject({ eventId: 'closed-app-question', tag: 'agent-status-agent-zero-window' });
    expect(records.filter(record => record.eventId === payload.eventId).map(record => record.stage)).toEqual(['generated', 'send_started', 'provider_accepted']);
    expect(records.filter(record => record.eventId === payload.eventId).every(record => record.eventEpoch === payload.eventEpoch && record.eventSequence === payload.eventSequence)).toBe(true);

    updates.close();
    coordinator.stop();
  });
});
