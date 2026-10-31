import type { Worktree } from '../domain/models.js';
import type { PullRequestComment } from '../domain/models.js';
import type { GithubRepository } from '../github/github.js';
import { redactIntegrationText } from '../integrations/text.js';
import { detailPageLimits, overviewPageLimits, type GithubProblem, type GithubQueue, type LocalMatches, type NetworkOutcome, type PullRequestSnapshot, type QueueReason, type QueueRow } from '../github/service.js';
import type {
  GithubCommentV1, GithubDestinationV1, GithubDiscussionEntryV1, GithubFreshnessV1, GithubListCoverageV1, GithubOverviewInputV1, GithubOverviewRowV1,
  GithubOverviewV1, GithubPullRequestInputV1, GithubPullRequestV1, GithubReasonV1, GithubTextV1
} from './contracts.js';

/**
 * What a principal may see of GitHub: the repositories of the configured Projects its Places admit
 * (keyed by lowercased `owner/name`), those Projects, and the Worktrees it admits. Everything else
 * GitHub holds is left out, never counted.
 */
export type GithubScope = { repositories: ReadonlyMap<string, { name: string; repository: GithubRepository }>; projects: ReadonlySet<string>; admitted: ReadonlySet<string> };

const defaultLimit = 20;
const defaultBodyChars = 1_500;
const defaultEntries = 20;
const defaultThreadComments = 5;
const defaultSections = ['summary', 'checks', 'reviewers'] as const;
// the most text one discussion page carries: entries past it go to the next page, though a page
// always holds at least one
const pageChars = 120_000;

/** What the Overview's reasons cannot show, so an empty list is never read as nothing to do. */
export const githubNotCovered = [
  'Replies on pull requests you already reviewed, unless they ask for your review again: a new or repeated review request is the signal to revisit them (intentional).',
  'General comments and review summaries on your pull requests.',
  'Replies on resolved or outdated review threads.',
  `Review threads beyond the newest ${overviewPageLimits.myThreads} on each of your pull requests.`,
  `Rows beyond the first page of each GitHub search (${overviewPageLimits.mine} of your pull requests, ${overviewPageLimits.reviews} review requests, ${overviewPageLimits.issues} assigned issues).`
];

// what each problem tells the Conductor; GitHub's own message stays on the server
const problemMessages = {
  'no-token': 'GitHub authentication is not configured on the console host.',
  'rate-limited': "GitHub's rate limit is holding requests back.",
  failing: 'GitHub could not be read; what is shown is from the last read that worked.'
} as const;

const iso = (at: number | undefined): string | null => at === undefined ? null : new Date(at).toISOString();

/** How old data is, as the module judges it, and what this call did about GitHub, never naming more than the problem's kind. */
export function githubFreshness({ fetchedAt, problem, network, stale, polling }: { fetchedAt?: number; problem?: GithubProblem; network: NetworkOutcome; stale: boolean; polling: boolean }, now: number): GithubFreshnessV1 {
  const kind = problem === undefined ? undefined : problem.kind === 'no-token' ? 'no_token' as const : problem.kind === 'rate-limited' ? 'rate_limited' as const : 'failing' as const;
  return {
    state: fetchedAt === undefined ? 'cold' : problem !== undefined ? 'failed' : stale ? 'stale' : 'fresh',
    fetchedAt: iso(fetchedAt),
    ageSeconds: fetchedAt === undefined ? null : Math.max(0, Math.floor((now - fetchedAt) / 1_000)),
    network: network === 'failed' && kind === 'rate_limited' ? 'rate_limited' : network === 'failed' && kind === 'no_token' ? 'no_token' : network,
    problem: problem === undefined ? null : { kind: kind!, message: problemMessages[problem.kind], retryAt: iso(problem.until) },
    backgroundPoll: polling ? 'browser' : 'none'
  };
}

/**
 * The places an item can go that the scope admits: every admitted Worktree holding it, else the main
 * worktree of the first admitted configured Project of its repository. Others are left out unannounced.
 */
export function githubDestinations(local: LocalMatches | undefined, scope: GithubScope): GithubDestinationV1[] {
  const held = (local?.holders ?? []).filter(worktree => scope.admitted.has(worktree.id)).map((worktree: Worktree): GithubDestinationV1 => ({
    kind: 'worktree', worktreeId: worktree.id, projectId: worktree.projectId, label: worktree.label, ...(worktree.branch === undefined ? {} : { branch: worktree.branch })
  }));
  if (held.length > 0) return held;
  const main = (local?.mains ?? []).find(({ project, worktree }) => worktree !== undefined && scope.projects.has(project.id) && scope.admitted.has(worktree.id));
  return main === undefined ? [] : [{ kind: 'project', worktreeId: main.worktree!.id, projectId: main.project.id, label: main.project.label }];
}

function reason(found: QueueReason): GithubReasonV1 {
  switch (found.kind) {
    case 'thread': return { kind: 'thread', threadId: found.id, path: found.path, lastAuthor: found.author, new: found.new };
    case 'changes': return { kind: 'changes', reviewId: found.id, reviewer: found.author, new: found.new };
    case 'review': return { kind: 'review', reRequested: found.reRequested === true, new: found.new };
    default: return { kind: found.kind, new: found.new };
  }
}

