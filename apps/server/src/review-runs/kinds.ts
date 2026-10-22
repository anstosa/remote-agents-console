import { reviewAgentKinds, reviewRunsFor, type ReviewAgentKind } from '../adapters/registry.js';

// the agent kinds that can run a Review run (ADR 0010), derived from the Adapters that describe `reviewRuns`
export { reviewAgentKinds, reviewRunsFor, type ReviewAgentKind };

// one value per Review run kind
export function byReviewAgentKind<T>(value: (kind: ReviewAgentKind) => T): Record<ReviewAgentKind, T> {
  return Object.fromEntries(reviewAgentKinds.map(kind => [kind, value(kind)])) as Record<ReviewAgentKind, T>;
}

// the effort levels each kind accepts: Codex as `-c model_reasoning_effort=…`, Claude as `--effort`
export const reviewEfforts = byReviewAgentKind(kind => reviewRunsFor(kind).efforts);

// narrow an arbitrary agent kind to a Review run kind
export function isReviewAgentKind(value: string): value is ReviewAgentKind {
  return (reviewAgentKinds as readonly string[]).includes(value);
}

// whether one effort level is accepted by that kind's CLI
export function acceptsReviewEffort(kind: ReviewAgentKind, effort: string): boolean {
  return reviewEfforts[kind].includes(effort);
}
