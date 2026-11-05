import { z } from 'zod';
import { objectId } from '../../git/comparison.js';
import type { IntegrationPrincipal, IntegrationScope } from '../auth/index.js';
import {
  developerIdSchema,
  developerIdentifier,
  developerPageProperties,
  developerPageShape,
  developerRequestId,
  developerRequestSchema,
  developerTool,
  type DeveloperResult,
  type DeveloperTool
} from './developer-tool.js';

export const agentToolNames = [
  'get_agent_runtime', 'list_agent_models', 'set_agent_model_effort',
  'list_conversations', 'rename_conversation', 'new_conversation', 'switch_conversation', 'resume_conversation', 'forget_conversation',
  'resume_agent', 'restart_agent', 'compact_conversation', 'get_lifecycle_command',
  'get_launch_options', 'launch_agent', 'queue_prompt_with_attachments', 'steer_agent', 'relay_agent_question_answer',
  'list_transcript_items', 'get_transcript_item', 'get_comparison', 'list_comparison_commits', 'get_comparison_file', 'list_merge_bases', 'set_merge_base',
  'list_review_options', 'start_review_tour', 'start_code_review', 'get_review_job', 'cancel_review_job', 'get_stored_review',
  'ask_review', 'ask_comparison', 'get_ask_job', 'create_pull_request_review_draft'
] as const;

export type AgentToolName = typeof agentToolNames[number];
export type AgentToolPort = (input: Record<string, unknown>, principal: IntegrationPrincipal) => Promise<DeveloperResult>;
export type AgentToolPorts = Partial<Record<AgentToolName, AgentToolPort>>;

const agentKinds = ['codex', 'omx', 'claude', 'pi', 'opencode'] as const;
const id = developerIdentifier;
const idJson = developerIdSchema;
const short = z.string().min(1).max(240);
const shortJson = { type: 'string', minLength: 1, maxLength: 240 };
const iso = z.string().datetime({ offset: true });
const isoJson = { type: 'string', format: 'date-time' };
const gitObjectId = z.string().regex(objectId);
const gitObjectIdJson = { type: 'string', pattern: objectId.source };
const request = { request_id: developerRequestId };
const requestJson = { request_id: developerRequestSchema };
const target = { agent_id: id };
const targetJson = { agent_id: idJson };
const agentKind = z.enum(agentKinds);
const agentKindJson = { type: 'string', enum: agentKinds };
const boolJson = { type: 'boolean' };
const nonnegativeJson = { type: 'integer', minimum: 0 };
// match post-trim conversation bounds
const trimmedConversationNameJson = { type: 'string', pattern: '^\\s*(?:\\S|\\S[\\s\\S]{0,118}\\S)\\s*$' };
// mirror commit-only mode inputs
const modeCommitConditionJson = {
  if: { properties: { mode: { const: 'commit' } }, required: ['mode'] },
  then: { required: ['commit'] },
  else: { not: { required: ['commit'] } }
};
// mirror commit-only scope inputs and outputs
const scopeCommitConditionJson = {
  if: { properties: { scope: { const: 'commit' } }, required: ['scope'] },
  then: { required: ['commit'] },
  else: { not: { required: ['commit'] } }
};

// declare one strict JSON object schema
function jsonObject(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

// declare one bounded JSON array schema
function jsonArray(items: unknown, maxItems = 100): Record<string, unknown> {
  return { type: 'array', items, maxItems };
}

// add the transport-selected instance to one input descriptor
function inputJson(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return jsonObject({ instance_id: { ...idJson, description: 'Canonical instance URL. Omit for the connected instance.' }, ...properties }, required);
}

const capabilities = z.object({
  model_switch: z.boolean(), effort_switch: z.boolean(), attachments: z.boolean(), steer: z.boolean(),
  compact: z.boolean(), resume: z.boolean(), restart: z.boolean()
}).strict();
const capabilitiesJson = jsonObject({ model_switch: boolJson, effort_switch: boolJson, attachments: boolJson, steer: boolJson, compact: boolJson, resume: boolJson, restart: boolJson }, ['model_switch', 'effort_switch', 'attachments', 'steer', 'compact', 'resume', 'restart']);
const agentState = z.object({
  agent_id: id,
  kind: agentKind,
  state: z.enum(['idle', 'working', 'attention', 'question', 'exited', 'unknown']),
  worktree_id: id.optional(), conversation_id: id.optional(), model: z.string().min(1).max(200).optional(), effort: z.string().min(1).max(80).optional(),
  capabilities,
  process_generation: z.number().int().nonnegative()
}).strict();
const agentStateJson = jsonObject({
  agent_id: idJson, kind: agentKindJson, state: { type: 'string', enum: ['idle', 'working', 'attention', 'question', 'exited', 'unknown'] },
  worktree_id: idJson, conversation_id: idJson, model: { type: 'string', minLength: 1, maxLength: 200 }, effort: { type: 'string', minLength: 1, maxLength: 80 },
  capabilities: capabilitiesJson, process_generation: nonnegativeJson
}, ['agent_id', 'kind', 'state', 'capabilities', 'process_generation']);

const conversation = z.object({ id, name: z.string().min(1).max(120).optional(), active: z.boolean(), exited: z.boolean(), updated_at: iso }).strict();
const conversationJson = jsonObject({ id: idJson, name: { type: 'string', minLength: 1, maxLength: 120 }, active: boolJson, exited: boolJson, updated_at: isoJson }, ['id', 'active', 'exited', 'updated_at']);
const lifecycleStart = z.object({ command_id: id, state: z.enum(['pending', 'running', 'succeeded', 'failed', 'unknown']), credential_will_expire: z.boolean() }).strict();
const lifecycleStartJson = jsonObject({ command_id: idJson, state: { type: 'string', enum: ['pending', 'running', 'succeeded', 'failed', 'unknown'] }, credential_will_expire: boolJson }, ['command_id', 'state', 'credential_will_expire']);
const lifecycleView = z.object({
  command_id: id, target_agent_id: id, operation: z.enum(['restart', 'resume_replacing', 'compact_replacing']),
  state: z.enum(['pending', 'running', 'succeeded', 'failed', 'unknown']), expected_generation: z.number().int().nonnegative(), current_generation: z.number().int().nonnegative().optional(),
  error: z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(400) }).strict().optional()
}).strict();
const lifecycleViewJson = jsonObject({ command_id: idJson, target_agent_id: idJson, operation: { type: 'string', enum: ['restart', 'resume_replacing', 'compact_replacing'] }, state: { type: 'string', enum: ['pending', 'running', 'succeeded', 'failed', 'unknown'] }, expected_generation: nonnegativeJson, current_generation: nonnegativeJson, error: jsonObject({ code: { type: 'string', minLength: 1, maxLength: 120 }, message: { type: 'string', minLength: 1, maxLength: 400 } }, ['code', 'message']) }, ['command_id', 'target_agent_id', 'operation', 'state', 'expected_generation']);

