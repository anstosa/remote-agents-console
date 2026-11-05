import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationPrincipal, IntegrationScope } from '../auth/index.js';
import { redactIntegrationText } from '../text.js';
import type { GithubService } from '../../github/service.js';
import { githubRepository, type GithubRepository } from '../../github/github.js';
import type { HostFilesOwnerContext, HostFilesPlace, OperationResult } from '../../host-files/contracts.js';
import { HostFilesError } from '../../host-files/contracts.js';
import type { HostFilesService } from '../../host-files/service.js';
import { hostFilesLimits } from '../../host-files/service.js';
import { mcpFileLimits, type McpFileRef, type McpFileTransferService } from '../../host-files/mcp-transfer.js';
import type { WorktreeNote, WorktreeNoteService } from '../../notes/service.js';

import type { Schedule, ScheduleTarget } from '../../schedule/types.js';
import type { ConfiguredButtonCatalog } from '../../button-actions/catalog.js';
import type { ButtonActionService, ButtonOperation } from '../../button-actions/service.js';
import { buttonSlotNames, type ButtonSlot } from '../../config/buttons.js';
import { agentKinds } from '../../adapters/types.js';
import { declaredProcesses } from '../../domain/stack-processes.js';
import type { PullRequestSwitchService } from '../../pull-requests/switch-service.js';
import type { WorktreeManagementService } from '../../worktrees/management.js';
import type { Worktree } from '../../domain/models.js';
import type { DavoWatchOwner, Watches } from '../../watches/service.js';
import { developerFailure, developerIdSchema, developerIdentifier, developerPageProperties, developerPageShape, developerRequestId, developerRequestSchema, developerSuccess, developerTool, type DeveloperResult, type DeveloperTool } from './developer-tool.js';
import { legacyOutput } from './legacy-output.js';

type WorkspacePlace = HostFilesPlace & { projectId: string; label: string };
type AgentTarget = { agentId: string; worktreeId: string; projectId: string };
type PreparationKind = 'branch' | 'worktree' | 'prune' | 'file';
type PreparationRecord = { id: string; kind: PreparationKind; owner: string; leaseKey?: string; createdAt: number; expiresAt: number; facts: unknown; factsDigest: string; input: Record<string, unknown>; executable: boolean };
type ScheduleTargetOption = { target: ScheduleTarget; label: string; available: boolean; reason?: string };

export type WorkspaceToolsDependencies = {
  hostFiles: HostFilesService;
  transfers: McpFileTransferService;
  resolvePlace: (placeId: string, principal: IntegrationPrincipal) => Promise<WorkspacePlace | undefined>;
  resolveProject: (projectId: string, principal: IntegrationPrincipal) => Promise<{ id: string } | undefined>;
  resolveAgent: (agentId: string, principal: IntegrationPrincipal) => Promise<AgentTarget | undefined>;
  resolveWorktree: (worktreeId: string, principal: IntegrationPrincipal) => Promise<Worktree | undefined>;
  listWorktrees: (projectId: string, principal: IntegrationPrincipal) => Promise<Worktree[]>;
  owner: (principal: IntegrationPrincipal) => HostFilesOwnerContext | undefined;
  davoWatchOwner: (principal: IntegrationPrincipal) => DavoWatchOwner | undefined;
  pullRequests: PullRequestSwitchService;
  worktrees: WorktreeManagementService;
  worktreeStatus: (worktreeId: string, principal: IntegrationPrincipal) => Promise<unknown>;
  pullRequestStatus: (worktreeId: string, principal: IntegrationPrincipal) => Promise<unknown>;
  removeWorktree: (worktree: Worktree, input: { discardChanges: boolean; deleteBranch: boolean }) => Promise<{ removed: boolean }>;
  pruneRecords: (projectId: string) => Promise<void>;
  pruneFacts: (projectId: string) => Promise<{ ids: string[]; blockers: string[] }>;
  github: GithubService;
  notes: WorktreeNoteService;
  noteKey: (worktree: Worktree) => Promise<string | undefined>;
  scheduleTargets: (worktree: Worktree, principal: IntegrationPrincipal) => Promise<ScheduleTargetOption[]>;
  previewSchedule: (cron: string, target: ScheduleTarget) => Promise<string[]>;
  buildSchedule: (worktree: Worktree, note: WorktreeNote, input: { cron: string; enabled: boolean; target: ScheduleTarget }, principal: IntegrationPrincipal) => Promise<Schedule | string>;
  runNoteNow: (worktree: Worktree, note: WorktreeNote, target: ScheduleTarget, principal: IntegrationPrincipal) => Promise<{ runId: string; state: 'launched' | 'running' | 'skipped' | 'failed' }>;
  buttons: ButtonActionService;
  buttonCatalog: ConfiguredButtonCatalog;
  canInvokeActionTarget: (target: AgentTarget, principal: IntegrationPrincipal) => Promise<boolean>;
  watches: Watches;
  now?: () => number;
};