function overviewRow(row: QueueRow, list: 'mine' | 'reviews' | 'issues', scope: GithubScope): GithubOverviewRowV1 {
  const base: GithubOverviewRowV1 = {
    repository: row.repository, number: row.number, title: row.title, url: row.url,
    ...(row.author === undefined ? {} : { author: row.author }), ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
    draft: row.draft === true, labels: row.labels ?? [], waitingOnMe: row.reasons.map(reason), destinations: githubDestinations(row.local, scope)
  };
  if (list === 'issues') return { ...base, linkedPullRequests: row.linkedPullRequests ?? [] };
  const pull = row.pull;
  return {
    ...base,
    ...(pull?.headSha === undefined ? {} : { headSha: pull.headSha }), ...(pull === undefined ? {} : { mergeable: pull.mergeable, checks: pull.checks }),
    ...(row.approved === true ? { approved: true as const } : {}),
    // only the Issues in the pull request's own repository, which the scope admits with it
    ...(pull?.closesHere === undefined || pull.closesHere.length === 0 ? {} : { closes: pull.closesHere }),
    ...(list === 'reviews' ? { request: { direct: pull?.direct === true, reRequested: row.reasons.some(found => found.kind === 'review' && found.reRequested === true) } } : {}),
    ...(pull?.myReview === undefined ? {} : { myLatestReview: pull.myReview }),
    ...(row.newCommits === true ? { newCommitsSinceMyReview: true as const } : {})
  };
}

/** The Overview held to the scope, filtered and bounded as asked; lists never read are null, not empty. */
export function githubOverview(queue: GithubQueue, scope: GithubScope, input: GithubOverviewInputV1, now: number): GithubOverviewV1 {
  const limit = input.limit ?? defaultLimit;
  const only = input.repository?.toLowerCase();
  const lists: Partial<Record<'mine' | 'reviews' | 'issues', GithubListCoverageV1>> = {};
  const result: GithubOverviewV1 = {
    freshness: githubFreshness(queue, now),
    coverage: { viewer: queue.viewer ?? null, repositories: [...scope.repositories.values()].map(({ name }) => name).sort(), lists, notCovered: githubNotCovered }
  };
  for (const list of input.lists ?? ['mine', 'reviews', 'issues'] as const) {
    const rows = queue[list];
    if (rows === undefined) {
      result[list] = null;
      lists[list] = { returned: 0, inScope: 0, complete: null, pageLimit: overviewPageLimits[list], truncatedByRequest: false };
      continue;
    }
    const inScope = rows.filter(row => scope.repositories.has(row.repository.toLowerCase()));
    const chosen = inScope.filter(row => (only === undefined || row.repository.toLowerCase() === only) && (input.waitingOnly !== true || row.reasons.length > 0));
    const total = queue.totals?.[list];
    result[list] = chosen.slice(0, limit).map(row => overviewRow(row, list, scope));
    // whether GitHub's search gave every row across all repositories, so none in scope is missing
    lists[list] = { returned: Math.min(chosen.length, limit), inScope: inScope.length, complete: total === undefined ? null : rows.length >= total, pageLimit: overviewPageLimits[list], truncatedByRequest: chosen.length > limit };
  }
  return result;
}

// the first `max` characters of untrusted text, credential-shaped values redacted as every
// integration's text is, cut on code points
function bounded(raw: string, max: number): GithubTextV1 {
  const text = redactIntegrationText(raw);
  const points = Array.from(text);
  return points.length <= max ? { text } : { text: points.slice(0, max).join(''), truncated: true };
}

function comment(found: PullRequestComment, max: number): GithubCommentV1 {
  return { id: found.id, author: found.author, bot: found.bot, mine: found.mine === true, createdAt: found.createdAt, url: found.url, body: bounded(found.body, max) };
}

// which discussion a cursor pages through: the snapshot it was cut from, where the next page starts,
// and the pull request and thread filter its entries came from
type Cursor = { snapshot: number; offset: number; filter: string };
const filterOf = (input: GithubPullRequestInputV1): string => `${input.repository.toLowerCase()}#${input.number}|${input.threads ?? 'unresolved'}|${input.includeOutdated === true}`;

/** The cursor a call names, or undefined for one that is not a cursor this module wrote. */
export function readCursor(cursor: string): Cursor | undefined {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    return Number.isInteger(value.snapshot) && Number.isInteger(value.offset) && (value.offset ?? -1) >= 0 && typeof value.filter === 'string' ? value as Cursor : undefined;
  } catch { return undefined; }
}

const writeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

/**
 * One pull request held to the sections asked for: `summary`, `checks` and `reviewers` by default,
 * and the bounded `discussion` (the description, then the review threads the filter keeps, then
 * review summaries, then general comments) only on request, a page at a time. A cursor that names
 * another snapshot or filter answers `expired` or `invalid`.
 */
