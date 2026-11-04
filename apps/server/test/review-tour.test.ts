import { describe, expect, it } from 'vitest';
import { classifyReviewPath } from '../src/git/change-classification.js';
import { parseGeneratedReviewTour, parseReviewRequestId, parseReviewTour, ReviewTourError, parseReviewTourInput, prohibitedNarration, type ReviewComparison, type ReviewTour } from '../src/review-tour/contracts.js';
import { ReviewTourJobs } from '../src/review-tour/jobs.js';
import { ReviewTourService, type PreparedReviewTour } from '../src/review-tour/service.js';
import type { ReviewTourGenerator } from '../src/review-tour/generator.js';

const implementationChange = { id: 'chg_12345678', file: 'src/feature.ts', category: 'implementation' as const, kind: 'hunk' as const, patch: '@@ -1 +1 @@\n-old\n+new' };

// build one stable prepared Comparison
function prepared(worktreeId = 'cora'): PreparedReviewTour {
  const comparison: ReviewComparison = { worktreeId, workspace: `/worktrees/${worktreeId}`, branch: 'feature/review-tour', scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: `fingerprint-${worktreeId}`, changes: [implementationChange] };
  return { comparison, resolved: { workspace: comparison.workspace, branch: comparison.branch, worktree: { id: worktreeId, label: worktreeId, path: comparison.workspace, identity: comparison.workspace, available: true, pinned: false } } };
}

// complete a deferred operation
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('review change classification', () => {
  it('classifies implementation, tests, and documentation with documentation precedence', () => {
    expect(classifyReviewPath('src/auth/service.ts')).toBe('implementation');
    expect(classifyReviewPath('src/auth/service.test.ts')).toBe('test');
    expect(classifyReviewPath('e2e/login.spec.ts')).toBe('test');
    expect(classifyReviewPath('README.md')).toBe('doc');
    expect(classifyReviewPath('docs/example.test.md')).toBe('doc');
  });
});

