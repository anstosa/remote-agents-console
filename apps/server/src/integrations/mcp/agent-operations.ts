import type { Agent, GitStatusChange, Worktree } from '../../domain/models.js';
import type { ComparisonScope, ComparisonService } from '../../git/comparison-service.js';
import type { IntegrationPrincipal } from '../auth/index.js';
import type { StructuredAgents, TranscriptLine } from '../../transports/structured-agents.js';
import type { TranscriptItem } from '../../transports/structured.js';
import { developerFailure, developerSuccess, type DeveloperResult } from './developer-tool.js';
import type { AgentToolName, AgentToolPorts } from './agent-tools.js';
import { digest, type IntegrationPolicyService, type LifecycleCommandRecord } from '../policy/service.js';
import type { ReviewTourService, PreparedReviewTour } from '../../review-tour/service.js';
import { ReviewTourError, type ReviewTour, type ReviewTourInput } from '../../review-tour/contracts.js';
import { startedReviewJob, type ReviewTourJobs } from '../../review-tour/jobs.js';
import type { ReviewTourStore } from '../../review-tour/store.js';
import type { CodeReviewJobs, StoredCodeReviewJob } from '../../code-review/jobs.js';
import type { CodeReview } from '../../code-review/contracts.js';
import type { AskJobs } from '../../asks/jobs.js';
import type { GeneralAskJob, GeneralAskJobs } from '../../asks/general-jobs.js';
import { redactIntegrationText } from '../text.js';
import { basename, extname } from 'node:path';

export type AgentAccess = 'read' | 'mutate';
export type ResolvedAgentTarget = { agent: Agent; worktree?: Worktree };
export type AgentOperationDependencies = {
  structuredAgents: Pick<StructuredAgents, 'agent' | 'models' | 'setModel' | 'newConversation' | 'rename' | 'resume' | 'compact' | 'transcript' | 'transcriptItem' | 'restartAtGeneration'>;
  comparison: Pick<ComparisonService, 'patch' | 'commits' | 'file' | 'mergeBases' | 'setMergeBase'>;
  resolveAgent: (principal: IntegrationPrincipal, agentId: string, access: AgentAccess) => Promise<ResolvedAgentTarget | undefined>;
  processGeneration: (agentId: string) => Promise<number | undefined>;
  capabilities: (agent: Agent) => { attachments: boolean; steer: boolean; compact: boolean; resume: boolean; restart: boolean };
  createdAt: (agentId: string, itemId: string) => string | undefined;
  policy?: Pick<IntegrationPolicyService, 'claimLifecycleCommand' | 'beginLifecycleCommand' | 'finishLifecycleCommand' | 'lifecycleCommand' | 'pendingLifecycleCommands'>;
  review?: {
    tours: Pick<ReviewTourService, 'prepare' | 'current' | 'capability'>;
    tourJobs: Pick<ReviewTourJobs, 'startPrepared' | 'get' | 'cancel'>;
    codeJobs: Pick<CodeReviewJobs, 'capability' | 'start' | 'get' | 'cancel'>;
    store: Pick<ReviewTourStore, 'current' | 'codeReview'>;
    asks: Pick<AskJobs, 'get'>;
    generalAsks: Pick<GeneralAskJobs, 'issueReview' | 'askReview' | 'askComparison' | 'get'>;
    resolveWorktree: (principal: IntegrationPrincipal, worktreeId: string) => Promise<Worktree | undefined>;
    currentBranch: (worktreeId: string) => Promise<string | undefined>;
  };
  extensions?: AgentToolPorts;
};

const sensitiveComparisonNames = new Set(['.env', '.npmrc', '.netrc', '.pypirc', 'auth.json', 'credentials', 'credentials.json', 'id_ed25519', 'id_rsa', 'integration-auth.json', 'integration-state.json', 'secrets.json']);
const sensitiveComparisonExtensions = new Set(['.cer', '.crt', '.jks', '.key', '.keystore', '.p12', '.pem', '.pfx']);
const safeComparisonHidden = new Set(['.dockerignore', '.editorconfig', '.gitattributes', '.github', '.gitignore']);

// reject credential and private-key files even when Git reports them as changed
function safeComparisonPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  const segments = normalized.split('/').filter(Boolean);
  if (normalized.startsWith('/') || segments.includes('..')) return false;
  if (segments.some(segment => segment.startsWith('.') && !safeComparisonHidden.has(segment))) return false;
  const name = basename(normalized).toLowerCase();
  if (/^remote-agent-console\.(?!example\.json$).+\.json$/u.test(name)) return false;
  return !sensitiveComparisonNames.has(name) && !sensitiveComparisonExtensions.has(extname(name));
}

type Page<T> = { items: T[]; next_cursor?: string; truncated: boolean };

// retain cursor parsing within the bounded collection projection
function pageOffset(cursor: unknown): number | undefined {
  if (cursor === undefined) return 0;
  if (typeof cursor !== 'string') return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d{1,10}$/u.test(decoded)) return undefined;
  const offset = Number(decoded);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

// cap both row count and serialized byte size
function page<T>(rows: readonly T[], cursor: unknown, requestedLimit: unknown): Page<T> | undefined {
  const offset = pageOffset(cursor);
  if (offset === undefined || offset > rows.length) return undefined;
  const limit = typeof requestedLimit === 'number' ? requestedLimit : 50;
  const items: T[] = [];
  let bytes = 2;
  // stop before either declared page boundary
  for (const row of rows.slice(offset)) {
    if (items.length >= limit) break;
    const rowBytes = Buffer.byteLength(JSON.stringify(row)) + (items.length === 0 ? 0 : 1);
    if (bytes + rowBytes > 48_000) break;
    items.push(row);
    bytes += rowBytes;
  }
  const next = offset + items.length;
  return { items, ...(next < rows.length ? { next_cursor: Buffer.from(String(next)).toString('base64url') } : {}), truncated: next < rows.length };
}