export function githubPullRequest(snapshot: PullRequestSnapshot, scope: GithubScope, input: GithubPullRequestInputV1, cursor: Cursor | undefined): GithubPullRequestV1['pullRequest'] | 'expired' | 'invalid' {
  const pull = snapshot.pullRequest;
  if (cursor !== undefined && cursor.filter !== filterOf(input)) return 'invalid';
  if (pull === undefined || snapshot.fetchedAt === undefined) return cursor === undefined ? null : 'expired';
  if (cursor !== undefined && cursor.snapshot !== snapshot.fetchedAt) return 'expired';
  const sections = new Set(input.sections ?? defaultSections);
  const maxBody = input.maxBodyChars ?? defaultBodyChars;
  const view: NonNullable<GithubPullRequestV1['pullRequest']> = {};
  if (sections.has('summary')) {
    view.summary = {
      title: pull.title, url: pull.url, state: pull.state, draft: pull.draft, ...(pull.author === undefined ? {} : { author: pull.author }), mine: pull.mine,
      ...(pull.updatedAt === undefined ? {} : { updatedAt: pull.updatedAt }), ...(pull.baseBranch === undefined ? {} : { baseBranch: pull.baseBranch }),
      branch: pull.branch, headSha: pull.headSha, headOnOrigin: pull.headOnOrigin, mergeable: pull.mergeable, checks: pull.checks,
      // the module keeps only the Issues in the pull request's own repository
      linkedIssues: pull.linkedIssues, destinations: githubDestinations(snapshot.local, scope)
    };
  }
  if (sections.has('checks')) view.checks = { runs: pull.checkRuns.map(({ name, status, url }) => ({ name, status, ...(url === undefined ? {} : { url }) })), mayBeTruncated: pull.pageFull?.checks === true };
  if (sections.has('reviewers')) {
    view.reviewers = {
      reviewers: pull.reviewers.map(({ login, team, bot, state, requested, newCommits }) => ({ login, ...(team ? { team } : {}), ...(bot ? { bot } : {}), ...(state === undefined ? {} : { state }), ...(requested ? { requested } : {}), ...(newCommits ? { newCommitsSinceReview: newCommits } : {}) })),
      mayBeTruncated: pull.reviewers.length > 0 && pull.pageFull?.reviewers === true,
      note: 'An approval alone is not merge readiness: read the checks and mergeability too.'
    };
  }
  if (sections.has('discussion')) {
    const threadFilter = input.threads ?? 'unresolved';
    const keepComments = input.maxThreadComments ?? defaultThreadComments;
    const threads = threadFilter === 'none' ? [] : pull.threads.filter(thread => (input.includeOutdated === true || !thread.outdated) && (threadFilter === 'all' || !thread.resolved));
    const entries: GithubDiscussionEntryV1[] = [
      ...(pull.description === undefined ? [] : [{ type: 'description' as const, ...comment(pull.description, maxBody) }]),
      ...threads.map((thread): GithubDiscussionEntryV1 => {
        // its opener and its newest replies
        const shown = thread.comments.length <= keepComments ? thread.comments : [thread.comments[0]!, ...thread.comments.slice(thread.comments.length - (keepComments - 1))].slice(0, keepComments);
        return {
          type: 'thread', id: thread.id, path: thread.path, ...(thread.line === undefined ? {} : { line: thread.line }), ...(thread.startLine === undefined ? {} : { startLine: thread.startLine }),
          resolved: thread.resolved, outdated: thread.outdated, lastSpeakerIsMe: thread.comments.at(-1)?.mine === true,
          ...(input.includeDiffHunks === true ? { diffHunk: bounded(thread.diffHunk, maxBody) } : {}),
          comments: shown.map(found => comment(found, maxBody)), omittedComments: thread.comments.length - shown.length,
          olderCommentsMayBeMissing: thread.comments.length >= detailPageLimits.threadComments
        };
      }),
      ...pull.reviews.map((review): GithubDiscussionEntryV1 => ({ type: 'review', state: review.state, ...comment(review, maxBody) })),
      ...pull.comments.map((found): GithubDiscussionEntryV1 => ({ type: 'comment', ...comment(found, maxBody) }))
    ];
    const offset = cursor?.offset ?? 0;
    const page: GithubDiscussionEntryV1[] = [];
    let chars = 0;
    for (const entry of entries.slice(offset, offset + (input.maxEntries ?? defaultEntries))) {
      chars += JSON.stringify(entry).length;
      if (page.length > 0 && chars > pageChars) break;
      page.push(entry);
    }
    const end = offset + page.length;
    view.discussion = {
      snapshot: new Date(snapshot.fetchedAt).toISOString(), entries: page, totalEntries: entries.length,
      nextCursor: end < entries.length ? writeCursor({ snapshot: snapshot.fetchedAt, offset: end, filter: filterOf(input) }) : null,
      mayBeTruncated: { threads: pull.pageFull?.threads === true, reviews: pull.pageFull?.reviews === true, comments: pull.pageFull?.comments === true }
    };
  }
  return view;
}
