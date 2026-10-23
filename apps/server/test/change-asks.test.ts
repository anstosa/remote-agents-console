import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changeAskCollection, ChangeAsks, ChangeAskStore, type ChangesTarget } from '../src/asks/changes.js';
import { parseChangeAskRequest } from '../src/asks/contracts.js';
import { AskJobs } from '../src/asks/jobs.js';
import type { ComparisonPatch } from '../src/git/comparison.js';
import type { ReviewRunner, ReviewRunRequest, ReviewRunResult } from '../src/review-runs/runner.js';
import type { TourGuide } from '../src/review-tour/contracts.js';
import { ReviewTourStore } from '../src/review-tour/store.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const session = '6f1c2a90-1111-4222-8333-444455556666';
const guideConversation = '9a8b7c6d-1111-4222-8333-444455556666';
const routePatch = 'diff --git a/src/route.ts b/src/route.ts\n--- a/src/route.ts\n+++ b/src/route.ts\n@@ -10,4 +10,5 @@\n a\n-b\n+B\n+C\n c\n d\n';
const patch: ComparisonPatch = { base: 'HEAD', gitBase: 'abc123', fingerprint: 'panel-fingerprint-0001', truncated: false, files: [
  { change: { path: 'src/route.ts', code: ' M', additions: 2, deletions: 1 }, kind: 'tracked', patch: routePatch, capped: false },
  { change: { path: 'assets/logo.png', code: ' M' }, kind: 'binary', patch: '', capped: false }
] };
const lines = { changeId: 'src/route.ts', side: 'additions' as const, startLine: 11, endLine: 12 };
const tourConfig = { agent: 'claude' as const, model: 'opus', effort: 'high', prompt: 'Narrate.' };

// a runner whose turns wait for the test to answer or fail them
function controlledRunner() {
  const turns: Array<{ request: ReviewRunRequest; answer: (value: ReviewRunResult) => void; fail: (error: unknown) => void }> = [];
  const closed: string[] = [];
  const runner: ReviewRunner = {
    capability: async () => ({ available: true }),
    run: async request => await new Promise((answer, fail) => { turns.push({ request, answer, fail }); }),
    closeWorktree: async worktreeId => { closed.push(worktreeId); }
  };
  return { runner, turns, closed };
}

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'rac-change-asks-'));
  directories.push(created);
  return created;
}

async function setup(guide?: TourGuide, current: ComparisonPatch | null = patch) {
  const file = join(await directory(), 'change-asks.json');
  const store = new ChangeAskStore(file);
  const { runner, turns, closed } = controlledRunner();
  const jobs = new AskJobs(runner, new ReviewTourStore(join(await directory(), 'reviews.json')), () => []);
  const tour = { ...tourConfig };
  const comparison = { patch: current };
  const asks = new ChangeAsks(jobs, store, () => tour);
  const branch = { now: 'feature/one' };
  const target: ChangesTarget = { worktreeId: 'cora', workspace: '/worktrees/cora', branch: 'feature/one', scope: 'working', branchNow: async () => branch.now, patch: async () => comparison.patch ?? undefined, guide: async () => guide };
  return { file, store, jobs, asks, target, turns, closed, branch, tour, comparison };
}

// let a settled turn's store write finish
const settled = async () => { for (let index = 0; index < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 5)); };
const question = (text: string, about: { lines: typeof lines } | { threadId: string } = { lines }) => parseChangeAskRequest({ ...about, question: text, ...('lines' in about ? { fingerprint: patch.fingerprint } : {}) })!;

describe('Code panel Ask requests', () => {
  it('parses a question about new lines with the Comparison it saw, or on a thread', () => {
    expect(parseChangeAskRequest({ lines, question: ' Why? ', fingerprint: patch.fingerprint })).toEqual({ lines, question: 'Why?', fingerprint: patch.fingerprint });
    expect(parseChangeAskRequest({ threadId: 'ask_1', question: 'And?' })).toEqual({ threadId: 'ask_1', question: 'And?' });
    expect(parseChangeAskRequest({ threadId: 'ask_1', question: 'And?', fingerprint: patch.fingerprint })).toEqual({ threadId: 'ask_1', question: 'And?' });
    expect(parseChangeAskRequest({ lines, question: 'Why?' })).toBeUndefined();
    expect(parseChangeAskRequest({ target: 'guide', lines, question: 'Why?', fingerprint: patch.fingerprint })).toBeUndefined();
  });
});

