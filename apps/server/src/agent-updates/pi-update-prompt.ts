import { valid } from 'semver';
import type { AgentUpdateServiceLike, AgentUpdateStatus } from './service.js';
import { isReviewRun, type Agent, type Worktree } from '../domain/models.js';
import { worktreeMatchesWorkspace } from '../workspaces/resolver.js';

const maxRequests = 256;
const requestIdPattern = /^[A-Za-z0-9_-]{12,128}$/u;

export type PiUpdatePromptInput = { requestId: string; currentVersion: string; targetVersion: string };
export type PiUpdatePromptResult =
  | { outcome: 'submitted'; agentId: string; worktreeId: string }
  | { outcome: 'stale' | 'unavailable' | 'failed'; error: string };
export type PiUpdatePromptCoordinatorLike = { submit(sessionId: string, input: PiUpdatePromptInput): Promise<PiUpdatePromptResult> };
type PiUpdateTarget = { worktreeId: string; existingAgentId?: string };
type PiUpdatePromptDependencies = {
  agentUpdates: Pick<AgentUpdateServiceLike, 'statuses'>;
  resolveTarget(): Promise<PiUpdateTarget | undefined>;
  submitExisting(agentId: string, prompt: string): Promise<boolean>;
  launchAndSubmit(worktreeId: string, prompt: string): Promise<{ agentId?: string }>;
};
type RequestRecord = { fingerprint: string; promise: Promise<PiUpdatePromptResult>; active: boolean };

// accept only one browser retry identity and exact semantic versions
export function parsePiUpdatePromptInput(value: unknown): PiUpdatePromptInput | undefined {
  // require one plain JSON record
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // reject hidden fields so browser input cannot grow into executable input
  if (Object.keys(record).some(key => !['requestId', 'currentVersion', 'targetVersion'].includes(key))) return undefined;
  const { requestId, currentVersion, targetVersion } = record;
  // require one bounded opaque retry identity
  if (typeof requestId !== 'string' || !requestIdPattern.test(requestId)) return undefined;
  // require the displayed exact current release
  if (typeof currentVersion !== 'string' || valid(currentVersion) === null || currentVersion.length > 120) return undefined;
  // require the displayed exact target release
  if (typeof targetVersion !== 'string' || valid(targetVersion) === null || targetVersion.length > 120) return undefined;
  return { requestId, currentVersion, targetVersion };
}

// find the one discovered Worktree mapped to the console's exact command-side checkout
export function piUpdateWorktree(worktrees: readonly Worktree[], checkout: string, hostCheckout: string | undefined): Worktree | undefined {
  // require a proven command-side checkout
  if (hostCheckout === undefined) return undefined;
  // the trusted host mapping bridges container aliases such as /workspace
  const matches = worktrees.filter(worktree => worktree.available && (worktree.hostPath ?? worktree.identity) === hostCheckout && (worktree.hostPath !== undefined || worktree.identity === checkout));
  return matches.length === 1 ? matches[0] : undefined;
}

// choose one ordinary operator Agent without taking a Review, Conductor or Conductor worker
export function piUpdateAgent(agents: readonly Agent[], worktree: Pick<Worktree, 'id' | 'identity' | 'hostPath'>): Agent | undefined {
  return agents
    .filter(agent => agent.worktreeId === worktree.id && worktreeMatchesWorkspace(worktree, agent.home) && !isReviewRun(agent) && agent.structured?.role !== 'conductor' && agent.spawnedBy === undefined && (agent.structured === undefined || agent.structured.lifecycle === 'live'))
    .sort((left, right) => left.id.localeCompare(right.id))[0];
}

// build the fixed local-change request from authoritative versions only
export function piUpdatePrompt(currentVersion: string, targetVersion: string): string {
  return [
    `Update the bundled Pi dependency in this Remote Agents checkout from ${currentVersion} to ${targetVersion} as a local code change.`,
    `Set @earendil-works/pi-coding-agent to the exact ${targetVersion} release in apps/server/package.json. Read that release's package metadata and set @earendil-works/pi-codemode to the exact version it declares; do not choose the Codemode version independently. Regenerate pnpm-lock.yaml with the repository's package manager.`,
    'Review the Pi release changes for compatibility with the Remote Agents RPC transport, extension, MCP tools, Codemode, sandbox runtime and model catalog. Preserve all unrelated dirty work.',
    'Run the focused tests and type checks that cover the Pi RPC, extension, MCP, Codemode, sandbox and model-catalog contracts. Report the local file changes, validation results and any compatibility risk.',
    'Do not pull, commit, push, deploy, restart services, invoke the Remote Agents server updater, or install Pi globally. Stop after the local dependency edits and tests.'
  ].join('\n\n');
}

