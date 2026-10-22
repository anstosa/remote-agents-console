import type { HeadlessRunFailure } from '../adapters/types.js';
import { ReviewTourError } from '../review-tour/contracts.js';
import type { ReviewAgentKind } from './kinds.js';

// the name an interactive run gives its conversation: "🗺 Tour · branch", "🔍 Review · preset" or
// "💬 Ask · preset" (an Ask resuming a conversation keeps that conversation's own name). The Named
// conversations list recognises a run's conversation by this prefix and keeps it apart.
export const tourRunLabel = (subject: string) => `🗺 Tour · ${subject}`;
export const reviewRunLabel = (subject: string) => `🔍 Review · ${subject}`;
export const askRunLabel = (subject: string) => `💬 Ask · ${subject}`;
export const isReviewRunName = (name: string) => [tourRunLabel(''), reviewRunLabel(''), askRunLabel('')].some(prefix => name.startsWith(prefix));

export type ReviewRunUnavailableReason = 'generator_unavailable' | 'unsupported_cli' | 'configuration_invalid' | 'authentication_required' | 'interactive_unavailable';
export type ReviewRunCapability = { available: true } | { available: false; reason: ReviewRunUnavailableReason };
// an interactive run's visible Agent, and whether it is asking the operator a question
export type ReviewRunInfo = { agentId: string; needsInput: boolean };
// what an interactive run reports while it runs: its Agent once launched, then each change of
// whether it is waiting on the operator; headless runs report nothing
export type ReviewRunProgress = { onStarted?: (run: { agentId: string }) => void; onAttention?: (needsInput: boolean) => void };
// What a Review run's reply must be: JSON matching `schema`, which `validate` checks and returns a
// human-readable error for (an interactive run sends that error back to its Agent once for a
// corrected reply, while headless runs leave validation to the caller), or Markdown text.
export type ReviewRunReply = { kind: 'json'; schema: object; validate?: (value: unknown) => string | undefined } | { kind: 'text' };
// One Review run (ADR 0010): a prompt sent to one agent's conversation in the Worktree, a new one or
// the `resume`d one. `worktreeId` is where an interactive run launches its Agent, which is named
// `label` ("🗺 Tour · branch"); headless runs ignore both. An absent model or effort leaves the
// CLI's own default. `maxOutputBytes` bounds the reply, MAX_REVIEW_GENERATED_BYTES when absent. A
// run with `followUps` expects more turns on its conversation: an interactive one keeps its Agent for
// them (`ReviewRunner.closeWorktree` ends it) rather than closing it on success. An interactive run
// keeps `recovery` beside its pane, so a run a server restart orphans can still be finished from it
// (`InteractiveReviewHost.recover`); headless runs ignore it.
export type ReviewRunRequest = { kind: ReviewAgentKind; workspace: string; worktreeId: string; prompt: string; reply: ReviewRunReply; resume?: string; followUps?: true; model?: string; effort?: string; timeoutMs: number; label: string; maxOutputBytes?: number; recovery?: object } & ReviewRunProgress;
// a finished Review run: its reply (the parsed JSON, or the text) and the conversation it ran in, when known
export type ReviewRunResult = { value: unknown; conversation?: string };
// `agent_busy`: the Agent kept for the conversation is in use by the operator
export type ReviewRunErrorCode = HeadlessRunFailure | 'capability_unavailable' | 'timed_out' | 'cancelled' | 'agent_busy';

// a typed Review run failure; a ReviewTourError, so tour and review jobs map it unchanged
export class ReviewRunError extends ReviewTourError {
  constructor(public override readonly code: ReviewRunErrorCode, retryable: boolean) { super(code, retryable); }
}

// runs Review runs of any kind; the caller validates the parsed JSON it returns. `closeWorktree`
// ends what `followUps` runs kept in one Worktree (interactive Agents); nothing when there is none
export interface ReviewRunner {
  capability(kind: ReviewAgentKind): Promise<ReviewRunCapability>;
  run(request: ReviewRunRequest, signal: AbortSignal): Promise<ReviewRunResult>;
  closeWorktree(worktreeId: string): Promise<void>;
}

// runs one kind's headless Review runs; routed to by kind and mode
export interface KindReviewRunner {
  capability(): Promise<ReviewRunCapability>;
  run(request: ReviewRunRequest, signal: AbortSignal): Promise<ReviewRunResult>;
}

// refuse a run whose capability check failed; a missing CLI may yet be installed
export function unavailable(capability: ReviewRunCapability): ReviewRunError | undefined {
  return capability.available ? undefined : new ReviewRunError('capability_unavailable', capability.reason === 'generator_unavailable');
}
