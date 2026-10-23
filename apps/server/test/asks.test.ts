import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guideAskPrompt, hunkExcerpt, parseAskRequest, reviewerAskPrompt, findingAnchor } from '../src/asks/contracts.js';
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
const ask = (question = 'Why is this a problem?') => ({ target: 'reviewer' as const, findingId: finding.id, question, fingerprint: tour.fingerprint });
const guideConversation = '9a8b7c6d-1111-4222-8333-444455556666';
const guided: ReviewTour = { ...tour, guide: { agent: 'claude', conversation: guideConversation, model: 'sonnet', effort: 'medium' } };
const lines = { changeId: change.id, side: 'additions' as const, startLine: 11, endLine: 12 };
const askGuide = (question = 'What does this do?', about: { lines: typeof lines } | { threadId: string } = { lines }) => ({ target: 'guide' as const, ...about, question, fingerprint: tour.fingerprint });

// a store holding the tour and its Code review
async function stored(review: CodeReview = codeReview(), storedTour: ReviewTour = guided): Promise<ReviewTourStore> {
  const directory = await mkdtemp(join(tmpdir(), 'rac-asks-'));
  directories.push(directory);
  const store = new ReviewTourStore(join(directory, 'reviews.json'));
  const generation = await store.invalidate('cora', 'feature/one');
  await store.saveIfCurrent('cora', 'feature/one', storedTour, generation!);
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
    expect(hunkExcerpt(change, { side: 'additions', startLine: 11, endLine: 12 })).toBe(' a\n-b\n+B\n+C\n c\n d');
    expect(hunkExcerpt(change, { side: 'deletions', startLine: 11, endLine: 11 })).toBe(' a\n-b\n+B\n+C\n c');
    expect(hunkExcerpt(change, { side: 'additions', startLine: 90, endLine: 91 })).toBe('');
  });

  it('excerpts a range from a removed line to an added one', () => {
    const long = { patch: '@@ -1,8 +1,8 @@\n 1\n 2\n 3\n 4\n-five\n+FIVE\n 6\n 7\n 8\n 9' };
    expect(hunkExcerpt(long, { startSide: 'deletions', startLine: 5, side: 'additions', endLine: 5 })).toBe(' 2\n 3\n 4\n-five\n+FIVE\n 6\n 7\n 8');
    expect(hunkExcerpt(long, { startSide: 'deletions', startLine: 40, side: 'additions', endLine: 5 })).toBe('');
  });

  it('parses a question to the reviewer or the guide, about new lines or an existing thread', () => {
    expect(parseAskRequest(askGuide())).toEqual(askGuide());
    expect(parseAskRequest(askGuide('Why?', { threadId: 'ask_thread' }))).toEqual(askGuide('Why?', { threadId: 'ask_thread' }));
    const crossing = { ...lines, startSide: 'deletions' as const };
    expect(parseAskRequest({ ...askGuide(), lines: crossing })).toEqual({ ...askGuide(), lines: crossing });
    expect(parseAskRequest({ ...askGuide(), threadId: 'ask_thread' })).toBeUndefined();
    expect(parseAskRequest({ ...askGuide(), lines: { ...lines, startLine: 0 } })).toBeUndefined();
    expect(parseAskRequest({ findingId: finding.id, question: 'Why?', fingerprint: tour.fingerprint })).toBeUndefined();
    expect(parseAskRequest({ ...ask(), target: 'guide' })).toBeUndefined();
  });

  it('asks the guide about its lines in prose, with the question last', () => {
    const anchor = { changeId: change.id, file: change.file, startSide: 'deletions' as const, side: 'additions' as const, startLine: 11, endLine: 12, excerpt: '-b\n+B\n+C' };
    const prompt = guideAskPrompt(anchor, 'What does this do?');
    expect(prompt).toContain('tour you narrated');
    expect(prompt).toContain('Markdown');
    expect(prompt).toContain('Location: src/route.ts, old line 11 to new line 12');
    expect(prompt).toContain('```diff\n-b\n+B\n+C\n```');
    expect(prompt.endsWith('Question: What does this do?')).toBe(true);
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
    expect(jobs.pending('owner', 'cora')).toEqual([{ threadId: finding.id, target: 'reviewer', anchor: findingAnchor(finding, change), question: 'Why is this a problem?', job: started.job }]);
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
    await jobs.supersedeWorktree('cora', 'tour');
    expect(turns[0]!.signal.aborted).toBe(true);
    expect(jobs.get('owner', started.job.id)?.state).toEqual({ kind: 'gone', code: 'job_superseded' });
    expect(closed).toEqual(['cora']);
    turns[0]!.answer({ value: 'Too late.' });
    await settled();
    expect(await store.askThreads('cora', 'feature/one', tour.fingerprint)).toEqual([]);
  });
});