describe('Code panel Ask jobs', () => {
  it('starts a diff conversation on the tour agent with the first question, seeded with the Changes, and resumes it after', async () => {
    const { asks, jobs, store, target, turns } = await setup();
    const first = await asks.ask('owner', target, question('What does this do?'));
    const request = turns[0]!.request;
    expect(request).toMatchObject({ kind: 'claude', worktreeId: 'cora', workspace: '/worktrees/cora', reply: { kind: 'text' }, followUps: true, model: 'opus', effort: 'high', label: '💬 Ask · Working changes' });
    expect(request.resume).toBeUndefined();
    expect(request.prompt).toContain(' M src/route.ts (+2 -1)');
    expect(request.prompt).toContain(' M assets/logo.png');
    expect(request.prompt).toContain('```diff\n' + routePatch.trimEnd());
    expect(request.prompt).toMatch(/Location: src\/route\.ts, new lines 11-12[\s\S]*Question: What does this do\?$/u);
    expect(jobs.pending('owner', 'cora', changeAskCollection('working'))).toMatchObject([{ threadId: first.threadId, target: 'diff', question: 'What does this do?' }]);
    // the scope's conversation is not known until its first answer
    await expect(asks.ask('owner', target, question('And these?'))).rejects.toMatchObject({ code: 'busy' });
    turns[0]!.answer({ value: 'It routes.', conversation: session });
    await settled();
    const anchor = { changeId: 'src/route.ts', file: 'src/route.ts', side: 'additions', startLine: 11, endLine: 12, excerpt: ' a\n-b\n+B\n+C\n c\n d' };
    expect(await store.threads('cora', 'feature/one', 'working')).toEqual([{ id: first.threadId, target: 'diff', kind: 'claude', conversation: session, anchor, turns: [{ id: first.job.id, question: 'What does this do?', askedAt: first.job.startedAt, answer: 'It routes.' }] }]);
    // new lines and follow-ups resume the session, each with its current lines and no seed
    const second = await asks.ask('owner', target, question('And these?', { lines: { ...lines, startLine: 13, endLine: 13 } }));
    expect(second.threadId).not.toBe(first.threadId);
    expect(turns[1]!.request).toMatchObject({ resume: session, model: 'opus', effort: 'high' });
    expect(turns[1]!.request.prompt).not.toContain('assets/logo.png');
    expect(turns[1]!.request.prompt).toContain('Location: src/route.ts, new line 13');
    const followUp = await asks.ask('owner', target, question('Why?', { threadId: first.threadId }));
    expect(followUp.threadId).toBe(first.threadId);
    expect(turns[2]!.request).toMatchObject({ resume: session });
    expect(turns[2]!.request.prompt).toContain('```diff\n a\n-b\n+B\n+C\n c\n d\n```');
    turns[2]!.answer({ value: 'Because.', conversation: session });
    await settled();
    expect((await store.threads('cora', 'feature/one', 'working')).find(thread => thread.id === first.threadId)!.turns.map(turn => turn.answer)).toEqual(['It routes.', 'Because.']);
  });

  it('asks the tour guide when the stored tour covers the panel\'s Comparison', async () => {
    const { asks, store, target, turns } = await setup({ agent: 'claude', conversation: guideConversation, model: 'sonnet', effort: 'medium' });
    const started = await asks.ask('owner', target, question('What does this do?'));
    expect(turns[0]!.request).toMatchObject({ resume: guideConversation, model: 'sonnet', effort: 'medium', label: '💬 Ask · Tour guide' });
    expect(turns[0]!.request.prompt).toContain('review tour you narrated');
    turns[0]!.answer({ value: 'It routes.', conversation: guideConversation });
    await settled();
    expect(await store.threads('cora', 'feature/one', 'working')).toMatchObject([{ id: started.threadId, target: 'guide', conversation: guideConversation }]);
    // its follow-ups stay with the guide
    await asks.ask('owner', target, question('Why?', { threadId: started.threadId }));
    expect(turns[1]!.request).toMatchObject({ resume: guideConversation, model: 'sonnet', label: '💬 Ask · Tour guide' });
  });

  it('refuses a moved Comparison, lines outside its hunks, and an unknown file or thread', async () => {
    const { asks, target } = await setup();
    await expect(asks.ask('owner', target, { ...question('Why?'), fingerprint: 'panel-fingerprint-0002' } as never)).rejects.toMatchObject({ code: 'stale_during_generation' });
    await expect(asks.ask('owner', target, question('Why?', { lines: { ...lines, startLine: 90, endLine: 91 } }))).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(asks.ask('owner', target, question('Why?', { lines: { ...lines, changeId: 'src/other.ts' } }))).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(asks.ask('owner', target, question('Why?', { threadId: 'ask_unknown' }))).rejects.toMatchObject({ code: 'target_unavailable' });
    const gone = await setup(undefined, null);
    await expect(gone.asks.ask('owner', gone.target, question('Why?'))).rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('keeps a failed first question unstored, as a failed job, so the session can start again', async () => {
    const { asks, jobs, store, target, turns } = await setup();
    const failed = await asks.ask('owner', target, question('What does this do?'));
    turns[0]!.fail(new Error('crashed'));
    await settled();
    expect(jobs.get('owner', failed.job.id)?.state).toEqual({ kind: 'error', code: 'generation_failed', retryable: true });
    // an answer from a run that kept no conversation cannot be followed up
    const unkept = await asks.ask('owner', target, question('Again?'));
    turns[1]!.answer({ value: 'It routes.' });
    await settled();
    expect(jobs.get('owner', unkept.job.id)?.state).toEqual({ kind: 'error', code: 'conversation_unavailable', retryable: false });
    expect(await store.threads('cora', 'feature/one', 'working')).toEqual([]);
    await asks.ask('owner', target, question('Once more?'));
    expect(turns[2]!.request.resume).toBeUndefined();
  });

  it('keeps the panel\'s questions running through a new tour, and ends them with the Worktree', async () => {
    const { asks, jobs, target, closed } = await setup();
    const started = await asks.ask('owner', target, question('What does this do?'));
    await jobs.supersedeWorktree('cora', 'tour');
    expect(jobs.get('owner', started.job.id)?.state.kind).toBe('pending');
    expect(closed).toEqual(['cora']);
    await jobs.supersedeWorktree('cora', 'all');
    expect(jobs.get('owner', started.job.id)?.state).toEqual({ kind: 'gone', code: 'job_superseded' });
  });
});

describe('Code panel Ask jobs as things change', () => {
  it('lets one question start a scope\'s conversation even when two arrive together', async () => {
    const { asks, target, turns } = await setup();
    const results = await Promise.allSettled([asks.ask('owner', target, question('First?')), asks.ask('owner', target, question('Second?'))]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'busy' } });
    expect(turns).toHaveLength(1);
  });

  it('drops an answer that lands after the Worktree moved to another branch', async () => {
    const { asks, jobs, store, target, turns, branch } = await setup();
    const late = await asks.ask('owner', target, question('What does this do?'));
    branch.now = 'feature/two';
    const onTwo: ChangesTarget = { ...target, branch: 'feature/two', scope: 'pr' };
    await asks.ask('owner', onTwo, question('And here?'));
    turns[1]!.answer({ value: 'Here too.', conversation: session });
    await settled();
    turns[0]!.answer({ value: 'It routes.', conversation: session });
    await settled();
    expect(jobs.get('owner', late.job.id)?.state).toEqual({ kind: 'gone', code: 'job_superseded' });
    expect((await store.threads('cora', 'feature/two', 'pr')).map(thread => thread.turns[0]!.answer)).toEqual(['Here too.']);
  });

  it('follows up with the lines as they are now, or as first asked once the changes drop them', async () => {
    const { asks, target, turns, comparison } = await setup();
    const first = await asks.ask('owner', target, question('What does this do?'));
    turns[0]!.answer({ value: 'It routes.', conversation: session });
    await settled();
    comparison.patch = { ...patch, files: [{ ...patch.files[0]!, patch: routePatch.replace('+C', '+D') }] };
    await asks.ask('owner', target, question('Now?', { threadId: first.threadId }));
    expect(turns[1]!.request.prompt).toContain('+B\n+D');
    expect(turns[1]!.request.prompt).toContain('as they are now');
    turns[1]!.answer({ value: 'Still routes.', conversation: session });
    await settled();
    comparison.patch = { ...patch, files: [patch.files[1]!] };
    await asks.ask('owner', target, question('And now?', { threadId: first.threadId }));
    expect(turns[2]!.request.prompt).toContain('+B\n+C');
    expect(turns[2]!.request.prompt).toContain('the changes no longer hold them');
  });

  it('resumes the scope\'s conversation as it started, and starts another once the tour agent changes', async () => {
    const { asks, target, turns, tour } = await setup();
    await asks.ask('owner', target, question('What does this do?'));
    turns[0]!.answer({ value: 'It routes.', conversation: session });
    await settled();
    tour.model = 'haiku';
    await asks.ask('owner', target, question('And these?'));
    expect(turns[1]!.request).toMatchObject({ kind: 'claude', resume: session, model: 'opus' });
    tour.agent = 'codex' as never;
    tour.model = undefined as never;
    await asks.ask('owner', target, question('Again?', { lines: { ...lines, startLine: 13, endLine: 13 } }));
    expect(turns[2]!.request).toMatchObject({ kind: 'codex' });
    expect(turns[2]!.request.resume).toBeUndefined();
  });
});

describe('Code panel Ask threads in their store', () => {
  it('keeps threads per Worktree, branch and scope across restarts', async () => {
    const { asks, file, target, turns } = await setup();
    await asks.ask('owner', target, question('What does this do?'));
    turns[0]!.answer({ value: 'It routes.', conversation: session });
    await settled();
    const reopened = new ChangeAskStore(file);
    expect(await reopened.threads('cora', 'feature/one', 'working')).toHaveLength(1);
    expect(await reopened.started('cora', 'feature/one', 'working')).toEqual({ agent: 'claude', conversation: session, model: 'opus', effort: 'high' });
    expect(await reopened.threads('cora', 'feature/one', 'pr')).toEqual([]);
    expect(await reopened.threads('cora', 'feature/two', 'working')).toEqual([]);
    expect(await reopened.threads('dora', 'feature/one', 'working')).toEqual([]);
  });
});
