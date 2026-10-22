import { reviewAgentKinds, reviewRunsFor, type ReviewAgentKind } from '../adapters/registry.js';

// the agent kinds that can run a Review run (ADR 0010), derived from the Adapters that describe `runs`
export { reviewAgentKinds, reviewRunsFor, type ReviewAgentKind };

// the effort levels each kind accepts: Codex as `-c model_reasoning_effort=…`, Claude as `--effort`
export const reviewEfforts = Object.fromEntries(reviewAgentKinds.map(kind => [kind, reviewRunsFor(kind).efforts])) as Record<ReviewAgentKind, readonly string[]>;

// narrow an arbitrary agent kind to a Review run kind
export function isReviewAgentKind(value: string): value is ReviewAgentKind {
  return (reviewAgentKinds as readonly string[]).includes(value);
}

// whether one effort level is accepted by that kind's CLI
export function acceptsReviewEffort(kind: ReviewAgentKind, effort: string): boolean {
  return reviewEfforts[kind].includes(effort);
}