const transcriptSummary = z.object({ id, role: z.enum(['user', 'assistant', 'system', 'tool']), kind: z.enum(['message', 'reasoning', 'tool', 'diff', 'error']), created_at: iso, preview: z.string().max(1000), truncated: z.boolean() }).strict();
const transcriptSummaryJson = jsonObject({ id: idJson, role: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'] }, kind: { type: 'string', enum: ['message', 'reasoning', 'tool', 'diff', 'error'] }, created_at: isoJson, preview: { type: 'string', maxLength: 1000 }, truncated: boolJson }, ['id', 'role', 'kind', 'created_at', 'preview', 'truncated']);
const transcriptMessage = z.object({ id, role: z.enum(['user', 'assistant', 'system']), kind: z.enum(['message', 'reasoning', 'error']), created_at: iso, text: z.string().max(48_000), truncated: z.boolean() }).strict();
const transcriptTool = z.object({ id, role: z.literal('assistant'), kind: z.literal('tool'), created_at: iso, name: z.string().min(1).max(200), summary: z.string().max(2000), state: z.enum(['running', 'done', 'failed']), duration_ms: z.number().int().nonnegative().optional(), output: z.string().max(24_000).optional(), result: z.string().max(24_000).optional(), truncated: z.boolean() }).strict();
const transcriptDiff = z.object({ id, role: z.literal('assistant'), kind: z.literal('diff'), created_at: iso, path: z.string().min(1).max(4096), patch: z.string().max(48_000), truncated: z.boolean() }).strict();
const transcriptItem = z.union([transcriptMessage, transcriptTool, transcriptDiff]);
const transcriptItemJson = { oneOf: [
  jsonObject({ id: idJson, role: { type: 'string', enum: ['user', 'assistant', 'system'] }, kind: { type: 'string', enum: ['message', 'reasoning', 'error'] }, created_at: isoJson, text: { type: 'string', maxLength: 48_000 }, truncated: boolJson }, ['id', 'role', 'kind', 'created_at', 'text', 'truncated']),
  jsonObject({ id: idJson, role: { const: 'assistant' }, kind: { const: 'tool' }, created_at: isoJson, name: { type: 'string', minLength: 1, maxLength: 200 }, summary: { type: 'string', maxLength: 2000 }, state: { type: 'string', enum: ['running', 'done', 'failed'] }, duration_ms: nonnegativeJson, output: { type: 'string', maxLength: 24_000 }, result: { type: 'string', maxLength: 24_000 }, truncated: boolJson }, ['id', 'role', 'kind', 'created_at', 'name', 'summary', 'state', 'truncated']),
  jsonObject({ id: idJson, role: { const: 'assistant' }, kind: { const: 'diff' }, created_at: isoJson, path: { type: 'string', minLength: 1, maxLength: 4096 }, patch: { type: 'string', maxLength: 48_000 }, truncated: boolJson }, ['id', 'role', 'kind', 'created_at', 'path', 'patch', 'truncated'])
] };

const comparisonFileRow = z.object({ path: z.string().min(1).max(4096), status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'untracked', 'binary']), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }).strict();
const comparisonFileRowJson = jsonObject({ path: { type: 'string', minLength: 1, maxLength: 4096 }, status: { type: 'string', enum: ['added', 'modified', 'deleted', 'renamed', 'copied', 'untracked', 'binary'] }, additions: nonnegativeJson, deletions: nonnegativeJson }, ['path', 'status', 'additions', 'deletions']);
const comparisonBase = { base: z.string().min(1).max(255), files: z.array(comparisonFileRow).max(100), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() };
const comparisonBaseJson = { base: { type: 'string', minLength: 1, maxLength: 255 }, files: jsonArray(comparisonFileRowJson), next_cursor: { type: 'string', minLength: 1, maxLength: 400 }, truncated: boolJson };
const comparisonSummary = z.union([
  z.object({ mode: z.enum(['working', 'pull_request']), ...comparisonBase }).strict(),
  z.object({ mode: z.literal('commit'), head: gitObjectId, ...comparisonBase }).strict()
]);
const comparisonSummaryJson = { oneOf: [
  jsonObject({ mode: { type: 'string', enum: ['working', 'pull_request'] }, ...comparisonBaseJson }, ['mode', 'base', 'files', 'truncated']),
  jsonObject({ mode: { const: 'commit' }, head: gitObjectIdJson, ...comparisonBaseJson }, ['mode', 'head', 'base', 'files', 'truncated'])
] };
const comparisonFile = z.object({ path: z.string().min(1).max(4096), patch: z.string().max(262_144).optional(), before: z.string().max(262_144).optional(), after: z.string().max(262_144).optional(), binary: z.boolean(), truncated: z.boolean() }).strict();
const comparisonFileJson = jsonObject({ path: { type: 'string', minLength: 1, maxLength: 4096 }, patch: { type: 'string', maxLength: 262_144 }, before: { type: 'string', maxLength: 262_144 }, after: { type: 'string', maxLength: 262_144 }, binary: boolJson, truncated: boolJson }, ['path', 'binary', 'truncated']);