const opaque = z.string().min(20).max(16_384);
const repository = z.string().min(3).max(300).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const branch = z.string().min(1).max(255).refine(value => !value.includes('\0'));
const request = { request_id: developerRequestId };
const idJson = developerIdSchema;
const opaqueJson = { type: 'string', minLength: 20, maxLength: 16_384 };
// reserve the largest permitted capability in attachment page accounting
const attachmentCapabilityBudget = 'x'.repeat(16_384);
const preparationOutput = z.object({ preparation_id: developerIdentifier, facts_digest: z.string().min(43).max(64), expires_at: z.string().datetime({ offset: true }), blockers: z.array(z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(400) }).strict()).max(50) }).strict();
const preparationJson = { type: 'object', properties: { preparation_id: idJson, facts_digest: { type: 'string', minLength: 43, maxLength: 64 }, expires_at: { type: 'string', format: 'date-time' }, blockers: { type: 'array', maxItems: 50, items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'], additionalProperties: false } } }, required: ['preparation_id', 'facts_digest', 'expires_at', 'blockers'], additionalProperties: false };
const fileRef = z.object({ object_token: opaque, name: z.string().min(1).max(255), size: z.number().int().nonnegative(), mime: z.string().min(1).max(200).optional() }).strict();
const fileRefJson = { type: 'object', properties: { object_token: opaqueJson, name: { type: 'string', minLength: 1, maxLength: 255 }, size: { type: 'integer', minimum: 0 }, mime: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['object_token', 'name', 'size'], additionalProperties: false };
const worktreeStatusOutput = legacyOutput('get_worktree_status');
const pullRequestStatusOutput = legacyOutput('get_pull_request_status');
const destinationOutput = exactDestinationOutput();
const filesCapabilitiesOutput = exactFilesCapabilitiesOutput();
const filesPageOutput = exactFilesPageOutput();
const filePreviewOutput = exactFilePreviewOutput();
const fileOperationOutput = exactFileOperationOutput();
const fileUploadBeginOutput = exactFileUploadBeginOutput();
const fileChunkOutput = exactFileChunkOutput();
const fileTransferOutput = exactFileTransferOutput();
const fileDownloadOutput = exactFileDownloadOutput();
const noteOutput = exactNoteOutput();
const attachmentPageOutput = exactAttachmentPageOutput();
const attachmentOutput = exactAttachmentOutput();
const scheduleTargetPageOutput = exactScheduleTargetPageOutput();
const scheduleOutput = exactScheduleOutput();
const actionPageOutput = exactActionPageOutput();
const watchPullOutput = legacyOutput('watch_pull_request');
const watchReviewsOutput = legacyOutput('watch_review_requests');
const watchProcessOutput = legacyOutput('watch_process');

// expose only exact workspace tools whose domain ports are fully provided
export function createWorkspaceTools(deps: WorkspaceToolsDependencies): DeveloperTool[] {
  const preparations = new PreparationStore(deps.now ?? Date.now);
  const pages = new PageCursorStore(deps.now ?? Date.now);
  const tools: DeveloperTool[] = [];
  const add = (tool: DeveloperTool): void => { tools.push(tool); };

  // register a read tool with paired strict input/output schemas
  const read = (input: { name: string; title: string; description: string; scopes: IntegrationScope[]; audiences?: ('conductor' | 'realtime')[]; contractVersion?: 'v1' | 'v2'; schema: z.ZodType<Record<string, unknown>>; inputSchema: Record<string, unknown>; output: z.ZodTypeAny; dataSchema: Record<string, unknown>; openWorld?: boolean; execute: (value: Record<string, unknown>, principal: IntegrationPrincipal) => Promise<unknown> }): void => add(developerTool({ ...input, audiences: input.audiences ?? ['conductor', 'realtime'], requiredScopes: input.scopes, risk: 'read', schema: input.schema, inputSchema: input.inputSchema, output: input.output, dataSchema: input.dataSchema, openWorld: input.openWorld, execute: async (value, principal) => await safely(async () => developerSuccess(await input.execute(value, principal))) }));
  // register a mutation with the common request identity
  const mutation = (input: { name: string; title: string; description: string; scopes: IntegrationScope[]; risk?: 'write' | 'operational' | 'dangerous'; audiences?: ('conductor' | 'realtime')[]; contractVersion?: 'v1' | 'v2'; schema: z.ZodObject<any>; properties: Record<string, unknown>; required: string[]; output: z.ZodTypeAny; dataSchema: Record<string, unknown>; idempotency?: 'generic' | 'domain_cursor'; destructive?: boolean; openWorld?: boolean; execute: (value: Record<string, unknown>, principal: IntegrationPrincipal) => Promise<unknown> }): void => add(developerTool({ ...input, audiences: input.audiences ?? ['conductor', 'realtime'], requiredScopes: input.scopes, risk: input.risk ?? 'write', schema: input.schema.extend(request).strict(), inputSchema: objectSchema({ ...input.properties, request_id: developerRequestSchema }, [...input.required, 'request_id']), output: input.output, dataSchema: input.dataSchema, idempotency: input.idempotency, destructive: input.destructive, openWorld: input.openWorld, execute: async (value, principal) => await safely(async () => developerSuccess(await input.execute(value, principal))) }));

  // register a domain cursor without allocating generic replay state
  const cursor = (input: { name: string; title: string; description: string; scopes: IntegrationScope[]; audiences?: ('conductor' | 'realtime')[]; schema: z.ZodType<Record<string, unknown>>; inputSchema: Record<string, unknown>; output: z.ZodTypeAny; dataSchema: Record<string, unknown>; destructive?: boolean; openWorld?: boolean; execute: (value: Record<string, unknown>, principal: IntegrationPrincipal) => Promise<unknown> }): void => add(developerTool({ ...input, audiences: input.audiences ?? ['conductor', 'realtime'], requiredScopes: input.scopes, risk: 'operational', schema: input.schema, inputSchema: input.inputSchema, output: input.output, dataSchema: input.dataSchema, idempotency: 'domain_cursor', destructive: input.destructive, openWorld: input.openWorld, execute: async (value, principal) => await safely(async () => developerSuccess(await input.execute(value, principal))) }));

  registerDestinations({ read, mutation, cursor, deps, preparations, pages });
  registerGithub({ read, mutation, cursor, deps, preparations, pages });
  registerFiles({ read, mutation, cursor, deps, preparations, pages });
  registerNotes({ read, mutation, cursor, deps, preparations, pages });
  registerActions({ read, mutation, cursor, deps, preparations, pages });
  registerWatchFeed({ read, mutation, cursor, deps, preparations, pages });
  return tools;
}

// register branch, Worktree and destination operations
function registerDestinations(ctx: RegistryContext): void {
  const { read, mutation, deps, preparations, pages } = ctx;
  const targetSchema = z.object({ agent_id: developerIdentifier, ...developerPageShape }).strict();
  read({ name: 'list_agent_destinations', title: 'List agent destinations', description: 'List bounded branch, Worktree and pull-request destinations.', scopes: scopes('status:read'), schema: targetSchema, inputSchema: objectSchema({ agent_id: idJson, ...developerPageProperties }, ['agent_id']), ...destinationOutput, openWorld: true, execute: async (value, principal) => {
    const target = await requiredAgent(deps, value.agent_id as string, principal);
    const available = await deps.pullRequests.available(target.worktreeId, true, true);
    // require one current target availability snapshot
    if (available === undefined) throw failure('not_found', 'destination list unavailable');
    const limit = (value.limit as number | undefined) ?? 50;
    const allBranches = available.branches.map(candidate => ({ name: candidate.branch.slice(0, 255), checked_out: candidate.checkedOut, ...(candidate.openIn === undefined ? {} : { open_in: { worktree_id: candidate.openIn.worktreeId, worktree_name: candidate.openIn.worktreeName.slice(0, 240), ...(candidate.openIn.agentId === undefined ? {} : { agent_id: candidate.openIn.agentId }) } }), ...(candidate.commitSummary === undefined ? {} : { commit_summary: { subject: candidate.commitSummary.subject.slice(0, 300), count: candidate.commitSummary.count } }) }));
    const allWorktrees = await deps.listWorktrees(target.projectId, principal);
    const allWorktreeViews = allWorktrees.map(worktree => ({ worktree_id: worktree.id, label: worktree.label.slice(0, 240), ...(worktree.branch === undefined ? {} : { branch: worktree.branch.slice(0, 255) }), active: worktree.id === target.worktreeId, available: worktree.available && !worktree.locked }));
    const allPullRequests = [...available.pullRequests, ...available.otherPullRequests].map(candidate => ({ number: candidate.number, title: candidate.title.slice(0, 512), title_truncated: candidate.title.length > 512, branch: candidate.branch.slice(0, 255), head_sha: candidate.headSha, head_on_origin: candidate.headOnOrigin, ...(candidate.headRepository === undefined ? {} : { head_repository: candidate.headRepository.slice(0, 300) }), draft: candidate.draft, url: candidate.url.slice(0, 2_048), checkout_branch: candidate.checkoutBranch.slice(0, 255), checked_out: candidate.checkedOut, ...(candidate.openIn === undefined ? {} : { open_in: { worktree_id: candidate.openIn.worktreeId, worktree_name: candidate.openIn.worktreeName.slice(0, 240), ...(candidate.openIn.agentId === undefined ? {} : { agent_id: candidate.openIn.agentId }) } }) }));
    const combined = [...allBranches.map(item => ({ kind: 'branch' as const, item })), ...allWorktreeViews.map(item => ({ kind: 'worktree' as const, item })), ...allPullRequests.map(item => ({ kind: 'pull_request' as const, item }))];
    const offset = pages.offset(value.cursor, principal, 'list_agent_destinations', { agent_id: value.agent_id });
    const page = boundedPage(combined, offset, limit);
    const branches = page.items.filter(entry => entry.kind === 'branch').map(entry => entry.item);
    const worktrees = page.items.filter(entry => entry.kind === 'worktree').map(entry => entry.item);
    const pullRequests = page.items.filter(entry => entry.kind === 'pull_request').map(entry => entry.item);
    const total = available.branches.length + allWorktrees.length + available.pullRequests.length + available.otherPullRequests.length;
    const nextCursor = page.nextOffset === undefined ? undefined : pages.create(principal, 'list_agent_destinations', { agent_id: value.agent_id }, page.nextOffset);
    return { branches, worktrees, pull_requests: pullRequests, counts: { branches: available.branches.length, worktrees: allWorktrees.length, pull_requests: available.pullRequests.length + available.otherPullRequests.length }, ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }), truncated: page.truncated || branches.length + worktrees.length + pullRequests.length < total };
  } });
  const switchInput = z.object({ agent_id: developerIdentifier, branch }).strict();
  mutation({ name: 'switch_branch', title: 'Switch branch', description: 'Switch one fresh clean target to a current local branch.', scopes: scopes('agents:control', 'admin:dangerous'), risk: 'dangerous', schema: switchInput, properties: { agent_id: idJson, branch: stringJson(1, 255) }, required: ['agent_id', 'branch'], output: worktreeStatusOutput.output, dataSchema: withLegacyDefinitions(worktreeStatusOutput), execute: async (value, principal) => {
    const target = await requiredAgent(deps, value.agent_id as string, principal);
    const result = await deps.pullRequests.switchBranch(target.worktreeId, value.branch as string);
    // report every current-domain refusal without projecting internal variants
    if (result !== 'switched') throw failure('target_changed', typeof result === 'object' ? result.error : 'target is busy', true);
    return await deps.worktreeStatus(target.worktreeId, principal);
  } });
  const moveBranch = z.object({ agent_id: developerIdentifier, branch, destination_worktree_id: developerIdentifier }).strict();
  mutation({ name: 'move_branch', title: 'Move branch', description: 'Move a currently occupied branch into a fresh destination.', scopes: scopes('agents:control', 'admin:dangerous'), risk: 'dangerous', schema: moveBranch, properties: { agent_id: idJson, branch: stringJson(1, 255), destination_worktree_id: idJson }, required: ['agent_id', 'branch', 'destination_worktree_id'], output: worktreeStatusOutput.output, dataSchema: withLegacyDefinitions(worktreeStatusOutput), execute: async (value, principal) => {
    await requiredAgent(deps, value.agent_id as string, principal);
    await requiredWorktree(deps, value.destination_worktree_id as string, principal);
    const result = await deps.pullRequests.moveBranch(value.destination_worktree_id as string, value.branch as string);
    // require a fully settled move
    if (result !== 'moved') throw failure('target_changed', result === 'recovery-required' ? 'move needs manual recovery' : 'destination changed', true);
    return await deps.worktreeStatus(value.destination_worktree_id as string, principal);
  } });
  const movePull = z.object({ agent_id: developerIdentifier, number: z.number().int().positive().max(2_147_483_647), destination_worktree_id: developerIdentifier }).strict();
  mutation({ name: 'move_pull_request', title: 'Move pull request', description: 'Move one held pull request into a fresh destination.', scopes: scopes('agents:control', 'admin:dangerous'), risk: 'dangerous', openWorld: true, schema: movePull, properties: { agent_id: idJson, number: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }, destination_worktree_id: idJson }, required: ['agent_id', 'number', 'destination_worktree_id'], output: pullRequestStatusOutput.output, dataSchema: withLegacyDefinitions(pullRequestStatusOutput), execute: async (value, principal) => {
    await requiredAgent(deps, value.agent_id as string, principal);
    await requiredWorktree(deps, value.destination_worktree_id as string, principal);
    const result = await deps.pullRequests.move(value.destination_worktree_id as string, value.number as number);
    // require a fully settled move
    if (result !== 'moved') throw failure('target_changed', result === 'recovery-required' ? 'move needs manual recovery' : 'destination changed', true);
    return await deps.pullRequestStatus(value.destination_worktree_id as string, principal);
  } });
  registerRemovalPreparations(ctx);
}

// register facts-only assessments and fresh Davo execution preparations
function registerRemovalPreparations(ctx: RegistryContext): void {
  const { read, mutation, deps, preparations } = ctx;
  read({ name: 'assess_branch_removal', title: 'Assess branch removal', description: 'Read current branch loss-prevention facts without approving deletion.', scopes: scopes('status:read'), schema: z.object({ worktree_id: developerIdentifier, branch }).strict(), inputSchema: objectSchema({ worktree_id: idJson, branch: stringJson(1, 255) }, ['worktree_id', 'branch']), output: preparationOutput, dataSchema: preparationJson, execute: async (value, principal) => {
    const worktree = await requiredWorktree(deps, value.worktree_id as string, principal);
    const result = await deps.worktrees.branchRemoval(worktree.projectId, value.branch as string);
    // expose only current bounded blockers
    if (!result.ok) throw failure('invalid_state', result.error);
    return preparations.create('branch', principal, result.facts, { worktree_id: worktree.id, project_id: worktree.projectId, branch: value.branch }, false, branchBlockers(result.facts));
  } });
  mutation({ name: 'prepare_branch_removal', title: 'Prepare branch removal', description: 'Re-read branch facts under the current Davo lease.', scopes: scopes('agents:control', 'admin:dangerous'), risk: 'dangerous', destructive: false, audiences: ['realtime'], schema: z.object({ assessment_id: developerIdentifier, branch, confirmation: z.string().min(1).max(255) }).strict(), properties: { assessment_id: idJson, branch: stringJson(1, 255), confirmation: stringJson(1, 255) }, required: ['assessment_id', 'branch', 'confirmation'], output: preparationOutput, dataSchema: preparationJson, execute: async (value, principal) => {
    requireDavo(principal);
    const assessed = preparations.get(value.assessment_id as string, principal, 'branch', false);
    // require exact branch acknowledgement rather than adopting the assessment as approval
    if (assessed.input.branch !== value.branch || value.confirmation !== value.branch) throw failure('invalid_request', 'confirmation does not match the branch');
    const result = await deps.worktrees.branchRemoval(assessed.input.project_id as string, value.branch as string);
    if (!result.ok) throw failure('target_changed', result.error, true);
    return preparations.create('branch', principal, result.facts, assessed.input, true, branchBlockers(result.facts));
  } });
  mutation({ name: 'execute_branch_removal', title: 'Execute branch removal', description: 'Delete one freshly prepared branch under the same Davo lease.', scopes: scopes('agents:control', 'admin:dangerous'), risk: 'dangerous', audiences: ['realtime'], schema: z.object({ preparation_id: developerIdentifier }).strict(), properties: { preparation_id: idJson }, required: ['preparation_id'], output: z.object({ removed: z.literal(true), branch }).strict(), dataSchema: objectSchema({ removed: { const: true }, branch: stringJson(1, 255) }, ['removed', 'branch']), execute: async (value, principal) => {
    requireDavo(principal);
    const prepared = preparations.claim(value.preparation_id as string, principal, 'branch');
    const fresh = await deps.worktrees.branchRemoval(prepared.input.project_id as string, prepared.input.branch as string);
    if (!fresh.ok || digestFacts(fresh.facts) !== prepared.factsDigest) throw failure('target_changed', fresh.ok ? 'Branch facts changed' : fresh.error, true);
    const blockers = branchBlockers(fresh.facts);
    if (blockers.length > 0) throw failure('target_changed', blockers[0]!.message, true);
    const result = await deps.worktrees.deleteBranchGuarded(prepared.input.project_id as string, prepared.input.branch as string, true);
    if (!result.ok) throw failure('target_changed', result.error, true);
    return { removed: true, branch: prepared.input.branch };
  } });
  read({ name: 'assess_worktree_removal', title: 'Assess worktree removal', description: 'Read current Worktree removal facts without approving deletion.', scopes: scopes('status:read'), schema: z.object({ worktree_id: developerIdentifier }).strict(), inputSchema: objectSchema({ worktree_id: idJson }, ['worktree_id']), output: preparationOutput, dataSchema: preparationJson, execute: async (value, principal) => {
    const worktree = await requiredWorktree(deps, value.worktree_id as string, principal);
    const result = await deps.worktrees.removal(worktree);
    if (!result.ok) throw failure('invalid_state', result.error);
    return preparations.create('worktree', principal, result.facts, { worktree_id: worktree.id }, false, removalBlockers(worktree, result.facts));
  } });
  mutation({ name: 'prepare_worktree_removal', title: 'Prepare worktree removal', description: 'Re-read Worktree facts under the current Davo lease.', scopes: scopes('agents:control', 'admin:dangerous'), risk: 'dangerous', destructive: false, audiences: ['realtime'], schema: z.object({ assessment_id: developerIdentifier, worktree_id: developerIdentifier, confirmation: z.string().min(1).max(255) }).strict(), properties: { assessment_id: idJson, worktree_id: idJson, confirmation: stringJson(1, 255) }, required: ['assessment_id', 'worktree_id', 'confirmation'], output: preparationOutput, dataSchema: preparationJson, execute: async (value, principal) => {
    requireDavo(principal);
    const assessed = preparations.get(value.assessment_id as string, principal, 'worktree', false);
    if (assessed.input.worktree_id !== value.worktree_id || value.confirmation !== value.worktree_id) throw failure('invalid_request', 'confirmation does not match the Worktree');
    const worktree = await requiredWorktree(deps, value.worktree_id as string, principal);
    const result = await deps.worktrees.removal(worktree);
    if (!result.ok) throw failure('target_changed', result.error, true);
    return preparations.create('worktree', principal, result.facts, { worktree_id: worktree.id }, true, removalBlockers(worktree, result.facts));
  } });
  mutation({ name: 'execute_worktree_removal', title: 'Execute worktree removal', description: 'Remove one freshly prepared Worktree under the same Davo lease.', scopes: scopes('agents:control', 'admin:dangerous'), risk: 'dangerous', audiences: ['realtime'], schema: z.object({ preparation_id: developerIdentifier }).strict(), properties: { preparation_id: idJson }, required: ['preparation_id'], output: z.object({ removed: z.literal(true), worktree_id: developerIdentifier }).strict(), dataSchema: objectSchema({ removed: { const: true }, worktree_id: idJson }, ['removed', 'worktree_id']), execute: async (value, principal) => {
    requireDavo(principal);
    const prepared = preparations.claim(value.preparation_id as string, principal, 'worktree');
    const worktree = await requiredWorktree(deps, prepared.input.worktree_id as string, principal);
    const fresh = await deps.worktrees.removal(worktree);
    if (!fresh.ok || digestFacts(fresh.facts) !== prepared.factsDigest) throw failure('target_changed', fresh.ok ? 'Worktree facts changed' : fresh.error, true);
    const blockers = removalBlockers(worktree, fresh.facts);
    if (blockers.length > 0) throw failure('target_changed', blockers[0]!.message, true);
    const result = await deps.removeWorktree(worktree, { discardChanges: false, deleteBranch: false });
    if (!result.removed) throw failure('target_changed', 'Worktree removal was refused', true);
    return { removed: true, worktree_id: worktree.id };
  } });
  read({ name: 'assess_worktree_prune', title: 'Assess Worktree prune', description: 'Read current prunable Worktree records.', scopes: scopes('status:read'), schema: z.object({ project_id: developerIdentifier }).strict(), inputSchema: objectSchema({ project_id: idJson }, ['project_id']), output: preparationOutput, dataSchema: preparationJson, execute: async (value, principal) => {
    const project = await deps.resolveProject(value.project_id as string, principal);
    // hide missing and out-of-scope Projects behind one denial
    if (project === undefined) throw failure('not_found', 'Project unavailable');
    const facts = await deps.pruneFacts(project.id);
    return preparations.create('prune', principal, facts, { project_id: project.id }, false, facts.blockers.map(message => ({ code: 'blocked', message })));
  } });
  mutation({ name: 'prepare_worktree_prune', title: 'Prepare Worktree prune', description: 'Re-read prune facts under the current Davo lease.', scopes: scopes('agents:control', 'admin:dangerous'), risk: 'dangerous', destructive: false, audiences: ['realtime'], schema: z.object({ assessment_id: developerIdentifier, confirmation: z.string().min(1).max(255) }).strict(), properties: { assessment_id: idJson, confirmation: stringJson(1, 255) }, required: ['assessment_id', 'confirmation'], output: preparationOutput, dataSchema: preparationJson, execute: async (value, principal) => {
    requireDavo(principal);
    const assessed = preparations.get(value.assessment_id as string, principal, 'prune', false);
    if (value.confirmation !== assessed.input.project_id) throw failure('invalid_request', 'confirmation does not match the Project');
    const facts = await deps.pruneFacts(assessed.input.project_id as string);
    return preparations.create('prune', principal, facts, assessed.input, true, facts.blockers.map(message => ({ code: 'blocked', message })));
  } });
  mutation({ name: 'execute_worktree_prune', title: 'Execute Worktree prune', description: 'Prune one freshly prepared Project under the same Davo lease.', scopes: scopes('agents:control', 'admin:dangerous'), risk: 'dangerous', audiences: ['realtime'], schema: z.object({ preparation_id: developerIdentifier }).strict(), properties: { preparation_id: idJson }, required: ['preparation_id'], output: z.object({ pruned_ids: z.array(developerIdentifier).max(100) }).strict(), dataSchema: objectSchema({ pruned_ids: { type: 'array', maxItems: 100, items: idJson } }, ['pruned_ids']), execute: async (value, principal) => {
    requireDavo(principal);
    const prepared = preparations.claim(value.preparation_id as string, principal, 'prune');
    const facts = await deps.pruneFacts(prepared.input.project_id as string);
    if (facts.blockers.length > 0 || digestFacts(facts) !== prepared.factsDigest) throw failure('target_changed', facts.blockers[0] ?? 'Prune facts changed', true);
    const outcome = await deps.worktrees.prune(prepared.input.project_id as string);
    if (!outcome.ok) throw failure('target_changed', outcome.error, true);
    await deps.pruneRecords(prepared.input.project_id as string);
    return { pruned_ids: facts.ids.slice(0, 100) };
  } });
}

// register guarded GitHub mutations and exact Worktree association reads
function registerGithub(ctx: RegistryContext): void {
  const { read, mutation, deps } = ctx;
  mutation({ name: 'reply_github_thread', title: 'Reply to GitHub thread', description: 'Reply to one exact current pull-request review thread.', scopes: scopes('github:write'), audiences: ['realtime'], risk: 'operational', destructive: false, openWorld: true, schema: z.object({ repository, number: z.number().int().positive().max(2_147_483_647), thread_id: developerIdentifier, body: z.string().min(1).max(8_000) }).strict(), properties: { repository: stringJson(3, 300), number: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }, thread_id: idJson, body: stringJson(1, 8_000) }, required: ['repository', 'number', 'thread_id', 'body'], output: z.object({ comment_id: developerIdentifier, url: z.string().url().max(2_048).optional() }).strict(), dataSchema: objectSchema({ comment_id: idJson, url: { type: 'string', maxLength: 2_048 } }, ['comment_id']), execute: async (value, principal) => {
    requireDavo(principal);
    const target = requiredRepository(value.repository as string);
    const result = await deps.github.replyToThread(target, value.number as number, value.thread_id as string, value.body as string);
    return { comment_id: result.id, ...(result.url === undefined ? {} : { url: result.url }) };
  } });
  mutation({ name: 'resolve_github_thread', title: 'Set GitHub thread resolution', description: 'Set one exact current pull-request review thread resolution state.', scopes: scopes('github:write'), audiences: ['realtime'], risk: 'operational', openWorld: true, schema: z.object({ repository, number: z.number().int().positive().max(2_147_483_647), thread_id: developerIdentifier, resolved: z.boolean() }).strict(), properties: { repository: stringJson(3, 300), number: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }, thread_id: idJson, resolved: { type: 'boolean' } }, required: ['repository', 'number', 'thread_id', 'resolved'], output: z.object({ thread_id: developerIdentifier, resolved: z.boolean() }).strict(), dataSchema: objectSchema({ thread_id: idJson, resolved: { type: 'boolean' } }, ['thread_id', 'resolved']), execute: async (value, principal) => {
    requireDavo(principal);
    await deps.github.resolveThread(requiredRepository(value.repository as string), value.number as number, value.thread_id as string, value.resolved as boolean);
    return { thread_id: value.thread_id, resolved: value.resolved };
  } });
  mutation({ name: 'rerequest_github_review', title: 'Re-request GitHub review', description: 'Re-request one current reviewer by exact login.', scopes: scopes('github:write'), audiences: ['realtime'], risk: 'operational', destructive: false, openWorld: true, schema: z.object({ repository, number: z.number().int().positive().max(2_147_483_647), reviewer: z.string().min(1).max(200) }).strict(), properties: { repository: stringJson(3, 300), number: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }, reviewer: stringJson(1, 200) }, required: ['repository', 'number', 'reviewer'], output: z.object({ requested: z.literal(true) }).strict(), dataSchema: objectSchema({ requested: { const: true } }, ['requested']), execute: async (value, principal) => {
    requireDavo(principal);
    await deps.github.rerequestReview(requiredRepository(value.repository as string), value.number as number, value.reviewer as string);
    return { requested: true };
  } });
  read({ name: 'get_pull_request_draft', title: 'Get pull-request draft', description: 'Read the current Worktree association and server-derived pull-request draft.', scopes: scopes('status:read'), schema: z.object({ agent_id: developerIdentifier }).strict(), inputSchema: objectSchema({ agent_id: idJson }, ['agent_id']), output: z.object({ repository: repository.optional(), base: branch.optional(), head: branch.optional(), title: z.string().max(256).optional(), body: z.string().max(30_000).optional(), can_create: z.boolean() }).strict(), dataSchema: objectSchema({ repository: stringJson(3, 300), base: stringJson(1, 255), head: stringJson(1, 255), title: stringJson(0, 256), body: stringJson(0, 30_000), can_create: { type: 'boolean' } }, ['can_create']), openWorld: true, execute: async (value, principal) => {
    const target = await requiredAgent(deps, value.agent_id as string, principal);
    const worktree = await requiredWorktree(deps, target.worktreeId, principal);
    const draft = await deps.github.pullRequestDraft(worktree.id);
    const repositoryValue = await deps.github.repositoryAt(worktree.identity, true);
    return { ...(repositoryValue === undefined ? {} : { repository: `${repositoryValue.owner}/${repositoryValue.name}` }), base: draft.base, head: draft.branch, title: draft.title, body: '', can_create: repositoryValue !== undefined };
  } });
  mutation({ name: 'create_pull_request', title: 'Create pull request', description: 'Push the associated Worktree branch and create its pull request.', scopes: scopes('github:write'), audiences: ['realtime'], risk: 'operational', destructive: false, openWorld: true, schema: z.object({ agent_id: developerIdentifier, title: z.string().min(1).max(256), body: z.string().max(30_000), base: branch, head: branch, draft: z.boolean() }).strict(), properties: { agent_id: idJson, title: stringJson(1, 256), body: stringJson(0, 30_000), base: stringJson(1, 255), head: stringJson(1, 255), draft: { type: 'boolean' } }, required: ['agent_id', 'title', 'body', 'base', 'head', 'draft'], output: z.object({ repository, number: z.number().int().positive().max(2_147_483_647), url: z.string().url().max(2_048) }).strict(), dataSchema: objectSchema({ repository: stringJson(3, 300), number: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }, url: stringJson(1, 2_048) }, ['repository', 'number', 'url']), execute: async (value, principal) => {
    requireDavo(principal);
    const target = await requiredAgent(deps, value.agent_id as string, principal);
    const worktree = await requiredWorktree(deps, target.worktreeId, principal);
    const current = await deps.github.pullRequestDraft(worktree.id);
    // bind the write to the current exact branch and base
    if (current.branch !== value.head || current.base !== value.base) throw failure('target_changed', 'pull-request source changed', true);
    const repositoryValue = await deps.github.repositoryAt(worktree.identity, true);
    if (repositoryValue === undefined) throw failure('not_found', 'GitHub repository unavailable');
    const created = await deps.github.createPullRequest(worktree.id, { title: value.title as string, body: value.body as string, base: value.base as string, draft: value.draft as boolean });
    return { repository: `${repositoryValue.owner}/${repositoryValue.name}`, number: created.number, url: created.url };
  } });
}

