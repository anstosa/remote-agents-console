import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/domain/models.js';
import { parsePiUpdatePromptInput, piUpdateAgent, PiUpdatePromptCoordinator, piUpdatePrompt, piUpdateWorktree } from '../src/agent-updates/pi-update-prompt.js';
import { testWorktree } from './helpers/config.js';

const available = { kind: 'pi' as const, currentVersion: '1.4.0', latestVersion: '1.5.0', updateAvailable: true, pinned: true as const };
const input = { requestId: 'pi-update-request-1', currentVersion: '1.4.0', targetVersion: '1.5.0' };

// build one minimal discovered Agent for selection tests
const agent = (id: string, overrides: Partial<Agent> = {}): Agent => ({ id, transport: 'tmux', panel: 'terminal', home: '/repo', title: 'Ready', kind: 'codex', attention: 'finished', worktreeId: 'proj:/repo', ...overrides });

describe('Pi update prompt', () => {
  it('accepts only closed version snapshots and retry identities', () => {
    expect(parsePiUpdatePromptInput(input)).toEqual(input);
    expect(parsePiUpdatePromptInput({ ...input, command: 'install pi' })).toBeUndefined();
    expect(parsePiUpdatePromptInput({ ...input, requestId: 'short' })).toBeUndefined();
    expect(parsePiUpdatePromptInput({ ...input, targetVersion: 'latest' })).toBeUndefined();
  });

  it('matches the console checkout on both local and host identities', () => {
    const exact = testWorktree({ id: 'proj:/repo', identity: '/repo', hostPath: '/host/repo' });
    const bridged = testWorktree({ id: 'proj:/workspace', identity: '/workspace', hostPath: '/host/repo' });
    const wrongHost = testWorktree({ id: 'other:/repo', projectId: 'other', identity: '/repo', hostPath: '/host/other' });
    expect(piUpdateWorktree([wrongHost, exact], '/repo', '/host/repo')).toBe(exact);
    expect(piUpdateWorktree([wrongHost, bridged], '/workspace', '/host/repo')).toBe(bridged);
    expect(piUpdateWorktree([exact], '/repo', undefined)).toBeUndefined();
    expect(piUpdateWorktree([exact, { ...exact, id: 'duplicate' }], '/repo', '/host/repo')).toBeUndefined();
  });

  it('chooses a deterministic ordinary Agent and excludes managed roles', () => {
    const agents = [
      agent('review', { reviewRun: 'review-1' }),
      agent('worker', { spawnedBy: 'conductor' }),
      agent('conductor', { structured: { lifecycle: 'live', role: 'conductor', revision: 1, switchable: false } }),
      agent('exited', { structured: { lifecycle: 'exited', revision: 1, switchable: false } }),
      agent('failed', { structured: { lifecycle: 'failed', revision: 1, switchable: false } }),
      agent('starting', { structured: { lifecycle: 'starting', revision: 1, switchable: false } }),
      agent('z-normal'),
      agent('a-normal'),
      agent('elsewhere', { worktreeId: 'proj:/other' })
    ];
    const worktree = testWorktree({ id: 'proj:/repo', identity: '/repo', hostPath: '/host/repo' });
    expect(piUpdateAgent(agents, worktree)?.id).toBe('a-normal');
    expect(piUpdateAgent([agent('spoofed', { home: '/other' })], worktree)).toBeUndefined();
  });

  it('builds a bounded local-change prompt without update side effects', () => {
    const prompt = piUpdatePrompt('1.4.0', '1.5.0');
    expect(prompt).toContain('from 1.4.0 to 1.5.0');
    expect(prompt).toContain('Read that release\'s package metadata');
    expect(prompt).toContain('pnpm-lock.yaml');
    expect(prompt).toContain('Do not pull, commit, push, deploy, restart services');
    expect(prompt).toContain('do not choose the Codemode version independently');
  });

  it('rejects stale versions before resolving or submitting a target', async () => {
    const resolveTarget = vi.fn(async () => ({ worktreeId: 'proj:/repo', existingAgentId: 'agent-1' }));
    const submitExisting = vi.fn(async () => true);
    const coordinator = new PiUpdatePromptCoordinator({ agentUpdates: { statuses: async () => [{ ...available, latestVersion: '1.6.0' }] }, resolveTarget, submitExisting, launchAndSubmit: async () => ({ agentId: 'new' }) });
    await expect(coordinator.submit('session', input)).resolves.toEqual({ outcome: 'stale', error: 'The available Pi update changed. Reopen the launcher and review the current version.' });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(submitExisting).not.toHaveBeenCalled();
  });

  it('reuses one ordinary Agent and deduplicates simultaneous browser retries', async () => {
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const submitExisting = vi.fn(async () => { await gate; return true; });
    const launchAndSubmit = vi.fn(async () => ({ agentId: 'new' }));
    const coordinator = new PiUpdatePromptCoordinator({ agentUpdates: { statuses: async () => [available] }, resolveTarget: async () => ({ worktreeId: 'proj:/repo', existingAgentId: 'agent-1' }), submitExisting, launchAndSubmit });
    const first = coordinator.submit('session', input);
    const retry = coordinator.submit('session', input);
    const coalesced = coordinator.submit('another-session', { ...input, requestId: 'pi-update-request-2' });
    await vi.waitFor(() => expect(submitExisting).toHaveBeenCalledTimes(1));
    release();
    const result = { outcome: 'submitted' as const, agentId: 'agent-1', worktreeId: 'proj:/repo' };
    await expect(Promise.all([first, retry, coalesced])).resolves.toEqual([result, result, result]);
    expect(launchAndSubmit).not.toHaveBeenCalled();
    expect(submitExisting.mock.calls[0]?.[1]).toContain('@earendil-works/pi-coding-agent');
  });

  it('launches through the normal worktree path only when no ordinary Agent exists', async () => {
    const submitExisting = vi.fn(async () => true);
    const launchAndSubmit = vi.fn(async () => ({ agentId: 'agent-new' }));
    const coordinator = new PiUpdatePromptCoordinator({ agentUpdates: { statuses: async () => [available] }, resolveTarget: async () => ({ worktreeId: 'proj:/repo' }), submitExisting, launchAndSubmit });
    await expect(coordinator.submit('session', input)).resolves.toEqual({ outcome: 'submitted', agentId: 'agent-new', worktreeId: 'proj:/repo' });
    expect(submitExisting).not.toHaveBeenCalled();
    expect(launchAndSubmit).toHaveBeenCalledExactlyOnceWith('proj:/repo', expect.stringContaining('local code change'));
  });

  it('launches fresh instead of stranding the prompt on a retained dead Agent', async () => {
    const worktree = testWorktree({ id: 'proj:/repo', identity: '/repo' });
    const dead = agent('agent-dead', { structured: { lifecycle: 'exited', revision: 2, switchable: false } });
    const submitExisting = vi.fn(async () => true);
    const launchAndSubmit = vi.fn(async () => ({ agentId: 'agent-fresh' }));
    const coordinator = new PiUpdatePromptCoordinator({
      agentUpdates: { statuses: async () => [available] },
      resolveTarget: async () => {
        const existing = piUpdateAgent([dead], worktree);
        return { worktreeId: worktree.id, ...(existing === undefined ? {} : { existingAgentId: existing.id }) };
      },
      submitExisting,
      launchAndSubmit
    });
    await expect(coordinator.submit('session', input)).resolves.toEqual({ outcome: 'submitted', agentId: 'agent-fresh', worktreeId: 'proj:/repo' });
    expect(submitExisting).not.toHaveBeenCalled();
    expect(launchAndSubmit).toHaveBeenCalledOnce();
  });

  it('retains ambiguous delivery failures for one retry identity', async () => {
    const submitExisting = vi.fn(async () => false);
    const coordinator = new PiUpdatePromptCoordinator({ agentUpdates: { statuses: async () => [available] }, resolveTarget: async () => ({ worktreeId: 'proj:/repo', existingAgentId: 'agent-1' }), submitExisting, launchAndSubmit: async () => ({}) });
    const failed = { outcome: 'failed' as const, error: 'Prompt delivery could not be confirmed. Check the Remote Agents checkout before trying again.' };
    await expect(coordinator.submit('session', input)).resolves.toEqual(failed);
    await expect(coordinator.submit('session', input)).resolves.toEqual(failed);
    expect(submitExisting).toHaveBeenCalledTimes(1);
  });

  it('allows the same retry identity after a safe availability failure', async () => {
    let availableNow = false;
    const submitExisting = vi.fn(async () => true);
    const coordinator = new PiUpdatePromptCoordinator({
      agentUpdates: { statuses: async () => [available] },
      resolveTarget: async () => availableNow ? { worktreeId: 'proj:/repo', existingAgentId: 'agent-1' } : undefined,
      submitExisting,
      launchAndSubmit: async () => ({})
    });
    await expect(coordinator.submit('session', input)).resolves.toMatchObject({ outcome: 'unavailable' });
    availableNow = true;
    await expect(coordinator.submit('session', input)).resolves.toMatchObject({ outcome: 'submitted', agentId: 'agent-1' });
    expect(submitExisting).toHaveBeenCalledTimes(1);
  });
});