const pendingJob = z.object({ job_id: id, state: z.literal('pending'), status_tool: z.enum(['get_review_job', 'get_ask_job']), started_at: iso, expires_at: iso, retry_after_ms: z.number().int().min(250).max(60_000), run: z.object({ agent_id: id, needs_input: z.boolean() }).strict().optional() }).strict();
const pendingJobJson = jsonObject({ job_id: idJson, state: { const: 'pending' }, status_tool: { type: 'string', enum: ['get_review_job', 'get_ask_job'] }, started_at: isoJson, expires_at: isoJson, retry_after_ms: { type: 'integer', minimum: 250, maximum: 60_000 }, run: jsonObject({ agent_id: idJson, needs_input: boolJson }, ['agent_id', 'needs_input']) }, ['job_id', 'state', 'status_tool', 'started_at', 'expires_at', 'retry_after_ms']);
const publicReviewComparison = z.object({ scope: z.enum(['working', 'pr', 'commit']), commit: gitObjectId.optional(), base: z.string().min(1).max(4096), fingerprint: z.string().min(16).max(128), include_tests: z.boolean(), include_docs: z.boolean() }).strict().refine(value => (value.scope === 'commit') === (value.commit !== undefined));
const publicReviewComparisonJson = { ...jsonObject({ scope: { type: 'string', enum: ['working', 'pr', 'commit'] }, commit: gitObjectIdJson, base: { type: 'string', minLength: 1, maxLength: 4096 }, fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, include_tests: boolJson, include_docs: boolJson }, ['scope', 'base', 'fingerprint', 'include_tests', 'include_docs']), ...scopeCommitConditionJson };
const reviewStart = z.union([z.object({ kind: z.literal('empty'), comparison: publicReviewComparison }).strict(), z.object({ kind: z.literal('pending'), job: pendingJob }).strict()]);
const reviewStartJson = { oneOf: [jsonObject({ kind: { const: 'empty' }, comparison: publicReviewComparisonJson }, ['kind', 'comparison']), jsonObject({ kind: { const: 'pending' }, job: pendingJobJson }, ['kind', 'job'])] };
const reviewStep = z.object({ id: z.string().min(1).max(80), title: z.string().min(1).max(240), explanation: z.string().min(1).max(4000), change_ids: z.array(z.string().min(8).max(100)).min(1).max(100), change_ids_total: z.number().int().min(1).max(500), change_ids_truncated: z.boolean() }).strict();
const reviewStepJson = jsonObject({ id: { type: 'string', minLength: 1, maxLength: 80 }, title: { type: 'string', minLength: 1, maxLength: 240 }, explanation: { type: 'string', minLength: 1, maxLength: 4000 }, change_ids: { type: 'array', items: { type: 'string', minLength: 8, maxLength: 100 }, minItems: 1, maxItems: 100 }, change_ids_total: { type: 'integer', minimum: 1, maximum: 500 }, change_ids_truncated: boolJson }, ['id', 'title', 'explanation', 'change_ids', 'change_ids_total', 'change_ids_truncated']);
const codeReviewItem = z.union([
  z.object({ kind: z.literal('finding'), id: z.string().min(1).max(64), change_id: z.string().min(1).max(100), side: z.enum(['additions', 'deletions']), start_line: z.number().int().positive(), end_line: z.number().int().positive(), severity: z.enum(['high', 'medium', 'low']), title: z.string().min(1).max(200), body: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('general'), id: z.string().min(1).max(64), severity: z.enum(['high', 'medium', 'low']), title: z.string().min(1).max(200), body: z.string().min(1).max(4000), file: z.string().min(1).max(4096).optional() }).strict()
]);
const codeReviewItemJson = { oneOf: [
  jsonObject({ kind: { const: 'finding' }, id: { type: 'string', minLength: 1, maxLength: 64 }, change_id: { type: 'string', minLength: 1, maxLength: 100 }, side: { type: 'string', enum: ['additions', 'deletions'] }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 4000 } }, ['kind', 'id', 'change_id', 'side', 'start_line', 'end_line', 'severity', 'title', 'body']),
  jsonObject({ kind: { const: 'general' }, id: { type: 'string', minLength: 1, maxLength: 64 }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, title: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 4000 }, file: { type: 'string', minLength: 1, maxLength: 4096 } }, ['kind', 'id', 'severity', 'title', 'body'])
] };
const reviewTourContent = {
  kind: z.literal('tour'), fingerprint: z.string().min(16).max(128), scope: z.enum(['working', 'pr', 'commit']), commit: gitObjectId.optional(), base: z.string().min(1).max(4096),
  include_tests: z.boolean(), include_docs: z.boolean(), title: z.string().min(1).max(240), overview: z.string().min(1).max(2000), items: z.array(reviewStep).max(20), total_items: z.number().int().min(1).max(500), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean()
};
const reviewTourContentJson = { kind: { const: 'tour' }, fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, scope: { type: 'string', enum: ['working', 'pr', 'commit'] }, commit: gitObjectIdJson, base: { type: 'string', minLength: 1, maxLength: 4096 }, include_tests: boolJson, include_docs: boolJson, title: { type: 'string', minLength: 1, maxLength: 240 }, overview: { type: 'string', minLength: 1, maxLength: 2000 }, items: jsonArray(reviewStepJson, 20), total_items: { type: 'integer', minimum: 1, maximum: 500 }, next_cursor: { type: 'string', minLength: 1, maxLength: 400 }, truncated: boolJson };
const reviewCodeContent = {
  kind: z.literal('code_review'), fingerprint: z.string().min(16).max(128), preset: z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(80), agent: agentKind }).strict(), effort: z.string().min(1).max(20).optional(), focus: z.string().min(1).max(2000).optional(), completed_at: iso,
  items: z.array(codeReviewItem).max(50), total_items: z.number().int().min(0).max(130), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean()
};
const reviewCodeContentJson = { kind: { const: 'code_review' }, fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, preset: jsonObject({ id: { type: 'string', minLength: 1, maxLength: 40 }, label: { type: 'string', minLength: 1, maxLength: 80 }, agent: agentKindJson }, ['id', 'label', 'agent']), effort: { type: 'string', minLength: 1, maxLength: 20 }, focus: { type: 'string', minLength: 1, maxLength: 2000 }, completed_at: isoJson, items: jsonArray(codeReviewItemJson, 50), total_items: { type: 'integer', minimum: 0, maximum: 130 }, next_cursor: { type: 'string', minLength: 1, maxLength: 400 }, truncated: boolJson };
const reviewResult = z.union([
  z.object({ source: z.literal('job'), review_id: id, job_id: id, worktree_id: id, ...reviewTourContent }).strict().refine(value => (value.scope === 'commit') === (value.commit !== undefined)),
  z.object({ source: z.literal('stored'), review_id: id, worktree_id: id, branch: z.string().min(1).max(1024), saved_at: iso, ...reviewTourContent }).strict().refine(value => (value.scope === 'commit') === (value.commit !== undefined)),
  z.object({ source: z.literal('job'), review_id: id, job_id: id, worktree_id: id, ...reviewCodeContent }).strict(),
  z.object({ source: z.literal('stored'), review_id: id, worktree_id: id, branch: z.string().min(1).max(1024), saved_at: iso, ...reviewCodeContent }).strict()
]);
const reviewResultJson = { oneOf: [
  { ...jsonObject({ source: { const: 'job' }, review_id: idJson, job_id: idJson, worktree_id: idJson, ...reviewTourContentJson }, ['source', 'review_id', 'job_id', 'worktree_id', 'kind', 'fingerprint', 'scope', 'base', 'include_tests', 'include_docs', 'title', 'overview', 'items', 'total_items', 'truncated']), ...scopeCommitConditionJson },
  { ...jsonObject({ source: { const: 'stored' }, review_id: idJson, worktree_id: idJson, branch: { type: 'string', minLength: 1, maxLength: 1024 }, saved_at: isoJson, ...reviewTourContentJson }, ['source', 'review_id', 'worktree_id', 'branch', 'saved_at', 'kind', 'fingerprint', 'scope', 'base', 'include_tests', 'include_docs', 'title', 'overview', 'items', 'total_items', 'truncated']), ...scopeCommitConditionJson },
  jsonObject({ source: { const: 'job' }, review_id: idJson, job_id: idJson, worktree_id: idJson, ...reviewCodeContentJson }, ['source', 'review_id', 'job_id', 'worktree_id', 'kind', 'fingerprint', 'preset', 'completed_at', 'items', 'total_items', 'truncated']),
  jsonObject({ source: { const: 'stored' }, review_id: idJson, worktree_id: idJson, branch: { type: 'string', minLength: 1, maxLength: 1024 }, saved_at: isoJson, ...reviewCodeContentJson }, ['source', 'review_id', 'worktree_id', 'branch', 'saved_at', 'kind', 'fingerprint', 'preset', 'completed_at', 'items', 'total_items', 'truncated'])
] };
const reviewErrorCode = z.enum(['invalid_request', 'capability_unavailable', 'authentication_required', 'target_unavailable', 'configured_worktree_required', 'scope_unavailable', 'conflicted_unavailable', 'too_large', 'generation_failed', 'malformed_result', 'generation_rejected', 'timed_out', 'cancelled', 'stale_during_generation', 'busy', 'agent_busy', 'conversation_unavailable']);
const reviewErrorCodeJson = { type: 'string', enum: reviewErrorCode.options };
const reviewJob = z.union([
  z.object({ kind: z.literal('pending'), job: pendingJob }).strict(),
  z.object({ kind: z.literal('ready'), job_id: id, result: reviewResult }).strict(),
  z.object({ kind: z.literal('error'), job_id: id, code: reviewErrorCode, retryable: z.boolean() }).strict(),
  z.object({ kind: z.literal('gone'), job_id: id, reason: z.enum(['cancelled', 'superseded', 'expired']) }).strict()
]);
const reviewJobJson = { oneOf: [jsonObject({ kind: { const: 'pending' }, job: pendingJobJson }, ['kind', 'job']), jsonObject({ kind: { const: 'ready' }, job_id: idJson, result: reviewResultJson }, ['kind', 'job_id', 'result']), jsonObject({ kind: { const: 'error' }, job_id: idJson, code: reviewErrorCodeJson, retryable: boolJson }, ['kind', 'job_id', 'code', 'retryable']), jsonObject({ kind: { const: 'gone' }, job_id: idJson, reason: { type: 'string', enum: ['cancelled', 'superseded', 'expired'] } }, ['kind', 'job_id', 'reason'])] };
const askJob = z.union([
  z.object({ kind: z.literal('pending'), job: pendingJob }).strict(),
  z.object({ kind: z.literal('ready'), job_id: id, answer: z.string().max(48_000), truncated: z.boolean() }).strict(),
  z.object({ kind: z.literal('error'), job_id: id, code: reviewErrorCode, retryable: z.boolean() }).strict(),
  z.object({ kind: z.literal('gone'), job_id: id, reason: z.literal('superseded') }).strict()
]);
const askJobJson = { oneOf: [jsonObject({ kind: { const: 'pending' }, job: pendingJobJson }, ['kind', 'job']), jsonObject({ kind: { const: 'ready' }, job_id: idJson, answer: { type: 'string', maxLength: 48_000 }, truncated: boolJson }, ['kind', 'job_id', 'answer', 'truncated']), jsonObject({ kind: { const: 'error' }, job_id: idJson, code: reviewErrorCodeJson, retryable: boolJson }, ['kind', 'job_id', 'code', 'retryable']), jsonObject({ kind: { const: 'gone' }, job_id: idJson, reason: { const: 'superseded' } }, ['kind', 'job_id', 'reason'])] };