// register first-class owner-bound Files operations and bounded transfers
function registerFiles(ctx: RegistryContext): void {
  const { read, mutation, deps, preparations, pages } = ctx;
  read({ name: 'get_files_capabilities', title: 'Get Files capabilities', description: 'Describe bounded MCP Files operations for one Place.', scopes: scopes('files:read'), schema: z.object({ place_id: developerIdentifier }).strict(), inputSchema: objectSchema({ place_id: idJson }, ['place_id']), ...filesCapabilitiesOutput, execute: async (value, principal) => {
    await requiredPlace(deps, value.place_id as string, principal);
    return { operations: ['list', 'preview', 'download_file', 'create_file', 'create_folder', 'copy', 'move', 'rename', 'delete', 'upload'], chunk_bytes: mcpFileLimits.chunkBytes, mcp_file_bytes: mcpFileLimits.fileBytes, backend_file_bytes: hostFilesLimits.uploadFileBytes, backend_batch_bytes: hostFilesLimits.uploadTotalBytes, max_active_owner: mcpFileLimits.activeOwner, max_active_global: mcpFileLimits.activeGlobal, directory_download: false };
  } });
  read({ name: 'list_files', title: 'List Files', description: 'List one bounded Place-relative directory with owner-bound capabilities.', scopes: scopes('files:read'), schema: z.object({ place_id: developerIdentifier, path: z.string().max(1_024).optional(), object_token: opaque.optional(), ...developerPageShape }).strict().refine(value => value.path === undefined || value.object_token === undefined), inputSchema: objectSchema({ place_id: idJson, path: stringJson(0, 1_024), object_token: opaqueJson, ...developerPageProperties }, ['place_id']), ...filesPageOutput, execute: async (value, principal) => {
    const owner = requiredOwner(deps, principal);
    const place = await requiredPlace(deps, value.place_id as string, principal);
    // reject absolute path authority at the MCP boundary
    if (typeof value.path === 'string' && value.path.startsWith('/')) throw failure('invalid_request', 'path must be Place-relative');
    const listed = await deps.hostFiles.list(place, owner, value.path as string | undefined, value.object_token as string | undefined);
    const limit = (value.limit as number | undefined) ?? 50;
    const entries = listed.entries.map(entry => ({ name: entry.name.slice(0, 255), relative_path: (entry.hostPath.startsWith(place.hostPath ?? place.home) ? entry.hostPath.slice((place.hostPath ?? place.home).length).replace(/^\//u, '') : entry.name).slice(0, 4_096), kind: entry.kind, ...(entry.symlinkTargetKind === undefined ? {} : { symlink_target_kind: entry.symlinkTargetKind }), size: entry.size, modified_at: entry.modifiedAt, permissions: entry.permissions.slice(0, 16), object_token: entry.objectToken }));
    const binding = { place_id: value.place_id, path: value.path, object_token: value.object_token };
    const offset = pages.offset(value.cursor, principal, 'list_files', binding);
    const page = boundedPage(entries, offset, limit);
    const nextCursor = page.nextOffset === undefined ? undefined : pages.create(principal, 'list_files', binding, page.nextOffset);
    return { items: page.items, ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }), truncated: listed.truncated || page.truncated };
  } });
  read({ name: 'preview_file_object', title: 'Preview File object', description: 'Preview one owner-bound regular file with bounded output.', scopes: scopes('files:read'), schema: z.object({ object_token: opaque, max_bytes: z.number().int().min(1).max(65_536).optional() }).strict(), inputSchema: objectSchema({ object_token: opaqueJson, max_bytes: { type: 'integer', minimum: 1, maximum: 65_536 } }, ['object_token']), ...filePreviewOutput, execute: async (value, principal) => {
    const owner = requiredOwner(deps, principal);
    const placeId = deps.hostFiles.objectPlaceId(owner, value.object_token as string);
    if (placeId === undefined) throw failure('not_found', 'file unavailable');
    const place = await requiredPlace(deps, placeId, principal);
    const preview = await deps.hostFiles.preview(place, owner, value.object_token as string);
    const maxBytes = (value.max_bytes as number | undefined) ?? 65_536;
    if (preview.binary) return { encoding: 'binary', size: preview.size, truncated: preview.truncated };
    const content = preview.content ?? '';
    const contentBytes = Buffer.from(content, 'utf8');
    const text = utf8Prefix(contentBytes, maxBytes);
    return { text, encoding: 'utf8', size: preview.size, truncated: preview.truncated || contentBytes.length > maxBytes };
  } });
  registerFileOperations(ctx);
  registerFileTransfers(ctx);
}

// register prepared file mutations and current operation views
function registerFileOperations(ctx: RegistryContext): void {
  const { read, mutation, deps, preparations } = ctx;
  const operationKinds = z.enum(['create_file', 'create_folder', 'copy', 'move', 'rename', 'delete']);
  const prepareSchema = z.object({ place_id: developerIdentifier, kind: operationKinds, sources: z.array(opaque).max(32), destination_token: opaque.optional(), name: z.string().min(1).max(255).optional(), collision: z.enum(['fail', 'keep_both', 'replace']) }).strict();
  mutation({ name: 'prepare_file_operation', title: 'Prepare File operation', description: 'Prepare one bounded owner-scoped Files mutation.', scopes: scopes('files:write'), destructive: false, schema: prepareSchema, properties: { place_id: idJson, kind: { enum: operationKinds.options }, sources: { type: 'array', maxItems: 32, items: opaqueJson }, destination_token: opaqueJson, name: stringJson(1, 255), collision: { enum: ['fail', 'keep_both', 'replace'] } }, required: ['place_id', 'kind', 'sources', 'collision'], output: preparationOutput, dataSchema: preparationJson, execute: async (value, principal) => {
    const owner = requiredOwner(deps, principal);
    const place = await requiredPlace(deps, value.place_id as string, principal);
    enforceFileRole(principal, value, false);
    const input = fileOperationInput(value);
    const prepared = await deps.hostFiles.prepareOperation(place, owner, input);
    const destructive = input.kind === 'delete' || value.collision === 'replace';
    const blockers = prepared.conflicts.filter(() => value.collision === 'fail').map(conflict => ({ code: 'collision', message: `destination ${conflict.destinationName} already exists` }));
    // collision-fail preparations remain facts-only when a destination changed
    const executable = !destructive && (!(value.collision === 'fail') || prepared.conflicts.length === 0);
    const saved = { ...value, backend_operation_id: prepared.operationId, conflict_ids: prepared.conflicts.map(conflict => conflict.id) };
    return preparations.create('file', principal, { kind: prepared.kind, total_items: prepared.totalItems, conflicts: prepared.conflicts, confirmation: prepared.confirmation }, saved, executable, blockers);
  } });
  mutation({ name: 'prepare_confirmed_file_operation', title: 'Confirm File operation', description: 'Freshly re-prepare one destructive Files mutation under the current Davo lease.', scopes: scopes('files:write', 'admin:dangerous'), risk: 'dangerous', destructive: false, audiences: ['realtime'], schema: z.object({ assessment_id: developerIdentifier, confirmation: z.enum(['delete', 'replace']) }).strict(), properties: { assessment_id: idJson, confirmation: { enum: ['delete', 'replace'] } }, required: ['assessment_id', 'confirmation'], output: preparationOutput, dataSchema: preparationJson, execute: async (value, principal) => {
    requireDavo(principal);
    const assessed = preparations.get(value.assessment_id as string, principal, 'file', false);
    const kind = assessed.input.kind as string;
    const collision = assessed.input.collision as string;
    const expected = kind === 'delete' ? 'delete' : collision === 'replace' ? 'replace' : undefined;
    // require exact semantic acknowledgement
    if (expected === undefined || value.confirmation !== expected) throw failure('invalid_request', 'confirmation does not match the operation');
    const owner = requiredOwner(deps, principal);
    const place = await requiredPlace(deps, assessed.input.place_id as string, principal);
    const prepared = await deps.hostFiles.reprepareOperation(place, assessed.input.backend_operation_id as string, owner);
    const blockers = prepared.conflicts.filter(conflict => collision === 'fail').map(conflict => ({ code: 'collision', message: `destination ${conflict.destinationName} already exists` }));
    return preparations.create('file', principal, { kind: prepared.kind, total_items: prepared.totalItems, conflicts: prepared.conflicts, confirmation: prepared.confirmation }, { ...assessed.input, backend_operation_id: prepared.operationId, conflict_ids: prepared.conflicts.map(conflict => conflict.id) }, true, blockers);
  } });
  mutation({ name: 'execute_file_operation', title: 'Execute File operation', description: 'Execute one current prepared Files operation.', scopes: scopes('files:write'), schema: z.object({ preparation_id: developerIdentifier }).strict(), properties: { preparation_id: idJson }, required: ['preparation_id'], output: z.object({ operation_id: developerIdentifier, state: z.enum(['pending', 'running']) }).strict(), dataSchema: objectSchema({ operation_id: idJson, state: { enum: ['pending', 'running'] } }, ['operation_id', 'state']), execute: async (value, principal) => {
    const prepared = preparations.claim(value.preparation_id as string, principal, 'file');
    const destructive = prepared.input.kind === 'delete' || prepared.input.collision === 'replace';
    // destructive execution always requires Davo's dangerous grant
    if (destructive && (principal.authentication !== 'realtime' || !principal.scopes.includes('admin:dangerous'))) throw failure('forbidden', 'Destructive Files execution requires Davo approval');
    const owner = requiredOwner(deps, principal);
    const place = await requiredPlace(deps, prepared.input.place_id as string, principal);
    const collision = prepared.input.collision as 'fail' | 'keep_both' | 'replace';
    const decisions = Object.fromEntries((prepared.input.conflict_ids as string[]).map(id => [id, collision === 'keep_both' ? 'keep-both' : collision])) as Record<string, 'replace' | 'skip' | 'keep-both'>;
    const result = await deps.hostFiles.executeOperation(place, owner, prepared.input.backend_operation_id as string, decisions, prepared.input.kind === 'delete');
    return { operation_id: result.operationId, state: result.state === 'running' ? 'running' : 'pending' };
  } });
  read({ name: 'get_file_operation', title: 'Get File operation', description: 'Read one owner-scoped Files operation.', scopes: scopes('files:read'), schema: z.object({ place_id: developerIdentifier, operation_id: developerIdentifier }).strict(), inputSchema: objectSchema({ place_id: idJson, operation_id: idJson }, ['place_id', 'operation_id']), ...fileOperationOutput, execute: async (value, principal) => {
    const result = deps.hostFiles.operation(await requiredPlace(deps, value.place_id as string, principal), requiredOwner(deps, principal), value.operation_id as string);
    return fileOperationView(result);
  } });
}

// register single-file streaming upload and download operations
function registerFileTransfers(ctx: RegistryContext): void {
  const { read, mutation, cursor, deps } = ctx;
  const beginSchema = z.object({ place_id: developerIdentifier, destination_token: opaque, name: z.string().min(1).max(255), total_bytes: z.number().int().min(0).max(mcpFileLimits.fileBytes), mime: z.string().min(1).max(200).optional(), collision: z.enum(['fail', 'keep_both', 'replace']) }).strict();
  const beginProperties = { place_id: idJson, destination_token: opaqueJson, name: stringJson(1, 255), total_bytes: { type: 'integer', minimum: 0, maximum: mcpFileLimits.fileBytes }, mime: stringJson(1, 200), collision: { enum: ['fail', 'keep_both', 'replace'] } };
  // open one role-checked atomic upload
  const beginUpload = async (value: Record<string, unknown>, principal: IntegrationPrincipal): Promise<unknown> => {
    // Conductor uploads are additive only
    if (principal.authentication === 'conductor' && value.collision !== 'fail') throw failure('forbidden', 'Conductor uploads cannot replace or rename an existing file');
    const result = await deps.transfers.begin(requiredOwner(deps, principal), { placeId: value.place_id as string, destinationToken: value.destination_token as string, name: value.name as string, totalBytes: value.total_bytes as number, ...(value.mime === undefined ? {} : { mime: value.mime as string }), collision: value.collision as 'fail' | 'keep_both' | 'replace' });
    return { transfer_id: result.transfer_id, next_offset: 0, chunk_bytes: mcpFileLimits.chunkBytes, inactivity_expires_at: result.inactivity_expires_at, absolute_expires_at: result.absolute_expires_at };
  };
  mutation({ name: 'begin_file_upload', title: 'Begin File upload', description: 'Open one bounded single-file atomic upload.', scopes: scopes('files:write'), risk: 'operational', destructive: false, audiences: ['conductor'], schema: beginSchema, properties: beginProperties, required: ['place_id', 'destination_token', 'name', 'total_bytes', 'collision'], ...fileUploadBeginOutput, execute: beginUpload });
  mutation({ name: 'begin_file_upload', title: 'Begin File upload', description: 'Open one bounded single-file atomic upload.', scopes: scopes('files:write'), risk: 'operational', audiences: ['realtime'], schema: beginSchema, properties: beginProperties, required: ['place_id', 'destination_token', 'name', 'total_bytes', 'collision'], ...fileUploadBeginOutput, execute: beginUpload });
  cursor({ name: 'upload_file_chunk', title: 'Upload File chunk', description: 'Append one exact offset and digest-bound upload chunk.', scopes: scopes('files:write'), destructive: false, schema: z.object({ transfer_id: developerIdentifier, offset: z.number().int().nonnegative(), data_base64: z.string().max(54_616), sha256: z.string().min(43).max(44) }).strict(), inputSchema: objectSchema({ transfer_id: idJson, offset: { type: 'integer', minimum: 0 }, data_base64: { type: 'string', maxLength: 54_616 }, sha256: { type: 'string', minLength: 43, maxLength: 44 } }, ['transfer_id', 'offset', 'data_base64', 'sha256']), ...fileChunkOutput, execute: async (value, principal) => await deps.transfers.chunk(requiredOwner(deps, principal), { transferId: value.transfer_id as string, offset: value.offset as number, dataBase64: value.data_base64 as string, sha256: value.sha256 as string }) });
  const finalizeSchema = z.object({ transfer_id: developerIdentifier, total_sha256: z.string().min(43).max(44) }).strict();
  const finalizeProperties = { transfer_id: idJson, total_sha256: { type: 'string', minLength: 43, maxLength: 44 } };
  const finalizeOutput = { output: z.object({ file: fileRef, status: z.literal('ready') }).strict(), dataSchema: objectSchema({ file: fileRefJson, status: { const: 'ready' } }, ['file', 'status']) };
  // publish one digest-verified upload
  const finalizeUpload = async (value: Record<string, unknown>, principal: IntegrationPrincipal): Promise<unknown> => await deps.transfers.finalize(requiredOwner(deps, principal), value.transfer_id as string, value.total_sha256 as string);
  mutation({ name: 'finalize_file_upload', title: 'Finalize File upload', description: 'Verify and atomically publish one completed file.', scopes: scopes('files:write'), risk: 'operational', destructive: false, audiences: ['conductor'], schema: finalizeSchema, properties: finalizeProperties, required: ['transfer_id', 'total_sha256'], ...finalizeOutput, execute: finalizeUpload });
  mutation({ name: 'finalize_file_upload', title: 'Finalize File upload', description: 'Verify and atomically publish one completed file.', scopes: scopes('files:write'), risk: 'operational', audiences: ['realtime'], schema: finalizeSchema, properties: finalizeProperties, required: ['transfer_id', 'total_sha256'], ...finalizeOutput, execute: finalizeUpload });
  read({ name: 'get_file_transfer', title: 'Get File transfer', description: 'Read one stable-owner transfer snapshot.', scopes: scopes('files:read'), schema: z.object({ transfer_id: developerIdentifier }).strict(), inputSchema: objectSchema({ transfer_id: idJson }, ['transfer_id']), ...fileTransferOutput, execute: async (value, principal) => transferView(await deps.transfers.status(requiredOwner(deps, principal), value.transfer_id as string)) });
  mutation({ name: 'cancel_file_transfer', title: 'Cancel File transfer', description: 'Cancel one active private transfer stage.', scopes: scopes('files:write'), risk: 'operational', schema: z.object({ transfer_id: developerIdentifier }).strict(), properties: { transfer_id: idJson }, required: ['transfer_id'], output: z.object({ cancelled: z.literal(true) }).strict(), dataSchema: objectSchema({ cancelled: { const: true } }, ['cancelled']), execute: async (value, principal) => await deps.transfers.cancel(requiredOwner(deps, principal), value.transfer_id as string) });
  read({ name: 'download_file_chunk', title: 'Download File chunk', description: 'Read one bounded single-file capability range.', scopes: scopes('files:read'), schema: z.object({ object_token: opaque, offset: z.number().int().nonnegative(), max_bytes: z.number().int().min(1).max(mcpFileLimits.chunkBytes).optional() }).strict(), inputSchema: objectSchema({ object_token: opaqueJson, offset: { type: 'integer', minimum: 0 }, max_bytes: { type: 'integer', minimum: 1, maximum: mcpFileLimits.chunkBytes } }, ['object_token', 'offset']), ...fileDownloadOutput, execute: async (value, principal) => await deps.transfers.download(requiredOwner(deps, principal), value.object_token as string, value.offset as number, value.max_bytes as number | undefined) });
}

// register rich Note, attachment and schedule tools
function registerNotes(ctx: RegistryContext): void {
  const { read, mutation, deps, pages } = ctx;
  registerLegacyDavoNotes(ctx);
  const target = scheduleTargetSchema();
  const targetJson = scheduleTargetJson();
  const noteInput = { worktree_id: developerIdentifier, note_id: developerIdentifier };
  const noteProperties = { worktree_id: idJson, note_id: idJson };
  read({ name: 'get_note', title: 'Get Note', description: 'Read one visible Note without attachment bodies.', scopes: scopes('logs:read'), schema: z.object(noteInput).strict(), inputSchema: objectSchema(noteProperties, ['worktree_id', 'note_id']), output: z.object({ note: noteOutput.output, mine: z.boolean() }).strict(), dataSchema: objectSchema({ note: noteOutput.dataSchema, mine: { type: 'boolean' } }, ['note', 'mine']), execute: async (value, principal) => {
    const resolved = await resolveNote(deps, value.worktree_id as string, value.note_id as string, principal);
    return { note: noteView(resolved.note), mine: principal.authentication === 'conductor' && resolved.note.source === 'conductor' };
  } });
  mutation({ name: 'set_note_lock', title: 'Set Note lock', description: 'Set operator deletion lock state.', scopes: scopes('notes:write'), audiences: ['realtime'], schema: z.object({ ...noteInput, locked: z.boolean() }).strict(), properties: { ...noteProperties, locked: { type: 'boolean' } }, required: ['worktree_id', 'note_id', 'locked'], output: z.object({ note: noteOutput.output }).strict(), dataSchema: objectSchema({ note: noteOutput.dataSchema }, ['note']), execute: async (value, principal) => {
    requireDavo(principal);
    const at = await noteAt(deps, value.worktree_id as string, principal);
    const note = await deps.notes.setLocked(at.key, value.note_id as string, value.locked as boolean);
    if (note === undefined) throw failure('not_found', 'Note unavailable');
    return { note: noteView(note) };
  } });
  mutation({ name: 'set_note_visibility', title: 'Set Note visibility', description: 'Set operator cross-workspace visibility.', scopes: scopes('notes:write'), audiences: ['realtime'], schema: z.object({ ...noteInput, all_workspaces: z.boolean() }).strict(), properties: { ...noteProperties, all_workspaces: { type: 'boolean' } }, required: ['worktree_id', 'note_id', 'all_workspaces'], output: z.object({ note: noteOutput.output }).strict(), dataSchema: objectSchema({ note: noteOutput.dataSchema }, ['note']), execute: async (value, principal) => {
    requireDavo(principal);
    const at = await noteAt(deps, value.worktree_id as string, principal);
    const resolved = await deps.notes.setVisibility(at.key, value.note_id as string, value.all_workspaces as boolean);
    if (resolved === undefined) throw failure('not_found', 'Note unavailable');
    return { note: noteView(resolved.note) };
  } });
  mutation({ name: 'delete_note_with_undo', title: 'Delete Note with undo', description: 'Delete one unlocked Note and retain its bounded undo handle.', scopes: scopes('notes:write'), audiences: ['realtime'], schema: z.object(noteInput).strict(), properties: noteProperties, required: ['worktree_id', 'note_id'], output: z.object({ deleted: z.literal(true), undo_id: developerIdentifier, expires_at: z.string().datetime({ offset: true }) }).strict(), dataSchema: objectSchema({ deleted: { const: true }, undo_id: idJson, expires_at: { type: 'string', format: 'date-time' } }, ['deleted', 'undo_id', 'expires_at']), execute: async (value, principal) => {
    requireDavo(principal);
    const at = await noteAt(deps, value.worktree_id as string, principal);
    const deletion = await deps.notes.deleteWithUndo(at.key, value.note_id as string);
    if (deletion === 'locked') throw failure('invalid_state', 'Note is locked');
    if (deletion === undefined) throw failure('not_found', 'Note unavailable');
    pruneNoteUndos((deps.now ?? Date.now)());
    noteUndos.set(deletion.undoToken, { owner: stableOwner(principal), worktreeId: value.worktree_id as string, expiresAt: (deps.now ?? Date.now)() + 60_000 });
    return { deleted: true, undo_id: deletion.undoToken, expires_at: new Date((deps.now ?? Date.now)() + 60_000).toISOString() };
  } });
  mutation({ name: 'undo_note_delete', title: 'Undo Note delete', description: 'Restore one same-owner recent deletion.', scopes: scopes('notes:write'), destructive: false, schema: z.object({ worktree_id: developerIdentifier, undo_id: developerIdentifier }).strict(), properties: { worktree_id: idJson, undo_id: idJson }, required: ['worktree_id', 'undo_id'], output: z.object({ note: noteOutput.output }).strict(), dataSchema: objectSchema({ note: noteOutput.dataSchema }, ['note']), execute: async (value, principal) => {
    pruneNoteUndos((deps.now ?? Date.now)());
    const record = noteUndos.get(value.undo_id as string);
    // bind undo to stable owner and Worktree
    if (record === undefined || record.owner !== stableOwner(principal) || record.worktreeId !== value.worktree_id || record.expiresAt < (deps.now ?? Date.now)()) throw failure('not_found', 'Note deletion unavailable');
    const restored = await deps.notes.undoDeletion(value.undo_id as string);
    if (restored === 'gone') throw failure('not_found', 'Note deletion unavailable');
    if (restored === 'conflict' || restored === 'limit') throw failure('invalid_state', restored === 'conflict' ? 'Note already exists' : 'Note limit reached');
    noteUndos.delete(value.undo_id as string);
    return { note: noteView(restored) };
  } });
  read({ name: 'list_note_attachments', title: 'List Note attachments', description: 'Issue short-lived attachment capabilities without returning bodies.', scopes: scopes('logs:read'), schema: z.object({ ...noteInput, ...developerPageShape }).strict(), inputSchema: objectSchema({ ...noteProperties, ...developerPageProperties }, ['worktree_id', 'note_id']), ...attachmentPageOutput, execute: async (value, principal) => {
    const at = await noteAt(deps, value.worktree_id as string, principal);
    const resolved = await deps.notes.resolve(at.key, value.note_id as string);
    if (resolved === undefined) throw failure('not_found', 'Note unavailable');
    const attachments = await deps.notes.attachments(at.key, value.note_id as string);
    if (attachments === undefined) throw failure('not_found', 'Note unavailable');
    const limit = (value.limit as number | undefined) ?? 50;
    const binding = { worktree_id: value.worktree_id, note_id: value.note_id };
    const offset = pages.offset(value.cursor, principal, 'list_note_attachments', binding);
    const budgets = attachments.map(attachment => attachmentPageBudget(value.worktree_id as string, value.note_id as string, attachment));
    const page = boundedPage(budgets, offset, limit);
    const selected = attachments.slice(offset, offset + page.items.length);
    // mint capabilities only for rows admitted to this bounded page
    const items = selected.map(attachment => attachmentView(deps, requiredOwner(deps, principal), at.key, value.worktree_id as string, value.note_id as string, attachment));
    const nextCursor = page.nextOffset === undefined ? undefined : pages.create(principal, 'list_note_attachments', binding, page.nextOffset);
    return { items, ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }), truncated: page.truncated };
  } });
  mutation({ name: 'add_note_attachment', title: 'Add Note attachment', description: 'Copy one owner-bound File reference into a Note budget.', scopes: scopes('notes:write'), destructive: false, schema: z.object({ ...noteInput, file: fileRef }).strict(), properties: { ...noteProperties, file: fileRefJson }, required: ['worktree_id', 'note_id', 'file'], ...attachmentOutput, execute: async (value, principal) => {
    const at = await mutableNoteAt(deps, value.worktree_id as string, value.note_id as string, principal);
    const supplied = value.file as McpFileRef;
    const placeId = deps.hostFiles.objectPlaceId(requiredOwner(deps, principal), supplied.object_token);
    if (placeId === undefined) throw failure('not_found', 'File unavailable');
    const place = await requiredPlace(deps, placeId, principal);
    const opened = await deps.hostFiles.readAttachmentFile(place, requiredOwner(deps, principal), supplied.object_token, promptAttachmentBytesLimit);
    // bind the FileRef metadata to current object bytes
    if (opened.name !== supplied.name || opened.bytes.length !== supplied.size) throw failure('target_changed', 'File reference changed', true);
    const note = await deps.notes.appendAttachments(at.key, value.note_id as string, [{ name: opened.name, data: opened.bytes.toString('base64') }], principal.authentication === 'conductor' ? 'conductor' : 'operator');
    if (note === 'invalid') throw failure('transfer_limit', 'Note attachment budget exceeded');
    if (note === undefined) throw failure('not_found', 'Note unavailable');
    return { attachment: attachmentView(deps, requiredOwner(deps, principal), at.key, value.worktree_id as string, value.note_id as string, { name: opened.name, data: opened.bytes.toString('base64') }) };
  } });
  mutation({ name: 'remove_note_attachment', title: 'Remove Note attachment', description: 'Remove one exact same-owner Note attachment.', scopes: scopes('notes:write'), schema: z.object({ ...noteInput, attachment_id: developerIdentifier }).strict(), properties: { ...noteProperties, attachment_id: idJson }, required: ['worktree_id', 'note_id', 'attachment_id'], output: z.object({ removed: z.literal(true) }).strict(), dataSchema: objectSchema({ removed: { const: true } }, ['removed']), execute: async (value, principal) => {
    const at = await mutableNoteAt(deps, value.worktree_id as string, value.note_id as string, principal);
    const attachments = await deps.notes.attachments(at.key, value.note_id as string);
    const found = attachments?.find(attachment => attachmentId(value.worktree_id as string, value.note_id as string, attachment) === value.attachment_id);
    if (found === undefined) throw failure('not_found', 'Attachment unavailable');
    const note = await deps.notes.removeAttachment(at.key, value.note_id as string, found.name, principal.authentication === 'conductor' ? 'conductor' : 'operator');
    if (note === undefined) throw failure('not_found', 'Attachment unavailable');
    return { removed: true };
  } });
  read({ name: 'list_schedule_targets', title: 'List schedule targets', description: 'List current role-filtered destinations for one Note.', scopes: scopes('status:read'), schema: z.object({ ...noteInput, ...developerPageShape }).strict(), inputSchema: objectSchema({ ...noteProperties, ...developerPageProperties }, ['worktree_id', 'note_id']), ...scheduleTargetPageOutput, execute: async (value, principal) => {
    const at = await resolveNote(deps, value.worktree_id as string, value.note_id as string, principal);
    const options = await deps.scheduleTargets(at.worktree, principal);
    const limit = (value.limit as number | undefined) ?? 50;
    const items = options.map(option => ({ target: scheduleTargetView(option.target), label: option.label.slice(0, 240), available: option.available, ...(option.reason === undefined ? {} : { reason: option.reason.slice(0, 240) }) }));
    const binding = { worktree_id: value.worktree_id, note_id: value.note_id };
    const offset = pages.offset(value.cursor, principal, 'list_schedule_targets', binding);
    const page = boundedPage(items, offset, limit);
    const nextCursor = page.nextOffset === undefined ? undefined : pages.create(principal, 'list_schedule_targets', binding, page.nextOffset);
    return { items: page.items, ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }), truncated: page.truncated };
  } });
  read({ name: 'preview_note_schedule', title: 'Preview Note schedule', description: 'Validate one exact target and return the next bounded run times.', scopes: scopes('status:read'), schema: z.object({ ...noteInput, cron: z.string().min(1).max(200), target }).strict(), inputSchema: objectSchema({ ...noteProperties, cron: stringJson(1, 200), target: targetJson }, ['worktree_id', 'note_id', 'cron', 'target']), output: z.object({ next_runs: z.array(z.string().datetime({ offset: true })).max(20) }).strict(), dataSchema: objectSchema({ next_runs: { type: 'array', maxItems: 20, items: { type: 'string', format: 'date-time' } } }, ['next_runs']), execute: async (value, principal) => {
    await resolveNote(deps, value.worktree_id as string, value.note_id as string, principal);
    return { next_runs: (await deps.previewSchedule(value.cron as string, fromScheduleTarget(value.target))).slice(0, 20) };
  } });
  mutation({ name: 'set_note_schedule', title: 'Set Note schedule', description: 'Set one validated role-owned Note schedule.', scopes: scopes('notes:write'), schema: z.object({ ...noteInput, cron: z.string().min(1).max(200), enabled: z.boolean(), target }).strict(), properties: { ...noteProperties, cron: stringJson(1, 200), enabled: { type: 'boolean' }, target: targetJson }, required: ['worktree_id', 'note_id', 'cron', 'enabled', 'target'], output: z.object({ schedule: scheduleOutput.output }).strict(), dataSchema: objectSchema({ schedule: scheduleOutput.dataSchema }, ['schedule']), execute: async (value, principal) => {
    const at = await mutableNoteAt(deps, value.worktree_id as string, value.note_id as string, principal);
    const targetValue = fromScheduleTarget(value.target);
    await requireScheduleTarget(deps, at.worktree, targetValue, principal);
    const schedule = await deps.buildSchedule(at.worktree, at.note, { cron: value.cron as string, enabled: value.enabled as boolean, target: targetValue }, principal);
    if (typeof schedule === 'string') throw failure('invalid_request', schedule);
    const note = await deps.notes.setSchedule(at.key, value.note_id as string, schedule, principal.authentication === 'conductor' ? 'conductor' : 'operator');
    if (note === undefined || note.schedule === undefined) throw failure('invalid_state', 'Schedule could not be set');
    return { schedule: scheduleView(note.schedule) };
  } });
  mutation({ name: 'remove_note_schedule', title: 'Remove Note schedule', description: 'Remove one role-owned Note schedule.', scopes: scopes('notes:write'), schema: z.object(noteInput).strict(), properties: noteProperties, required: ['worktree_id', 'note_id'], output: z.object({ removed: z.literal(true) }).strict(), dataSchema: objectSchema({ removed: { const: true } }, ['removed']), execute: async (value, principal) => {
    const at = await mutableNoteAt(deps, value.worktree_id as string, value.note_id as string, principal);
    const note = await deps.notes.removeSchedule(at.key, value.note_id as string, principal.authentication === 'conductor' ? 'conductor' : 'operator');
    if (note === undefined) throw failure('not_found', 'Note unavailable');
    return { removed: true };
  } });
  mutation({ name: 'run_note_now', title: 'Run Note now', description: 'Launch one explicit role-allowed Note target.', scopes: scopes('notes:write'), risk: 'operational', destructive: false, openWorld: true, schema: z.object({ ...noteInput, target }).strict(), properties: { ...noteProperties, target: targetJson }, required: ['worktree_id', 'note_id', 'target'], output: z.object({ run_id: developerIdentifier, state: z.enum(['launched', 'running', 'skipped', 'failed']) }).strict(), dataSchema: objectSchema({ run_id: idJson, state: { enum: ['launched', 'running', 'skipped', 'failed'] } }, ['run_id', 'state']), execute: async (value, principal) => {
    const at = await mutableNoteAt(deps, value.worktree_id as string, value.note_id as string, principal);
    const targetValue = fromScheduleTarget(value.target);
    await requireScheduleTarget(deps, at.worktree, targetValue, principal);
    return await deps.runNoteNow(at.worktree, at.note, targetValue, principal);
  } });
}

