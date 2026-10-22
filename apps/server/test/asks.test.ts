import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hunkExcerpt, parseAskRequest, reviewerAskPrompt, findingAnchor } from '../src/asks/contracts.js';
import { AskJobs } from '../src/asks/jobs.js';
import type { CodeReview } from '../src/code-review/contracts.js';
import { ReviewRunError, type ReviewRunner, type ReviewRunRequest, type ReviewRunResult } from '../src/review-runs/runner.js';
import type { ReviewTour } from '../src/review-tour/contracts.js';
import { ReviewTourStore } from '../src/review-tour/store.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

const conversation = '6f1c2a90-1111-4222-8333-444455556666';
const change = { id: 'chg_route0001', file: 'src/route.ts', category: 'implementation' as const, kind: 'hunk' as const, oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, patch: '@@ -10,4 +10,5 @@\n a\n-b\n+B\n+C\n c\n d' };
const tour: ReviewTour = { title: 'Routing tour', overview: 'Follow the request.', scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint: 'fingerprint-1234567890', changes: [change], steps: [{ id: 'route', title: 'Accept the request', explanation: 'The route delegates.', changeIds: [change.id] }] };
const finding = { id: 'fnd_0123456789abcdef', changeId: change.id, side: 'additions' as const, startLine: 11, endLine: 12, severity: 'high' as const, title: 'Guard skipped', body: 'The new branch skips the guard.' };
const codeReview = (extra: Partial<CodeReview> = {}): CodeReview => ({ fingerprint: tour.fingerprint, preset: { id: 'correctness', label: 'Correctness', agent: 'claude' }, effort: 'high', findings: [finding], general: [], completedAt: new Date().toISOString(), conversation, ...extra });
const target = { worktreeId: 'cora', workspace: '/worktrees/cora', branch: 'feature/one' };
const ask = (question = 'Why is this a problem?') => ({ findingId: finding.id, question, fingerprint: tour.fingerprint });

// a store holding the tour and its Code review
async function stored(review: CodeReview = codeReview()): Promise<ReviewTourStore> {
  const directory = await mkdtemp(join(tmpdir(), 'rac-asks-'));
  directories.push(directory);
  const store = new ReviewTourStore(join(directory, 'reviews.json'));
  const generation = await store.invalidate('cora', 'feature/one');
  await store.saveIfCurrent('cora', 'feature/one', tour, generation!);
  await store.saveCodeReviewIfCurrent('cora', 'feature/one', review, store.beginCodeReview('cora'));
  return store;
}

// a runner whose turns wait for the test to answer or fail them
function controlledRunner() {
  const turns: Array<{ request: ReviewRunRequest; signal: AbortSignal; answer: (value: ReviewRunResult) => void; fail: (error: unknown) => void }> = [];
  const closed: string[] = [];
  const runner: ReviewRunner = {
    capability: async () => ({ available: true }),
    run: async (request, signal) => await new Promise((answer, fail) => { turns.push({ request, signal, answer, fail }); }),
    closeWorktree: async worktreeId => { closed.push(worktreeId); }
  };
  return { runner, turns, closed };
}

// let a settled turn's store write finish
const settled = async () => { for (let index = 0; index < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 5)); };

describe('Ask contracts', () => {
  it('excerpts the asked-about lines of one side with a little context', () => {
    expect(hunkExcerpt(change, 'additions', 11, 12)).toBe(' a\n-b\n+B\n+C\n c\n d');
    expect(hunkExcerpt(change, 'deletions', 11, 11)).toBe(' a\n-b\n+B\n+C\n c');
    expect(hunkExcerpt(change, 'additions', 90, 91)).toBe('');
  });

  it('trims a question and refuses a blank or oversized one', () => {
    expect(parseAskRequest(ask('  Why?  '))).toEqual(ask('Why?'));
    expect(parseAskRequest(ask('   '))).toBeUndefined();
    expect(parseAskRequest(ask('x'.repeat(4_001)))).toBeUndefined();
    expect(parseAskRequest({ ...ask(), extra: true })).toBeUndefined();
  });

  it('asks about the Finding at its lines with the question last', () => {
    const prompt = reviewerAskPrompt(finding, findingAnchor(finding, change), 'Why?');
    expect(prompt).toContain('Finding: Guard skipped (high)');
    expect(prompt).toContain('Location: src/route.ts, new lines 11-12');
    expect(prompt).toContain('```diff\n a\n-b\n+B');
    expect(prompt.endsWith('Question: Why?')).toBe(true);
  });
});