describe('review tour contracts', () => {
  it('requires the exact request shape', () => {
    expect(parseReviewTourInput({ scope: 'working', includeTests: false, includeDocs: true })).toEqual({ scope: 'working', includeTests: false, includeDocs: true });
    expect(parseReviewTourInput({ scope: 'working', includeTests: false, includeDocs: true, unexpected: true })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'branch', includeTests: false, includeDocs: false })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'pr', includeTests: true, includeDocs: false, effort: 'high' })).toEqual({ scope: 'pr', includeTests: true, includeDocs: false, effort: 'high' });
    expect(parseReviewTourInput({ scope: 'pr', includeTests: true, includeDocs: false, effort: 3 })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'pr', includeTests: true, includeDocs: false, effort: 'x'.repeat(21) })).toBeUndefined();
    const sha = 'a'.repeat(40);
    expect(parseReviewTourInput({ scope: 'commit', commit: sha, includeTests: false, includeDocs: false })).toEqual({ scope: 'commit', commit: sha, includeTests: false, includeDocs: false });
    expect(parseReviewTourInput({ scope: 'commit', includeTests: false, includeDocs: false })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'commit', commit: 'HEAD~1', includeTests: false, includeDocs: false })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'pr', commit: sha, includeTests: false, includeDocs: false })).toBeUndefined();
    expect(parseReviewRequestId('review-start_1234567890')).toBe('review-start_1234567890');
    expect(parseReviewRequestId('short')).toBeUndefined();
  });

  it('accepts complete one-time change assignments and rejects finding-shaped narration', () => {
    const valid = { title: 'Authentication flow', overview: 'Walk through the request path.', steps: [{ id: 'authentication', title: 'Wire the request', explanation: 'The handler delegates to the service.', changeIds: [implementationChange.id] }] };
    expect(parseGeneratedReviewTour(valid, [implementationChange])).toEqual(valid);
    expect(prohibitedNarration('Ｆｉｎｄｉｎｇ: unsafe branch')).toBe(true);
    expect(parseGeneratedReviewTour({ ...valid, title: 'Finding: unsafe branch' }, [implementationChange])).toBeUndefined();
    expect(parseGeneratedReviewTour({ ...valid, steps: [{ ...valid.steps[0], changeIds: ['chg_unknown0'] }] }, [implementationChange])).toBeUndefined();
  });

  it('keeps a stored tour\'s guide only on a conversation its agent can resume', () => {
    const tour: ReviewTour = { title: 'Authentication flow', overview: 'Walk through the request path.', steps: [{ id: 'authentication', title: 'Wire the request', explanation: 'The handler delegates to the service.', changeIds: [implementationChange.id] }], scope: 'working', base: 'HEAD', includeTests: false, includeDocs: false, fingerprint: 'fingerprint-1234567890', changes: [implementationChange] };
    const guide = { agent: 'claude' as const, conversation: '6f1c2a90-1111-4222-8333-444455556666', model: 'opus', effort: 'high' };
    expect(parseReviewTour({ ...tour, guide })).toEqual({ ...tour, guide });
    expect(parseReviewTour(tour)).toEqual(tour);
    expect(parseReviewTour({ ...tour, guide: { ...guide, conversation: 'not a uuid' } })).toBeUndefined();
    expect(parseReviewTour({ ...tour, guide: { ...guide, extra: true } })).toBeUndefined();
    // a model is one argv value, so a stored one never starts like a flag
    expect(parseReviewTour({ ...tour, guide: { ...guide, model: '--dangerously-skip-permissions' } })).toBeUndefined();
    // OpenRouter's rolling ids start with `~`
    expect(parseReviewTour({ ...tour, guide: { ...guide, model: 'openrouter/~anthropic/claude-opus-latest' } })?.guide?.model).toBe('openrouter/~anthropic/claude-opus-latest');
  });

  it('loads a stored tour with exactly its scope\'s pinned data', () => {
    const tour = { title: 'One commit', overview: 'Walk through one commit.', steps: [{ id: 'commit', title: 'The commit', explanation: 'It changes the feature.', changeIds: [implementationChange.id] }], base: 'aaaaaaa^', includeTests: false, includeDocs: false, fingerprint: 'fingerprint-1234567890', changes: [implementationChange] };
    const commit = 'a'.repeat(40);
    expect(parseReviewTour({ ...tour, scope: 'commit', commit })).toEqual({ ...tour, scope: 'commit', commit });
    expect(parseReviewTour({ ...tour, scope: 'commit' })).toBeUndefined();
    expect(parseReviewTour({ ...tour, scope: 'working', commit })).toBeUndefined();
  });

  it('loads a Since my review tour with its reviewed commit and base tree, and no other tour with a base tree', () => {
    const tour = { title: 'Since my review', overview: 'Walk through the fixes.', steps: [{ id: 'fixes', title: 'The fixes', explanation: 'It answers the review.', changeIds: [implementationChange.id] }], base: 'aaaaaaa (rebased)', includeTests: false, includeDocs: false, fingerprint: 'fingerprint-1234567890', changes: [implementationChange] };
    const [reviewedCommit, baseTree] = ['a'.repeat(40), 'b'.repeat(40)];
    expect(parseReviewTourInput({ scope: 'since-review', reviewedCommit, includeTests: false, includeDocs: false })).toEqual({ scope: 'since-review', reviewedCommit, includeTests: false, includeDocs: false });
    expect(parseReviewTourInput({ scope: 'since-review', includeTests: false, includeDocs: false })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'since-review', reviewedCommit, baseTree, includeTests: false, includeDocs: false })).toBeUndefined();
    expect(parseReviewTour({ ...tour, scope: 'since-review', reviewedCommit, baseTree })).toEqual({ ...tour, scope: 'since-review', reviewedCommit, baseTree });
    expect(parseReviewTour({ ...tour, scope: 'since-review', reviewedCommit, baseTree, fallback: true })).toEqual({ ...tour, scope: 'since-review', reviewedCommit, baseTree, fallback: true });
    expect(parseReviewTour({ ...tour, scope: 'since-review', reviewedCommit })).toBeUndefined();
    expect(parseReviewTour({ ...tour, scope: 'pr', baseTree })).toBeUndefined();
    expect(parseReviewTour({ ...tour, scope: 'pr', fallback: true })).toBeUndefined();
  });
});