// register trusted catalog locators without exposing configured definitions
function registerActions(ctx: RegistryContext): void {
  const { read, mutation, deps, pages } = ctx;
  const invocations = actionInvocations(deps.now ?? Date.now);
  read({ name: 'list_configured_actions', title: 'List configured actions', description: 'List trusted server action IDs and revisions only.', scopes: scopes('status:read'), schema: z.object({ place_id: developerIdentifier, target_agent_id: developerIdentifier.optional(), ...developerPageShape }).strict(), inputSchema: objectSchema({ place_id: idJson, target_agent_id: idJson, ...developerPageProperties }, ['place_id']), ...actionPageOutput, execute: async (value, principal) => {
    const place = await requiredPlace(deps, value.place_id as string, principal);
    // selected targets must remain scoped before any catalog projection
    if (value.target_agent_id !== undefined) {
      const target = await requiredAgent(deps, value.target_agent_id as string, principal);
      // hide actions that cannot target the selected Agent
      if (!await deps.canInvokeActionTarget(target, principal)) throw failure('forbidden', 'Configured action target unavailable');
    }
    const slots = deps.buttonCatalog.value.projects[place.projectId] ?? deps.buttonCatalog.value.application;
    const actions = buttonSlotNames.flatMap(slot => slots[slot].map(action => ({ action_id: action.id, revision: deps.buttonCatalog.value.revision, label: action.text.slice(0, 240), kind: action.actionKind, available: principal.authentication !== 'conductor' || action.actionKind === 'prompt' })));
    const limit = (value.limit as number | undefined) ?? 50;
    const binding = { place_id: value.place_id, target_agent_id: value.target_agent_id, revision: deps.buttonCatalog.value.revision };
    const offset = pages.offset(value.cursor, principal, 'list_configured_actions', binding);
    const page = boundedPage(actions, offset, limit);
    const nextCursor = page.nextOffset === undefined ? undefined : pages.create(principal, 'list_configured_actions', binding, page.nextOffset);
    return { items: page.items, ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }), truncated: page.truncated };
  } });
  read({ name: 'resolve_configured_action', title: 'Resolve configured action', description: 'Resolve one trusted locator into a short-lived invocation capability.', scopes: scopes('status:read'), schema: z.object({ action_id: developerIdentifier, revision: z.string().min(1).max(240), place_id: developerIdentifier, target_agent_id: developerIdentifier.optional(), selected_file_tokens: z.array(opaque).max(32).optional() }).strict(), inputSchema: objectSchema({ action_id: idJson, revision: stringJson(1, 240), place_id: idJson, target_agent_id: idJson, selected_file_tokens: { type: 'array', maxItems: 32, items: opaqueJson } }, ['action_id', 'revision', 'place_id']), output: z.object({ invocation_id: developerIdentifier, expires_at: z.string().datetime({ offset: true }), kind: z.enum(['prompt', 'shell']), target_summary: z.string().min(1).max(400) }).strict(), dataSchema: objectSchema({ invocation_id: idJson, expires_at: { type: 'string', format: 'date-time' }, kind: { enum: ['prompt', 'shell'] }, target_summary: stringJson(1, 400) }, ['invocation_id', 'expires_at', 'kind', 'target_summary']), execute: async (value, principal) => {
    const place = await requiredPlace(deps, value.place_id as string, principal);
    const found = findAction(deps.buttonCatalog, place.projectId, value.action_id as string, value.revision as string);
    if (found === undefined) throw failure('not_found', 'Configured action unavailable');
    // Conductor never resolves a shell action
    if (principal.authentication === 'conductor' && found.kind === 'shell') throw failure('forbidden', 'Conductor cannot invoke shell actions');
    let target: AgentTarget | undefined;
    if (value.target_agent_id !== undefined) target = await requiredAgent(deps, value.target_agent_id as string, principal);
    // enforce self or owned-worker policy after scope resolution
    if (target !== undefined && !await deps.canInvokeActionTarget(target, principal)) throw failure('forbidden', 'Configured action target unavailable');
    // Conductor prompts require an existing exact target and never use launch fallback
    if (principal.authentication === 'conductor' && target === undefined) throw failure('invalid_request', 'Conductor actions require an existing target Agent');
    const selected = (value.selected_file_tokens as string[] | undefined) ?? [];
    // Files shell actions accept exactly one current directory capability
    if (found.slot === 'split:files' && selected.length !== 1) throw failure('invalid_request', 'Files action requires one selected directory');
    if (found.slot !== 'split:files' && selected.length > 0) throw failure('invalid_request', 'Selected Files are unsupported for this action');
    const expiresAt = (deps.now ?? Date.now)() + 5 * 60_000;
    const id = invocations.create({ owner: stableOwner(principal), leaseKey: principal.leaseKey, placeId: place.id, actionId: value.action_id as string, revision: value.revision as string, slot: found.slot, kind: found.kind, ...(target === undefined ? {} : { agentId: target.agentId }), ...(selected[0] === undefined ? {} : { filesDirectoryToken: selected[0] }), expiresAt });
    return { invocation_id: id, expires_at: new Date(expiresAt).toISOString(), kind: found.kind, target_summary: target === undefined ? place.label.slice(0, 400) : `Agent ${target.agentId} in ${place.label}`.slice(0, 400) };
  } });
  // register the Conductor's prompt-only projection
  mutation({ name: 'invoke_configured_action', title: 'Invoke configured action', description: 'Invoke one trusted prompt action without launch fallback.', scopes: scopes('prompts:write'), audiences: ['conductor'], risk: 'operational', openWorld: true, schema: z.object({ invocation_id: developerIdentifier }).strict(), properties: { invocation_id: idJson }, required: ['invocation_id'], output: actionOperationSchema(), dataSchema: actionOperationJson(), execute: async (value, principal) => await invokeAction(deps, invocations, value, principal, true) });
  // register Davo's configured operator projection
  mutation({ name: 'invoke_configured_action', title: 'Invoke configured action', description: 'Invoke one trusted configured operator action.', scopes: scopes('actions:invoke'), audiences: ['realtime'], risk: 'operational', openWorld: true, schema: z.object({ invocation_id: developerIdentifier }).strict(), properties: { invocation_id: idJson }, required: ['invocation_id'], output: actionOperationSchema(), dataSchema: actionOperationJson(), execute: async (value, principal) => await invokeAction(deps, invocations, value, principal, false) });
  read({ name: 'get_configured_action_status', title: 'Get configured action status', description: 'Read one same-owner configured action operation.', scopes: scopes('status:read'), schema: z.object({ operation_id: developerIdentifier }).strict(), inputSchema: objectSchema({ operation_id: idJson }, ['operation_id']), output: actionOperationSchema(), dataSchema: actionOperationJson(), execute: async (value, principal) => actionOperationView(await deps.buttons.statusOwned({ key: actionServiceOwner(principal), filesOwner: requiredOwner(deps, principal) }, value.operation_id as string)) });
}

