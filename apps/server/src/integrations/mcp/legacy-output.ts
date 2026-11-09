import Fastify from 'fastify';
import { z } from 'zod';
import { objectId } from '../../git/comparison.js';

const string = { type: 'string' };
const boolean = { type: 'boolean' };
const integer = { type: 'integer' };
const number = { type: 'number' };
const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const localObject = { type: 'string', pattern: objectId.source };
const githubHead = { type: 'string', pattern: '^[0-9a-f]{40}$' };
// reference only ordinary JSON Schema components
const ref = (name: string): Record<string, unknown> => ({ $ref: `#/$defs/${name}` });
// construct closed objects while explicitly preserving optional-key absence
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });
// preserve source arrays without imposing a new legacy payload cap
const array = (items: Record<string, unknown>): Record<string, unknown> => ({ type: 'array', items });
// retain source enum values verbatim
const enumeration = (...values: string[]): Record<string, unknown> => ({ type: 'string', enum: values });
const action = enumeration('start', 'stop', 'build', 'restart', 'migrate');
const attention = enumeration('working', 'finished', 'question');
const reviewScope = enumeration('working', 'pr', 'commit');
const jobDescriptor = object({ id: string, expiresAt: string, retryAfterMs: integer, startedAt: string });
const openIn = object({ worktreeId: string, worktreeName: string, agentId: string }, ['worktreeId', 'worktreeName']);
const change = object({ code: string, path: string, originalPath: string, additions: number, deletions: number, category: enumeration('implementation', 'test', 'doc') }, ['code', 'path']);
const git = { gitStatus: ref('gitStatus'), gitPrStatus: ref('gitComparison'), gitUpstream: ref('gitUpstream'), pullRequest: ref('pull') };
const summary = { worktreeId: string, branch: string, savedAt: string, title: string, scope: reviewScope, commit: localObject, includeTests: boolean, includeDocs: boolean, fingerprint: string, codeReview: enumeration('running', 'ready', 'failed'), findings: integer };
const summaryRequired = ['worktreeId', 'branch', 'savedAt', 'title', 'scope', 'includeTests', 'includeDocs', 'fingerprint'];
const destination = object({ kind: enumeration('worktree', 'project'), worktreeId: string, projectId: string, label: string, branch: string }, ['kind', 'worktreeId', 'projectId', 'label']);
const comment = { id: string, author: string, bot: boolean, mine: boolean, createdAt: string, url: string, body: ref('githubText') };
const commentRequired = Object.keys(comment);
const defs: Record<string, Record<string, unknown>> = {
  instance: object({ id: string, name: string, url: string, local: boolean, icon: string }, ['id', 'name', 'url', 'local']),
  gitStatus: object({ files: number, staged: number, unstaged: number, untracked: number, conflicted: number, changes: array(change) }, ['files', 'staged', 'unstaged', 'untracked', 'conflicted']),
  gitComparison: object({ base: string, files: number, changes: array(change) }, ['base', 'files']),
  gitUpstream: object({ upstream: string, ahead: number, behind: number }),
  pull: object({ number: integer, title: string, status: enumeration('draft', 'open', 'merged'), url: string, baseBranch: string, checks: enumeration('passed', 'pending', 'failed'), issues: object({ mergeConflicts: boolean, failingChecks: boolean, unresolvedComments: boolean }, []), unresolvedThreads: integer }, ['number', 'title', 'status', 'url']),
  stack: object({ actions: array(action), running: boolean, transition: enumeration('starting', 'migrating'), operation: action, tunnel: boolean, processes: array(object({ name: string, state: enumeration('running', 'exited', 'stopped'), exitCode: number, operation: action }, ['name', 'state'])) }, ['actions']),
  stackLog: object({ action, active: boolean, startedAt: string, completedAt: string, output: string }, ['action', 'active', 'startedAt', 'output']),
  agent: object({ id: string, title: string, label: string, projectId: string, worktreeId: string, placeId: string, branch: string, ...git, projectUrl: string, projectProxied: boolean, question: object({ id: string, text: string, choices: array(string) }), attention, unread: boolean }, ['id', 'title', 'label', 'attention', 'unread']),
  worktree: object({ id: string, label: string, available: boolean, pinned: boolean, active: boolean, order: number, agentIds: array(string), projectUrl: string, projectProxied: boolean, branch: string, ...git, stack: ref('stack'), review: ref('reviewSummary') }, ['id', 'label', 'available', 'pinned', 'active', 'order', 'agentIds']),
  latest: object({ text: string, source: enumeration('terminal', 'history'), truncated: boolean }),
  tail: object({ text: string, rows: integer, older: boolean, truncated: boolean }),
  prompt: object({ id: string, text: string, createdAt: string, answer: string, answeredAt: string, from: string, label: enumeration('report', 'event', 'run') }, ['id', 'text', 'createdAt']),
  queued: object({ id: string, text: string, createdAt: string, from: string, label: enumeration('report', 'event', 'run'), attachments: array(object({ name: string, size: number })) }, ['id', 'text', 'createdAt']),
  preview: object({ path: string, size: number, binary: boolean, truncated: boolean, content: string, image: object({ mediaType: string, base64: string }) }, ['path', 'size', 'binary', 'truncated']),
  reviewSummary: object(summary, summaryRequired),
  tour: object({ title: string, overview: string, steps: array(object({ id: string, title: string, explanation: string, changeIds: array(string) })), scope: reviewScope, commit: localObject, base: string, includeTests: boolean, includeDocs: boolean, fingerprint: string, changes: array(object({ id: string, file: string, originalFile: string, category: enumeration('implementation', 'test', 'doc'), kind: enumeration('hunk', 'binary', 'rename', 'metadata', 'untracked'), oldStart: number, oldLines: number, newStart: number, newLines: number, patch: string }, ['id', 'file', 'category', 'kind', 'patch'])), guide: object({ agent: enumeration('claude', 'codex', 'omx', 'pi'), conversation: string, model: string, effort: string }, ['agent', 'conversation']) }, ['title', 'overview', 'steps', 'scope', 'base', 'includeTests', 'includeDocs', 'fingerprint', 'changes']),
  storedReview: object({ worktreeId: string, branch: string, savedAt: string, tour: ref('tour') }),
  reviewStatus: object({ summary: ref('reviewSummary'), review: ref('storedReview') }, []),
  publicComparison: object({ scope: reviewScope, commit: localObject, base: string, fingerprint: string, includeTests: boolean, includeDocs: boolean }, ['scope', 'base', 'fingerprint', 'includeTests', 'includeDocs']),
  reviewStart: { oneOf: [object({ kind: { const: 'empty' }, comparison: ref('publicComparison') }), object({ kind: { const: 'pending' }, job: jobDescriptor, codeReview: object({ job: jobDescriptor }) }, ['kind', 'job'])] },
  branchDestination: object({ branch: string, checkedOut: boolean, openIn, commitSummary: object({ subject: string, count: integer }) }, ['branch', 'checkedOut']),
  pullDestination: object({ number: integer, title: string, branch: string, headSha: githubHead, headOnOrigin: boolean, headRepository: string, draft: boolean, url: string, checkoutBranch: string, checkedOut: boolean, openIn }, ['number', 'title', 'branch', 'headSha', 'headOnOrigin', 'draft', 'url', 'checkoutBranch', 'checkedOut']),
  switching: object({ enabled: boolean, pullRequests: array(ref('pullDestination')), otherPullRequests: array(ref('pullDestination')), branches: array(ref('branchDestination')), pullRequestsSupported: boolean }),
  prStatus: object({ current: ref('pull'), comparison: ref('gitComparison'), switching: ref('switching'), actionsUrl: string }, []),
  workspaceSummary: object({ text: string, worktrees: array(object({ id: string, label: string, active: boolean, agents: integer, attention: enumeration('working', 'finished', 'question', 'inactive'), branch: string, changes: integer }, ['id', 'label', 'active', 'agents', 'attention', 'changes'])), scratchAgents: array(object({ id: string, label: string, attention })) }),
  attention: object({ state: enumeration('idle', 'working', 'question', 'completed'), text: string, agents: array(object({ id: string, label: string, attention, unread: boolean })) }),
  githubText: object({ text: string, truncated: { const: true } }, ['text']),
  githubFreshness: object({ state: enumeration('fresh', 'stale', 'cold', 'failed'), fetchedAt: nullableString, ageSeconds: nullableNumber, network: enumeration('none', 'not_needed', 'joined', 'fetched', 'throttled', 'rate_limited', 'no_token', 'failed'), problem: { anyOf: [{ type: 'null' }, object({ kind: enumeration('no_token', 'rate_limited', 'failing'), message: string, retryAt: nullableString })] }, backgroundPoll: enumeration('browser', 'none') }),
  githubReason: { oneOf: [object({ kind: { const: 'thread' }, threadId: string, path: string, lastAuthor: string, new: boolean }), object({ kind: { const: 'checks' }, new: boolean }), object({ kind: { const: 'conflicts' }, new: boolean }), object({ kind: { const: 'changes' }, reviewId: string, reviewer: string, new: boolean }), object({ kind: { const: 'review' }, reRequested: boolean, new: boolean })] },
  githubRow: object({ repository: string, number: integer, title: string, url: string, author: string, updatedAt: string, draft: boolean, labels: array(string), waitingOnMe: array(ref('githubReason')), destinations: array(destination), headSha: githubHead, mergeable: enumeration('mergeable', 'conflicting', 'unknown'), checks: enumeration('passed', 'failed', 'pending'), approved: { const: true }, closes: array(integer), request: object({ direct: boolean, reRequested: boolean }), myLatestReview: object({ state: enumeration('approved', 'changes', 'commented', 'dismissed'), atHead: boolean }), newCommitsSinceMyReview: { const: true }, linkedPullRequests: array(integer) }, ['repository', 'number', 'title', 'url', 'draft', 'labels', 'waitingOnMe', 'destinations']),
  githubCoverage: object({ returned: integer, inScope: integer, complete: { type: ['boolean', 'null'] }, pageLimit: integer, truncatedByRequest: boolean }),
  githubOverview: object({ freshness: ref('githubFreshness'), coverage: object({ viewer: nullableString, repositories: array(string), lists: object({ mine: ref('githubCoverage'), reviews: ref('githubCoverage'), issues: ref('githubCoverage') }, []), notCovered: array(string) }), mine: { anyOf: [{ type: 'null' }, array(ref('githubRow'))] }, reviews: { anyOf: [{ type: 'null' }, array(ref('githubRow'))] }, issues: { anyOf: [{ type: 'null' }, array(ref('githubRow'))] } }, ['freshness', 'coverage']),
  githubComment: object(comment, commentRequired),
  githubDiscussion: { oneOf: [object({ type: { const: 'description' }, ...comment }), object({ type: { const: 'comment' }, ...comment }), object({ type: { const: 'review' }, state: string, ...comment }), object({ type: { const: 'thread' }, id: string, path: string, line: integer, startLine: integer, resolved: boolean, outdated: boolean, lastSpeakerIsMe: boolean, diffHunk: ref('githubText'), comments: array(ref('githubComment')), omittedComments: integer, olderCommentsMayBeMissing: boolean }, ['type', 'id', 'path', 'resolved', 'outdated', 'lastSpeakerIsMe', 'comments', 'omittedComments', 'olderCommentsMayBeMissing'])] },
  githubPull: object({ freshness: ref('githubFreshness'), repository: string, number: integer, pullRequest: { anyOf: [{ type: 'null' }, object({ summary: object({ title: string, url: string, state: enumeration('open', 'merged', 'closed'), draft: boolean, author: string, mine: boolean, updatedAt: string, baseBranch: string, branch: string, headSha: githubHead, headOnOrigin: boolean, mergeable: enumeration('mergeable', 'conflicting', 'unknown'), checks: enumeration('passed', 'failed', 'pending'), linkedIssues: array(object({ number: integer, title: string, url: string, state: enumeration('open', 'closed') })), destinations: array(destination) }, ['title', 'url', 'state', 'draft', 'mine', 'branch', 'headSha', 'headOnOrigin', 'mergeable', 'checks', 'linkedIssues', 'destinations']), checks: object({ runs: array(object({ name: string, status: enumeration('passed', 'failed', 'pending', 'skipped'), url: string }, ['name', 'status'])), mayBeTruncated: boolean }), reviewers: object({ reviewers: array(object({ login: string, team: { const: true }, bot: { const: true }, state: enumeration('approved', 'changes', 'commented', 'dismissed'), requested: { const: true }, newCommitsSinceReview: { const: true } }, ['login'])), mayBeTruncated: boolean, note: string }), discussion: object({ snapshot: string, entries: array(ref('githubDiscussion')), totalEntries: integer, nextCursor: nullableString, mayBeTruncated: object({ threads: boolean, reviews: boolean, comments: boolean }) }) }, [])] } }),
  notes: object({ notes: array(object({ id: string, title: string, text: string, mine: boolean, schedule: object({ cron: string, enabled: boolean, conductor: boolean }) }, ['id', 'text', 'mine'])) }),
  watches: object({ watches: array(object({ watch_id: string, kind: enumeration('pull_request', 'process', 'review_requests', 'command'), description: string, created_at: string })) }),
  watchPull: object({ watch_id: string, state: object({ url: string, head: githubHead, checks: enumeration('passed', 'failed', 'pending'), merge_conflict: boolean, unresolved_threads: integer }) }),
  watchProcess: object({ watch_id: string, state: string }, ['watch_id']),
  watchReviews: object({ watch_id: string, requested: array(object({ number: integer, url: string })) })
};
const named: Record<string, Record<string, unknown>> = {
  list_instances: array(ref('instance')), list_worktrees: array(ref('worktree')), get_worktree_status: ref('worktree'), list_agents: array(ref('agent')), get_agent_status: ref('agent'), get_agent_latest_response: ref('latest'), summarize_agent_response: ref('latest'), get_agent_log_tail: ref('tail'), list_prompt_history: object({ prompts: array(ref('prompt')) }), list_queued_prompts: object({ prompts: array(ref('queued')) }), get_stack_status: ref('stack'), get_stack_log: ref('stackLog'), preview_file: ref('preview'), get_process_log: object({ name: string, path: string, output: string }), list_notes: ref('notes'), get_pull_request_status: ref('prStatus'), get_github_overview: ref('githubOverview'), get_github_pull_request: ref('githubPull'), get_review_status: ref('reviewStatus'), summarize_workspace: ref('workspaceSummary'), summarize_attention_items: ref('attention'),
  queue_prompt: object({ accepted: { const: true }, prompt_id: string }), update_queued_prompt: ref('queued'), move_queued_prompt: object({ prompts: array(ref('queued')) }), remove_queued_prompt: object({ removed: { const: true } }), answer_agent_question: object({ answered: { const: true } }), cancel_agent: object({ cancelled: { const: true } }), launch_worktree_agent: object({ launched: { const: true } }), launch_scratch_agent: object({ launched: { const: true } }), deactivate_agent: object({ deactivated: { const: true } }), start_new_task: object({ started: { const: true } }), run_stack_action: object({ started: { const: true } }), start_review: ref('reviewStart'), spawn_agent: object({ agent_id: string }), create_worktree: object({ worktree_id: string, setup_error: string, fetch_error: string, launch_error: string }, ['worktree_id']), close_agent: object({ closed: { const: true } }), create_note: object({ note_id: string }), update_note: object({ updated: { const: true } }), delete_note: object({ deleted: { const: true } }), schedule_note: object({ scheduled: { const: true } }), watch_pull_request: ref('watchPull'), watch_process: ref('watchProcess'), watch_review_requests: ref('watchReviews'), watch_command: object({ watch_id: string }), list_watches: ref('watches'), unwatch: object({ removed: { const: true } }), switch_pull_request: object({ switched: { const: true } })
};

// use the installed framework's standard JSON Schema engine with mutation disabled
const validationHost = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, strict: false } } });
validationHost.post('/schema-compiler', { schema: { body: { type: 'object' } } }, async () => ({}));
await validationHost.ready();
const compile = validationHost.validatorCompiler!;
await validationHost.close();

// bind actual legacy output validation to its exact advertised schema, without converting Zod
export function legacyOutput(name: string): { output: z.ZodTypeAny; dataSchema: Record<string, unknown>; definitions: typeof defs } {
  const dataSchema = named[name];
  // a new public tool must supply a contract rather than inherit an untyped data field
  if (dataSchema === undefined) throw new Error(`missing output contract: ${name}`);
  const validate = compile({ schema: { ...dataSchema, $defs: defs }, method: 'POST', url: `/mcp/${name}`, httpPart: 'body' });
  return { output: z.custom(value => validate(value) === true), dataSchema, definitions: defs };
}

// expose the standard validator for contract-parity regression tests
export function validateToolSchema(schema: Record<string, unknown>, value: unknown): boolean {
  return compile({ schema, method: 'POST', url: '/mcp/contract', httpPart: 'body' })(value) === true;
}
