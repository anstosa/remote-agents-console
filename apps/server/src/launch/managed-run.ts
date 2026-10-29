import type { AttentionState } from '../adapters/types.js';
import type { Agent } from '../domain/models.js';
import type { LaunchOutcome } from '../transports/transport.js';

// ── Managed runs ──────────────────────────────────────────────────────────────────
// A managed run launches a fresh Agent, delivers one prompt, watches its attention to an end
// and then closes its pane. Scheduled prompts' unattended Runs and interactive Review runs
// (ADR 0010) share it: the scheduler keeps its watch on the Note and advances it each
// reconcile tick, while a Review run polls its watch in memory.

// whether a freshly launched pane became ready for its first prompt, per the Adapter's `ready` rule
export type ReadinessOutcome = { state: 'ready' } | { state: 'blocked'; reason: string } | { state: 'timed-out' };
export type FreshLaunchFailure = 'launch-refused' | 'no-agent' | 'not-ready-blocked' | 'not-ready-timeout' | 'delivery-failed';
// `detail` carries a blocked readiness's reason; `agentId` survives only when the pane is left open
export type FreshLaunchOutcome = { status: 'launched'; agentId: string } | { status: 'failed'; reason: FreshLaunchFailure; detail?: string; agentId?: string };
// The caller's steps for one fresh launch: launch the Agent through its Transport, which answers
// with the new Agent, wait for its readiness, then `prepare` it (best-effort: name the
// conversation) and deliver the prompt. `close` removes a pane that never became ready. A
// `prepare` that resolves `false` left input in the pane it could not confirm, so the prompt is
// not pasted after it.
export type FreshLaunchSteps = {
  launch(): Promise<LaunchOutcome>;
  waitForReadiness(agent: Agent): Promise<ReadinessOutcome>;
  close(agentId: string): Promise<unknown>;
  prepare?(agent: Agent): Promise<unknown>;
  deliver(agent: Agent): Promise<boolean>;
};

// Launch a fresh Agent and deliver its first prompt. A blocked or slow readiness closes the
// pane this launch created rather than leaving it behind, so the outcome carries no agent id;
// a failed delivery leaves the ready pane open and names it.
export async function launchFresh(steps: FreshLaunchSteps): Promise<FreshLaunchOutcome> {
  const launched = await steps.launch();
  // a refused launch (an unconfigured or unlaunchable kind, or a busy worktree) pastes nothing
  if (!('agent' in launched)) return { status: 'failed', reason: launched.failure === 'refused' ? 'launch-refused' : 'no-agent' };
  const { agent } = launched;
  const readiness = await steps.waitForReadiness(agent);
  if (readiness.state !== 'ready') {
    await steps.close(agent.id).catch(() => undefined);
    return readiness.state === 'blocked' ? { status: 'failed', reason: 'not-ready-blocked', detail: readiness.reason } : { status: 'failed', reason: 'not-ready-timeout' };
  }
  // a failed naming never blocks delivery, but a rename left unsent in the composer would be
  // submitted as one command with the prompt pasted after it
  if (await steps.prepare?.(agent).catch(() => undefined) === false) return { status: 'failed', reason: 'delivery-failed', detail: 'the agent did not accept input', agentId: agent.id };
  if (!await steps.deliver(agent)) return { status: 'failed', reason: 'delivery-failed', agentId: agent.id };
  return { status: 'launched', agentId: agent.id };
}

// a managed run must report `working` within this window, or it is taken to have finished
// without observable work (a no-op prompt, or a task that started and finished between observations)
export const managedRunStartWindowMs = 60 * 1_000;
// one observation of a managed run: working, asking a question, finished, or not yet started
export type ManagedRunProgress = 'working' | 'question' | 'finished' | 'starting';

// Read one observation of a managed run's attention: idle counts as finished only after the
// run was seen working, or once the start window has passed since delivery.
export function managedRunProgress(attention: AttentionState, sawWorking: boolean, elapsedMs: number, startWindowMs = managedRunStartWindowMs): ManagedRunProgress {
  if (attention === 'working') return 'working';
  if (attention === 'question') return 'question';
  return sawWorking || elapsedMs >= startWindowMs ? 'finished' : 'starting';
}