type Definition = {
  name: AgentToolName; title: string; description: string; scopes: IntegrationScope[]; risk: 'read' | 'write' | 'operational' | 'dangerous';
  audiences?: readonly ('conductor' | 'realtime')[]; schema: z.ZodType<Record<string, unknown>>; properties: Record<string, unknown>; required: string[];
  inputSchema?: Record<string, unknown>; output: z.ZodTypeAny; dataSchema: Record<string, unknown>; idempotency?: 'generic' | 'domain_cursor' | 'lifecycle';
};

const operationalAgentTools = new Set<AgentToolName>(['resume_agent', 'restart_agent', 'compact_conversation', 'launch_agent', 'steer_agent', 'start_review_tour', 'start_code_review', 'cancel_review_job', 'ask_review', 'ask_comparison', 'create_pull_request_review_draft']);
const additiveAgentTools = new Set<AgentToolName>(['new_conversation', 'launch_agent', 'queue_prompt_with_attachments', 'steer_agent', 'start_review_tour', 'start_code_review', 'ask_review', 'ask_comparison', 'create_pull_request_review_draft']);
const openWorldAgentTools = new Set<AgentToolName>(['resume_conversation', 'resume_agent', 'restart_agent', 'compact_conversation', 'get_launch_options', 'launch_agent', 'queue_prompt_with_attachments', 'steer_agent', 'relay_agent_question_answer', 'start_review_tour', 'start_code_review', 'ask_review', 'ask_comparison', 'create_pull_request_review_draft']);

// bind a real domain port to one fully declared MCP tool
function bind(definition: Definition, port: AgentToolPort): DeveloperTool {
  const risk = operationalAgentTools.has(definition.name) ? 'operational' : definition.risk;
  return developerTool({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    requiredScopes: definition.scopes,
    risk,
    audiences: definition.audiences ?? ['conductor', 'realtime'],
    schema: definition.schema,
    inputSchema: definition.inputSchema ?? inputJson(definition.properties, definition.required),
    output: definition.output,
    dataSchema: definition.dataSchema,
    openWorld: openWorldAgentTools.has(definition.name),
    ...(risk === 'read' ? {} : { destructive: !additiveAgentTools.has(definition.name) }),
    ...(definition.idempotency === undefined ? {} : { idempotency: definition.idempotency }),
    execute: port
  });
}