// require a real authorized structured target
async function structuredTarget(deps: AgentOperationDependencies, principal: IntegrationPrincipal, agentId: string, access: AgentAccess): Promise<Agent | DeveloperResult> {
  const resolved = await deps.resolveAgent(principal, agentId, access);
  if (resolved === undefined) return developerFailure('not_found', 'Agent not found.');
  if (resolved.agent.transport !== 'structured' || resolved.agent.structured === undefined) return developerFailure('capability_not_supported', 'This operation requires a structured agent.');
  return resolved.agent;
}

// identify a typed failure returned by a local guard
function resultValue(value: Agent | DeveloperResult): value is DeveloperResult {
  return 'ok' in value;
}

// bind stable artifacts to the server-derived principal owner
function principalKey(principal: IntegrationPrincipal): string {
  return principal.stableOwnerKey ?? `${principal.authentication}:${principal.subjectId}`;
}

// map the persisted command without exposing its idempotency record
function lifecycleView(command: LifecycleCommandRecord): Record<string, unknown> {
  return {
    command_id: command.id,
    target_agent_id: command.targetAgentId,
    operation: command.operation,
    state: command.state,
    expected_generation: command.expectedGeneration,
    ...(command.currentGeneration === undefined ? {} : { current_generation: command.currentGeneration }),
    ...(command.error === undefined ? {} : { error: command.error })
  };
}

// execute one already-durable generation-fenced restart
async function runRestart(deps: AgentOperationDependencies, command: LifecycleCommandRecord): Promise<void> {
  if (deps.policy === undefined) return;
  const current = await deps.processGeneration(command.targetAgentId);
  if (current === undefined) {
    await deps.policy.finishLifecycleCommand(command.id, 'failed', undefined, { code: 'target_changed', message: 'The target no longer exists.' });
    return;
  }
  const begun = await deps.policy.beginLifecycleCommand(command.id, current);
  // dispatch only a newly running exact-generation command
  if (begun?.state !== 'running') return;
  const outcome = await deps.structuredAgents.restartAtGeneration(command.targetAgentId, command.expectedGeneration, command.id).catch(() => undefined);
  const observed = await deps.processGeneration(command.targetAgentId);
  if (outcome === 'ok' && observed === command.expectedGeneration + 1) {
    await deps.policy.finishLifecycleCommand(command.id, 'succeeded', observed);
    return;
  }
  if (outcome === 'target_changed') {
    await deps.policy.finishLifecycleCommand(command.id, 'failed', observed, { code: 'target_changed', message: 'The target generation changed before execution.' });
    return;
  }
  await deps.policy.finishLifecycleCommand(command.id, outcome === undefined ? 'unknown' : 'failed', observed, { code: outcome === undefined ? 'unknown_outcome' : 'invalid_state', message: outcome === undefined ? 'The restart outcome is unknown.' : 'The target could not be restarted.' });
}

/** Wake only reconciled pending restarts that have no observed replacing effect. */
export async function recoverPendingAgentLifecycleCommands(deps: AgentOperationDependencies): Promise<void> {
  if (deps.policy === undefined) return;
  const commands = await deps.policy.pendingLifecycleCommands();
  // resume only restart commands whose pending state reconciliation proved safe
  for (const command of commands) {
    if (command.operation !== 'restart') continue;
    await runRestart(deps, command);
  }
}

// project source runtime state without leaking holder/process details
async function agentState(deps: AgentOperationDependencies, agent: Agent, principal: IntegrationPrincipal): Promise<Record<string, unknown>> {
  const structured = agent.structured!;
  const state = structured.lifecycle === 'exited' || structured.lifecycle === 'failed'
    ? 'exited'
    : agent.attention === 'question'
      ? 'question'
      : agent.attention === 'working'
        ? 'working'
      : 'idle';
  const domain = deps.capabilities(agent);
  const lifecycleMutation = principal.authentication !== 'conductor' || agent.id === principal.subjectId || agent.spawnedBy === principal.subjectId;
  return {
    agent_id: agent.id,
    kind: agent.kind,
    state,
    ...(agent.worktreeId === undefined ? {} : { worktree_id: agent.worktreeId }),
    ...(agent.conversationId === undefined ? {} : { conversation_id: agent.conversationId }),
    ...(structured.model?.id === undefined ? {} : { model: structured.model.id }),
    ...(structured.model?.effort === undefined ? {} : { effort: structured.model.effort }),
    capabilities: { model_switch: lifecycleMutation && structured.switchable, effort_switch: lifecycleMutation && structured.switchable, ...domain, compact: lifecycleMutation && domain.compact, resume: lifecycleMutation && domain.resume, restart: lifecycleMutation && domain.restart },
    process_generation: await deps.processGeneration(agent.id) ?? 0
  };
}

// select a comparison scope only after schema validation
function comparisonScope(input: Record<string, unknown>): ComparisonScope {
  return input.mode === 'commit' ? { commit: input.commit as string } : input.mode === 'pull_request' ? 'pr' : 'working';
}

// map Git status codes to the public contract
function comparisonStatus(change: GitStatusChange): 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'binary' {
  const code = change.code.trim();
  if (code === '??') return 'untracked';
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  if (code.startsWith('C')) return 'copied';
  return 'modified';
}