// register first-class Davo non-command Watches and their signed pull feed
function registerWatchFeed(ctx: RegistryContext): void {
  const { read, mutation, cursor, deps } = ctx;
  mutation({ name: 'watch_pull_request', title: 'Watch pull request', description: 'Create one durable Davo pull-request Watch.', scopes: scopes('status:read'), audiences: ['realtime'], contractVersion: 'v1', risk: 'operational', destructive: false, openWorld: true, schema: z.object({ worktree_id: developerIdentifier, number: z.number().int().positive().max(2_147_483_647) }).strict(), properties: { worktree_id: idJson, number: { type: 'integer', minimum: 1, maximum: 2_147_483_647 } }, required: ['worktree_id', 'number'], output: watchPullOutput.output, dataSchema: withLegacyDefinitions(watchPullOutput), execute: async (value, principal) => {
    const worktree = await requiredWorktree(deps, value.worktree_id as string, principal);
    const repositoryValue = await deps.github.repositoryAt(worktree.identity, true);
    if (repositoryValue === undefined) throw failure('not_found', 'GitHub repository unavailable');
    return watchResult(await deps.watches.watchPullRequestDavo(requiredDavoWatchOwner(deps, principal), repositoryValue, value.number as number));
  } });
  mutation({ name: 'watch_review_requests', title: 'Watch review requests', description: 'Create one durable Davo review-request Watch.', scopes: scopes('status:read'), audiences: ['realtime'], contractVersion: 'v1', risk: 'operational', destructive: false, openWorld: true, schema: z.object({ worktree_id: developerIdentifier }).strict(), properties: { worktree_id: idJson }, required: ['worktree_id'], output: watchReviewsOutput.output, dataSchema: withLegacyDefinitions(watchReviewsOutput), execute: async (value, principal) => {
    const worktree = await requiredWorktree(deps, value.worktree_id as string, principal);
    const repositoryValue = await deps.github.repositoryAt(worktree.identity, true);
    if (repositoryValue === undefined) throw failure('not_found', 'GitHub repository unavailable');
    return watchResult(await deps.watches.watchReviewRequestsDavo(requiredDavoWatchOwner(deps, principal), repositoryValue));
  } });
  mutation({ name: 'watch_process', title: 'Watch process', description: 'Create one durable Davo Stack-process Watch.', scopes: scopes('status:read'), audiences: ['realtime'], contractVersion: 'v1', risk: 'operational', destructive: false, schema: z.object({ worktree_id: developerIdentifier, process: developerIdentifier }).strict(), properties: { worktree_id: idJson, process: idJson }, required: ['worktree_id', 'process'], output: watchProcessOutput.output, dataSchema: withLegacyDefinitions(watchProcessOutput), execute: async (value, principal) => {
    const worktree = await requiredWorktree(deps, value.worktree_id as string, principal);
    // only declared Stack processes are watchable
    if (!declaredProcesses(worktree.commands).some(process => process.name === value.process)) throw failure('not_found', 'Stack process unavailable');
    return watchResult(await deps.watches.watchProcessDavo(requiredDavoWatchOwner(deps, principal), worktree.id, value.process as string, worktree.label));
  } });
  read({ name: 'list_watches', title: 'List Watches', description: 'List every active or ended-unacknowledged Watch for this stable Davo owner.', scopes: scopes('status:read'), audiences: ['realtime'], contractVersion: 'v1', schema: z.object({}).strict(), inputSchema: objectSchema({}, []), output: z.object({ watches: z.array(z.object({ watch_id: developerIdentifier, kind: z.enum(['pull_request', 'process', 'review_requests', 'command']), description: z.string().min(1).max(400), created_at: z.string().datetime({ offset: true }) }).strict()).max(50) }).strict(), dataSchema: objectSchema({ watches: { type: 'array', maxItems: 50, items: { type: 'object', properties: { watch_id: idJson, kind: { enum: ['pull_request', 'process', 'review_requests', 'command'] }, description: stringJson(1, 400), created_at: { type: 'string', format: 'date-time' } }, required: ['watch_id', 'kind', 'description', 'created_at'], additionalProperties: false } } }, ['watches']), execute: async (_value, principal) => ({ watches: (await deps.watches.listDavo(requiredDavoWatchOwner(deps, principal).principalOwnerKey)).map(watch => ({ watch_id: watch.id, kind: watch.kind, description: watch.description.slice(0, 400), created_at: watch.createdAt })) }) });
  mutation({ name: 'unwatch', title: 'Remove Watch', description: 'Remove one same-owner non-command Davo Watch.', scopes: scopes('status:read'), audiences: ['realtime'], contractVersion: 'v1', risk: 'operational', schema: z.object({ watch_id: developerIdentifier }).strict(), properties: { watch_id: idJson }, required: ['watch_id'], output: z.object({ removed: z.literal(true) }).strict(), dataSchema: objectSchema({ removed: { const: true } }, ['removed']), execute: async (value, principal) => {
    const removed = await deps.watches.removeDavo(requiredDavoWatchOwner(deps, principal).principalOwnerKey, value.watch_id as string);
    if (!removed) throw failure('not_found', 'Watch unavailable');
    return { removed: true };
  } });
  read({ name: 'get_watch_events', title: 'Get Watch events', description: 'Read the earliest bounded unacknowledged Davo Watch prefix.', scopes: scopes('status:read'), audiences: ['realtime'], schema: z.object({ watch_id: developerIdentifier, limit: z.number().int().min(1).max(20).optional() }).strict(), inputSchema: objectSchema({ watch_id: idJson, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['watch_id']), output: watchEventsSchema(), dataSchema: watchEventsJson(), execute: async (value, principal) => await deps.watches.davoEvents(requiredDavoWatchOwner(deps, principal).principalOwnerKey, value.watch_id as string, value.limit as number | undefined) });
  cursor({ name: 'ack_watch_events', title: 'Acknowledge Watch events', description: 'Atomically acknowledge one signed exact current event prefix.', scopes: scopes('status:read'), audiences: ['realtime'], destructive: true, schema: z.object({ watch_id: developerIdentifier, page_token: opaque }).strict(), inputSchema: objectSchema({ watch_id: idJson, page_token: opaqueJson }, ['watch_id', 'page_token']), output: z.object({ watch_id: developerIdentifier, acknowledged_through: z.number().int().positive(), ended: z.boolean(), removed: z.boolean() }).strict(), dataSchema: objectSchema({ watch_id: idJson, acknowledged_through: { type: 'integer', minimum: 1 }, ended: { type: 'boolean' }, removed: { type: 'boolean' } }, ['watch_id', 'acknowledged_through', 'ended', 'removed']), execute: async (value, principal) => await deps.watches.acknowledgeDavo(requiredDavoWatchOwner(deps, principal).principalOwnerKey, value.watch_id as string, value.page_token as string) });
}

type ReadRegistration = (input: { name: string; title: string; description: string; scopes: IntegrationScope[]; audiences?: ('conductor' | 'realtime')[]; contractVersion?: 'v1' | 'v2'; schema: z.ZodType<Record<string, unknown>>; inputSchema: Record<string, unknown>; output: z.ZodTypeAny; dataSchema: Record<string, unknown>; openWorld?: boolean; execute: (value: Record<string, unknown>, principal: IntegrationPrincipal) => Promise<unknown> }) => void;
type MutationRegistration = (input: { name: string; title: string; description: string; scopes: IntegrationScope[]; risk?: 'write' | 'operational' | 'dangerous'; audiences?: ('conductor' | 'realtime')[]; contractVersion?: 'v1' | 'v2'; schema: z.ZodObject<any>; properties: Record<string, unknown>; required: string[]; output: z.ZodTypeAny; dataSchema: Record<string, unknown>; idempotency?: 'generic' | 'domain_cursor'; destructive?: boolean; openWorld?: boolean; execute: (value: Record<string, unknown>, principal: IntegrationPrincipal) => Promise<unknown> }) => void;
type CursorRegistration = (input: { name: string; title: string; description: string; scopes: IntegrationScope[]; audiences?: ('conductor' | 'realtime')[]; schema: z.ZodType<Record<string, unknown>>; inputSchema: Record<string, unknown>; output: z.ZodTypeAny; dataSchema: Record<string, unknown>; destructive?: boolean; openWorld?: boolean; execute: (value: Record<string, unknown>, principal: IntegrationPrincipal) => Promise<unknown> }) => void;
type RegistryContext = { read: ReadRegistration; mutation: MutationRegistration; cursor: CursorRegistration; deps: WorkspaceToolsDependencies; preparations: PreparationStore; pages: PageCursorStore };
type PublicFailure = Error & { code: string; retryable: boolean; publicFailure: true };
const promptAttachmentBytesLimit = 25 * 1024 * 1024;
const noteUndos = new Map<string, { owner: string; worktreeId: string; expiresAt: number }>();

// retain only bounded short-lived preparation facts
class PreparationStore {
  private readonly records = new Map<string, PreparationRecord & { blockers: Array<{ code: string; message: string }> }>();

  // bind the store to one injectable clock
  constructor(private readonly now: () => number) {}

  // create one non-authoritative assessment or executable same-lease preparation
  create(kind: PreparationKind, principal: IntegrationPrincipal, facts: unknown, input: Record<string, unknown>, executable: boolean, blockers: Array<{ code: string; message: string }>): z.infer<typeof preparationOutput> {
    this.prune();
    // keep preparation state bounded without evicting current executable records
    if (this.records.size >= 1_024) throw failure('capacity_exceeded', 'Preparation capacity is full', true);
    const now = this.now();
    const id = randomBytes(18).toString('base64url');
    const factsDigest = digestFacts(facts);
    const record = { id, kind, owner: stableOwner(principal), ...(principal.leaseKey === undefined ? {} : { leaseKey: principal.leaseKey }), createdAt: now, expiresAt: now + 5 * 60_000, facts, factsDigest, input, executable, blockers };
    this.records.set(id, record);
    return { preparation_id: id, facts_digest: factsDigest, expires_at: new Date(record.expiresAt).toISOString(), blockers: blockers.slice(0, 50) };
  }

  // resolve one assessment bearer or exact-owner executable preparation
  get(id: string, principal: IntegrationPrincipal, kind: PreparationKind, executable: boolean): PreparationRecord & { blockers: Array<{ code: string; message: string }> } {
    this.prune();
    const record = this.records.get(id);
    // hide missing and wrong-kind preparations
    if (record === undefined || record.kind !== kind || record.expiresAt < this.now()) throw failure('not_found', 'Preparation unavailable');
    // executable records require the same stable owner and active lease
    if (executable && (!record.executable || record.owner !== stableOwner(principal) || record.leaseKey !== principal.leaseKey)) throw failure('stale_preparation', 'Preparation is not executable under this lease');
    // blockers never become implicit confirmation
    if (executable && record.blockers.length > 0) throw failure('invalid_state', record.blockers[0]!.message);
    return record;
  }

  // atomically claim one executable preparation before any asynchronous effect
  claim(id: string, principal: IntegrationPrincipal, kind: PreparationKind): PreparationRecord & { blockers: Array<{ code: string; message: string }> } {
    const record = this.get(id, principal, kind, true);
    this.records.delete(id);
    return record;
  }

  // discard expired preparation data
  private prune(): void {
    const now = this.now();
    // inspect every bounded record
    for (const [id, record] of this.records) {
      // retain current records
      if (record.expiresAt > now) continue;
      this.records.delete(id);
    }
  }
}

type PageCursorRecord = { owner: string; tool: string; binding: string; offset: number; expiresAt: number };

// retain bounded opaque read cursors without exposing offsets
class PageCursorStore {
  private readonly records = new Map<string, PageCursorRecord>();

  // bind cursor expiry to one injectable clock
  constructor(private readonly now: () => number) {}

  // resolve the first page or one same-owner bound continuation
  offset(cursor: unknown, principal: IntegrationPrincipal, tool: string, binding: unknown): number {
    this.prune();
    // first-page requests start at zero
    if (cursor === undefined) return 0;
    const record = this.records.get(cursor as string);
    const digest = digestFacts(binding);
    // hide stale, foreign, or retargeted cursors
    if (record === undefined || record.owner !== stableOwner(principal) || record.tool !== tool || record.binding !== digest || record.expiresAt < this.now()) throw failure('not_found', 'Page cursor unavailable');
    return record.offset;
  }

  // issue one five-minute continuation capability
  create(principal: IntegrationPrincipal, tool: string, binding: unknown, offset: number): string {
    this.prune();
    // refuse cursor pressure without evicting live traversal state
    if (this.records.size >= 1_024) throw failure('capacity_exceeded', 'Page cursor capacity is full', true);
    const id = randomBytes(18).toString('base64url');
    this.records.set(id, { owner: stableOwner(principal), tool, binding: digestFacts(binding), offset, expiresAt: this.now() + 5 * 60_000 });
    return id;
  }

  // discard expired continuation capabilities
  private prune(): void {
    const now = this.now();
    // inspect every bounded cursor record
    for (const [id, record] of this.records) {
      // retain current cursors
      if (record.expiresAt > now) continue;
      this.records.delete(id);
    }
  }
}

// slice one collection by count and serialized-byte ceilings
function boundedPage<T>(values: T[], offset: number, limit: number): { items: T[]; nextOffset?: number; truncated: boolean } {
  const items: T[] = [];
  let bytes = 2;
  // admit items only while both normative ceilings remain
  for (let index = offset; index < values.length && items.length < limit; index += 1) {
    const candidate = Buffer.byteLength(JSON.stringify(values[index])) + (items.length === 0 ? 0 : 1);
    // leave the first excluded item for the continuation
    if (bytes + candidate > 48_000) return { items, nextOffset: index, truncated: true };
    items.push(values[index]!);
    bytes += candidate;
  }
  const nextOffset = offset + items.length;
  return nextOffset < values.length ? { items, nextOffset, truncated: true } : { items, truncated: false };
}

// truncate valid UTF-8 bytes at the last complete code point
function utf8Prefix(bytes: Buffer, maxBytes: number): string {
  let end = Math.min(bytes.length, maxBytes);
  // backtrack over an excluded continuation sequence
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

// hold trusted action locators without retaining executable definitions
function actionInvocations(now: () => number): { create(value: Omit<ActionInvocation, 'id'>): string; get(id: string, principal: IntegrationPrincipal): ActionInvocation } {
  const records = new Map<string, ActionInvocation>();
  // remove expired records before every access
  const prune = (): void => {
    // inspect every bounded record
    for (const [id, record] of records) {
      // retain current records
      if (record.expiresAt > now()) continue;
      records.delete(id);
    }
  };
  return {
    // create one short-lived locator
    create(value): string {
      prune();
      if (records.size >= 512) throw failure('capacity_exceeded', 'Action invocation capacity is full', true);
      const id = randomBytes(18).toString('base64url');
      records.set(id, { id, ...value });
      return id;
    },
    // require one same-owner current locator
    get(id, principal): ActionInvocation {
      prune();
      const record = records.get(id);
      if (record === undefined || record.owner !== stableOwner(principal) || record.expiresAt < now()) throw failure('not_found', 'Action invocation unavailable');
      return record;
    }
  };
}

type ActionInvocation = { id: string; owner: string; leaseKey?: string; placeId: string; actionId: string; revision: string; slot: ButtonSlot; kind: 'prompt' | 'shell'; agentId?: string; filesDirectoryToken?: string; expiresAt: number };

// invoke one freshly re-resolved configured locator
async function invokeAction(deps: WorkspaceToolsDependencies, invocations: ReturnType<typeof actionInvocations>, value: Record<string, unknown>, principal: IntegrationPrincipal, promptOnly: boolean): Promise<ReturnType<typeof actionOperationView>> {
  const invocation = invocations.get(value.invocation_id as string, principal);
  // active Davo invocations remain exact-lease-bound
  if (principal.authentication === 'realtime' && invocation.leaseKey !== principal.leaseKey) throw failure('lease_expired', 'Action invocation lease changed');
  if (promptOnly && invocation.kind !== 'prompt') throw failure('forbidden', 'Conductor cannot invoke shell actions');
  const operation = await deps.buttons.startOwned({ key: actionServiceOwner(principal), filesOwner: requiredOwner(deps, principal) }, { requestId: value.request_id as string, actionId: invocation.actionId, configRevision: invocation.revision, placeId: invocation.placeId, slot: invocation.slot, ...(invocation.agentId === undefined ? {} : { agentId: invocation.agentId }), ...(invocation.filesDirectoryToken === undefined ? {} : { filesDirectoryToken: invocation.filesDirectoryToken }) });
  return actionOperationView(operation);
}

// find one trusted action locator and its non-secret projection
function findAction(catalog: ConfiguredButtonCatalog, projectId: string, actionId: string, revision: string): { slot: ButtonSlot; kind: 'prompt' | 'shell' } | undefined {
  // reject stale catalog revisions before scanning
  if (revision !== catalog.value.revision) return undefined;
  const slots = catalog.value.projects[projectId] ?? catalog.value.application;
  // inspect each finite configured slot
  for (const slot of buttonSlotNames) {
    const action = slots[slot].find(candidate => candidate.id === actionId);
    // return no executable definition bytes
    if (action !== undefined) return { slot, kind: action.actionKind };
  }
  return undefined;
}

// project one action engine snapshot
function actionOperationView(operation: ButtonOperation): { operation_id: string; state: ButtonOperation['state']; phase?: string; error?: string; exit_code?: number; agent_id?: string } {
  return { operation_id: operation.id, state: operation.state, ...(operation.phase === undefined ? {} : { phase: operation.phase.slice(0, 240) }), ...(operation.error === undefined ? {} : { error: operation.error.slice(0, 400) }), ...(operation.exitCode === undefined ? {} : { exit_code: operation.exitCode }), ...(operation.agentId === undefined ? {} : { agent_id: operation.agentId }) };
}

// validate the exact action result DTO
function actionOperationSchema(): z.ZodTypeAny { return z.object({ operation_id: developerIdentifier, state: z.enum(['queued', 'launching', 'running', 'complete', 'failed', 'interrupted']), phase: z.string().min(1).max(240).optional(), error: z.string().min(1).max(400).optional(), exit_code: z.number().int().optional(), agent_id: developerIdentifier.optional() }).strict(); }

// describe the exact action result DTO
function actionOperationJson(): Record<string, unknown> { return objectSchema({ operation_id: idJson, state: { enum: ['queued', 'launching', 'running', 'complete', 'failed', 'interrupted'] }, phase: stringJson(1, 240), error: stringJson(1, 400), exit_code: { type: 'integer' }, agent_id: idJson }, ['operation_id', 'state']); }

// project one transfer into the normative finite states
function transferView(value: Awaited<ReturnType<McpFileTransferService['status']>>): Record<string, unknown> {
  const state = value.state === 'active' ? 'open' : value.state;
  return { transfer_id: value.transfer_id, state, next_offset: value.next_offset, total_bytes: value.total_bytes, ...(value.error === undefined ? {} : { error: { code: 'transfer_failed', message: value.error.slice(0, 400), retryable: false } }) };
}

// convert the MCP file operation request into the existing service input
function fileOperationInput(value: Record<string, unknown>): Parameters<HostFilesService['prepareOperation']>[2] {
  const kind = value.kind as string;
  const sources = value.sources as string[];
  // map each exact operation arm
  if (kind === 'create_file') return { kind: 'create-file', name: value.name as string, destinationDirectoryToken: value.destination_token as string };
  if (kind === 'create_folder') return { kind: 'create-folder', name: value.name as string, destinationDirectoryToken: value.destination_token as string };
  if (kind === 'rename') return { kind: 'rename', sourceToken: sources[0]!, newName: value.name as string, destinationDirectoryToken: value.destination_token as string };
  if (kind === 'copy' || kind === 'move') return { kind, sourceTokens: sources, destinationDirectoryToken: value.destination_token as string };
  return { kind: 'delete', sourceTokens: sources };
}

// enforce role and shape rules before Files preparation
function enforceFileRole(principal: IntegrationPrincipal, value: Record<string, unknown>, confirmed: boolean): void {
  const kind = value.kind as string;
  const collision = value.collision as string;
  const sources = value.sources as string[];
  const destination = typeof value.destination_token === 'string';
  const named = typeof value.name === 'string';
  // reject malformed per-arm fields through the caller's schema-independent semantic guard
  if (!['create_file', 'create_folder', 'copy', 'move', 'rename', 'delete'].includes(kind)) throw failure('invalid_request', 'Unsupported Files operation');
  // enforce the exact input arm without accepting ignored capabilities
  if ((kind === 'create_file' || kind === 'create_folder') && (sources.length !== 0 || !destination || !named)) throw failure('invalid_request', 'Create requires a destination and name only');
  if ((kind === 'copy' || kind === 'move') && (sources.length < 1 || !destination || named)) throw failure('invalid_request', 'Copy and move require sources and a destination');
  if (kind === 'rename' && (sources.length !== 1 || !destination || !named)) throw failure('invalid_request', 'Rename requires one source, destination, and name');
  if (kind === 'delete' && (sources.length < 1 || destination || named)) throw failure('invalid_request', 'Delete requires only source capabilities');
  // preserve transport room around the bounded capability list
  if (sources.reduce((total, token) => total + Buffer.byteLength(token), 0) > 48_000) throw failure('invalid_request', 'File capability list is too large');
  // Conductor destructive requests remain facts-only and are never confirmable
  if (principal.authentication === 'conductor' && confirmed) throw failure('forbidden', 'Conductor cannot confirm destructive Files operations');
  // Conductor safe movement cannot choose destination replacement
  if (principal.authentication === 'conductor' && (kind === 'move' || kind === 'rename') && collision !== 'fail') throw failure('forbidden', 'Conductor move and rename require collision=fail');
}

// project one existing Files operation without host paths
function fileOperationView(result: OperationResult): Record<string, unknown> {
  const state = result.state === 'completed' ? 'complete' : result.state === 'queued' ? 'pending' : result.state === 'partial' || result.state === 'canceled' ? 'failed' : result.state;
  const failed = result.results.find(item => item.outcome === 'failed');
  return { operation_id: result.operationId, state, completed: result.completedItems, total: result.totalItems, ...(failed === undefined ? {} : { error: { code: failed.code ?? 'operation_failed', message: (failed.message ?? 'File operation failed').slice(0, 400), retryable: false } }) };
}

// create bounded branch removal blockers
function branchBlockers(facts: { checkedOut: boolean; dirtyCount: number; pushed: boolean; merged: boolean; defaultBranch: boolean }): Array<{ code: string; message: string }> {
  const blockers: Array<{ code: string; message: string }> = [];
  if (facts.checkedOut) blockers.push({ code: 'checked_out', message: 'Branch is checked out' });
  if (facts.dirtyCount > 0) blockers.push({ code: 'dirty', message: 'Branch Worktree has uncommitted changes' });
  if (!facts.pushed && !facts.merged) blockers.push({ code: 'unpublished', message: 'Branch has unpublished commits' });
  if (facts.defaultBranch) blockers.push({ code: 'default_branch', message: 'Default branch cannot be removed' });
  return blockers;
}

// create bounded Worktree removal blockers
function removalBlockers(worktree: Worktree, facts: { main: boolean; locked: boolean; dirtyCount: number; pushed: boolean; merged: boolean }): Array<{ code: string; message: string }> {
  const blockers: Array<{ code: string; message: string }> = [];
  if (facts.main || worktree.main) blockers.push({ code: 'main_worktree', message: 'Main Worktree cannot be removed' });
  if (facts.locked || worktree.locked) blockers.push({ code: 'locked', message: 'Worktree is locked' });
  if (facts.dirtyCount > 0) blockers.push({ code: 'dirty', message: 'Worktree has uncommitted changes' });
  if (!facts.pushed && !facts.merged) blockers.push({ code: 'unpublished', message: 'Worktree has unpublished commits' });
  return blockers;
}

// resolve one Note persistence key and scoped Worktree
async function noteAt(deps: WorkspaceToolsDependencies, worktreeId: string, principal: IntegrationPrincipal): Promise<{ worktree: Worktree; key: string }> {
  const worktree = await requiredWorktree(deps, worktreeId, principal);
  const key = await deps.noteKey(worktree);
  if (key === undefined) throw failure('not_found', 'Note store unavailable');
  return { worktree, key };
}

// resolve one readable Note
async function resolveNote(deps: WorkspaceToolsDependencies, worktreeId: string, noteId: string, principal: IntegrationPrincipal): Promise<{ worktree: Worktree; key: string; note: WorktreeNote }> {
  const at = await noteAt(deps, worktreeId, principal);
  const resolved = await deps.notes.resolve(at.key, noteId);
  if (resolved === undefined) throw failure('not_found', 'Note unavailable');
  return { ...at, note: resolved.note };
}

// resolve one role-mutable Note
async function mutableNoteAt(deps: WorkspaceToolsDependencies, worktreeId: string, noteId: string, principal: IntegrationPrincipal): Promise<{ worktree: Worktree; key: string; note: WorktreeNote }> {
  const at = await resolveNote(deps, worktreeId, noteId, principal);
  // Conductor may mutate only Notes it created and the operator has not claimed
  if (principal.authentication === 'conductor' && at.note.source !== 'conductor') throw failure('forbidden', 'Conductor may change only its own Notes');
  return at;
}

// project one Note without stored attachment bodies
function noteView(note: WorktreeNote): Record<string, unknown> {
  const attachments = note.attachments ?? [];
  const bytes = attachments.reduce((total, attachment) => total + decodedBase64Size(attachment.data), 0);
  return { id: note.id, ...(note.title === undefined ? {} : { title: note.title }), text: note.text, locked: note.locked === true, all_workspaces: note.allWorkspaces === true, attachment_count: attachments.length, attachment_bytes: bytes, ...(note.schedule === undefined ? {} : { schedule: scheduleView(note.schedule) }) };
}

// issue one capability-only Note attachment projection
function attachmentView(deps: WorkspaceToolsDependencies, owner: HostFilesOwnerContext, noteKey: string, worktreeId: string, noteId: string, attachment: { name: string; data: string }): Record<string, unknown> {
  const id = attachmentId(worktreeId, noteId, attachment);
  const size = decodedBase64Size(attachment.data);
  const digest = digestBase64(attachment.data);
  const capability = deps.transfers.noteAttachment(owner, attachment.name, size, digest, async (offset, maxBytes) => {
    const current = (await deps.notes.attachments(noteKey, noteId))?.find(candidate => attachmentId(worktreeId, noteId, candidate) === id);
    if (current === undefined) throw new HostFilesError('stale_object', 'attachment changed', 409);
    return decodeBase64Range(current.data, offset, maxBytes);
  }, { worktreeId, noteId });
  return { attachment_id: id, name: attachment.name, size, object_token: capability.object_token, expires_at: capability.expires_at };
}

// account for a worst-case capability without minting omitted rows
function attachmentPageBudget(worktreeId: string, noteId: string, attachment: { name: string; data: string }): Record<string, unknown> {
  return { attachment_id: attachmentId(worktreeId, noteId, attachment), name: attachment.name, size: decodedBase64Size(attachment.data), object_token: attachmentCapabilityBudget, expires_at: '9999-12-31T23:59:59.999Z' };
}

// derive one stable non-secret attachment identity
function attachmentId(worktreeId: string, noteId: string, attachment: { name: string; data: string }): string { return createHash('sha256').update(worktreeId).update('\0').update(noteId).update('\0').update(attachment.name).update('\0').update(attachment.data).digest('base64url'); }

// project one stored schedule
function scheduleView(schedule: Schedule): Record<string, unknown> {
  return { cron: schedule.cron, kind: schedule.kind, ...(schedule.model === undefined ? {} : { model: schedule.model }), ...(schedule.effort === undefined ? {} : { effort: schedule.effort }), target: scheduleTargetView(schedule.target), enabled: schedule.enabled, updated_at: schedule.updatedAt, ...(schedule.lastRun === undefined ? {} : { last_run: { at: schedule.lastRun.at, status: schedule.lastRun.status, ...(schedule.lastRun.detail === undefined ? {} : { detail: schedule.lastRun.detail }), ...(schedule.lastRun.agentId === undefined ? {} : { agent_id: schedule.lastRun.agentId }), ...(schedule.lastRun.startedAt === undefined ? {} : { started_at: schedule.lastRun.startedAt }), ...(schedule.lastRun.sawWorking === undefined ? {} : { saw_working: schedule.lastRun.sawWorking }) } }) };
}

// project one schedule target
function scheduleTargetView(target: ScheduleTarget): Record<string, unknown> {
  if ('worktreeId' in target) return { kind: 'worktree', worktree_id: target.worktreeId };
  if ('projectId' in target) return { kind: 'project', project_id: target.projectId };
  if ('conductor' in target) return { kind: 'conductor' };
  return { kind: 'scratch' };
}

// parse one exact wire schedule target
function fromScheduleTarget(value: unknown): ScheduleTarget {
  const target = value as Record<string, unknown>;
  if (target.kind === 'worktree') return { worktreeId: target.worktree_id as string };
  if (target.kind === 'project') return { projectId: target.project_id as string };
  if (target.kind === 'conductor') return { conductor: true };
  return { scratch: true };
}

// validate one target against current role-filtered options
async function requireScheduleTarget(deps: WorkspaceToolsDependencies, worktree: Worktree, target: ScheduleTarget, principal: IntegrationPrincipal): Promise<void> {
  const options = await deps.scheduleTargets(worktree, principal);
  const serialized = JSON.stringify(scheduleTargetView(target));
  const found = options.find(option => JSON.stringify(scheduleTargetView(option.target)) === serialized);
  if (found === undefined || !found.available) throw failure('forbidden', found?.reason ?? 'Schedule target unavailable');
}

// describe the four exact schedule target arms
function scheduleTargetSchema(): z.ZodTypeAny { return z.discriminatedUnion('kind', [z.object({ kind: z.literal('worktree'), worktree_id: developerIdentifier }).strict(), z.object({ kind: z.literal('project'), project_id: developerIdentifier }).strict(), z.object({ kind: z.literal('scratch') }).strict(), z.object({ kind: z.literal('conductor') }).strict()]); }

// describe the paired schedule target JSON schema
function scheduleTargetJson(): Record<string, unknown> { return { oneOf: [objectSchema({ kind: { const: 'worktree' }, worktree_id: idJson }, ['kind', 'worktree_id']), objectSchema({ kind: { const: 'project' }, project_id: idJson }, ['kind', 'project_id']), objectSchema({ kind: { const: 'scratch' } }, ['kind']), objectSchema({ kind: { const: 'conductor' } }, ['kind'])] }; }

// validate watch event feed results
function watchEventsSchema(): z.ZodTypeAny { return z.object({ watch_id: developerIdentifier, events: z.array(z.object({ sequence: z.number().int().positive(), text: z.string().min(1).max(8_192) }).strict()).max(20), more: z.boolean(), ended: z.boolean(), end_reason: z.enum(['completed', 'unwatched', 'event_backlog_limit']).optional(), page_token: opaque.optional() }).strict(); }

// describe watch event feed results
function watchEventsJson(): Record<string, unknown> { return objectSchema({ watch_id: idJson, events: { type: 'array', maxItems: 20, items: objectSchema({ sequence: { type: 'integer', minimum: 1 }, text: stringJson(1, 8_192) }, ['sequence', 'text']) }, more: { type: 'boolean' }, ended: { type: 'boolean' }, end_reason: { enum: ['completed', 'unwatched', 'event_backlog_limit'] }, page_token: opaqueJson }, ['watch_id', 'events', 'more', 'ended']); }

// turn a domain Watch refusal into a public refusal
function watchResult<T>(result: T | { refused: string; code?: string }): T {
  if (typeof result === 'object' && result !== null && 'refused' in result) throw failure(result.code ?? 'invalid_state', String(result.refused));
  return result as T;
}

// require one configured Place scoped to this principal
async function requiredPlace(deps: WorkspaceToolsDependencies, placeId: string, principal: IntegrationPrincipal): Promise<WorkspacePlace> {
  const place = await deps.resolvePlace(placeId, principal);
  if (place === undefined) throw failure('not_found', 'Place unavailable');
  return place;
}

// require one scoped Agent target
async function requiredAgent(deps: WorkspaceToolsDependencies, agentId: string, principal: IntegrationPrincipal): Promise<AgentTarget> {
  const target = await deps.resolveAgent(agentId, principal);
  if (target === undefined) throw failure('not_found', 'Agent unavailable');
  return target;
}

// require one scoped Worktree
async function requiredWorktree(deps: WorkspaceToolsDependencies, worktreeId: string, principal: IntegrationPrincipal): Promise<Worktree> {
  const worktree = await deps.resolveWorktree(worktreeId, principal);
  if (worktree === undefined) throw failure('not_found', 'Worktree unavailable');
  return worktree;
}

// require a first-class Files owner
function requiredOwner(deps: WorkspaceToolsDependencies, principal: IntegrationPrincipal): HostFilesOwnerContext {
  const owner = deps.owner(principal);
  if (owner === undefined) throw failure('forbidden', 'Files owner unavailable');
  return owner;
}

// require Davo authentication
function requireDavo(principal: IntegrationPrincipal): void {
  if (principal.authentication !== 'realtime') throw failure('forbidden', 'Davo authentication required');
}

// require one discriminated Davo Watch owner
function requiredDavoWatchOwner(deps: WorkspaceToolsDependencies, principal: IntegrationPrincipal): DavoWatchOwner {
  requireDavo(principal);
  const owner = deps.davoWatchOwner(principal);
  if (owner === undefined) throw failure('forbidden', 'Davo Watch owner unavailable');
  return owner;
}

// parse one exact GitHub repository locator
function requiredRepository(value: string): GithubRepository {
  const parsed = githubRepository(`https://github.com/${value}`);
  if (parsed === undefined) throw failure('invalid_request', 'Invalid GitHub repository');
  return parsed;
}

// derive one stable principal owner key
function stableOwner(principal: IntegrationPrincipal): string { return `${principal.authentication}:${principal.stableOwnerKey ?? principal.subjectId}`; }

// separate action owners by principal namespace
function actionServiceOwner(principal: IntegrationPrincipal): string { return `mcp:${stableOwner(principal)}`; }

// construct a typed public failure
function failure(code: string, message: string, retryable = false): PublicFailure {
  const error = new Error(message) as PublicFailure;
  error.code = code;
  error.retryable = retryable;
  error.publicFailure = true;
  return error;
}

// normalize domain failures into the developer envelope
async function safely(run: () => Promise<DeveloperResult>): Promise<DeveloperResult> {
  try { return await run(); }
  catch (error) {
    if (error instanceof HostFilesError) return developerFailure(error.code, error.message.slice(0, 400), error.retryable);
    // translate only failures deliberately constructed for this public contract
    if (error instanceof Error && 'publicFailure' in error && (error as Partial<PublicFailure>).publicFailure === true) return developerFailure((error as PublicFailure).code, error.message.slice(0, 400), (error as PublicFailure).retryable);
    throw error;
  }
}

// return a typed list of integration scopes
function scopes(...values: IntegrationScope[]): IntegrationScope[] { return values; }

// create one strict JSON object schema
function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> { return { type: 'object', properties, required, additionalProperties: false }; }

// create one bounded JSON string schema
function stringJson(minLength: number, maxLength: number): Record<string, unknown> { return { type: 'string', minLength, maxLength }; }

// digest one canonical facts snapshot
function digestFacts(facts: unknown): string { return createHash('sha256').update(JSON.stringify(facts)).digest('base64url'); }

// compute decoded bytes from canonical persisted base64 without allocating them
function decodedBase64Size(data: string): number { return Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0); }

// digest canonical persisted base64 in bounded decoded chunks
function digestBase64(data: string): string {
  const hash = createHash('sha256');
  const charsPerChunk = 54_612;
  // decode only one bounded transfer-sized segment at a time
  for (let offset = 0; offset < data.length; offset += charsPerChunk) hash.update(Buffer.from(data.slice(offset, offset + charsPerChunk), 'base64'));
  return hash.digest('base64url');
}

// decode one exact persisted base64 byte range with transfer-sized memory
function decodeBase64Range(data: string, offset: number, maxBytes: number): Buffer {
  const size = decodedBase64Size(data);
  // reject invalid ranges before slicing
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || maxBytes < 1 || maxBytes > mcpFileLimits.chunkBytes) throw new HostFilesError('invalid_request', 'invalid attachment range', 400);
  const end = Math.min(size, offset + maxBytes);
  const firstGroup = Math.floor(offset / 3);
  const lastGroup = Math.ceil(end / 3);
  const decoded = Buffer.from(data.slice(firstGroup * 4, lastGroup * 4), 'base64');
  return decoded.subarray(offset - firstGroup * 3, offset - firstGroup * 3 + end - offset);
}

