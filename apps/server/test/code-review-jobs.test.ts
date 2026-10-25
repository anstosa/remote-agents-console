import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeReviewJobs, type SettledCodeReviewJob } from '../src/code-review/jobs.js';
import { CodeReviewer } from '../src/code-review/reviewer.js';
import type { ReviewPreset } from '../src/review-runs/config.js';
import { ReviewRunError, type ReviewRunner, type ReviewRunRequest } from '../src/review-runs/runner.js';
import type { ReviewComparison, ReviewTour } from '../src/review-tour/contracts.js';
import { ReviewTourJobs } from '../src/review-tour/jobs.js';
import type { PreparedReviewTour, ReviewTourService } from '../src/review-tour/service.js';
import { ReviewTourStore } from '../src/review-tour/store.js';

const directories: string[] = [];
const change = { id: 'chg_route0001', file: 'src/route.ts', category: 'implementation' as const, kind: 'hunk' as const, oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, patch: '@@ -1 +1,2 @@\n-old\n+new\n+more' };
const preset: ReviewPreset = { id: 'correctness', label: 'Correctness', agent: 'codex', effort: 'high', prompt: 'Review for correctness.' };
const output = { findings: [{ changeId: change.id, side: 'additions', startLine: 2, endLine: 2, severity: 'medium', title: 'Unchecked value', body: 'The new line skips validation.' }], general: [{ severity: 'low', title: 'No test', body: 'Nothing covers it.', file: null }] };
const tourOf = (comparison: ReviewComparison): ReviewTour => ({ title: 'Route tour', overview: 'Follow the route.', steps: [{ id: 'route', title: 'Route', explanation: 'The route changes.', changeIds: [change.id] }], scope: comparison.scope, base: comparison.base, includeTests: comparison.includeTests, includeDocs: comparison.includeDocs, fingerprint: comparison.fingerprint, changes: comparison.changes });

// build one prepared Comparison on a branch
function prepared(fingerprint = 'fingerprint-1234567890'): PreparedReviewTour {
  const comparison: ReviewComparison = { agentId: 'agent-cora', worktreeId: 'cora', workspace: '/worktrees/cora', branch: 'feature/review', scope: 'pr', base: 'origin/main', includeTests: false, includeDocs: false, fingerprint, changes: [change] };
  return { comparison, resolved: {} as never };
}

// a runner whose runs wait for the test to settle them, recording each signal
function controlledRunner() {
  const runs: Array<{ request: ReviewRunRequest; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const runner: ReviewRunner = {
    capability: async () => ({ available: true }),
    // a test settles a run with its reply, as a run returns it with no conversation
    run: async (request, signal) => ({ value: await new Promise((resolve, reject) => { runs.push({ request, signal, resolve, reject }); }) }),
    closeWorktree: async () => {}
  };
  return { runner, runs };
}

// an isolated durable store
async function store(): Promise<{ store: ReviewTourStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'rac-code-review-jobs-'));
  directories.push(directory);
  return { store: new ReviewTourStore(join(directory, 'reviews.json')), directory };
}