describe('Ask jobs', () => {
  it('resumes the review\'s conversation for a text answer, then stores the turn with the tour', async () => {
    const store = await stored();
    const { runner, turns } = controlledRunner();
    const jobs = new AskJobs(runner, store, () => [{ id: 'correctness', label: 'Correctness', agent: 'claude', model: 'opus', prompt: 'Review.' }]);
    const started = await jobs.ask('owner', target, ask());
    expect(started.threadId).toBe(finding.id);
    expect(turns[0]!.request).toMatchObject({ kind: 'claude', workspace: '/worktrees/cora', worktreeId: 'cora', reply: { kind: 'text' }, resume: conversation, followUps: true, label: '💬 Ask · Correctness', model: 'opus', effort: 'high' });
    expect(jobs.pending('owner', 'cora')).toEqual([{ threadId: finding.id, question: 'Why is this a problem?', job: started.job }]);
    expect(jobs.pending('someone-else', 'cora')).toEqual([]);
    // a thread takes one question at a time
    await expect(jobs.ask('owner', target, ask('And?'))).rejects.toMatchObject({ code: 'busy' });
    turns[0]!.answer({ value: 'Because **the guard** runs later.', conversation });
    await settled();
    expect(jobs.get('owner', started.job.id)?.state).toEqual({ kind: 'ready' });
    expect(jobs.get('someone-else', started.job.id)).toBeUndefined();
    expect(await store.askThreads('cora', 'feature/one', tour.fingerprint)).toEqual([{ id: finding.id, target: 'reviewer', kind: 'claude', conversation, anchor: findingAnchor(finding, change), turns: [{ id: started.job.id, question: 'Why is this a problem?', askedAt: started.job.startedAt, answer: 'Because **the guard** runs later.' }] }]);
    // a follow-up joins the same thread
    const followUp = await jobs.ask('owner', target, ask('And then?'));
    turns[1]!.fail(new ReviewRunError('timed_out', true));
    await settled();
    expect(jobs.get('owner', followUp.job.id)?.state).toEqual({ kind: 'error', code: 'timed_out', retryable: true });
    const [thread] = await store.askThreads('cora', 'feature/one', tour.fingerprint);
    expect(thread!.turns.map(turn => [turn.question, turn.answer, turn.error])).toEqual([['Why is this a problem?', 'Because **the guard** runs later.', undefined], ['And then?', undefined, { code: 'timed_out', retryable: true }]]);
  });

  it('refuses a stale Comparison, an unknown Finding and a review that kept no conversation', async () => {
    const { runner } = controlledRunner();
    const jobs = new AskJobs(runner, await stored(), () => []);
    await expect(jobs.ask('owner', target, { ...ask(), fingerprint: 'fingerprint-other-12345' })).rejects.toMatchObject({ code: 'stale_during_generation' });
    await expect(jobs.ask('owner', target, { ...ask(), findingId: 'fnd_unknown' })).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(jobs.ask('owner', { ...target, branch: 'feature/two' }, ask())).rejects.toMatchObject({ code: 'target_unavailable' });
    const { conversation: _conversation, ...unresumable } = codeReview();
    await expect(new AskJobs(runner, await stored(unresumable), () => []).ask('owner', target, ask())).rejects.toMatchObject({ code: 'conversation_unavailable' });
  });

  it('ends a Worktree\'s questions when its tour goes, closing their conversations and storing nothing', async () => {
    const store = await stored();
    const { runner, turns, closed } = controlledRunner();
    const jobs = new AskJobs(runner, store, () => []);
    const started = await jobs.ask('owner', target, ask());
    await jobs.supersedeWorktree('cora');
    expect(turns[0]!.signal.aborted).toBe(true);
    expect(jobs.get('owner', started.job.id)?.state).toEqual({ kind: 'gone', code: 'job_superseded' });
    expect(closed).toEqual(['cora']);
    turns[0]!.answer({ value: 'Too late.' });
    await settled();
    expect(await store.askThreads('cora', 'feature/one', tour.fingerprint)).toEqual([]);
  });
});

describe('Ask jobs and the store', () => {
  it('reports a turn the store could not write as a failed job, not a superseded one', async () => {
    const store = await stored();
    const { runner, turns } = controlledRunner();
    const failing = { current: store.current.bind(store), codeReview: store.codeReview.bind(store), saveAskTurn: async () => { throw new Error('ENOSPC'); } };
    const jobs = new AskJobs(runner, failing, () => []);
    const started = await jobs.ask('owner', target, ask());
    turns[0]!.answer({ value: 'An answer.' });
    await settled();
    expect(jobs.get('owner', started.job.id)?.state).toEqual({ kind: 'error', code: 'generation_failed', retryable: true });
  });
});

describe('Ask threads in the tour store', () => {
  it('keeps threads beside the tour across restarts and clears them with the tour or a replacing review', async () => {
    const store = await stored();
    const anchor = findingAnchor(finding, change);
    const turn = { id: 'turn_one', question: 'Why?', askedAt: new Date().toISOString(), answer: 'Because.' };
    expect(await store.saveAskTurn('cora', 'feature/one', tour.fingerprint, { id: finding.id, target: 'reviewer', kind: 'claude', conversation, anchor }, turn)).toBe(true);
    // a turn on another conversation than the review's is refused
    expect(await store.saveAskTurn('cora', 'feature/one', tour.fingerprint, { id: 'other', target: 'reviewer', kind: 'claude', conversation: '7f1c2a90-1111-4222-8333-444455556666', anchor }, turn)).toBe(false);
    const file = (store as unknown as { asks: { file: string } }).asks.file;
    const restarted = new ReviewTourStore(join(file, '..', 'reviews.json'));
    expect(await restarted.askThreads('cora', 'feature/one', tour.fingerprint)).toHaveLength(1);
    expect(await restarted.askThreads('cora', 'feature/one', 'fingerprint-other-12345')).toEqual([]);
    // a replacing review, on its own conversation, takes the old reviewer's threads with it
    await restarted.saveCodeReviewIfCurrent('cora', 'feature/one', codeReview({ conversation: '7f1c2a90-1111-4222-8333-444455556666' }), restarted.beginCodeReview('cora'));
    expect(await restarted.askThreads('cora', 'feature/one', tour.fingerprint)).toEqual([]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ cora: expect.objectContaining({ threads: [] }) });
    await restarted.saveAskTurn('cora', 'feature/one', tour.fingerprint, { id: finding.id, target: 'reviewer', kind: 'claude', conversation: '7f1c2a90-1111-4222-8333-444455556666', anchor }, turn);
    await restarted.dismiss('cora');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({});
  });
});
