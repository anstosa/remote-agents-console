import type { ResolvedReviewConfig } from './config.js';
import type { ReviewAgentKind } from './kinds.js';
import { ReviewRunError, type KindReviewRunner, type ReviewRunCapability, type ReviewRunner, type ReviewRunRequest } from './runner.js';

// routes each Review run by its kind's configured mode: headless to that kind's CLI runner,
// interactive to the injected interactive runner (a visible Agent; unavailable until one is)
export class ModeDispatchReviewRunner implements ReviewRunner {
  constructor(private readonly agents: ResolvedReviewConfig['agents'], private readonly headless: Record<ReviewAgentKind, KindReviewRunner>, private readonly interactive?: ReviewRunner) {}

  // report the runnable state of the kind's configured mode
  async capability(kind: ReviewAgentKind): Promise<ReviewRunCapability> {
    if (this.agents[kind].mode === 'headless') return await this.headless[kind].capability();
    return this.interactive === undefined ? { available: false, reason: 'interactive_unavailable' } : await this.interactive.capability(kind);
  }

  // run on the kind's configured mode
  async run(request: ReviewRunRequest, signal: AbortSignal): Promise<unknown> {
    if (this.agents[request.kind].mode === 'headless') return await this.headless[request.kind].run(request, signal);
    // an interactive mode without an interactive runner cannot run
    if (this.interactive === undefined) throw new ReviewRunError('capability_unavailable', false);
    return await this.interactive.run(request, signal);
  }
}
