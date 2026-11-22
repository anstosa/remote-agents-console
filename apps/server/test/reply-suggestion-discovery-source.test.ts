import { describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../src/adapters/registry.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { paneLister, socketFinder } from './helpers/discovery-stubs.js';

describe('DiscoveryService reply source targets', () => {
  it('publishes stable atomic identities and rejects recognized PID reuse', async () => {
    let process = { kind: 'codex' as const, pid: 456, startTime: '100', wrapped: false };
    const processes = { recognizeAgent: vi.fn(async () => ({ ...process })) };
    const tmux = paneLister([{
      paneId: '%1', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready',
      reportedAttention: 'finished', reportedSession: '11111111-2222-4333-8444-555555555555'
    }]);
    const service = new DiscoveryService(socketFinder(), tmux as never, processes);
    const [agent] = await service.refresh(true);
    const first = service.replySuggestionTarget(agent!.id)!;
    expect(first).toMatchObject({ panePid: 123, process: { pid: 456, startTime: '100' }, kind: 'codex' });

    await service.refresh(true);
    expect(service.replySuggestionTarget(agent!.id)!.generation).toBe(first.generation);
    await expect(service.validateReplySuggestionTarget(first)).resolves.toBe(true);

    process = { ...process, startTime: '101' };
    await service.refresh(true);
    const replaced = service.replySuggestionTarget(agent!.id)!;
    expect(replaced.generation).toBeGreaterThan(first.generation);
    await expect(service.validateReplySuggestionTarget(first)).resolves.toBe(false);
    await expect(service.validateReplySuggestionTarget(replaced)).resolves.toBe(true);
  });

  it('keeps dashboard recognition while omitting an unproved process lifetime', async () => {
    const processes = { recognizeAgent: async (pid: number) => ({ kind: 'claude' as const, pid, wrapped: false }) };
    const service = new DiscoveryService(socketFinder(), paneLister([{
      paneId: '%2', sessionId: '$0', pid: 222, path: '/tmp', title: 'Ready', reportedAttention: 'finished'
    }]) as never, processes);
    const [agent] = await service.refresh(true);
    expect(agent?.kind).toBe('claude');
    expect(service.replySuggestionTarget(agent!.id)).toBeUndefined();
  });

  it('requires the replacement Claude process to report its own conversation', async () => {
    const firstSession = '11111111-2222-4333-8444-555555555555';
    const secondSession = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    let process = { kind: 'claude' as const, pid: 456, startTime: '100', wrapped: false };
    const processes = { recognizeAgent: vi.fn(async () => ({ ...process })) };
    const pane = {
      paneId: '%4', sessionId: '$0', pid: 123, path: '/tmp', title: 'Ready',
      reportedAttention: 'finished', reportedSession: firstSession,
      reportedSessionProcesses: `${firstSession}|456:100` as string | undefined
    };
    const service = new DiscoveryService(socketFinder(), paneLister([pane]) as never, processes);
    const [agent] = await service.refresh(true);
    const original = service.replySuggestionTarget(agent!.id)!;
    await expect(service.previewConversationOwned(original)).resolves.toBe(true);

    // a session-only update cannot reuse ancestry reported for another session
    pane.reportedSession = secondSession;
    await service.refresh(true);
    await expect(service.previewConversationOwned(service.replySuggestionTarget(agent!.id)!)).resolves.toBe(false);

    // absent proof remains unavailable even while the process stays live
    pane.reportedSessionProcesses = undefined;
    await service.refresh(true);
    await expect(service.previewConversationOwned(service.replySuggestionTarget(agent!.id)!)).resolves.toBe(false);

    // a retained report from the previous process cannot authorize the replacement
    process = { ...process, pid: 789, startTime: '200' };
    await service.refresh(true);
    const mixed = service.replySuggestionTarget(agent!.id)!;
    await expect(service.previewConversationOwned(mixed)).resolves.toBe(false);

    // a hook report from the replacement establishes its exact lifetime
    pane.reportedSessionProcesses = `${secondSession}|789:200`;
    await service.refresh(true);
    await expect(service.previewConversationOwned(service.replySuggestionTarget(agent!.id)!)).resolves.toBe(true);
  });

  it('publishes an observed source key for a tmux message question', async () => {
    const latestMessage = vi.spyOn(adapterFor('codex')!.conversations!, 'latestMessage').mockResolvedValue('Should I deploy now?');
    const service = new DiscoveryService(socketFinder(), paneLister([{
      paneId: '%3', sessionId: '$0', pid: 333, path: '/tmp', title: 'Ready', reportedAttention: 'finished'
    }]) as never, { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, startTime: '300', wrapped: false }) });
    const suggestions = { observe: vi.fn(async () => 'source-key'), invalidate: vi.fn(), refresh: vi.fn() };
    service.useReplySuggestions(suggestions as never);
    try {
      const [agent] = (await service.dashboard(false, true)).agents;
      expect(agent).toMatchObject({ hasMessageQuestion: true, messageReplySuggestionKey: 'source-key' });
      expect(suggestions.observe).toHaveBeenCalledWith(agent!.id);
    } finally {
      latestMessage.mockRestore();
    }
  });
});
