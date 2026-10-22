import type { ResolvedReviewConfig } from './config.js';
import { conversationKey, type ReviewAgentKind } from './kinds.js';
import { ReviewRunError, type KindReviewRunner, type ReviewRunCapability, type ReviewRunner, type ReviewRunRequest, type ReviewRunResult } from './runner.js';

// routes each Review run by its kind's configured mode: headless to that kind's CLI runner,
// interactive to the injected interactive runner (a visible Agent; unavailable until one is).
// Turns resuming one conversation run one at a time, in the order they arrive.
export class ModeDispatchReviewRunner implements ReviewRunner {
  // the last turn queued on each resumed conversation, settled either way
  private readonly turns = new Map<string, Promise<unknown>>();

  constructor(private readonly agents: ResolvedReviewConfig['agents'], private readonly headless: Record<ReviewAgentKind, KindReviewRunner>, private readonly interactive?: ReviewRunner) {}

  // report the runnable state of the kind's configured mode
  async capability(kind: ReviewAgentKind): Promise<ReviewRunCapability> {
    if (this.agents[kind].mode === 'headless') return await this.headless[kind].capability();
    return this.interactive === undefined ? { available: false, reason: 'interactive_unavailable' } : await this.interactive.capability(kind);
  }

  // run on the kind's configured mode, after any earlier turn on the same conversation
  async run(request: ReviewRunRequest, signal: AbortSignal): Promise<ReviewRunResult> {
    if (request.resume === undefined) return await this.dispatch(request, signal);
    const key = conversationKey(request.kind, request.resume);
    const turn = (this.turns.get(key) ?? Promise.resolve()).then(() => this.dispatch(request, signal));
    const settled = turn.catch(() => undefined);
    this.turns.set(key, settled);
    try { return await turn; } finally { if (this.turns.get(key) === settled) this.turns.delete(key); }
  }

  // only an interactive runner keeps anything
  async closeWorktree(worktreeId: string): Promise<void> {
    await this.interactive?.closeWorktree(worktreeId);
  }

  private async dispatch(request: ReviewRunRequest, signal: AbortSignal): Promise<ReviewRunResult> {
    if (this.agents[request.kind].mode === 'headless') return await this.headless[request.kind].run(request, signal);
    // an interactive mode without an interactive runner cannot run
    if (this.interactive === undefined) throw new ReviewRunError('capability_unavailable', false);
    return await this.interactive.run(request, signal);
  }
}