// define the exact bounded destination page contract
function exactDestinationOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const open = z.object({ worktree_id: developerIdentifier, worktree_name: z.string().min(1).max(240), agent_id: developerIdentifier.optional() }).strict();
  const branches = z.array(z.object({ name: branch, checked_out: z.boolean(), open_in: open.optional(), commit_summary: z.object({ subject: z.string().min(1).max(300), count: z.number().int().positive() }).strict().optional() }).strict()).max(100);
  const worktrees = z.array(z.object({ worktree_id: developerIdentifier, label: z.string().min(1).max(240), branch: branch.optional(), active: z.boolean(), available: z.boolean() }).strict()).max(100);
  const pulls = z.array(z.object({ number: z.number().int().positive().max(2_147_483_647), title: z.string().max(512), title_truncated: z.boolean(), branch, head_sha: z.string().regex(/^[0-9a-f]{40}$/u), head_on_origin: z.boolean(), head_repository: z.string().min(1).max(300).optional(), draft: z.boolean(), url: z.string().min(1).max(2_048), checkout_branch: branch, checked_out: z.boolean(), open_in: open.optional() }).strict()).max(100);
  const openJson = objectSchema({ worktree_id: idJson, worktree_name: stringJson(1, 240), agent_id: idJson }, ['worktree_id', 'worktree_name']);
  return { output: z.object({ branches, worktrees, pull_requests: pulls, counts: z.object({ branches: z.number().int().min(0).max(200), worktrees: z.number().int().nonnegative(), pull_requests: z.number().int().nonnegative() }).strict(), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict(), dataSchema: objectSchema({ branches: { type: 'array', maxItems: 100, items: objectSchema({ name: stringJson(1, 255), checked_out: { type: 'boolean' }, open_in: openJson, commit_summary: objectSchema({ subject: stringJson(1, 300), count: { type: 'integer', minimum: 1 } }, ['subject', 'count']) }, ['name', 'checked_out']) }, worktrees: { type: 'array', maxItems: 100, items: objectSchema({ worktree_id: idJson, label: stringJson(1, 240), branch: stringJson(1, 255), active: { type: 'boolean' }, available: { type: 'boolean' } }, ['worktree_id', 'label', 'active', 'available']) }, pull_requests: { type: 'array', maxItems: 100, items: objectSchema({ number: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }, title: stringJson(0, 512), title_truncated: { type: 'boolean' }, branch: stringJson(1, 255), head_sha: { type: 'string', pattern: '^[0-9a-f]{40}$' }, head_on_origin: { type: 'boolean' }, head_repository: stringJson(1, 300), draft: { type: 'boolean' }, url: stringJson(1, 2_048), checkout_branch: stringJson(1, 255), checked_out: { type: 'boolean' }, open_in: openJson }, ['number', 'title', 'title_truncated', 'branch', 'head_sha', 'head_on_origin', 'draft', 'url', 'checkout_branch', 'checked_out']) }, counts: objectSchema({ branches: { type: 'integer', minimum: 0, maximum: 200 }, worktrees: { type: 'integer', minimum: 0 }, pull_requests: { type: 'integer', minimum: 0 } }, ['branches', 'worktrees', 'pull_requests']), next_cursor: stringJson(1, 400), truncated: { type: 'boolean' } }, ['branches', 'worktrees', 'pull_requests', 'counts', 'truncated']) };
}