// project only comparison metadata, never patches
function comparisonRows(files: readonly { change: GitStatusChange; kind: string }[]): Array<Record<string, unknown>> {
  return files.map(({ change, kind }) => ({ path: change.path, status: kind === 'binary' ? 'binary' : comparisonStatus(change), additions: change.additions ?? 0, deletions: change.deletions ?? 0 }));
}

// retain a UTF-8 prefix without splitting code points
function boundedText(value: string | undefined, maxBytes: number): { text?: string; truncated: boolean } {
  if (value === undefined) return { truncated: false };
  const source = Buffer.from(value);
  if (source.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  // back off incomplete UTF-8 continuation bytes
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return { text: source.subarray(0, end).toString('utf8'), truncated: true };
}

// convert one source transcript entry into a bounded public summary
function transcriptSummary(deps: AgentOperationDependencies, agentId: string, item: TranscriptLine): Record<string, unknown> | undefined {
  const createdAt = deps.createdAt(agentId, item.id);
  if (createdAt === undefined) return undefined;
  if (item.kind === 'tool') { const text = redactIntegrationText(item.summary || item.name); return { id: item.id, role: 'tool', kind: item.diff === undefined ? 'tool' : 'diff', created_at: createdAt, preview: text.slice(0, 1000), truncated: text.length > 1000 }; }
  if (item.kind === 'message') { const text = redactIntegrationText(item.text); return { id: item.id, role: item.role, kind: 'message', created_at: createdAt, preview: text.slice(0, 1000), truncated: text.length > 1000 }; }
  if (item.kind === 'thinking') { const text = redactIntegrationText(item.text); return { id: item.id, role: 'assistant', kind: 'reasoning', created_at: createdAt, preview: text.slice(0, 1000), truncated: text.length > 1000 }; }
  if (item.kind === 'notice') { const text = redactIntegrationText(item.text); return { id: item.id, role: 'system', kind: item.tone === 'error' ? 'error' : 'message', created_at: createdAt, preview: text.slice(0, 1000), truncated: text.length > 1000 }; }
  return { id: item.id, role: 'system', kind: item.outcome === 'failed' ? 'error' : 'message', created_at: createdAt, preview: item.outcome, truncated: false };
}

// convert one full source item without exposing source or labels
function transcriptDetail(deps: AgentOperationDependencies, agentId: string, item: TranscriptItem): Record<string, unknown> | undefined {
  const createdAt = deps.createdAt(agentId, item.id);
  if (createdAt === undefined) return undefined;
  if (item.kind === 'tool' && item.diff !== undefined) { const patch = redactIntegrationText(item.diff.patch); return { id: item.id, role: 'assistant', kind: 'diff', created_at: createdAt, path: item.diff.path, patch: patch.slice(0, 48_000), truncated: patch.length > 48_000 }; }
  if (item.kind === 'tool') { const summary = redactIntegrationText(item.summary); const output = item.output === undefined ? undefined : redactIntegrationText(item.output); const result = item.result === undefined ? undefined : redactIntegrationText(item.result); return { id: item.id, role: 'assistant', kind: 'tool', created_at: createdAt, name: item.name, summary: summary.slice(0, 2000), state: item.state, ...(item.durationMs === undefined ? {} : { duration_ms: item.durationMs }), ...(output === undefined ? {} : { output: output.slice(0, 24_000) }), ...(result === undefined ? {} : { result: result.slice(0, 24_000) }), truncated: summary.length > 2000 || (output?.length ?? 0) > 24_000 || (result?.length ?? 0) > 24_000 }; }
  if (item.kind === 'message') { const text = redactIntegrationText(item.text); return { id: item.id, role: item.role, kind: 'message', created_at: createdAt, text: text.slice(0, 48_000), truncated: text.length > 48_000 }; }
  if (item.kind === 'thinking') { const text = redactIntegrationText(item.text); return { id: item.id, role: 'assistant', kind: 'reasoning', created_at: createdAt, text: text.slice(0, 48_000), truncated: text.length > 48_000 }; }
  if (item.kind === 'notice') { const text = redactIntegrationText(item.text); return { id: item.id, role: 'system', kind: item.tone === 'error' ? 'error' : 'message', created_at: createdAt, text: text.slice(0, 48_000), truncated: text.length > 48_000 }; }
  return { id: item.id, role: 'system', kind: item.outcome === 'failed' ? 'error' : 'message', created_at: createdAt, text: item.outcome, truncated: false };
}

// map one review-domain error into the developer envelope
function reviewFailure(error: unknown): DeveloperResult {
  if (error instanceof ReviewTourError) return developerFailure(error.code, 'The review operation could not be completed.', error.retryable);
  return developerFailure('generation_failed', 'The review operation failed.', true);
}

// map the domain job descriptor into the shared pending contract
function pendingJob(job: { id: string; startedAt: number; expiresAt: number }, statusTool: 'get_review_job' | 'get_ask_job', run?: { agentId: string; needsInput: boolean }): Record<string, unknown> {
  return { job_id: job.id, state: 'pending', status_tool: statusTool, started_at: new Date(job.startedAt).toISOString(), expires_at: new Date(job.expiresAt).toISOString(), retry_after_ms: 1_000, ...(run === undefined ? {} : { run: { agent_id: run.agentId, needs_input: run.needsInput } }) };
}

// project the public comparison arm without source-only fields
function publicReviewComparison(comparison: PreparedReviewTour['comparison']): Record<string, unknown> {
  return { scope: comparison.scope, ...(comparison.commit === undefined ? {} : { commit: comparison.commit }), base: comparison.base, fingerprint: comparison.fingerprint, include_tests: comparison.includeTests, include_docs: comparison.includeDocs };
}

// project one bounded tour result page
function tourResult(source: Record<string, unknown>, tour: ReviewTour, cursor: unknown, limit: unknown): Record<string, unknown> | undefined {
  const rows = tour.steps.map(step => ({ id: step.id, title: step.title, explanation: redactIntegrationText(step.explanation).slice(0, 4_000), change_ids: step.changeIds.slice(0, 100), change_ids_total: step.changeIds.length, change_ids_truncated: step.changeIds.length > 100 }));
  const paged = page(rows, cursor, Math.min(typeof limit === 'number' ? limit : 20, 20));
  if (paged === undefined) return undefined;
  return { ...source, kind: 'tour', fingerprint: tour.fingerprint, scope: tour.scope, ...(tour.commit === undefined ? {} : { commit: tour.commit }), base: tour.base, include_tests: tour.includeTests, include_docs: tour.includeDocs, title: tour.title, overview: redactIntegrationText(tour.overview).slice(0, 2_000), items: paged.items, total_items: rows.length, ...(paged.next_cursor === undefined ? {} : { next_cursor: paged.next_cursor }), truncated: paged.truncated };
}

// project one bounded code-review result page
function codeReviewResult(source: Record<string, unknown>, review: CodeReview, cursor: unknown, limit: unknown): Record<string, unknown> | undefined {
  const rows = [
    ...review.findings.map(item => ({ kind: 'finding', id: item.id, change_id: item.changeId, side: item.side, start_line: item.startLine, end_line: item.endLine, severity: item.severity, title: item.title, body: redactIntegrationText(item.body) })),
    ...review.general.map(item => ({ kind: 'general', id: item.id, severity: item.severity, title: item.title, body: redactIntegrationText(item.body), ...(item.file === undefined ? {} : { file: item.file }) }))
  ];
  const paged = page(rows, cursor, Math.min(typeof limit === 'number' ? limit : 50, 50));
  if (paged === undefined) return undefined;
  return { ...source, kind: 'code_review', fingerprint: review.fingerprint, preset: review.preset, ...(review.effort === undefined ? {} : { effort: review.effort }), ...(review.focus === undefined ? {} : { focus: review.focus }), completed_at: review.completedAt, items: paged.items, total_items: rows.length, ...(paged.next_cursor === undefined ? {} : { next_cursor: paged.next_cursor }), truncated: paged.truncated };
}

// map a tour or code-review domain job without leaking run controllers
function reviewJobView(job: ReturnType<ReviewTourJobs['get']> | StoredCodeReviewJob, cursor: unknown, limit: unknown, reviewId: string): Record<string, unknown> | undefined {
  if (job === undefined) return undefined;
  if (job.state.kind === 'pending') return { kind: 'pending', job: pendingJob(job, 'get_review_job', job.state.run) };
  if (job.state.kind === 'error') return { kind: 'error', job_id: job.id, code: job.state.code, retryable: job.state.retryable };
  if (job.state.kind === 'gone') return { kind: 'gone', job_id: job.id, reason: job.state.code === 'job_cancelled' ? 'cancelled' : job.state.code === 'job_expired' ? 'expired' : 'superseded' };
  if (job.state.kind === 'empty') return undefined;
  const source = { source: 'job', review_id: reviewId, job_id: job.id, worktree_id: job.worktreeId };
  const result = 'tour' in job.state ? tourResult(source, job.state.tour, cursor, limit) : codeReviewResult(source, job.state.review, cursor, limit);
  return result === undefined ? undefined : { kind: 'ready', job_id: job.id, result };
}

// map one stable Ask job including its retained ready answer
function askJobView(job: ReturnType<AskJobs['get']> | GeneralAskJob): Record<string, unknown> | undefined {
  if (job === undefined) return undefined;
  if (job.state.kind === 'pending') return { kind: 'pending', job: pendingJob(job, 'get_ask_job', job.state.run) };
  if (job.state.kind === 'error') return { kind: 'error', job_id: job.id, code: job.state.code, retryable: job.state.retryable };
  if (job.state.kind === 'gone') return { kind: 'gone', job_id: job.id, reason: 'superseded' };
  const answer = boundedText(redactIntegrationText(job.state.answer), 48_000);
  return { kind: 'ready', job_id: job.id, answer: answer.text ?? '', truncated: answer.truncated };
}

// build review-only context without raw patches or private conversations
function storedReviewContext(tour: ReviewTour, codeReview?: CodeReview): string {
  const serialized = JSON.stringify({
    tour: { title: tour.title, overview: tour.overview, scope: tour.scope, ...(tour.commit === undefined ? {} : { commit: tour.commit }), base: tour.base, steps: tour.steps },
    ...(codeReview === undefined ? {} : { code_review: { preset: codeReview.preset, ...(codeReview.effort === undefined ? {} : { effort: codeReview.effort }), findings: codeReview.findings, general: codeReview.general } })
  });
  return boundedText(serialized, 200_000).text ?? '';
}

// build bounded whole-comparison context for an unanchored general question
function comparisonAskContext(comparison: PreparedReviewTour['comparison']): string {
  const serialized = JSON.stringify({ scope: comparison.scope, ...(comparison.commit === undefined ? {} : { commit: comparison.commit }), base: comparison.base, fingerprint: comparison.fingerprint, changes: comparison.changes.map(change => ({ id: change.id, file: change.file, category: change.category, kind: change.kind, patch: change.patch })) });
  return boundedText(serialized, 200_000).text ?? '';
}

// implement source-backed agent tools and retain injected hard-boundary operations
export function createAgentOperations(deps: AgentOperationDependencies): AgentToolPorts {
  const direct: AgentToolPorts = {
    get_agent_runtime: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'read');
      return resultValue(agent) ? agent : developerSuccess(await agentState(deps, agent, principal));
    },
    list_agent_models: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'read');
      if (resultValue(agent)) return agent;
      const available = await deps.structuredAgents.models(agent.id);
      if (available === undefined) return developerFailure('capability_not_supported', 'Model switching is unavailable.');
      const canSwitch = agent.structured?.switchable === true && (principal.authentication !== 'conductor' || agent.id === principal.subjectId || agent.spawnedBy === principal.subjectId);
      return developerSuccess({ agent_id: agent.id, ...(available.current?.model === undefined ? {} : { current_model: available.current.model }), ...(available.current?.effort === undefined ? {} : { current_effort: available.current.effort }), models: available.models.slice(0, 100).map(model => ({ id: model.id, label: model.name.slice(0, 240), efforts: model.efforts.slice(0, 20) })), can_switch: canSwitch, ...(canSwitch ? {} : { reason: 'Model switching is unavailable for this agent.' }) });
    },
    set_agent_model_effort: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'mutate');
      if (resultValue(agent)) return agent;
      const model = typeof input.model === 'string' ? input.model : agent.structured?.model?.id;
      if (model === undefined) return developerFailure('invalid_state', 'The current model is unknown.');
      const outcome = await deps.structuredAgents.setModel(agent.id, { model, ...(typeof input.effort === 'string' ? { effort: input.effort } : {}) });
      if (outcome !== 'ok') return developerFailure(outcome === 'not-allowed' ? 'forbidden' : outcome === 'unavailable' ? 'not_found' : 'invalid_state', 'The model or effort could not be changed.', outcome === 'busy');
      const current = await deps.structuredAgents.agent(agent.id);
      return current === undefined ? developerFailure('not_found', 'Agent not found.') : developerSuccess(await agentState(deps, current, principal));
    },
    new_conversation: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'mutate');
      if (resultValue(agent)) return agent;
      const outcome = await deps.structuredAgents.newConversation(agent.id);
      if (outcome !== 'ok') return developerFailure(outcome === 'unavailable' ? 'not_found' : 'invalid_state', 'The conversation could not be started.', outcome === 'busy');
      if (typeof input.name === 'string' && await deps.structuredAgents.rename(agent.id, input.name) !== 'ok') return developerFailure('invalid_state', 'The conversation started but its requested name was not confirmed.');
      const current = await deps.structuredAgents.agent(agent.id);
      return current?.conversationId === undefined ? developerFailure('invalid_state', 'The new conversation identifier is unavailable.', true) : developerSuccess({ conversation_id: current.conversationId, active: true });
    },
    rename_conversation: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'mutate');
      if (resultValue(agent)) return agent;
      if (agent.conversationId !== input.conversation_id) return developerFailure('not_found', 'Conversation not found.');
      const outcome = await deps.structuredAgents.rename(agent.id, input.name as string);
      return outcome === 'ok' ? developerSuccess({ conversation_id: input.conversation_id, name: input.name }) : developerFailure(outcome === 'unavailable' ? 'not_found' : 'invalid_state', 'The conversation could not be renamed.', outcome === 'busy');
    },
    resume_conversation: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'mutate');
      if (resultValue(agent)) return agent;
      if (!await deps.structuredAgents.resume(agent.id, input.conversation_id as string)) return developerFailure('invalid_state', 'The conversation could not be resumed.', true);
      const current = await deps.structuredAgents.agent(agent.id);
      return current === undefined ? developerFailure('not_found', 'Agent not found.') : developerSuccess(await agentState(deps, current, principal));
    },
    resume_agent: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'mutate');
      if (resultValue(agent)) return agent;
      if (!await deps.structuredAgents.resume(agent.id)) return developerFailure('invalid_state', 'The agent could not be resumed.', true);
      const current = await deps.structuredAgents.agent(agent.id);
      return current === undefined ? developerFailure('not_found', 'Agent not found.') : developerSuccess(await agentState(deps, current, principal));
    },
    compact_conversation: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'mutate');
      if (resultValue(agent)) return agent;
      if (input.conversation_id !== undefined && input.conversation_id !== agent.conversationId) return developerFailure('capability_not_supported', 'Replacing compaction requires the lifecycle command port.');
      const outcome = await deps.structuredAgents.compact(agent.id);
      return outcome === 'ok' ? developerSuccess({ kind: 'completed', compacted: true, queue_preserved: true }) : developerFailure(outcome === 'unavailable' ? 'not_found' : 'invalid_state', 'The conversation could not be compacted.', outcome === 'busy');
    },
    list_transcript_items: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'read');
      if (resultValue(agent)) return agent;
      if (input.conversation_id !== undefined && input.conversation_id !== agent.conversationId) return developerFailure('not_found', 'Conversation not found.');
      const transcript = await deps.structuredAgents.transcript(agent.id, 2_000);
      if (transcript === undefined) return developerFailure('not_found', 'Transcript not found.');
      const rows = transcript.items.map(item => transcriptSummary(deps, agent.id, item));
      if (rows.some(row => row === undefined)) return developerFailure('capability_not_supported', 'Transcript timestamps are unavailable.');
      const result = page(rows as Record<string, unknown>[], input.cursor, input.limit);
      return result === undefined ? developerFailure('invalid_request', 'The transcript cursor is invalid.') : developerSuccess(result);
    },
    get_transcript_item: async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'read');
      if (resultValue(agent)) return agent;
      const item = await deps.structuredAgents.transcriptItem(agent.id, input.item_id as string);
      if (item === undefined) return developerFailure('not_found', 'Transcript item not found.');
      const projected = transcriptDetail(deps, agent.id, item);
      return projected === undefined ? developerFailure('capability_not_supported', 'Transcript timestamps are unavailable.') : developerSuccess(projected);
    },
    get_comparison: async (input, principal) => {
      const resolved = await deps.resolveAgent(principal, input.agent_id as string, 'read');
      if (resolved?.worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      const captured = await deps.comparison.patch(resolved.worktree, comparisonScope(input));
      if (!captured.ok) return developerFailure('invalid_state', 'Comparison unavailable.', captured.reason === 'unavailable');
      const rows = page(comparisonRows(captured.patch.files), input.cursor, input.limit);
      if (rows === undefined) return developerFailure('invalid_request', 'The comparison cursor is invalid.');
      const mode = captured.kind === 'pr' ? 'pull_request' : captured.kind;
      return developerSuccess({ mode, base: captured.patch.base, ...(mode === 'commit' ? { head: input.commit } : {}), ...rows, truncated: rows.truncated || captured.patch.truncated });
    },
    list_comparison_commits: async (input, principal) => {
      const resolved = await deps.resolveAgent(principal, input.agent_id as string, 'read');
      if (resolved?.worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      const log = await deps.comparison.commits(resolved.worktree);
      if (log === undefined) return developerFailure('not_found', 'Comparison commits unavailable.');
      const rows = log.commits.map(commit => ({ sha: commit.sha, subject: commit.subject.slice(0, 300), author: commit.author.slice(0, 240), date: commit.authoredAt }));
      const result = page(rows, input.cursor, input.limit);
      return result === undefined ? developerFailure('invalid_request', 'The commit cursor is invalid.') : developerSuccess({ ...result, truncated: result.truncated || log.truncated });
    },
    get_comparison_file: async (input, principal) => {
      if (!safeComparisonPath(input.path as string)) return developerFailure('sensitive_path', 'Sensitive comparison files cannot be returned.');
      const resolved = await deps.resolveAgent(principal, input.agent_id as string, 'read');
      if (resolved?.worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      const captured = await deps.comparison.file(resolved.worktree, comparisonScope(input), input.path as string);
      if (!captured.ok) return developerFailure(captured.reason === 'not_in_comparison' ? 'not_found' : 'invalid_state', 'Comparison file unavailable.');
      const max = typeof input.max_bytes === 'number' ? input.max_bytes : 262_144;
      const before = boundedText(captured.base?.content === undefined ? undefined : redactIntegrationText(captured.base.content), Math.floor(max / 2));
      const after = boundedText(captured.working?.content === undefined ? undefined : redactIntegrationText(captured.working.content), max - Buffer.byteLength(before.text ?? ''));
      return developerSuccess({ path: captured.path, ...(before.text === undefined ? {} : { before: before.text }), ...(after.text === undefined ? {} : { after: after.text }), binary: captured.base?.binary === true || captured.working?.binary === true, truncated: before.truncated || after.truncated || captured.base?.truncated === true || captured.working?.truncated === true });
    },
    list_merge_bases: async (input, principal) => {
      const resolved = await deps.resolveAgent(principal, input.agent_id as string, 'read');
      if (resolved?.worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      const choices = await deps.comparison.mergeBases(resolved.worktree);
      if (choices === undefined) return developerFailure('not_found', 'Merge-base options are unavailable.');
      const options = page(choices.options, input.cursor, input.limit);
      if (options === undefined) return developerFailure('invalid_request', 'The merge-base cursor is invalid.');
      return developerSuccess({ ...(choices.current === undefined ? {} : { current: choices.current }), ...options });
    },
    set_merge_base: async (input, principal) => {
      const resolved = await deps.resolveAgent(principal, input.agent_id as string, 'mutate');
      if (resolved?.worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      const outcome = await deps.comparison.setMergeBase(resolved.worktree, input.ref as string, input.sha as string);
      if (outcome === 'saved') return developerSuccess({ ref: input.ref, sha: input.sha });
      if (outcome === 'not_found') return developerFailure('not_found', 'Merge-base option not found.');
      if (outcome === 'target_changed') return developerFailure('target_changed', 'The merge-base option changed before it could be saved.', true);
      return developerFailure('invalid_state', 'The merge base could not be saved.', true);
    }
  };
  // install durable lifecycle operations only with their authoritative policy store
  if (deps.policy !== undefined) {
    direct.restart_agent = async (input, principal) => {
      const agent = await structuredTarget(deps, principal, input.agent_id as string, 'mutate');
      if (resultValue(agent)) return agent;
      const generation = await deps.processGeneration(agent.id);
      if (generation === undefined) return developerFailure('not_found', 'Agent not found.');
      const owner = principalKey(principal);
      const claim = await deps.policy!.claimLifecycleCommand(owner, 'restart_agent', input.request_id as string, digest(JSON.stringify(input)), { targetAgentId: agent.id, operation: 'restart', expectedGeneration: generation });
      if (claim.kind === 'capacity') return developerFailure('idempotency_capacity', 'Lifecycle command capacity is temporarily unavailable.', true);
      if (claim.kind === 'conflict') return developerFailure('idempotency_conflict', 'The request identifier was reused with different arguments.');
      if (claim.command === undefined) return developerFailure(claim.kind === 'in_progress' ? 'in_progress' : 'unknown_outcome', 'The lifecycle command is unavailable.', true);
      // wake only a newly claimed command; replay remains read-only
      if (claim.kind === 'claimed') void runRestart(deps, claim.command).catch(() => undefined);
      return developerSuccess({ command_id: claim.command.id, state: claim.command.state, credential_will_expire: principal.expiresAt !== undefined });
    };
    direct.get_lifecycle_command = async (input, principal) => {
      const command = await deps.policy!.lifecycleCommand(principalKey(principal), input.command_id as string);
      return command === undefined ? developerFailure('not_found', 'Lifecycle command not found.') : developerSuccess(lifecycleView(command));
    };
  }
  // install Review and Ask operations only with their owner-aware domain services
  if (deps.review !== undefined) {
    const review = deps.review;
    direct.list_review_options = async (input, principal) => {
      const resolved = await deps.resolveAgent(principal, input.agent_id as string, 'read');
      if (resolved?.worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      try {
        const [comparison, tourCapability, codeCapability] = await Promise.all([
          review.tours.current(resolved.worktree.id, { scope: 'working', includeTests: true, includeDocs: true }),
          review.tours.capability(),
          review.codeJobs.capability()
        ]);
        const selections = comparison.changes.map(change => ({ id: change.id, path: change.file, category: change.category, kind: change.kind, selected: true }));
        const paged = page(selections, input.cursor, input.limit);
        if (paged === undefined) return developerFailure('invalid_request', 'The review-options cursor is invalid.');
        const presets = [
          { id: 'tour', label: 'Review Tour', agent: tourCapability.agent, ...(tourCapability.effort === undefined ? {} : { effort: tourCapability.effort }), efforts: tourCapability.efforts, available: tourCapability.available, ...(tourCapability.available ? {} : { reason: tourCapability.reason }) },
          ...codeCapability.presets
        ].slice(0, 40);
        return developerSuccess({ fingerprint: comparison.fingerprint, presets, scopes: [{ scope: 'working', label: 'Working changes', available: true }], selections: paged.items, selection_total: selections.length, ...(paged.next_cursor === undefined ? {} : { next_cursor: paged.next_cursor }), truncated: paged.truncated });
      } catch (error) {
        return reviewFailure(error);
      }
    };
    direct.start_review_tour = async (input, principal) => {
      const resolved = await deps.resolveAgent(principal, input.agent_id as string, 'mutate');
      if (resolved?.worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      if (input.preset !== undefined && input.preset !== 'tour') return developerFailure('invalid_request', 'The selected Review Tour preset is unavailable.');
      const reviewInput: ReviewTourInput = { scope: input.scope as ReviewTourInput['scope'], ...(typeof input.commit === 'string' ? { commit: input.commit } : {}), includeTests: true, includeDocs: true };
      try {
        const prepared = await review.tours.prepare(resolved.worktree.id, reviewInput);
        if (prepared.comparison.fingerprint !== input.fingerprint) return developerFailure('stale_during_generation', 'The comparison changed before review start.', true);
        const selected = Array.isArray(input.selections) ? new Set(input.selections as string[]) : undefined;
        if (selected !== undefined && [...selected].some(id => !prepared.comparison.changes.some(change => change.id === id))) return developerFailure('invalid_request', 'A selected review item is unavailable.');
        const filtered = selected === undefined ? prepared : { ...prepared, comparison: { ...prepared.comparison, changes: prepared.comparison.changes.filter(change => selected.has(change.id)) } };
        const started = await review.tourJobs.startPrepared(principalKey(principal), filtered);
        return started.kind === 'empty'
          ? developerSuccess({ kind: 'empty', comparison: publicReviewComparison(filtered.comparison) })
          : developerSuccess({ kind: 'pending', job: pendingJob({ id: started.job.id, startedAt: Date.parse(started.job.startedAt), expiresAt: Date.parse(started.job.expiresAt) }, 'get_review_job') });
      } catch (error) {
        return reviewFailure(error);
      }
    };
    direct.start_code_review = async (input, principal) => {
      const resolved = await deps.resolveAgent(principal, input.agent_id as string, 'mutate');
      if (resolved?.worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      const reviewInput: ReviewTourInput = { scope: input.scope as ReviewTourInput['scope'], ...(typeof input.commit === 'string' ? { commit: input.commit } : {}), includeTests: input.include_tests as boolean, includeDocs: input.include_docs as boolean };
      try {
        const [prepared, capability] = await Promise.all([review.tours.prepare(resolved.worktree.id, reviewInput), review.codeJobs.capability()]);
        if (prepared.comparison.fingerprint !== input.fingerprint) return developerFailure('stale_during_generation', 'The comparison changed before review start.', true);
        const selected = Array.isArray(input.selections) ? new Set(input.selections as string[]) : undefined;
        if (selected !== undefined && [...selected].some(id => !prepared.comparison.changes.some(change => change.id === id))) return developerFailure('invalid_request', 'A selected review item is unavailable.');
        const filtered = selected === undefined ? prepared : { ...prepared, comparison: { ...prepared.comparison, changes: prepared.comparison.changes.filter(change => selected.has(change.id)) } };
        const preset = typeof input.preset === 'string' ? input.preset : capability.defaultPreset;
        const started = await review.codeJobs.start(principalKey(principal), filtered, { preset });
        return developerSuccess(pendingJob({ id: started.id, startedAt: Date.parse(started.startedAt), expiresAt: Date.parse(started.expiresAt) }, 'get_review_job'));
      } catch (error) {
        return reviewFailure(error);
      }
    };
    direct.get_review_job = async (input, principal) => {
      const owner = principalKey(principal);
      const job = review.tourJobs.get(owner, input.job_id as string) ?? review.codeJobs.get(owner, input.job_id as string);
      if (job === undefined || job.state.kind === 'empty') return developerFailure('not_found', 'Review job not found.');
      const reviewId = job?.state.kind === 'ready' ? review.generalAsks.issueReview(owner, job.worktreeId, 'tour' in job.state ? job.state.tour.fingerprint : job.state.review.fingerprint) : 'pending';
      if (job?.state.kind === 'ready' && reviewId === undefined) return developerFailure('rate_limited', 'Review handle capacity is temporarily unavailable.', true);
      const projected = reviewJobView(job, input.cursor, input.limit, reviewId ?? 'pending');
      return projected === undefined ? developerFailure('invalid_request', 'The review cursor is invalid.') : developerSuccess(projected);
    };
    direct.cancel_review_job = async (input, principal) => {
      const owner = principalKey(principal);
      const id = input.job_id as string;
      const cancelled = review.tourJobs.cancel(owner, id) || review.codeJobs.cancel(owner, id);
      return cancelled ? developerSuccess({ job_id: id, state: 'cancelled' }) : developerFailure('not_found', 'Review job not found.');
    };
    direct.get_stored_review = async (input, principal) => {
      const worktree = await review.resolveWorktree(principal, input.worktree_id as string);
      if (worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      const branch = await review.currentBranch(worktree.id);
      if (branch === undefined) return developerFailure('not_found', 'Current review branch not found.');
      const stored = await review.store.current(worktree.id, branch);
      if (stored === undefined || typeof input.fingerprint === 'string' && stored.tour.fingerprint !== input.fingerprint) return developerSuccess({});
      const reviewId = review.generalAsks.issueReview(principalKey(principal), worktree.id, stored.tour.fingerprint);
      if (reviewId === undefined) return developerFailure('rate_limited', 'Review handle capacity is temporarily unavailable.', true);
      const source = { source: 'stored', review_id: reviewId, worktree_id: worktree.id, branch: stored.branch, saved_at: stored.savedAt };
      if (input.kind === 'code_review') {
        const code = await review.store.codeReview(worktree.id, stored.branch, stored.tour.fingerprint);
        if (code === undefined) return developerSuccess({});
        const result = codeReviewResult(source, code, input.cursor, input.limit);
        return result === undefined ? developerFailure('invalid_request', 'The review cursor is invalid.') : developerSuccess({ review: result });
      }
      const result = tourResult(source, stored.tour, input.cursor, input.limit);
      return result === undefined ? developerFailure('invalid_request', 'The review cursor is invalid.') : developerSuccess({ review: result });
    };
    direct.ask_review = async (input, principal) => {
      const owner = principalKey(principal);
      try {
        const job = await review.generalAsks.askReview(owner, input.review_id as string, input.question as string, async handle => {
          const worktree = await review.resolveWorktree(principal, handle.worktreeId);
          if (worktree === undefined) return undefined;
          const branch = await review.currentBranch(worktree.id);
          if (branch === undefined) return undefined;
          const stored = await review.store.current(worktree.id, branch);
          if (stored === undefined || stored.tour.fingerprint !== handle.fingerprint) return undefined;
          const current = await review.tours.current(worktree.id, { scope: stored.tour.scope, ...(stored.tour.commit === undefined ? {} : { commit: stored.tour.commit }), includeTests: stored.tour.includeTests, includeDocs: stored.tour.includeDocs }).catch(() => undefined);
          if (current?.fingerprint !== handle.fingerprint) return undefined;
          const code = await review.store.codeReview(worktree.id, stored.branch, stored.tour.fingerprint);
          return { worktreeId: worktree.id, workspace: worktree.identity, label: 'Stored review', context: storedReviewContext(stored.tour, code) };
        });
        return developerSuccess(pendingJob(job, 'get_ask_job', job.state.kind === 'pending' ? job.state.run : undefined));
      } catch (error) {
        return reviewFailure(error);
      }
    };
    direct.ask_comparison = async (input, principal) => {
      const resolved = await deps.resolveAgent(principal, input.agent_id as string, 'mutate');
      if (resolved?.worktree === undefined) return developerFailure('not_found', 'Configured worktree not found.');
      const scope = input.mode === 'pull_request' ? 'pr' : input.mode as ReviewTourInput['scope'];
      try {
        const comparison = await review.tours.current(resolved.worktree.id, { scope, ...(typeof input.commit === 'string' ? { commit: input.commit } : {}), includeTests: true, includeDocs: true });
        const job = await review.generalAsks.askComparison(principalKey(principal), { worktreeId: resolved.worktree.id, workspace: resolved.worktree.identity, label: 'Comparison', context: comparisonAskContext(comparison) }, input.question as string);
        return developerSuccess(pendingJob(job, 'get_ask_job', job.state.kind === 'pending' ? job.state.run : undefined));
      } catch (error) {
        return reviewFailure(error);
      }
    };
    direct.get_ask_job = async (input, principal) => {
      const owner = principalKey(principal);
      const projected = askJobView(review.generalAsks.get(owner, input.job_id as string) ?? review.asks.get(owner, input.job_id as string));
      return projected === undefined ? developerFailure('not_found', 'Ask job not found.') : developerSuccess(projected);
    };
  }
  return { ...direct, ...deps.extensions };
}