const modelList = z.object({ agent_id: id, current_model: z.string().min(1).max(200).optional(), current_effort: z.string().min(1).max(80).optional(), models: z.array(z.object({ id: z.string().min(1).max(200), label: short, efforts: z.array(z.string().min(1).max(80)).max(20) }).strict()).max(100), can_switch: z.boolean(), reason: short.optional() }).strict();
const modelListJson = jsonObject({ agent_id: idJson, current_model: { type: 'string', minLength: 1, maxLength: 200 }, current_effort: { type: 'string', minLength: 1, maxLength: 80 }, models: jsonArray(jsonObject({ id: { type: 'string', minLength: 1, maxLength: 200 }, label: shortJson, efforts: jsonArray({ type: 'string', minLength: 1, maxLength: 80 }, 20) }, ['id', 'label', 'efforts'])), can_switch: boolJson, reason: shortJson }, ['agent_id', 'models', 'can_switch']);
const pageConversation = z.object({ items: z.array(conversation).max(100), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict();
const pageConversationJson = jsonObject({ items: jsonArray(conversationJson), next_cursor: { type: 'string', minLength: 1, maxLength: 400 }, truncated: boolJson }, ['items', 'truncated']);
const pageTranscript = z.object({ items: z.array(transcriptSummary).max(100), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict();
const pageTranscriptJson = jsonObject({ items: jsonArray(transcriptSummaryJson), next_cursor: { type: 'string', minLength: 1, maxLength: 400 }, truncated: boolJson }, ['items', 'truncated']);
const commitPage = z.object({ items: z.array(z.object({ sha: gitObjectId, subject: z.string().max(300), author: z.string().max(240), date: iso }).strict()).max(100), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict();
const commitPageJson = jsonObject({ items: jsonArray(jsonObject({ sha: gitObjectIdJson, subject: { type: 'string', maxLength: 300 }, author: { type: 'string', maxLength: 240 }, date: isoJson }, ['sha', 'subject', 'author', 'date'])), next_cursor: { type: 'string', minLength: 1, maxLength: 400 }, truncated: boolJson }, ['items', 'truncated']);
const mergeBaseRow = z.object({ ref: z.string().min(1).max(255), label: short.optional(), sha: gitObjectId }).strict();
const mergeBaseRowJson = jsonObject({ ref: { type: 'string', minLength: 1, maxLength: 255 }, label: shortJson, sha: gitObjectIdJson }, ['ref', 'sha']);
const mergeBases = z.object({ current: mergeBaseRow.omit({ label: true }).optional(), options: z.array(mergeBaseRow).max(100), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict();
const mergeBasesJson = jsonObject({ current: jsonObject({ ref: { type: 'string', minLength: 1, maxLength: 255 }, sha: gitObjectIdJson }, ['ref', 'sha']), options: jsonArray(mergeBaseRowJson), next_cursor: { type: 'string', minLength: 1, maxLength: 400 }, truncated: boolJson }, ['options', 'truncated']);

const definitions: Definition[] = [];
// retain manifest order for deterministic discovery
const add = (definition: Definition): void => { definitions.push(definition); };
// register one read contract
const read = (name: AgentToolName, title: string, description: string, scopes: IntegrationScope[], schema: z.ZodType<Record<string, unknown>>, properties: Record<string, unknown>, required: string[], output: z.ZodTypeAny, dataSchema: Record<string, unknown>, options: Pick<Definition, 'audiences' | 'inputSchema'> = {}): void => add({ name, title, description, scopes, risk: 'read', schema, properties, required, output, dataSchema, ...options });
// register one mutation contract
const write = (name: AgentToolName, title: string, description: string, scopes: IntegrationScope[], schema: z.ZodType<Record<string, unknown>>, properties: Record<string, unknown>, required: string[], output: z.ZodTypeAny, dataSchema: Record<string, unknown>, audiences?: readonly ('conductor' | 'realtime')[], inputSchema?: Record<string, unknown>, idempotency?: Definition['idempotency']): void => add({ name, title, description, scopes, risk: 'write', schema, properties, required, output, dataSchema, ...(audiences === undefined ? {} : { audiences }), ...(inputSchema === undefined ? {} : { inputSchema }), ...(idempotency === undefined ? {} : { idempotency }) });

read('get_agent_runtime', 'Get agent runtime', 'Get bounded structured runtime state and capabilities.', ['status:read'], z.object(target).strict(), targetJson, ['agent_id'], agentState, agentStateJson);
read('list_agent_models', 'List agent models', 'List allowed model and effort choices without changing the agent.', ['status:read'], z.object(target).strict(), targetJson, ['agent_id'], modelList, modelListJson);
write('set_agent_model_effort', 'Set agent model or effort', 'Switch an authorized structured agent between allowed model settings.', ['agents:control'], z.object({ ...target, model: z.string().min(1).max(200).optional(), effort: z.string().min(1).max(80).optional(), ...request }).strict().refine(value => value.model !== undefined || value.effort !== undefined), { ...targetJson, model: { type: 'string', minLength: 1, maxLength: 200 }, effort: { type: 'string', minLength: 1, maxLength: 80 }, ...requestJson }, ['agent_id', 'request_id'], agentState, agentStateJson, undefined, { ...jsonObject({ ...targetJson, model: { type: 'string', minLength: 1, maxLength: 200 }, effort: { type: 'string', minLength: 1, maxLength: 80 }, ...requestJson }, ['agent_id', 'request_id']), anyOf: [{ required: ['model'] }, { required: ['effort'] }] });
read('list_conversations', 'List conversations', 'List bounded conversations for one visible agent.', ['logs:read'], z.object({ ...target, ...developerPageShape }).strict(), { ...targetJson, ...developerPageProperties }, ['agent_id'], pageConversation, pageConversationJson);
write('rename_conversation', 'Rename conversation', 'Rename one authorized conversation.', ['agents:control'], z.object({ ...target, conversation_id: id, name: z.string().trim().min(1).max(120), ...request }).strict(), { ...targetJson, conversation_id: idJson, name: trimmedConversationNameJson, ...requestJson }, ['agent_id', 'conversation_id', 'name', 'request_id'], z.object({ conversation_id: id, name: z.string().min(1).max(120) }).strict(), jsonObject({ conversation_id: idJson, name: { type: 'string', minLength: 1, maxLength: 120 } }, ['conversation_id', 'name']));
write('new_conversation', 'Start new conversation', 'Start a new conversation while retaining the queue.', ['agents:control'], z.object({ ...target, name: z.string().trim().min(1).max(120).optional(), ...request }).strict(), { ...targetJson, name: trimmedConversationNameJson, ...requestJson }, ['agent_id', 'request_id'], z.object({ conversation_id: id, active: z.literal(true) }).strict(), jsonObject({ conversation_id: idJson, active: { const: true } }, ['conversation_id', 'active']));
write('switch_conversation', 'Switch conversation', 'Switch to a fresh authorized conversation without losing queued prompts.', ['agents:control'], z.object({ ...target, conversation_id: id, ...request }).strict(), { ...targetJson, conversation_id: idJson, ...requestJson }, ['agent_id', 'conversation_id', 'request_id'], z.object({ conversation_id: id, active: z.literal(true), queue_preserved: z.boolean() }).strict(), jsonObject({ conversation_id: idJson, active: { const: true }, queue_preserved: boolJson }, ['conversation_id', 'active', 'queue_preserved']));
write('resume_conversation', 'Resume conversation', 'Resume an exited structured conversation.', ['agents:control'], z.object({ ...target, conversation_id: id, ...request }).strict(), { ...targetJson, conversation_id: idJson, ...requestJson }, ['agent_id', 'conversation_id', 'request_id'], agentState, agentStateJson);
write('forget_conversation', 'Forget conversation record', 'Remove only the console record, never provider history.', ['agents:control'], z.object({ ...target, conversation_id: id, ...request }).strict(), { ...targetJson, conversation_id: idJson, ...requestJson }, ['agent_id', 'conversation_id', 'request_id'], z.object({ conversation_id: id, forgotten_console_record: z.literal(true), provider_history_deleted: z.literal(false) }).strict(), jsonObject({ conversation_id: idJson, forgotten_console_record: { const: true }, provider_history_deleted: { const: false } }, ['conversation_id', 'forgotten_console_record', 'provider_history_deleted']));
write('resume_agent', 'Resume agent', 'Resume one authorized structured agent.', ['agents:control'], z.object({ ...target, ...request }).strict(), { ...targetJson, ...requestJson }, ['agent_id', 'request_id'], agentState, agentStateJson);
write('restart_agent', 'Restart agent', 'Start a recoverable generation-fenced restart command.', ['agents:control'], z.object({ ...target, ...request }).strict(), { ...targetJson, ...requestJson }, ['agent_id', 'request_id'], lifecycleStart, lifecycleStartJson, undefined, undefined, 'lifecycle');
write('compact_conversation', 'Compact conversation', 'Compact synchronously or start a recoverable replacing command.', ['agents:control'], z.object({ ...target, conversation_id: id.optional(), ...request }).strict(), { ...targetJson, conversation_id: idJson, ...requestJson }, ['agent_id', 'request_id'], z.union([z.object({ kind: z.literal('completed'), compacted: z.literal(true), queue_preserved: z.boolean() }).strict(), z.object({ kind: z.literal('command'), command: lifecycleStart }).strict()]), { oneOf: [jsonObject({ kind: { const: 'completed' }, compacted: { const: true }, queue_preserved: boolJson }, ['kind', 'compacted', 'queue_preserved']), jsonObject({ kind: { const: 'command' }, command: lifecycleStartJson }, ['kind', 'command'])] });
read('get_lifecycle_command', 'Get lifecycle command', 'Get one owner-scoped recoverable lifecycle command.', ['status:read'], z.object({ command_id: id }).strict(), { command_id: idJson }, ['command_id'], lifecycleView, lifecycleViewJson);

const launchModelSelection = z.union([
  z.object({ mode: z.literal('model'), id: z.string().min(1).max(200) }).strict(),
  z.object({ mode: z.literal('keep-current') }).strict(),
  z.object({ mode: z.literal('native-default') }).strict()
]);
const launchModelSelectionJson = { oneOf: [
  jsonObject({ mode: { const: 'model' }, id: { type: 'string', minLength: 1, maxLength: 200 } }, ['mode', 'id']),
  jsonObject({ mode: { const: 'keep-current' } }, ['mode']),
  jsonObject({ mode: { const: 'native-default' } }, ['mode'])
] };
const launchModelPolicy = z.object({
  state: z.enum(['explicit', 'native-default', 'empty']),
  allowed: z.array(z.object({ model: z.string().min(1).max(200), effort: z.string().min(1).max(80).optional(), available: z.boolean().optional() }).strict()).max(100),
  default_selection: launchModelSelection,
  current_model: z.string().min(1).max(200).optional(), current_effort: z.string().min(1).max(80).optional(),
  catalog: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(240), provider: z.string().min(1).max(120).optional(), efforts: z.array(z.string().min(1).max(80)).max(20), default_effort: z.string().min(1).max(80).optional() }).strict()).max(100),
  catalog_status: z.enum(['ready', 'unavailable', 'unsupported']), message: z.string().min(1).max(400).optional()
}).strict();
const launchModelPolicyJson = jsonObject({
  state: { type: 'string', enum: ['explicit', 'native-default', 'empty'] },
  allowed: jsonArray(jsonObject({ model: { type: 'string', minLength: 1, maxLength: 200 }, effort: { type: 'string', minLength: 1, maxLength: 80 }, available: boolJson }, ['model'])),
  default_selection: launchModelSelectionJson, current_model: { type: 'string', minLength: 1, maxLength: 200 }, current_effort: { type: 'string', minLength: 1, maxLength: 80 },
  catalog: jsonArray(jsonObject({ id: { type: 'string', minLength: 1, maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 240 }, provider: { type: 'string', minLength: 1, maxLength: 120 }, efforts: jsonArray({ type: 'string', minLength: 1, maxLength: 80 }, 20), default_effort: { type: 'string', minLength: 1, maxLength: 80 } }, ['id', 'name', 'efforts'])),
  catalog_status: { type: 'string', enum: ['ready', 'unavailable', 'unsupported'] }, message: { type: 'string', minLength: 1, maxLength: 400 }
}, ['state', 'allowed', 'default_selection', 'catalog', 'catalog_status']);
const launchSecurityMap = z.record(z.string().min(1).max(80), z.string().min(1).max(80)).refine(value => Object.keys(value).length <= 20);
const launchSecurityMapJson = { type: 'object', propertyNames: { type: 'string', minLength: 1, maxLength: 80 }, additionalProperties: { type: 'string', minLength: 1, maxLength: 80 }, maxProperties: 20 };
const launchSecurity = z.object({
  controls: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(120), icon: z.enum(['reset', 'file', 'shield', 'hand', 'warning']), options: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().min(1).max(120), risk: z.enum(['normal', 'warning', 'danger']), detail: z.string().max(400) }).strict()).min(1).max(20) }).strict()).max(20),
  defaults: launchSecurityMap,
  constraints: z.array(z.object({ when: launchSecurityMap.refine(value => Object.keys(value).length >= 1), disables: z.array(z.string().min(1).max(80)).min(1).max(20), message: z.string().min(1).max(400) }).strict()).max(20),
  status: z.enum(['ready', 'partial', 'unsupported']), message: z.string().min(1).max(400).optional()
}).strict();
const launchSecurityJson = jsonObject({
  controls: jsonArray(jsonObject({ id: { type: 'string', minLength: 1, maxLength: 80 }, label: { type: 'string', minLength: 1, maxLength: 120 }, icon: { type: 'string', enum: ['reset', 'file', 'shield', 'hand', 'warning'] }, options: { ...jsonArray(jsonObject({ id: { type: 'string', minLength: 1, maxLength: 80 }, label: { type: 'string', minLength: 1, maxLength: 120 }, risk: { type: 'string', enum: ['normal', 'warning', 'danger'] }, detail: { type: 'string', maxLength: 400 } }, ['id', 'label', 'risk', 'detail']), 20), minItems: 1 } }, ['id', 'label', 'icon', 'options']), 20),
  defaults: launchSecurityMapJson,
  constraints: jsonArray(jsonObject({ when: { ...launchSecurityMapJson, minProperties: 1 }, disables: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 20 }, message: { type: 'string', minLength: 1, maxLength: 400 } }, ['when', 'disables', 'message']), 20),
  status: { type: 'string', enum: ['ready', 'partial', 'unsupported'] }, message: { type: 'string', minLength: 1, maxLength: 400 }
}, ['controls', 'defaults', 'constraints', 'status']);
const launchKind = z.object({ kind: agentKind, options_revision: short, model_policy: launchModelPolicy, security: launchSecurity }).strict();
const launchKindJson = jsonObject({ kind: agentKindJson, options_revision: shortJson, model_policy: launchModelPolicyJson, security: launchSecurityJson }, ['kind', 'options_revision', 'model_policy', 'security']);
const launchOption = z.object({ option_id: id, expires_at: iso, ordinary_launch: z.boolean(), kinds: z.array(launchKind).max(5) }).strict();
const launchOptionJson = jsonObject({ option_id: idJson, expires_at: isoJson, ordinary_launch: boolJson, kinds: jsonArray(launchKindJson, 5) }, ['option_id', 'expires_at', 'ordinary_launch', 'kinds']);
read('get_launch_options', 'Get launch options', 'Get a short-lived target-bound launch option.', ['status:read'], z.object({ destination_kind: z.enum(['worktree', 'scratch', 'folder']), worktree_id: id.optional(), folder_place_id: id.optional() }).strict().refine(value => value.destination_kind === 'worktree' ? value.worktree_id !== undefined && value.folder_place_id === undefined : value.destination_kind === 'folder' ? value.folder_place_id !== undefined && value.worktree_id === undefined : value.worktree_id === undefined && value.folder_place_id === undefined), { destination_kind: { type: 'string', enum: ['worktree', 'scratch', 'folder'] }, worktree_id: idJson, folder_place_id: idJson }, ['destination_kind'], launchOption, launchOptionJson, { inputSchema: { oneOf: [jsonObject({ destination_kind: { const: 'worktree' }, worktree_id: idJson }, ['destination_kind', 'worktree_id']), jsonObject({ destination_kind: { const: 'folder' }, folder_place_id: idJson }, ['destination_kind', 'folder_place_id']), jsonObject({ destination_kind: { const: 'scratch' } }, ['destination_kind'])] } });
write('launch_agent', 'Launch agent', 'Launch only after revalidating the complete short-lived option.', ['agents:control'], z.object({ option_id: id, kind: agentKind, model: z.string().min(1).max(200).optional(), effort: z.string().min(1).max(80).optional(), native_mode: z.string().min(1).max(80).optional(), security_mode: z.string().min(1).max(80).optional(), ...request }).strict(), { option_id: idJson, kind: agentKindJson, model: { type: 'string', minLength: 1, maxLength: 200 }, effort: { type: 'string', minLength: 1, maxLength: 80 }, native_mode: { type: 'string', minLength: 1, maxLength: 80 }, security_mode: { type: 'string', minLength: 1, maxLength: 80 }, ...requestJson }, ['option_id', 'kind', 'request_id'], z.object({ agent_id: id, kind: agentKind, model: z.string().min(1).max(200).optional(), effort: z.string().min(1).max(80).optional() }).strict(), jsonObject({ agent_id: idJson, kind: agentKindJson, model: { type: 'string', minLength: 1, maxLength: 200 }, effort: { type: 'string', minLength: 1, maxLength: 80 } }, ['agent_id', 'kind']), ['realtime']);
const fileRef = z.object({ object_token: z.string().min(20).max(16_384), name: z.string().min(1).max(255), size: z.number().int().nonnegative(), mime: z.string().min(1).max(200).optional() }).strict();
const fileRefJson = jsonObject({ object_token: { type: 'string', minLength: 20, maxLength: 16_384 }, name: { type: 'string', minLength: 1, maxLength: 255 }, size: nonnegativeJson, mime: { type: 'string', minLength: 1, maxLength: 200 } }, ['object_token', 'name', 'size']);
write('queue_prompt_with_attachments', 'Queue prompt with attachments', 'Queue a bounded prompt using owner-bound file capabilities.', ['prompts:write'], z.object({ ...target, prompt: z.string().min(1).max(8192), attachments: z.array(fileRef).min(1).max(20), ...request }).strict().refine(value => Buffer.byteLength(JSON.stringify(value.attachments)) <= 40_000), { ...targetJson, prompt: { type: 'string', minLength: 1, maxLength: 8192 }, attachments: { ...jsonArray(fileRefJson, 20), minItems: 1, description: 'Serialized attachments are limited to 40,000 UTF-8 bytes by runtime validation.' }, ...requestJson }, ['agent_id', 'prompt', 'attachments', 'request_id'], z.object({ accepted: z.literal(true), prompt_id: id }).strict(), jsonObject({ accepted: { const: true }, prompt_id: idJson }, ['accepted', 'prompt_id']));
write('steer_agent', 'Steer agent', 'Steer the current turn instead of queuing a new prompt.', ['prompts:write'], z.object({ ...target, text: z.string().min(1).max(8192), ...request }).strict(), { ...targetJson, text: { type: 'string', minLength: 1, maxLength: 8192 }, ...requestJson }, ['agent_id', 'text', 'request_id'], z.object({ accepted: z.literal(true), steered: z.literal(true) }).strict(), jsonObject({ accepted: { const: true }, steered: { const: true } }, ['accepted', 'steered']));
const answerShape = z.union([
  z.object({ ...target, question_id: id, index: z.number().int().min(0).max(15), ...request }).strict(),
  z.object({ ...target, question_id: id, text: z.string().min(1).max(8000), ...request }).strict(),
  z.object({ ...target, question_id: id, dismiss: z.literal(true), ...request }).strict()
]);
const answerCommonJson = { ...targetJson, question_id: idJson, ...requestJson };
const answerInputJson = { oneOf: [
  inputJson({ ...answerCommonJson, index: { type: 'integer', minimum: 0, maximum: 15 } }, ['agent_id', 'question_id', 'index', 'request_id']),
  inputJson({ ...answerCommonJson, text: { type: 'string', minLength: 1, maxLength: 8000 } }, ['agent_id', 'question_id', 'text', 'request_id']),
  inputJson({ ...answerCommonJson, dismiss: { const: true } }, ['agent_id', 'question_id', 'dismiss', 'request_id'])
] };
write('relay_agent_question_answer', 'Relay question answer', 'Relay exactly one answer form from the authenticated Davo lease.', ['prompts:write'], answerShape, { ...targetJson, question_id: idJson, index: { type: 'integer', minimum: 0, maximum: 15 }, text: { type: 'string', minLength: 1, maxLength: 8000 }, dismiss: { const: true }, ...requestJson }, ['agent_id', 'question_id', 'request_id'], z.object({ answered: z.literal(true), relayed: z.enum(['index', 'text', 'dismiss']) }).strict(), jsonObject({ answered: { const: true }, relayed: { type: 'string', enum: ['index', 'text', 'dismiss'] } }, ['answered', 'relayed']), ['realtime'], answerInputJson);