// define the exact Files capability contract
function exactFilesCapabilitiesOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const operations = ['list', 'preview', 'download_file', 'create_file', 'create_folder', 'copy', 'move', 'rename', 'delete', 'upload'] as const;
  const properties = { operations: { type: 'array', minItems: 1, maxItems: 10, items: { enum: operations } }, chunk_bytes: { const: 40_960 }, mcp_file_bytes: { const: 67_108_864 }, backend_file_bytes: { const: 1_073_741_824 }, backend_batch_bytes: { const: 2_147_483_648 }, max_active_owner: { const: 2 }, max_active_global: { const: 8 }, directory_download: { const: false } };
  return { output: z.object({ operations: z.array(z.enum(operations)).min(1).max(10), chunk_bytes: z.literal(40_960), mcp_file_bytes: z.literal(67_108_864), backend_file_bytes: z.literal(1_073_741_824), backend_batch_bytes: z.literal(2_147_483_648), max_active_owner: z.literal(2), max_active_global: z.literal(8), directory_download: z.literal(false) }).strict(), dataSchema: objectSchema(properties, Object.keys(properties)) };
}

// define the exact Files entry page contract
function exactFilesPageOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const kinds = ['file', 'directory', 'symlink', 'fifo', 'socket', 'block', 'character', 'other'] as const;
  const targetKinds = ['file', 'directory', 'missing', 'inaccessible', 'other'] as const;
  const entry = z.object({ name: z.string().min(1).max(255), relative_path: z.string().max(4_096), kind: z.enum(kinds), symlink_target_kind: z.enum(targetKinds).optional(), size: z.number().int().nonnegative(), modified_at: z.string().datetime({ offset: true }), permissions: z.string().min(1).max(16), object_token: opaque }).strict();
  const entryJson = objectSchema({ name: stringJson(1, 255), relative_path: stringJson(0, 4_096), kind: { enum: kinds }, symlink_target_kind: { enum: targetKinds }, size: { type: 'integer', minimum: 0 }, modified_at: { type: 'string', format: 'date-time' }, permissions: stringJson(1, 16), object_token: opaqueJson }, ['name', 'relative_path', 'kind', 'size', 'modified_at', 'permissions', 'object_token']);
  return { output: z.object({ items: z.array(entry).max(100), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict(), dataSchema: objectSchema({ items: { type: 'array', maxItems: 100, items: entryJson }, next_cursor: stringJson(1, 400), truncated: { type: 'boolean' } }, ['items', 'truncated']) };
}

// define the exact File preview contract
function exactFilePreviewOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  return { output: z.object({ text: z.string().max(65_536).optional(), encoding: z.enum(['utf8', 'base64', 'binary']), size: z.number().int().nonnegative(), truncated: z.boolean() }).strict().refine(value => value.encoding === 'binary' ? value.text === undefined : value.text !== undefined), dataSchema: objectSchema({ text: stringJson(0, 65_536), encoding: { enum: ['utf8', 'base64', 'binary'] }, size: { type: 'integer', minimum: 0 }, truncated: { type: 'boolean' } }, ['encoding', 'size', 'truncated']) };
}

