import { isReviewRun, type Agent, type Dashboard } from '../domain/models.js';

// A launched agent can take up to a minute to appear on the dashboard, so every
// launch route (and the Run primitive) polls discovery for that long before giving up.
export const launchReadyTimeoutSeconds = 60;
export const launchPollIntervalMs = 250;
export const launchPollAttempts = launchReadyTimeoutSeconds * 1_000 / launchPollIntervalMs;

/**
 * The real inter-poll delay; tests inject a no-op to skip the wall-clock wait.
 */
export const launchPollDelay = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, launchPollIntervalMs));

/**
 * Poll discovery for a freshly launched agent — one whose id is not in `before` and which
 * `matches` (its Place, Worktree or modal label) — for up to sixty seconds.
 * Extracted from `buildApp` so the launch routes and the Run primitive share one
 * poll (Scheduled prompts). `pollDelay` is the injectable inter-attempt wait.
 */
export type AgentWaiter = (before: Set<string>, matches: (agent: Agent) => boolean) => Promise<Agent | undefined>;

// the waiter match for an Agent launched at a directory-Project or Scratch Place. Neither Place
// match takes a Review run's Agent, which its own run launched alongside (ADR 0010).
export const atPlace = (placeId: string) => (agent: Agent): boolean => agent.placeId === placeId && !isReviewRun(agent);
// the waiter match for an Agent launched in a Worktree: the same Place match (discovery sets
// `worktreeId` exactly when the Agent's Place is that Worktree), kept on the field every Worktree
// flow already reads
export const inWorktree = (worktreeId: string) => (agent: Agent): boolean => agent.worktreeId === worktreeId && !isReviewRun(agent);
// the waiter match for the Agent one interactive Review run launched, by its pane mark
export const reviewRunAgent = (runId: string) => (agent: Agent): boolean => agent.reviewRun === runId;

export function createAgentWaiter(discovery: { dashboard(force?: boolean): Promise<Dashboard> }, pollDelay: () => Promise<void>): AgentWaiter {
  return async (before, matches) => {
    // poll for up to sixty seconds
    for (let attempt = 0; attempt < launchPollAttempts; attempt += 1) {
      const dashboard = await discovery.dashboard();
      const agent = dashboard.agents.find(candidate => !before.has(candidate.id) && matches(candidate) && (candidate.structured?.preparing !== true || candidate.structured.lifecycle === 'failed'));
      // a desired-model guard must settle before a launch is ready
      // return the ready agent
      if (agent) return agent;
      // pause before retrying
      if (attempt + 1 < launchPollAttempts) await pollDelay();
    }
    return undefined;
  };
}