// yield pending promise continuations and file writes
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('code review jobs', () => {
  it('publishes a ready review, persists it beside the tour and joins it once the tour is saved', async () => {
    const { runner, runs } = controlledRunner();
    const { store: reviewStore, directory } = await store();
    const settled: SettledCodeReviewJob[] = [];
    const jobs = new CodeReviewJobs(new CodeReviewer(runner, { presets: [preset], defaultPreset: preset.id }), reviewStore, job => { settled.push(job); });
    try {
      const generation = await reviewStore.invalidate('cora', 'feature/review');
      const started = await jobs.start('owner-a', 'agent-cora', prepared(), { preset: preset.id });
      expect(started.retryAfterMs).toBe(1_000);
      expect(Date.parse(started.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
      expect(jobs.get('owner-b', started.id)).toBeUndefined();
      expect(jobs.pending('owner-a', 'cora', 'fingerprint-1234567890')).toEqual(started);
      expect(jobs.status('cora', 'fingerprint-1234567890')).toBe('running');
      expect(runs[0]!.request).toMatchObject({ kind: 'codex', effort: 'high', label: '🔍 Review · Correctness' });
      runs[0]!.resolve(output);
      // wait for durable completion rather than elapsed wall time
      await expect.poll(() => jobs.get('owner-a', started.id)?.state.kind).toBe('ready');
      const job = jobs.get('owner-a', started.id);
      expect(job?.state).toMatchObject({ kind: 'ready', review: { fingerprint: 'fingerprint-1234567890', preset: { id: 'correctness' }, effort: 'high', findings: [{ startLine: 2 }], general: [{ title: 'No test' }] } });
      expect(settled).toMatchObject([{ worktreeId: 'cora', state: { kind: 'ready' } }]);
      expect(jobs.pending('owner-a', 'cora', 'fingerprint-1234567890')).toBeUndefined();
      // the tour finishes after the review and still joins it on read
      expect(await reviewStore.codeReview('cora', 'feature/review', 'fingerprint-1234567890')).toMatchObject({ findings: [{ title: 'Unchecked value' }] });
      await reviewStore.saveIfCurrent('cora', 'feature/review', tourOf(prepared().comparison), generation!);
      expect(await reviewStore.summaries([{ worktreeId: 'cora', branch: 'feature/review' }])).toEqual([expect.objectContaining({ codeReview: 'ready', findings: 2 })]);
      expect(await reviewStore.codeReview('cora', 'feature/review', 'other-fingerprint-123')).toBeUndefined();
      expect(await reviewStore.codeReview('cora', 'feature/other', 'fingerprint-1234567890')).toBeUndefined();
      // the tour file keeps its format; the review lives beside it and survives a restart
      expect(Object.keys(JSON.parse(await readFile(join(directory, 'reviews.json'), 'utf8')).cora)).toEqual(['worktreeId', 'branch', 'savedAt', 'tour']);
      const restarted = new ReviewTourStore(join(directory, 'reviews.json'));
      expect(await restarted.codeReview('cora', 'feature/review', 'fingerprint-1234567890')).toMatchObject({ preset: { label: 'Correctness' } });
      // dismissing the tour clears its review
      await restarted.dismiss('cora');
      expect(await restarted.codeReview('cora', 'feature/review', 'fingerprint-1234567890')).toBeUndefined();
    } finally { jobs.close(); }
  });

  it('records a typed failure and publishes it', async () => {
    const { runner, runs } = controlledRunner();
    const settled: SettledCodeReviewJob[] = [];
    const jobs = new CodeReviewJobs(new CodeReviewer(runner, { presets: [preset], defaultPreset: preset.id }), undefined, job => { settled.push(job); });
    try {
      const started = await jobs.start('owner-a', 'agent-cora', prepared(), { preset: preset.id, effort: 'low' });
      expect(runs[0]!.request.effort).toBe('low');
      runs[0]!.reject(new ReviewRunError('timed_out', true));
      // wait for the observable failure before checking its details
      await expect.poll(() => jobs.get('owner-a', started.id)?.state.kind).toBe('error');
      expect(jobs.get('owner-a', started.id)?.state).toEqual({ kind: 'error', code: 'timed_out', retryable: true });
      expect(jobs.status('cora', 'fingerprint-1234567890')).toBe('failed');
      expect(settled).toMatchObject([{ state: { kind: 'error', code: 'timed_out' } }]);
    } finally { jobs.close(); }
  });

  it('validates the preset and effort before starting', async () => {
    const { runner, runs } = controlledRunner();
    const jobs = new CodeReviewJobs(new CodeReviewer(runner, { presets: [preset], defaultPreset: preset.id }));
    try {
      await expect(jobs.start('owner-a', 'agent-cora', prepared(), { preset: 'missing' })).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(jobs.start('owner-a', 'agent-cora', prepared(), { preset: preset.id, effort: 'max' })).rejects.toMatchObject({ code: 'invalid_request' });
      expect(runs).toHaveLength(0);
    } finally { jobs.close(); }
  });

  it('cancels a run and replaces an earlier one for the same owner and Worktree', async () => {
    const { runner, runs } = controlledRunner();
    const { store: reviewStore } = await store();
    const jobs = new CodeReviewJobs(new CodeReviewer(runner, { presets: [preset], defaultPreset: preset.id }), reviewStore);
    try {
      const first = await jobs.start('owner-a', 'agent-cora', prepared(), { preset: preset.id });
      const second = await jobs.start('owner-a', 'agent-cora', prepared(), { preset: preset.id, focus: 'retries' });
      expect(jobs.get('owner-a', first.id)?.state).toEqual({ kind: 'gone', code: 'job_superseded' });
      expect(runs[0]!.signal.aborted).toBe(true);
      // a superseded run that still answers is never stored
      runs[0]!.resolve(output);
      expect(jobs.cancel('owner-b', second.id)).toBe(false);
      expect(jobs.cancel('owner-a', second.id)).toBe(true);
      expect(runs[1]!.signal.aborted).toBe(true);
      expect(jobs.get('owner-a', second.id)?.state).toEqual({ kind: 'gone', code: 'job_cancelled' });
      await settle();
      expect(await reviewStore.codeReview('cora', 'feature/review', 'fingerprint-1234567890')).toBeUndefined();
    } finally { jobs.close(); }
  });
});

describe('tour starts with a code review', () => {
  // a tour service whose generations never finish, counting prepares
  const tourService = (fingerprints: string[] = []) => {
    let prepares = 0;
    const service = { prepare: async () => { prepares += 1; return prepared(fingerprints[prepares - 1]); }, generate: async () => await new Promise<ReviewTour>(() => {}) } as unknown as ReviewTourService;
    return { service, prepares: () => prepares };
  };

  it('starts both from one Comparison, and a new tour supersedes the review and clears the stored one', async () => {
    const { runner, runs } = controlledRunner();
    const { store: reviewStore } = await store();
    const codeReviews = new CodeReviewJobs(new CodeReviewer(runner, { presets: [preset], defaultPreset: preset.id }), reviewStore);
    const tours = tourService();
    const jobs = new ReviewTourJobs(tours.service, reviewStore, undefined, codeReviews);
    try {
      const input = { scope: 'pr' as const, includeTests: false, includeDocs: false };
      const started = await jobs.start('owner-a', 'agent-cora', input, undefined, { preset: preset.id });
      // require a pending start with a review
      if (started.kind !== 'pending' || started.codeReview === undefined) throw new Error('expected a pending tour and review');
      expect(tours.prepares()).toBe(1);
      expect(runs[0]!.request.prompt).toContain(change.id);
      const reviewJob = started.codeReview.job.id;
      // a completed earlier review is cleared by the next tour too
      await reviewStore.saveCodeReviewIfCurrent('cora', 'feature/review', { fingerprint: 'fingerprint-1234567890', preset: { id: 'correctness', label: 'Correctness', agent: 'codex' }, findings: [], general: [], completedAt: new Date().toISOString() }, reviewStore.beginCodeReview('cora'));
      const again = await jobs.start('owner-a', 'agent-cora', input);
      expect(again).toMatchObject({ kind: 'pending' });
      expect(again).not.toHaveProperty('codeReview');
      expect(codeReviews.get('owner-a', reviewJob)?.state).toEqual({ kind: 'gone', code: 'job_superseded' });
      expect(runs[0]!.signal.aborted).toBe(true);
      expect(await reviewStore.codeReview('cora', 'feature/review', 'fingerprint-1234567890')).toBeUndefined();
    } finally { jobs.close(); codeReviews.close(); }
  });

  it('refuses an invalid review before preparing, and compares review options on idempotent replay', async () => {
    const { runner } = controlledRunner();
    const codeReviews = new CodeReviewJobs(new CodeReviewer(runner, { presets: [preset], defaultPreset: preset.id }));
    const tours = tourService();
    const jobs = new ReviewTourJobs(tours.service, undefined, undefined, codeReviews);
    try {
      const input = { scope: 'pr' as const, includeTests: false, includeDocs: false };
      await expect(jobs.start('owner-a', 'agent-cora', input, undefined, { preset: 'missing' })).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
      expect(tours.prepares()).toBe(0);
      const first = await jobs.start('owner-a', 'agent-cora', input, 'review-start_1234567890', { preset: preset.id, focus: 'cache' });
      expect(await jobs.start('owner-a', 'agent-cora', input, 'review-start_1234567890', { preset: preset.id, focus: 'cache' })).toEqual(first);
      await expect(jobs.start('owner-a', 'agent-cora', input, 'review-start_1234567890', { preset: preset.id })).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(jobs.start('owner-a', 'agent-cora', input, 'review-start_1234567890')).rejects.toMatchObject({ code: 'invalid_request' });
      expect(tours.prepares()).toBe(1);
    } finally { jobs.close(); codeReviews.close(); }
  });

  it('finishes a review a restart orphaned into its stored tour, unless the tour or a newer review replaced it', async () => {
    const { runner, runs } = controlledRunner();
    const { store: before, directory } = await store();
    const reviewer = new CodeReviewer(runner, { presets: [preset], defaultPreset: preset.id });
    const tour = prepared();
    await before.save('cora', 'feature/review', tourOf(tour.comparison));
    const running = new CodeReviewJobs(reviewer, before);
    await running.start('owner-a', 'agent-cora', tour, { preset: preset.id });
    await settle();
    // the recovery the run's request carried, as the runner's file hands it back after a restart
    const left = JSON.parse(JSON.stringify(runs[0]!.request.recovery)) as Record<string, unknown>;
    expect(left).toEqual({ kind: 'code-review', worktreeId: 'cora', branch: 'feature/review', fingerprint: tour.comparison.fingerprint, preset: { id: preset.id, label: preset.label, agent: preset.agent }, effort: 'high' });
    running.close();
    // each new process reads the same files
    const restarted = () => new ReviewTourStore(join(directory, 'reviews.json'));
    const after = restarted();
    const settled: SettledCodeReviewJob[] = [];
    const jobs = new CodeReviewJobs(reviewer, after, job => { settled.push(job); });
    await expect(jobs.recover({ ...left, fingerprint: 'fingerprint-of-a-newer-tour' }, 'agent-orphan')).resolves.toBeUndefined();
    await expect(jobs.recover({ ...left, branch: 'other' }, 'agent-orphan')).resolves.toBeUndefined();
    const recovery = await jobs.recover(left, 'agent-orphan');
    expect(recovery?.validate?.({ findings: 'none' })).toEqual(expect.any(String));
    const conversation = '6f1c2a90-1111-4222-8333-444455556666';
    await expect(recovery!.save(output, conversation)).resolves.toBe(true);
    // the orphan's review keeps the conversation the sweep read from its pane
    expect(await after.codeReview('cora', 'feature/review', tour.comparison.fingerprint)).toMatchObject({ preset: { id: preset.id }, effort: 'high', findings: [{ changeId: change.id, title: 'Unchecked value' }], general: [{ title: 'No test' }], conversation });
    expect(settled).toMatchObject([{ agentId: 'agent-orphan', worktreeId: 'cora', state: { kind: 'ready' } }]);
    // a review begun since the restart supersedes the orphan's
    const later = restarted();
    const recovering = await new CodeReviewJobs(reviewer, later).recover(left, 'agent-orphan');
    later.beginCodeReview('cora');
    await expect(recovering!.save(output)).resolves.toBe(false);
  });
});