// define the exact File operation contract
function exactFileOperationOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const error = z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(400), retryable: z.boolean() }).strict();
  const errorJson = objectSchema({ code: stringJson(1, 120), message: stringJson(1, 400), retryable: { type: 'boolean' } }, ['code', 'message', 'retryable']);
  return { output: z.object({ operation_id: developerIdentifier, state: z.enum(['pending', 'running', 'complete', 'failed']), completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), error: error.optional() }).strict(), dataSchema: objectSchema({ operation_id: idJson, state: { enum: ['pending', 'running', 'complete', 'failed'] }, completed: { type: 'integer', minimum: 0 }, total: { type: 'integer', minimum: 0 }, error: errorJson }, ['operation_id', 'state', 'completed', 'total']) };
}

// define the exact upload-begin contract
function exactFileUploadBeginOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  return { output: z.object({ transfer_id: developerIdentifier, next_offset: z.literal(0), chunk_bytes: z.literal(40_960), inactivity_expires_at: z.string().datetime({ offset: true }), absolute_expires_at: z.string().datetime({ offset: true }) }).strict(), dataSchema: objectSchema({ transfer_id: idJson, next_offset: { const: 0 }, chunk_bytes: { const: 40_960 }, inactivity_expires_at: { type: 'string', format: 'date-time' }, absolute_expires_at: { type: 'string', format: 'date-time' } }, ['transfer_id', 'next_offset', 'chunk_bytes', 'inactivity_expires_at', 'absolute_expires_at']) };
}

// define the exact upload-chunk contract
function exactFileChunkOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  return { output: z.object({ transfer_id: developerIdentifier, next_offset: z.number().int().nonnegative(), accepted_bytes: z.number().int().min(0).max(40_960) }).strict(), dataSchema: objectSchema({ transfer_id: idJson, next_offset: { type: 'integer', minimum: 0 }, accepted_bytes: { type: 'integer', minimum: 0, maximum: 40_960 } }, ['transfer_id', 'next_offset', 'accepted_bytes']) };
}

// define the exact transfer-status contract
function exactFileTransferOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const error = z.object({ code: z.string().min(1).max(120), message: z.string().min(1).max(400), retryable: z.boolean() }).strict();
  return { output: z.object({ transfer_id: developerIdentifier, state: z.enum(['open', 'finalizing', 'ready', 'cancelled', 'failed']), next_offset: z.number().int().nonnegative(), total_bytes: z.number().int().min(0).max(67_108_864), error: error.optional() }).strict(), dataSchema: objectSchema({ transfer_id: idJson, state: { enum: ['open', 'finalizing', 'ready', 'cancelled', 'failed'] }, next_offset: { type: 'integer', minimum: 0 }, total_bytes: { type: 'integer', minimum: 0, maximum: 67_108_864 }, error: objectSchema({ code: stringJson(1, 120), message: stringJson(1, 400), retryable: { type: 'boolean' } }, ['code', 'message', 'retryable']) }, ['transfer_id', 'state', 'next_offset', 'total_bytes']) };
}

// define the exact download-chunk contract
function exactFileDownloadOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  return { output: z.object({ offset: z.number().int().nonnegative(), data_base64: z.string().max(54_616), bytes: z.number().int().min(0).max(40_960), eof: z.boolean(), object_digest: z.string().min(43).max(44) }).strict(), dataSchema: objectSchema({ offset: { type: 'integer', minimum: 0 }, data_base64: stringJson(0, 54_616), bytes: { type: 'integer', minimum: 0, maximum: 40_960 }, eof: { type: 'boolean' }, object_digest: stringJson(43, 44) }, ['offset', 'data_base64', 'bytes', 'eof', 'object_digest']) };
}

// define the exact stored schedule contract
function exactScheduleOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const target = scheduleTargetSchema();
  const last = z.object({ at: z.string().datetime({ offset: true }), status: z.enum(['launched', 'running', 'completed', 'needs-input', 'timed-out', 'skipped', 'failed', 'delivered']), detail: z.string().min(1).max(400).optional(), agent_id: developerIdentifier.optional(), started_at: z.string().datetime({ offset: true }).optional(), saw_working: z.boolean().optional() }).strict();
  const lastJson = objectSchema({ at: { type: 'string', format: 'date-time' }, status: { enum: ['launched', 'running', 'completed', 'needs-input', 'timed-out', 'skipped', 'failed', 'delivered'] }, detail: stringJson(1, 400), agent_id: idJson, started_at: { type: 'string', format: 'date-time' }, saw_working: { type: 'boolean' } }, ['at', 'status']);
  return { output: z.object({ cron: z.string().min(1).max(200), kind: z.enum(agentKinds), model: z.string().min(1).max(200).optional(), effort: z.string().min(1).max(80).optional(), target, enabled: z.boolean(), updated_at: z.string().datetime({ offset: true }), last_run: last.optional() }).strict(), dataSchema: objectSchema({ cron: stringJson(1, 200), kind: { enum: agentKinds }, model: stringJson(1, 200), effort: stringJson(1, 80), target: scheduleTargetJson(), enabled: { type: 'boolean' }, updated_at: { type: 'string', format: 'date-time' }, last_run: lastJson }, ['cron', 'kind', 'target', 'enabled', 'updated_at']) };
}

// define the exact body-free Note contract
function exactNoteOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const schedule = exactScheduleOutput();
  return { output: z.object({ id: developerIdentifier, title: z.string().min(1).max(120).optional(), text: z.string().max(30_000), locked: z.boolean(), all_workspaces: z.boolean(), attachment_count: z.number().int().nonnegative(), attachment_bytes: z.number().int().min(0).max(25 * 1024 * 1024), schedule: schedule.output.optional() }).strict(), dataSchema: objectSchema({ id: idJson, title: stringJson(1, 120), text: stringJson(0, 30_000), locked: { type: 'boolean' }, all_workspaces: { type: 'boolean' }, attachment_count: { type: 'integer', minimum: 0 }, attachment_bytes: { type: 'integer', minimum: 0, maximum: 25 * 1024 * 1024 }, schedule: schedule.dataSchema }, ['id', 'text', 'locked', 'all_workspaces', 'attachment_count', 'attachment_bytes']) };
}

// define one capability-only Note attachment
function exactNoteAttachment(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  return { output: z.object({ attachment_id: developerIdentifier, name: z.string().min(1).max(240), size: z.number().int().min(1).max(25 * 1024 * 1024), object_token: opaque, expires_at: z.string().datetime({ offset: true }) }).strict(), dataSchema: objectSchema({ attachment_id: idJson, name: stringJson(1, 240), size: { type: 'integer', minimum: 1, maximum: 25 * 1024 * 1024 }, object_token: opaqueJson, expires_at: { type: 'string', format: 'date-time' } }, ['attachment_id', 'name', 'size', 'object_token', 'expires_at']) };
}

// define the exact attachment page
function exactAttachmentPageOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const attachment = exactNoteAttachment();
  return { output: z.object({ items: z.array(attachment.output).max(100), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict(), dataSchema: objectSchema({ items: { type: 'array', maxItems: 100, items: attachment.dataSchema }, next_cursor: stringJson(1, 400), truncated: { type: 'boolean' } }, ['items', 'truncated']) };
}

// define the exact attachment mutation result
function exactAttachmentOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const attachment = exactNoteAttachment();
  return { output: z.object({ attachment: attachment.output }).strict(), dataSchema: objectSchema({ attachment: attachment.dataSchema }, ['attachment']) };
}

// define the exact role-filtered schedule target page
function exactScheduleTargetPageOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const item = z.object({ target: scheduleTargetSchema(), label: z.string().min(1).max(240), available: z.boolean(), reason: z.string().min(1).max(240).optional() }).strict();
  const itemJson = objectSchema({ target: scheduleTargetJson(), label: stringJson(1, 240), available: { type: 'boolean' }, reason: stringJson(1, 240) }, ['target', 'label', 'available']);
  return { output: z.object({ items: z.array(item).max(100), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict(), dataSchema: objectSchema({ items: { type: 'array', maxItems: 100, items: itemJson }, next_cursor: stringJson(1, 400), truncated: { type: 'boolean' } }, ['items', 'truncated']) };
}

// define the exact trusted configured-action page
function exactActionPageOutput(): { output: z.ZodTypeAny; dataSchema: Record<string, unknown> } {
  const item = z.object({ action_id: developerIdentifier, revision: z.string().min(1).max(240), label: z.string().min(1).max(240), kind: z.enum(['prompt', 'shell']), available: z.boolean() }).strict();
  const itemJson = objectSchema({ action_id: idJson, revision: stringJson(1, 240), label: stringJson(1, 240), kind: { enum: ['prompt', 'shell'] }, available: { type: 'boolean' } }, ['action_id', 'revision', 'label', 'kind', 'available']);
  return { output: z.object({ items: z.array(item).max(100), next_cursor: z.string().min(1).max(400).optional(), truncated: z.boolean() }).strict(), dataSchema: objectSchema({ items: { type: 'array', maxItems: 100, items: itemJson }, next_cursor: stringJson(1, 400), truncated: { type: 'boolean' } }, ['items', 'truncated']) };
}

// hoist exact legacy definitions for envelope-level references
function withLegacyDefinitions(contract: ReturnType<typeof legacyOutput>): Record<string, unknown> { return { ...contract.dataSchema, $defs: contract.definitions }; }

// re-audience the existing exact Note tools to Davo without changing Conductor
function registerLegacyDavoNotes(ctx: RegistryContext): void {
  const { read, mutation, deps } = ctx;
  const listOutput = legacyOutput('list_notes');
  const createOutput = legacyOutput('create_note');
  const updateOutput = legacyOutput('update_note');
  const deleteOutput = legacyOutput('delete_note');
  const legacyScheduleOutput = legacyOutput('schedule_note');
  read({ name: 'list_notes', title: 'List Notes', description: 'List current operator-visible Notes.', scopes: scopes('logs:read'), audiences: ['realtime'], contractVersion: 'v1', schema: z.object({ worktree_id: developerIdentifier }).strict(), inputSchema: objectSchema({ worktree_id: idJson }, ['worktree_id']), output: listOutput.output, dataSchema: withLegacyDefinitions(listOutput), execute: async (value, principal) => {
    requireDavo(principal);
    const at = await noteAt(deps, value.worktree_id as string, principal);
    const notes = await deps.notes.list(at.key);
    if (notes === undefined) throw failure('not_found', 'Notes unavailable');
    return { notes: notes.map(note => ({ id: note.id, ...(note.title === undefined ? {} : { title: note.title }), text: redactIntegrationText(note.text), mine: note.source !== 'conductor', ...(note.schedule === undefined ? {} : { schedule: { cron: note.schedule.cron, enabled: note.schedule.enabled, conductor: 'conductor' in note.schedule.target } }) })) };
  } });
  mutation({ name: 'create_note', title: 'Create Note', description: 'Create one operator-owned Note.', scopes: scopes('notes:write'), audiences: ['realtime'], contractVersion: 'v1', destructive: false, schema: z.object({ worktree_id: developerIdentifier, title: z.string().min(1).max(120), text: z.string().max(30_000) }).strict(), properties: { worktree_id: idJson, title: stringJson(1, 120), text: stringJson(0, 30_000) }, required: ['worktree_id', 'title', 'text'], output: createOutput.output, dataSchema: withLegacyDefinitions(createOutput), execute: async (value, principal) => {
    requireDavo(principal);
    const at = await noteAt(deps, value.worktree_id as string, principal);
    const note = await deps.notes.createWithText(at.key, value.title as string, value.text as string);
    if (note === undefined) throw failure('invalid_state', 'Note limit reached');
    return { note_id: note.id };
  } });
  mutation({ name: 'update_note', title: 'Update Note', description: 'Update one operator Note.', scopes: scopes('notes:write'), audiences: ['realtime'], contractVersion: 'v1', schema: z.object({ worktree_id: developerIdentifier, note_id: developerIdentifier, title: z.string().min(1).max(120).optional(), text: z.string().max(30_000).optional() }).strict(), properties: { worktree_id: idJson, note_id: idJson, title: stringJson(1, 120), text: stringJson(0, 30_000) }, required: ['worktree_id', 'note_id'], output: updateOutput.output, dataSchema: withLegacyDefinitions(updateOutput), execute: async (value, principal) => {
    requireDavo(principal);
    // require at least one explicit change
    if (value.title === undefined && value.text === undefined) throw failure('invalid_request', 'At least one Note change is required');
    const at = await noteAt(deps, value.worktree_id as string, principal);
    // apply only explicitly supplied bounded fields
    if (value.title !== undefined && await deps.notes.rename(at.key, value.note_id as string, value.title as string) === undefined) throw failure('not_found', 'Note unavailable');
    if (value.text !== undefined && await deps.notes.update(at.key, value.note_id as string, value.text as string) === undefined) throw failure('not_found', 'Note unavailable');
    return { updated: true };
  } });
  mutation({ name: 'delete_note', title: 'Delete Note', description: 'Delete one unlocked operator Note.', scopes: scopes('notes:write'), audiences: ['realtime'], contractVersion: 'v1', schema: z.object({ worktree_id: developerIdentifier, note_id: developerIdentifier }).strict(), properties: { worktree_id: idJson, note_id: idJson }, required: ['worktree_id', 'note_id'], output: deleteOutput.output, dataSchema: withLegacyDefinitions(deleteOutput), execute: async (value, principal) => {
    requireDavo(principal);
    const at = await noteAt(deps, value.worktree_id as string, principal);
    const deleted = await deps.notes.deleteWithUndo(at.key, value.note_id as string);
    if (deleted === 'locked') throw failure('invalid_state', 'Note is locked');
    if (deleted === undefined) throw failure('not_found', 'Note unavailable');
    return { deleted: true };
  } });
  mutation({ name: 'schedule_note', title: 'Schedule Note', description: 'Update one existing explicit operator Note schedule.', scopes: scopes('notes:write'), audiences: ['realtime'], contractVersion: 'v1', schema: z.object({ worktree_id: developerIdentifier, note_id: developerIdentifier, cron: z.string().min(1).max(200), enabled: z.boolean() }).strict(), properties: { worktree_id: idJson, note_id: idJson, cron: stringJson(1, 200), enabled: { type: 'boolean' } }, required: ['worktree_id', 'note_id', 'cron', 'enabled'], output: legacyScheduleOutput.output, dataSchema: withLegacyDefinitions(legacyScheduleOutput), execute: async (value, principal) => {
    requireDavo(principal);
    const at = await resolveNote(deps, value.worktree_id as string, value.note_id as string, principal);
    // legacy input never chooses a target, so it may update only an existing explicit one
    if (at.note.schedule === undefined) throw failure('invalid_state', 'Use set_note_schedule to choose an explicit target');
    await requireScheduleTarget(deps, at.worktree, at.note.schedule.target, principal);
    const schedule = await deps.buildSchedule(at.worktree, at.note, { cron: value.cron as string, enabled: value.enabled as boolean, target: at.note.schedule.target }, principal);
    if (typeof schedule === 'string') throw failure('invalid_request', schedule);
    const updated = await deps.notes.setSchedule(at.key, at.note.id, schedule);
    if (updated === undefined) throw failure('not_found', 'Note unavailable');
    return { scheduled: true };
  } });
}

// expire and bound short-lived Note undo ownership metadata
function pruneNoteUndos(now: number): void {
  // remove expired entries first
  for (const [id, record] of noteUndos) {
    // retain current undo handles
    if (record.expiresAt > now) continue;
    noteUndos.delete(id);
  }
  // mirror the Note service's one-hundred snapshot ceiling
  while (noteUndos.size >= 100) {
    const oldest = noteUndos.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    noteUndos.delete(oldest);
  }
}