read('list_transcript_items', 'List transcript items', 'List bounded redacted structured transcript summaries.', ['logs:read'], z.object({ ...target, conversation_id: id.optional(), ...developerPageShape }).strict(), { ...targetJson, conversation_id: idJson, ...developerPageProperties }, ['agent_id'], pageTranscript, pageTranscriptJson);
read('get_transcript_item', 'Get transcript item', 'Get one bounded redacted transcript item.', ['logs:read'], z.object({ ...target, item_id: id }).strict(), { ...targetJson, item_id: idJson }, ['agent_id', 'item_id'], transcriptItem, transcriptItemJson);
const comparisonInput = { ...target, mode: z.enum(['working', 'pull_request', 'commit']), commit: gitObjectId.optional() };
const comparisonInputJson = { ...targetJson, mode: { type: 'string', enum: ['working', 'pull_request', 'commit'] }, commit: gitObjectIdJson };
// require commit identity only for commit mode
const comparisonInvariant = (value: { mode: 'working' | 'pull_request' | 'commit'; commit?: string }): boolean => (value.mode === 'commit') === (value.commit !== undefined);
read('get_comparison', 'Get comparison', 'Get a bounded comparison summary.', ['files:read'], z.object({ ...comparisonInput, ...developerPageShape }).strict().refine(comparisonInvariant), { ...comparisonInputJson, ...developerPageProperties }, ['agent_id', 'mode'], comparisonSummary, comparisonSummaryJson, { inputSchema: { ...jsonObject({ ...comparisonInputJson, ...developerPageProperties }, ['agent_id', 'mode']), ...modeCommitConditionJson } });
read('list_comparison_commits', 'List comparison commits', 'List commits in the current pull-request comparison.', ['status:read'], z.object({ ...target, ...developerPageShape }).strict(), { ...targetJson, ...developerPageProperties }, ['agent_id'], commitPage, commitPageJson);
read('get_comparison_file', 'Get comparison file', 'Get bounded content for one allow-listed changed file.', ['files:read'], z.object({ ...comparisonInput, path: z.string().min(1).max(4096), max_bytes: z.number().int().min(1).max(262_144).optional() }).strict().refine(comparisonInvariant), { ...comparisonInputJson, path: { type: 'string', minLength: 1, maxLength: 4096 }, max_bytes: { type: 'integer', minimum: 1, maximum: 262_144 } }, ['agent_id', 'mode', 'path'], comparisonFile, comparisonFileJson, { inputSchema: { ...jsonObject({ ...comparisonInputJson, path: { type: 'string', minLength: 1, maxLength: 4096 }, max_bytes: { type: 'integer', minimum: 1, maximum: 262_144 } }, ['agent_id', 'mode', 'path']), ...modeCommitConditionJson } });
read('list_merge_bases', 'List merge bases', 'List the current base and fresh resolved base choices.', ['status:read'], z.object({ ...target, ...developerPageShape }).strict(), { ...targetJson, ...developerPageProperties }, ['agent_id'], mergeBases, mergeBasesJson);
write('set_merge_base', 'Set merge base', 'Set one freshly revalidated resolved merge base.', ['review:write'], z.object({ ...target, ref: z.string().min(1).max(255), sha: gitObjectId, ...request }).strict(), { ...targetJson, ref: { type: 'string', minLength: 1, maxLength: 255 }, sha: gitObjectIdJson, ...requestJson }, ['agent_id', 'ref', 'sha', 'request_id'], mergeBaseRow.omit({ label: true }), jsonObject({ ref: { type: 'string', minLength: 1, maxLength: 255 }, sha: gitObjectIdJson }, ['ref', 'sha']));