describe('Ask jobs for the tour guide', () => {
  it('resumes the tour\'s own conversation about some lines, on a new thread that takes follow-ups', async () => {
    const store = await stored();
    const { runner, turns } = controlledRunner();
    const jobs = new AskJobs(runner, store, () => []);
    const started = await jobs.ask('owner', target, askGuide());
    expect(started.threadId).not.toBe(finding.id);
    expect(turns[0]!.request).toMatchObject({ kind: 'claude', worktreeId: 'cora', reply: { kind: 'text' }, resume: guideConversation, followUps: true, label: '💬 Ask · Tour guide', model: 'sonnet', effort: 'medium' });
    expect(turns[0]!.request.prompt).toContain('Location: src/route.ts, new lines 11-12');
    const anchor = { changeId: change.id, file: change.file, side: 'additions', startLine: 11, endLine: 12, excerpt: ' a\n-b\n+B\n+C\n c\n d' };
    expect(jobs.pending('owner', 'cora')).toEqual([{ threadId: started.threadId, target: 'guide', anchor, question: 'What does this do?', job: started.job }]);
    // another question about the same lines starts its own thread
    const other = await jobs.ask('owner', target, askGuide('And these?'));
    expect(other.threadId).not.toBe(started.threadId);
    turns[0]!.answer({ value: 'It **routes** the request.' });
    turns[1]!.answer({ value: 'They log it.' });
    await settled();
    const threads = await store.askThreads('cora', 'feature/one', tour.fingerprint);
    expect(threads.find(thread => thread.id === started.threadId)).toEqual({ id: started.threadId, target: 'guide', kind: 'claude', conversation: guideConversation, anchor, turns: [{ id: started.job.id, question: 'What does this do?', askedAt: started.job.startedAt, answer: 'It **routes** the request.' }] });
    // a follow-up names its thread and keeps its anchor
    const followUp = await jobs.ask('owner', target, askGuide('Why?', { threadId: started.threadId }));
    expect(followUp.threadId).toBe(started.threadId);
    await expect(jobs.ask('owner', target, askGuide('And?', { threadId: started.threadId }))).rejects.toMatchObject({ code: 'busy' });
    turns[2]!.answer({ value: 'Because.' });
    await settled();
    const [thread] = (await store.askThreads('cora', 'feature/one', tour.fingerprint)).filter(candidate => candidate.id === started.threadId);
    expect(thread!.turns.map(turn => turn.answer)).toEqual(['It **routes** the request.', 'Because.']);
  });

  it('refuses lines outside the tour\'s diffs, an unknown thread and a tour that kept no conversation', async () => {
    const { runner } = controlledRunner();
    const jobs = new AskJobs(runner, await stored(), () => []);
    await expect(jobs.ask('owner', target, askGuide('Why?', { lines: { ...lines, startLine: 90, endLine: 91 } }))).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(jobs.ask('owner', target, askGuide('Why?', { lines: { ...lines, changeId: 'chg_unknown01' } }))).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(jobs.ask('owner', target, askGuide('Why?', { threadId: 'ask_unknown' }))).rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(new AskJobs(runner, await stored(codeReview(), tour), () => []).ask('owner', target, askGuide())).rejects.toMatchObject({ code: 'conversation_unavailable' });
  });

  it('does not follow up a reviewer thread as the guide', async () => {
    const store = await stored();
    const { runner, turns } = controlledRunner();
    const jobs = new AskJobs(runner, store, () => []);
    await jobs.ask('owner', target, ask());
    turns[0]!.answer({ value: 'Because.' });
    await settled();
    expect(await store.askThreads('cora', 'feature/one', tour.fingerprint)).toHaveLength(1);
    await expect(jobs.ask('owner', target, askGuide('Why?', { threadId: finding.id }))).rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('bounds the questions waiting at once and the threads a tour can hold', async () => {
    const store = await stored();
    const { runner } = controlledRunner();
    const jobs = new AskJobs(runner, store, () => []);
    for (let index = 0; index < 10; index += 1) await jobs.ask('owner', target, askGuide(`Question ${index}?`));
    await expect(jobs.ask('owner', target, askGuide('One more?'))).rejects.toMatchObject({ code: 'busy' });
    // a full tour refuses a new thread before running it
    const full = await stored();
    const anchor = { changeId: change.id, file: change.file, side: 'additions' as const, startLine: 11, endLine: 11, excerpt: '+B' };
    for (let index = 0; index < 200; index += 1) await full.saveAskTurn('cora', 'feature/one', tour.fingerprint, { id: `ask_${index}`, target: 'guide', kind: 'claude', conversation: guideConversation, anchor }, { id: `turn_${index}`, question: 'Why?', askedAt: new Date().toISOString(), answer: 'Because.' });
    const fullRunner = controlledRunner();
    await expect(new AskJobs(fullRunner.runner, full, () => []).ask('owner', target, askGuide())).rejects.toMatchObject({ code: 'too_large' });
    expect(fullRunner.turns).toHaveLength(0);
  });

  it('keeps the guide\'s threads, questions and kept Agent through a replacing Code review', async () => {
    const store = await stored();
    const { runner, turns, closed } = controlledRunner();
    const jobs = new AskJobs(runner, store, () => []);
    const answered = await jobs.ask('owner', target, askGuide());
    turns[0]!.answer({ value: 'Stored first.' });
    await settled();
    const toGuide = await jobs.ask('owner', target, askGuide('Why?', { threadId: answered.threadId }));
    const toReviewer = await jobs.ask('owner', target, ask());
    await jobs.supersedeWorktree('cora', 'reviewer');
    expect(jobs.get('owner', toReviewer.job.id)?.state).toEqual({ kind: 'gone', code: 'job_superseded' });
    expect(jobs.get('owner', toGuide.job.id)?.state.kind).toBe('pending');
    expect(closed).toEqual([]);
    // the stored guide thread survives the new review landing
    await store.saveCodeReviewIfCurrent('cora', 'feature/one', codeReview({ conversation: '7f1c2a90-1111-4222-8333-444455556666' }), store.beginCodeReview('cora'));
    expect((await store.askThreads('cora', 'feature/one', tour.fingerprint)).map(thread => thread.target)).toEqual(['guide']);
    turns[1]!.answer({ value: 'Still here.' });
    await settled();
    expect((await store.askThreads('cora', 'feature/one', tour.fingerprint)).map(thread => [thread.target, thread.turns.map(turn => turn.answer)])).toEqual([['guide', ['Stored first.', 'Still here.']]]);
  });
});

describe('Ask jobs and the store', () => {
  it('reports a turn the store could not write as a failed job, not a superseded one', async () => {
    const store = await stored();
    const { runner, turns } = controlledRunner();
    const failing = { current: store.current.bind(store), codeReview: store.codeReview.bind(store), askThreads: store.askThreads.bind(store), saveAskTurn: async () => { throw new Error('ENOSPC'); } };
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

  it('keeps a guide thread only on the stored tour\'s own conversation', async () => {
    const store = await stored();
    const anchor = { changeId: change.id, file: change.file, side: 'additions' as const, startLine: 11, endLine: 12, excerpt: '+B' };
    const turn = { id: 'turn_one', question: 'Why?', askedAt: new Date().toISOString(), answer: 'Because.' };
    expect(await store.saveAskTurn('cora', 'feature/one', tour.fingerprint, { id: 'ask_one', target: 'guide', kind: 'claude', conversation, anchor }, turn)).toBe(false);
    expect(await store.saveAskTurn('cora', 'feature/one', tour.fingerprint, { id: 'ask_one', target: 'guide', kind: 'claude', conversation: guideConversation, anchor }, turn)).toBe(true);
    // a guide thread names no Finding, and a reviewer thread must
    expect(await store.saveAskTurn('cora', 'feature/one', tour.fingerprint, { id: 'ask_two', target: 'reviewer', kind: 'claude', conversation, anchor }, turn)).toBe(false);
    // the right conversation on another agent is not the guide's
    expect(await store.saveAskTurn('cora', 'feature/one', tour.fingerprint, { id: 'ask_three', target: 'guide', kind: 'codex', conversation: guideConversation, anchor }, turn)).toBe(false);
    // a new tour clears the threads of the one it replaces
    const generation = await store.invalidate('cora', 'feature/one');
    await store.saveIfCurrent('cora', 'feature/one', { ...guided, guide: { agent: 'claude', conversation: '8a8b7c6d-1111-4222-8333-444455556666' } }, generation!);
    expect(await store.askThreads('cora', 'feature/one', tour.fingerprint)).toEqual([]);
  });
});
