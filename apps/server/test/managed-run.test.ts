import { describe, expect, it, vi } from 'vitest';
import { launchFresh, managedRunProgress, type FreshLaunchSteps, type ReadinessOutcome } from '../src/launch/managed-run.js';
import type { Agent } from '../src/domain/models.js';

const agent = { id: 'agent-2' } as Agent;
// one fresh launch whose steps all succeed unless overridden
const steps = (over: Partial<FreshLaunchSteps> = {}): FreshLaunchSteps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    agentIds: async () => { calls.push('snapshot'); return new Set(['agent-1']); },
    launch: async () => { calls.push('launch'); return true; },
    waitForNewAgent: async before => { calls.push(`wait:${[...before].join(',')}`); return agent; },
    waitForReadiness: async (): Promise<ReadinessOutcome> => { calls.push('ready'); return { state: 'ready' }; },
    close: async id => { calls.push(`close:${id}`); },
    prepare: async () => { calls.push('prepare'); },
    deliver: async () => { calls.push('deliver'); return true; },
    ...over
  };
};

describe('managed run fresh launch', () => {
  it('snapshots, launches, waits for the Agent and its readiness, prepares, then delivers', async () => {
    const run = steps();
    await expect(launchFresh(run)).resolves.toEqual({ status: 'launched', agentId: 'agent-2' });
    expect(run.calls).toEqual(['snapshot', 'launch', 'wait:agent-1', 'ready', 'prepare', 'deliver']);
  });

  it('closes a pane that never became ready and names no agent', async () => {
    const blocked = steps({ waitForReadiness: async () => ({ state: 'blocked', reason: 'trust prompt' }) });
    await expect(launchFresh(blocked)).resolves.toEqual({ status: 'failed', reason: 'not-ready-blocked', detail: 'trust prompt' });
    expect(blocked.calls).toContain('close:agent-2');
    await expect(launchFresh(steps({ waitForReadiness: async () => ({ state: 'timed-out' }) }))).resolves.toEqual({ status: 'failed', reason: 'not-ready-timeout' });
  });

  it('reports a refused launch, a missing Agent and a failed delivery', async () => {
    await expect(launchFresh(steps({ launch: async () => false }))).resolves.toEqual({ status: 'failed', reason: 'launch-refused' });
    await expect(launchFresh(steps({ waitForNewAgent: async () => undefined }))).resolves.toEqual({ status: 'failed', reason: 'no-agent' });
    await expect(launchFresh(steps({ deliver: async () => false }))).resolves.toEqual({ status: 'failed', reason: 'delivery-failed', agentId: 'agent-2' });
  });

  it('never delivers after a prepare that left unconfirmed input in the pane', async () => {
    const deliver = vi.fn(async () => true);
    await expect(launchFresh(steps({ prepare: async () => false, deliver }))).resolves.toEqual({ status: 'failed', reason: 'delivery-failed', detail: 'the agent did not accept input', agentId: 'agent-2' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('never lets a failed prepare block delivery', async () => {
    const deliver = vi.fn(async () => true);
    await expect(launchFresh(steps({ prepare: async () => { throw new Error('rename failed'); }, deliver }))).resolves.toMatchObject({ status: 'launched' });
    expect(deliver).toHaveBeenCalled();
  });
});

describe('managed run progress', () => {
  it('reads idle as finished only after work was seen or past the start window', () => {
    expect(managedRunProgress('working', false, 0)).toBe('working');
    expect(managedRunProgress('question', true, 0)).toBe('question');
    expect(managedRunProgress('finished', true, 0)).toBe('finished');
    expect(managedRunProgress('finished', false, 1_000)).toBe('starting');
    expect(managedRunProgress('finished', false, 60_000)).toBe('finished');
    expect(managedRunProgress('finished', false, 500, 400)).toBe('finished');
  });
});