// serialize and deduplicate one browser-approved Pi pin prompt
export class PiUpdatePromptCoordinator implements PiUpdatePromptCoordinatorLike {
  private readonly requests = new Map<string, RequestRecord>();
  private readonly active = new Map<string, Promise<PiUpdatePromptResult>>();
  private tail: Promise<unknown> = Promise.resolve();

  // bind authoritative version, checkout and prompt engines
  constructor(private readonly deps: PiUpdatePromptDependencies) {}

  // submit once for one browser retry identity
  async submit(sessionId: string, input: PiUpdatePromptInput): Promise<PiUpdatePromptResult> {
    const key = `${sessionId}\0${input.requestId}`;
    const fingerprint = `${input.currentVersion}\0${input.targetVersion}`;
    const prior = this.requests.get(key);
    // retries may join only the exact original request
    if (prior !== undefined) return prior.fingerprint === fingerprint ? await prior.promise : { outcome: 'stale', error: 'This Pi update request was already used for different versions.' };
    this.prune();
    // never evict in-flight ownership to admit another request
    if (this.requests.size >= maxRequests) return { outcome: 'unavailable', error: 'Too many Pi update requests are still active. Try again after they finish.' };
    const shared = this.active.get(fingerprint);
    const operation = shared ?? this.queue(input, fingerprint);
    const record: RequestRecord = { fingerprint, promise: operation, active: true };
    this.requests.set(key, record);
    void operation.then(result => {
      record.active = false;
      // allow safe retries when no prompt delivery was attempted
      if ((result.outcome === 'stale' || result.outcome === 'unavailable') && this.requests.get(key) === record) this.requests.delete(key);
    }, () => { record.active = false; }).catch(() => undefined);
    return await operation;
  }

  // queue different targets while coalescing the same active update
  private queue(input: PiUpdatePromptInput, fingerprint: string): Promise<PiUpdatePromptResult> {
    const operation = this.tail.catch(() => undefined).then(async () => await this.execute(input));
    this.tail = operation.then(() => undefined, () => undefined);
    this.active.set(fingerprint, operation);
    void operation.finally(() => {
      // clear only this exact active operation
      if (this.active.get(fingerprint) === operation) this.active.delete(fingerprint);
    }).catch(() => undefined);
    return operation;
  }

  // validate live Pi state before resolving or mutating any Agent
  private async execute(input: PiUpdatePromptInput): Promise<PiUpdatePromptResult> {
    let statuses: AgentUpdateStatus[];
    try {
      statuses = await this.deps.agentUpdates.statuses();
    } catch {
      return { outcome: 'unavailable', error: 'Unable to verify the available Pi release.' };
    }
    const pi = statuses.find(status => status.kind === 'pi');
    // require the exact pinned update the modal displayed
    if (pi?.pinned !== true || !pi.updateAvailable || pi.currentVersion !== input.currentVersion || pi.latestVersion !== input.targetVersion) return { outcome: 'stale', error: 'The available Pi update changed. Reopen the launcher and review the current version.' };
    const target = await this.deps.resolveTarget().catch(() => undefined);
    // never redirect the change request into an arbitrary selected repository
    if (target === undefined) return { outcome: 'unavailable', error: 'The Remote Agents checkout is not available as a configured worktree.' };
    const prompt = piUpdatePrompt(pi.currentVersion, pi.latestVersion);
    // queue into the existing ordinary Agent when one is available
    if (target.existingAgentId !== undefined) {
      const submitted = await this.deps.submitExisting(target.existingAgentId, prompt).catch(() => false);
      return submitted ? { outcome: 'submitted', agentId: target.existingAgentId, worktreeId: target.worktreeId } : { outcome: 'failed', error: 'Prompt delivery could not be confirmed. Check the Remote Agents checkout before trying again.' };
    }
    const launched = await this.deps.launchAndSubmit(target.worktreeId, prompt).catch((): { agentId?: string } => ({}));
    return launched.agentId === undefined ? { outcome: 'failed', error: 'Prompt delivery could not be confirmed. Check the Remote Agents checkout before trying again.' } : { outcome: 'submitted', agentId: launched.agentId, worktreeId: target.worktreeId };
  }

  // remove oldest completed retry records while retaining every active operation
  private prune(): void {
    // skip work while below the bound
    if (this.requests.size < maxRequests) return;
    // scan oldest retry records first
    for (const [key, record] of this.requests) {
      // retain in-flight retry ownership
      if (record.active) continue;
      this.requests.delete(key);
      // stop after making one slot
      if (this.requests.size < maxRequests) return;
    }
  }
}