const reviewScopeInput = { scope: z.enum(['working', 'pr', 'commit']), commit: gitObjectId.optional() };
const reviewScopeJson = { scope: { type: 'string', enum: ['working', 'pr', 'commit'] }, commit: gitObjectIdJson };
// require commit identity only for commit review scope
const reviewScopeInvariant = (value: { scope: 'working' | 'pr' | 'commit'; commit?: string }): boolean => (value.scope === 'commit') === (value.commit !== undefined);
const reviewPreset = z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(80), agent: agentKind, effort: z.string().min(1).max(20).optional(), efforts: z.array(z.string().min(1).max(20)).max(20), available: z.boolean(), reason: short.optional() }).strict();
const reviewPresetJson = jsonObject({ id: { type: 'string', minLength: 1, maxLength: 40 }, label: { type: 'string', minLength: 1, maxLength: 80 }, agent: agentKindJson, effort: { type: 'string', minLength: 1, maxLength: 20 }, efforts: jsonArray({ type: 'string', minLength: 1, maxLength: 20 }, 20), available: boolJson, reason: shortJson }, ['id', 'label', 'agent', 'efforts', 'available']);
const reviewSelection = z.object({ id: z.string().min(8).max(100), path: z.string().min(1).max(4096), category: z.enum(['implementation', 'test', 'doc']), kind: z.enum(['hunk', 'binary', 'rename', 'metadata', 'untracked']), selected: z.boolean() }).strict();
const reviewSelectionJson = jsonObject({ id: { type: 'string', minLength: 8, maxLength: 100 }, path: { type: 'string', minLength: 1, maxLength: 4096 }, category: { type: 'string', enum: ['implementation', 'test', 'doc'] }, kind: { type: 'string', enum: ['hunk', 'binary', 'rename', 'metadata', 'untracked'] }, selected: boolJson }, ['id', 'path', 'category', 'kind', 'selected']);
const reviewOptions = z.object({ fingerprint: z.string().min(16).max(128), presets: z.array(reviewPreset).max(40), scopes: z.array(z.object({ scope: z.enum(['working', 'pr', 'commit']), commit: gitObjectId.optional(), label: z.string().min(1).max(120), available: z.boolean(), reason: short.optional() }).strict()).min(1).max(3), selections: z.array(reviewSelection).max(100), selection_total: z.number().int().min(0).max(500), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict();
const reviewOptionsJson = jsonObject({ fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, presets: jsonArray(reviewPresetJson, 40), scopes: { ...jsonArray(jsonObject({ scope: { type: 'string', enum: ['working', 'pr', 'commit'] }, commit: gitObjectIdJson, label: { type: 'string', minLength: 1, maxLength: 120 }, available: boolJson, reason: shortJson }, ['scope', 'label', 'available']), 3), minItems: 1 }, selections: jsonArray(reviewSelectionJson), selection_total: { type: 'integer', minimum: 0, maximum: 500 }, next_cursor: { type: 'string', minLength: 1, maxLength: 400 }, truncated: boolJson }, ['fingerprint', 'presets', 'scopes', 'selections', 'selection_total', 'truncated']);
read('list_review_options', 'List review options', 'List bounded fresh review choices and selection fingerprint.', ['status:read'], z.object({ ...target, ...developerPageShape }).strict(), { ...targetJson, ...developerPageProperties }, ['agent_id'], reviewOptions, reviewOptionsJson);
write('start_review_tour', 'Start Review Tour', 'Start an owner-scoped Review Tour job.', ['review:write'], z.object({ ...target, fingerprint: z.string().min(16).max(128), preset: z.string().min(1).max(40).optional(), ...reviewScopeInput, selections: z.array(z.string().min(8).max(100)).max(100).optional(), ...request }).strict().refine(reviewScopeInvariant), { ...targetJson, fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, preset: { type: 'string', minLength: 1, maxLength: 40 }, ...reviewScopeJson, selections: jsonArray({ type: 'string', minLength: 8, maxLength: 100 }), ...requestJson }, ['agent_id', 'fingerprint', 'scope', 'request_id'], reviewStart, reviewStartJson, undefined, { ...jsonObject({ ...targetJson, fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, preset: { type: 'string', minLength: 1, maxLength: 40 }, ...reviewScopeJson, selections: jsonArray({ type: 'string', minLength: 8, maxLength: 100 }), ...requestJson }, ['agent_id', 'fingerprint', 'scope', 'request_id']), ...scopeCommitConditionJson });
write('start_code_review', 'Start Code Review', 'Start an owner-scoped Code Review job.', ['review:write'], z.object({ ...target, fingerprint: z.string().min(16).max(128), preset: z.string().min(1).max(40).optional(), ...reviewScopeInput, selections: z.array(z.string().min(8).max(100)).max(100).optional(), include_tests: z.boolean(), include_docs: z.boolean(), ...request }).strict().refine(reviewScopeInvariant), { ...targetJson, fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, preset: { type: 'string', minLength: 1, maxLength: 40 }, ...reviewScopeJson, selections: jsonArray({ type: 'string', minLength: 8, maxLength: 100 }), include_tests: boolJson, include_docs: boolJson, ...requestJson }, ['agent_id', 'fingerprint', 'scope', 'include_tests', 'include_docs', 'request_id'], pendingJob, pendingJobJson, undefined, { ...jsonObject({ ...targetJson, fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, preset: { type: 'string', minLength: 1, maxLength: 40 }, ...reviewScopeJson, selections: jsonArray({ type: 'string', minLength: 8, maxLength: 100 }), include_tests: boolJson, include_docs: boolJson, ...requestJson }, ['agent_id', 'fingerprint', 'scope', 'include_tests', 'include_docs', 'request_id']), ...scopeCommitConditionJson });
read('get_review_job', 'Get review job', 'Get one owner-scoped review job.', ['status:read'], z.object({ job_id: id, ...developerPageShape }).strict(), { job_id: idJson, ...developerPageProperties }, ['job_id'], reviewJob, reviewJobJson);
write('cancel_review_job', 'Cancel review job', 'Cancel one owner-scoped review job.', ['review:write'], z.object({ job_id: id, ...request }).strict(), { job_id: idJson, ...requestJson }, ['job_id', 'request_id'], z.object({ job_id: id, state: z.literal('cancelled') }).strict(), jsonObject({ job_id: idJson, state: { const: 'cancelled' } }, ['job_id', 'state']));
read('get_stored_review', 'Get stored review', 'Get one bounded stored Review Tour or Code Review.', ['status:read'], z.object({ worktree_id: id, fingerprint: z.string().min(16).max(128).optional(), kind: z.enum(['tour', 'code_review']).optional(), ...developerPageShape }).strict(), { worktree_id: idJson, fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, kind: { type: 'string', enum: ['tour', 'code_review'] }, ...developerPageProperties }, ['worktree_id'], z.object({ review: reviewResult.optional() }).strict(), jsonObject({ review: reviewResultJson }, []));
write('ask_review', 'Ask about review', 'Start an owner-scoped follow-up question about a stored review.', ['review:write'], z.object({ review_id: z.string().min(16).max(128), question: z.string().min(1).max(8000), ...request }).strict(), { review_id: { type: 'string', minLength: 16, maxLength: 128 }, question: { type: 'string', minLength: 1, maxLength: 8000 }, ...requestJson }, ['review_id', 'question', 'request_id'], pendingJob, pendingJobJson);
write('ask_comparison', 'Ask about comparison', 'Start an owner-scoped question about a fresh comparison.', ['review:write'], z.object({ ...target, question: z.string().min(1).max(8000), mode: z.enum(['working', 'pull_request', 'commit']), commit: gitObjectId.optional(), ...request }).strict().refine(comparisonInvariant), { ...targetJson, question: { type: 'string', minLength: 1, maxLength: 8000 }, mode: { type: 'string', enum: ['working', 'pull_request', 'commit'] }, commit: gitObjectIdJson, ...requestJson }, ['agent_id', 'question', 'mode', 'request_id'], pendingJob, pendingJobJson, undefined, { ...jsonObject({ ...targetJson, question: { type: 'string', minLength: 1, maxLength: 8000 }, mode: { type: 'string', enum: ['working', 'pull_request', 'commit'] }, commit: gitObjectIdJson, ...requestJson }, ['agent_id', 'question', 'mode', 'request_id']), ...modeCommitConditionJson });
read('get_ask_job', 'Get Ask job', 'Get one owner-scoped Ask result.', ['status:read'], z.object({ job_id: id }).strict(), { job_id: idJson }, ['job_id'], askJob, askJobJson);
write('create_pull_request_review_draft', 'Create pull request review draft', 'Create a draft only; never submit a final GitHub review.', ['github:write' as IntegrationScope], z.object({ repository: z.string().min(3).max(300), number: z.number().int().min(1).max(2_147_483_647), fingerprint: z.string().min(16).max(128), body: z.string().max(30_000).optional(), comments: z.array(z.object({ path: z.string().min(1).max(4096), line: z.number().int().positive(), body: z.string().min(1).max(8000) }).strict()).max(100).optional(), ...request }).strict().refine(value => Buffer.byteLength(JSON.stringify({ body: value.body, comments: value.comments })) <= 48_000), { repository: { type: 'string', minLength: 3, maxLength: 300 }, number: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }, fingerprint: { type: 'string', minLength: 16, maxLength: 128 }, body: { type: 'string', maxLength: 30_000, description: 'Combined body and comments are limited to 48,000 UTF-8 bytes by runtime validation.' }, comments: { ...jsonArray(jsonObject({ path: { type: 'string', minLength: 1, maxLength: 4096 }, line: { type: 'integer', minimum: 1 }, body: { type: 'string', minLength: 1, maxLength: 8000 } }, ['path', 'line', 'body'])), description: 'Combined body and comments are limited to 48,000 UTF-8 bytes by runtime validation.' }, ...requestJson }, ['repository', 'number', 'fingerprint', 'request_id'], z.object({ draft_id: id, state: z.literal('pending') }).strict(), jsonObject({ draft_id: idJson, state: { const: 'pending' } }, ['draft_id', 'state']), ['realtime']);

// expose only operations backed by a real injected domain port
export function createAgentTools(ports: AgentToolPorts): DeveloperTool[] {
  return definitions.flatMap(definition => {
    const port = ports[definition.name];
    // do not advertise an operation whose domain port was not wired
    if (port === undefined) return [];
    return [bind(definition, port)];
  });
}
