import type { HeadlessRunFailure } from '../adapters/types.js';
import { ReviewTourError } from '../review-tour/contracts.js';
import type { ReviewAgentKind } from './kinds.js';

// the name an interactive run gives its conversation: "🗺 Tour · branch" or "🔍 Review · preset".
// The Named conversations list recognises a run's conversation by this prefix and keeps it apart.
export const tourRunLabel = (subject: string) => `🗺 Tour · ${subject}`;
export const reviewRunLabel = (subject: string) => `🔍 Review · ${subject}`;
export const isReviewRunName = (name: string) => name.startsWith(tourRunLabel('')) || name.startsWith(reviewRunLabel(''));

export type ReviewRunUnavailableReason = 'generator_unavailable' | 'unsupported_cli' | 'configuration_invalid' | 'authentication_required' | 'interactive_unavailable';
export type ReviewRunCapability = { available: true } | { available: false; reason: ReviewRunUnavailableReason };
// an interactive run's visible Agent, and whether it is asking the operator a question
export type ReviewRunInfo = { agentId: string; needsInput: boolean };
// what an interactive run reports while it runs: its Agent once launched, then each change of
// whether it is waiting on the operator; headless runs report nothing
export type ReviewRunProgress = { onStarted?: (run: { agentId: string }) => void; onAttention?: (needsInput: boolean) => void };
// one Review run (ADR 0010): a prompt sent to one agent in the Worktree, answered with JSON
// matching `schema`. `worktreeId` is where an interactive run launches its Agent, which is
// named `label` ("🗺 Tour · branch"); headless runs ignore both. An absent model or effort
// leaves the CLI's own default. `maxOutputBytes` bounds the structured result,
// MAX_REVIEW_GENERATED_BYTES when absent. `validate` checks the parsed JSON and returns a
// human-readable error; an interactive run sends that error back to its Agent once for a
// corrected reply, while headless runs leave validation to the caller. An interactive run keeps
// `recovery` beside its pane, so a run a server restart orphans can still be finished from it
// (`InteractiveReviewHost.recover`); headless runs ignore it.
export type ReviewRunRequest = { kind: ReviewAgentKind; workspace: string; worktreeId: string; prompt: string; schema: object; model?: string; effort?: string; timeoutMs: number; label: string; maxOutputBytes?: number; validate?: (value: unknown) => string | undefined; recovery?: object } & ReviewRunProgress;
export type ReviewRunErrorCode = HeadlessRunFailure | 'capability_unavailable' | 'timed_out' | 'cancelled';

// a typed Review run failure; a ReviewTourError, so tour and review jobs map it unchanged
export class ReviewRunError extends ReviewTourError {
  constructor(public override readonly code: ReviewRunErrorCode, retryable: boolean) { super(code, retryable); }
}

// runs Review runs of any kind; the caller validates the parsed JSON it returns
export interface ReviewRunner {
  capability(kind: ReviewAgentKind): Promise<ReviewRunCapability>;
  run(request: ReviewRunRequest, signal: AbortSignal): Promise<unknown>;
}

// runs one kind's headless Review runs; routed to by kind and mode
export interface KindReviewRunner {
  capability(): Promise<ReviewRunCapability>;
  run(request: ReviewRunRequest, signal: AbortSignal): Promise<unknown>;
}

// refuse a run whose capability check failed; a missing CLI may yet be installed
export function unavailable(capability: ReviewRunCapability): ReviewRunError | undefined {
  return capability.available ? undefined : new ReviewRunError('capability_unavailable', capability.reason === 'generator_unavailable');
}
