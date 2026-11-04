import { describe, expect, it } from 'vitest';
import { classifyReviewPath } from '../src/git/change-classification.js';
import { earlierThreadsSnapshot, MAX_EARLIER_CHARACTERS, parseGeneratedReviewTour, parseReviewRequestId, parseReviewTour, ReviewTourError, parseReviewTourInput, prohibitedNarration, type ReviewComparison, type ReviewTour } from '../src/review-tour/contracts.js';
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

  it('loads a Since my review tour with its reviewed commit, base branch, base tree and earlier threads, and no other tour with them', () => {
    const tour = { title: 'Since my review', overview: 'Walk through the fixes.', steps: [{ id: 'fixes', title: 'The fixes', explanation: 'It answers the review.', changeIds: [implementationChange.id] }], base: 'aaaaaaa (rebased)', includeTests: false, includeDocs: false, fingerprint: 'fingerprint-1234567890', changes: [implementationChange] };
    const [reviewedCommit, baseTree, baseBranch] = ['a'.repeat(40), 'b'.repeat(40), 'main'];
    const earlierThreads = { pullRequest: 7, threads: [] };
    expect(parseReviewTourInput({ scope: 'since-review', reviewedCommit, baseBranch, includeTests: false, includeDocs: false })).toEqual({ scope: 'since-review', reviewedCommit, baseBranch, includeTests: false, includeDocs: false });
    expect(parseReviewTourInput({ scope: 'since-review', reviewedCommit, includeTests: false, includeDocs: false })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'since-review', baseBranch, includeTests: false, includeDocs: false })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'since-review', reviewedCommit, baseBranch, baseTree, includeTests: false, includeDocs: false })).toBeUndefined();
    expect(parseReviewTourInput({ scope: 'pr', baseBranch, includeTests: false, includeDocs: false })).toBeUndefined();
    const since = { ...tour, scope: 'since-review', reviewedCommit, baseBranch, baseTree, earlierThreads };
    expect(parseReviewTour(since)).toEqual(since);
    expect(parseReviewTour({ ...since, fallback: true })).toEqual({ ...since, fallback: true });
    for (const missing of ['baseBranch', 'baseTree', 'earlierThreads']) expect(parseReviewTour({ ...since, [missing]: undefined })).toBeUndefined();
    expect(parseReviewTour({ ...tour, scope: 'pr', baseTree })).toBeUndefined();
    expect(parseReviewTour({ ...tour, scope: 'pr', fallback: true })).toBeUndefined();
    expect(parseReviewTour({ ...tour, scope: 'pr', earlierThreads })).toBeUndefined();
  });

  it('loads a Since my review tour\'s snapshot of my earlier threads, held to GitHub node ids', () => {
    const tour = { title: 'Since my review', overview: 'Walk through the fixes.', steps: [{ id: 'fixes', title: 'The fixes', explanation: 'It answers the review.', changeIds: [implementationChange.id] }], base: 'aaaaaaa (rebased)', includeTests: false, includeDocs: false, fingerprint: 'fingerprint-1234567890', changes: [implementationChange] };
    const comment = { id: 'C1', author: 'octocat', bot: false, mine: true, editedBy: 'mona', body: 'Back off first', createdAt: '2026-10-01T00:00:00Z', url: 'https://github.com/octo/repo/pull/7#discussion_r1' };
    const earlierThreads = { pullRequest: 7, partial: true, threads: [{ id: 'T1', path: 'src/feature.ts', line: 3, startLine: 1, resolved: true, resolvedBy: { login: 'mona' }, outdated: false, diffHunk: '@@ -1 +1 @@', comments: [comment] }] };
    const since = { ...tour, scope: 'since-review', reviewedCommit: 'a'.repeat(40), baseBranch: 'main', baseTree: 'b'.repeat(40) };
    expect(parseReviewTour({ ...since, earlierThreads })).toEqual({ ...since, earlierThreads });
    expect(parseReviewTour({ ...since, earlierThreads: { ...earlierThreads, threads: [{ ...earlierThreads.threads[0], comments: [] }] } })).toBeUndefined();
    expect(parseReviewTour({ ...since, earlierThreads: { ...earlierThreads, threads: [{ ...earlierThreads.threads[0], id: 'T1 -->' }] } })).toBeUndefined();
    expect(parseReviewTour({ ...since, earlierThreads: { ...earlierThreads, threads: [{ ...earlierThreads.threads[0], comments: [{ ...comment, id: 'C 1' }] }] } })).toBeUndefined();
  });

  it('keeps a snapshot within its total budget, dropping my unsent replies, then the oldest replies, then the oldest threads', () => {
    const comment = (id: string, minute: number, extra: object = {}) => ({ id, author: 'mona', bot: false, body: `${id} ${'x'.repeat(3_990)}`, createdAt: `2026-10-01T00:${String(minute).padStart(2, '0')}:00Z`, url: `https://github.com/octo/repo/pull/7#discussion_${id}`, ...extra });
    const thread = (index: number, comments: ReturnType<typeof comment>[]) => ({ id: `T${index}`, path: 'src/feature.ts', line: 3, resolved: false, outdated: false, diffHunk: '@@ -1 +1 @@', comments });
    // a reply still in my Draft review never enters the snapshot
    expect(earlierThreadsSnapshot([thread(0, [comment('C0', 0, { mine: true }), comment('C1', 1, { mine: true, pending: true })])])[0]!.comments.map(entry => entry.id)).toEqual(['C0']);
    // 60 threads of an opener and five replies is about 1.4M characters
    const threads = Array.from({ length: 60 }, (_, index) => thread(index, [comment(`O${index}`, 0, { mine: true }), ...Array.from({ length: 5 }, (_, reply) => comment(`R${index}-${reply}`, (index + reply * 7) % 60))]));
    const kept = earlierThreadsSnapshot(threads);
    const size = kept.reduce((total, entry) => total + entry.diffHunk.length + entry.comments.reduce((sum, item) => sum + item.body.length, 0), 0);
    expect(size).toBeLessThanOrEqual(MAX_EARLIER_CHARACTERS);
    // every reply went before any thread did, and the newest threads stay
    expect(kept.every(entry => entry.comments.length === 1)).toBe(true);
    expect(kept.at(-1)!.id).toBe('T59');
    expect(kept.length).toBeLessThan(60);
    // within budget, the oldest replies go first
    const few = earlierThreadsSnapshot(threads.slice(0, 9));
    const replies = few.flatMap(entry => entry.comments.slice(1));
    const dropped = threads.slice(0, 9).flatMap(entry => entry.comments.slice(1)).filter(entry => !replies.some(kept => kept.id === entry.id));
    expect(dropped.length).toBeGreaterThan(0);
    expect(Math.max(...dropped.map(entry => Date.parse(entry.createdAt)))).toBeLessThanOrEqual(Math.min(...replies.map(entry => Date.parse(entry.createdAt))));
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
  const input = { scope: 'since-review' as const, reviewedCommit: 'a'.repeat(40), baseBranch: 'main', includeTests: false, includeDocs: false };
  // a prepared Since my review Comparison ending at `head`
  const preparedSince = (head: string): PreparedReviewTour => {
    const { comparison, resolved } = prepared();
    return { resolved, comparison: { ...comparison, scope: 'since-review', reviewedCommit: input.reviewedCommit, baseBranch: 'main', baseTree: 'b'.repeat(40), head } };
  };

  it('refuses before capturing when the Pull request check refuses', async () => {
    let prepared = 0;
    const service = { startSinceReview: async () => { throw new ReviewTourError('head_behind_pull_request', true); }, prepare: async () => { prepared += 1; return prepared; } } as unknown as ReviewTourService;
    const jobs = new ReviewTourJobs(service);
    try {
      await expect(jobs.start('owner-a', 'cora', input)).rejects.toMatchObject({ code: 'head_behind_pull_request' });
      expect(prepared).toBe(0);
    } finally { jobs.close(); }
  });

  it('prepares the tour with the thread snapshot the start took, on the head the start checked', async () => {
    const earlierThreads = { pullRequest: 7, threads: [] };
    const handed: unknown[] = [];
    const started: unknown[] = [];
    const service = { startSinceReview: async (_worktreeId: string, scope: unknown) => { started.push(scope); return { earlierThreads, head: 'c'.repeat(40) }; }, prepare: async (_worktreeId: string, _input: unknown, snapshot: unknown) => { handed.push(snapshot); return preparedSince('c'.repeat(40)); }, generate: async () => await new Promise<ReviewTour>(() => {}) } as unknown as ReviewTourService;
    const jobs = new ReviewTourJobs(service);
    try {
      await jobs.start('owner-a', 'cora', input);
      expect(started).toEqual([{ reviewedCommit: input.reviewedCommit, baseBranch: 'main' }]);
      expect(handed).toEqual([earlierThreads]);
    } finally { jobs.close(); }
  });

  it('refuses a start whose HEAD moved off the pull request\'s head while it captured', async () => {
    const service = { startSinceReview: async () => ({ earlierThreads: { pullRequest: 7, threads: [] }, head: 'c'.repeat(40) }), prepare: async () => preparedSince('d'.repeat(40)), generate: async () => await new Promise<ReviewTour>(() => {}) } as unknown as ReviewTourService;
    const jobs = new ReviewTourJobs(service);
    try {
      await expect(jobs.start('owner-a', 'cora', input)).rejects.toMatchObject({ code: 'stale_during_generation' });
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