describe('review tour jobs', () => {
  it('hides jobs across owners and publishes successful generation', async () => {
    const result = deferred<ReviewTour>();
    const service = { prepare: async () => prepared(), generate: async () => await result.promise } as unknown as ReviewTourService;
    const saved: Array<{ worktreeId: string; branch: string; tour: ReviewTour }> = [];
    const completed: string[] = [];
    const store = { save: async (worktreeId: string, branch: string, tour: ReviewTour) => { saved.push({ worktreeId, branch, tour }); return { worktreeId, branch, savedAt: new Date().toISOString(), tour }; } };
    const jobs = new ReviewTourJobs(service, store as never, review => { completed.push(`${review.worktreeId}:${review.tour.title}`); });
    try {
      const started = await jobs.start('owner-a', 'cora', { scope: 'working', includeTests: false, includeDocs: false });
      expect(started.kind).toBe('pending');
      // require a pending job id
      if (started.kind !== 'pending') throw new Error('expected pending job');
      expect(jobs.get('owner-b', started.job.id)).toBeUndefined();
      result.resolve({ title: 'Tour', overview: 'Overview', steps: [{ id: 'step', title: 'Step', explanation: 'Explanation', changeIds: [implementationChange.id] }], ...prepared().comparison });
      await viWait();
      expect(jobs.get('owner-a', started.job.id)?.state.kind).toBe('ready');
      expect(saved).toMatchObject([{ worktreeId: 'cora', branch: 'feature/review-tour' }]);
      expect(completed).toEqual(['cora:Tour']);
    } finally { jobs.close(); }
  });

  it('replays one idempotent start without superseding its job', async () => {
    let prepares = 0;
    let generations = 0;
    const service = {
      prepare: async () => { prepares += 1; return prepared(); },
      generate: async () => { generations += 1; return await new Promise<ReviewTour>(() => {}); }
    } as unknown as ReviewTourService;
    const jobs = new ReviewTourJobs(service);
    try {
      const input = { scope: 'working' as const, includeTests: false, includeDocs: false };
      const first = await jobs.start('owner-a', 'cora', input, 'review-start_1234567890');
      const replay = await jobs.start('owner-a', 'cora', input, 'review-start_1234567890');
      expect(replay).toEqual(first);
      expect(prepares).toBe(1);
      expect(generations).toBe(1);
      await expect(jobs.start('owner-a', 'cora', { ...input, includeTests: true }, 'review-start_1234567890')).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
      await expect(jobs.start('owner-a', 'cora', { ...input, effort: 'high' }, 'review-start_1234567890')).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    } finally { jobs.close(); }
  });

  it('supersedes the previous worktree job and aborts its generation', async () => {
    const signals: AbortSignal[] = [];
    const service = {
      prepare: async () => prepared(),
      generate: async (_prepared: PreparedReviewTour, signal: AbortSignal) => {
        signals.push(signal);
        return await new Promise<ReviewTour>(() => {});
      }
    } as unknown as ReviewTourService;
    const jobs = new ReviewTourJobs(service);
    try {
      const first = await jobs.start('owner-a', 'cora', { scope: 'working', includeTests: false, includeDocs: false });
      const second = await jobs.start('owner-a', 'cora', { scope: 'working', includeTests: true, includeDocs: false });
      // require pending job descriptors
      if (first.kind !== 'pending' || second.kind !== 'pending') throw new Error('expected pending jobs');
      expect(jobs.get('owner-a', first.job.id)?.state).toEqual({ kind: 'gone', code: 'job_superseded' });
      expect(signals[0]?.aborted).toBe(true);
      expect(jobs.cancel('owner-b', second.job.id)).toBe(false);
      expect(jobs.cancel('owner-a', second.job.id)).toBe(true);
      expect(signals[1]?.aborted).toBe(true);
    } finally { jobs.close(); }
  });

  it('keeps another owner job independent on the same worktree', async () => {
    const service = { prepare: async () => prepared(), generate: async () => await new Promise<ReviewTour>(() => {}) } as unknown as ReviewTourService;
    const jobs = new ReviewTourJobs(service);
    try {
      const first = await jobs.start('owner-a', 'cora', { scope: 'working', includeTests: false, includeDocs: false });
      const second = await jobs.start('owner-b', 'cora', { scope: 'working', includeTests: false, includeDocs: false });
      // require pending job descriptors
      if (first.kind !== 'pending' || second.kind !== 'pending') throw new Error('expected pending jobs');
      expect(jobs.get('owner-a', first.job.id)?.state.kind).toBe('pending');
      expect(jobs.get('owner-b', second.job.id)?.state.kind).toBe('pending');
    } finally { jobs.close(); }
  });
});

describe('a Since my review start', () => {
  it('refuses before capturing when the Pull request check refuses', async () => {
    let prepared = 0;
    const service = { startSinceReview: async () => { throw new ReviewTourError('head_behind_pull_request', true); }, prepare: async () => { prepared += 1; return prepared; } } as unknown as ReviewTourService;
    const jobs = new ReviewTourJobs(service);
    try {
      await expect(jobs.start('owner-a', 'cora', { scope: 'since-review', reviewedCommit: 'a'.repeat(40), includeTests: false, includeDocs: false })).rejects.toMatchObject({ code: 'head_behind_pull_request' });
      expect(prepared).toBe(0);
    } finally { jobs.close(); }
  });
});

describe('review tour effort', () => {
  // a generator for the Codex tour agent that records the effort of each run, then fails it
  const generator = (efforts: Array<string | undefined>): ReviewTourGenerator => ({
    capability: async () => ({ available: true, agent: 'codex', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] }),
    generate: async (_comparison, _signal, effort) => { efforts.push(effort); throw new ReviewTourError('generation_failed', true); }
  });

  it('refuses an effort the tour agent does not accept before touching the Worktree', async () => {
    let targets = 0;
    const discovery = { worktreesNow: () => { targets += 1; return []; } };
    const service = new ReviewTourService(discovery as never, generator([]), {} as never);
    await expect(service.prepare('cora', { scope: 'working', includeTests: false, includeDocs: false, effort: 'max' })).rejects.toMatchObject({ code: 'invalid_request', retryable: false });
    expect(targets).toBe(0);
    await expect(service.prepare('cora', { scope: 'working', includeTests: false, includeDocs: false, effort: 'minimal' })).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(targets).toBe(1);
  });

  it('runs a prepared tour at its requested effort', async () => {
    const efforts: Array<string | undefined> = [];
    const service = new ReviewTourService({} as never, generator(efforts), {} as never);
    await expect(service.generate({ ...prepared(), effort: 'minimal' }, new AbortController().signal)).rejects.toMatchObject({ code: 'generation_failed' });
    await expect(service.generate(prepared(), new AbortController().signal)).rejects.toMatchObject({ code: 'generation_failed' });
    expect(efforts).toEqual(['minimal', undefined]);
  });
});

// yield pending promise continuations
async function viWait(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}
