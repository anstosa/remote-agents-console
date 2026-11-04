import { type CSSProperties, type ReactNode, useCallback, useState } from 'react';
import type { ReviewDiffNote } from './code-panel/review-diffs.js';
import { Icon } from './github-overview.js';
import { refusal, WriteButton } from './github-panel.js';
import type { PullRequestComment, PullRequestReviewThread } from './pull-request-comments.js';
import { threadLines } from './review-thread-prompt.js';

// The Review threads I opened on a Since my review tour's Pull request `pullRequest`, as GitHub had
// them when the tour started; `partial` when GitHub's page of threads was full, so older ones may be
// missing.
export type EarlierThreads = { pullRequest: number; threads: PullRequestReviewThread[]; partial?: true };
type Request = (url: string, init?: RequestInit, observeReachability?: boolean) => Promise<Response>;

const isComment = (value: unknown): value is PullRequestComment => {
  const comment = value as PullRequestComment | null;
  return comment !== null && typeof comment === 'object' && typeof comment.id === 'string' && typeof comment.author === 'string' && typeof comment.body === 'string' && typeof comment.url === 'string';
};
const isThread = (value: unknown): value is PullRequestReviewThread => {
  const thread = value as PullRequestReviewThread | null;
  return thread !== null && typeof thread === 'object' && typeof thread.id === 'string' && typeof thread.path === 'string' && typeof thread.resolved === 'boolean' && typeof thread.outdated === 'boolean'
    && (thread.line === undefined || Number.isInteger(thread.line)) && (thread.startLine === undefined || Number.isInteger(thread.startLine))
    && (thread.resolvedBy === undefined || (thread.resolvedBy !== null && typeof thread.resolvedBy.login === 'string'))
    && Array.isArray(thread.comments) && thread.comments.length > 0 && thread.comments.every(isComment);
};

export function isEarlierThreads(value: unknown): value is EarlierThreads {
  const earlier = value as EarlierThreads | null;
  return earlier !== null && typeof earlier === 'object' && Number.isInteger(earlier.pullRequest) && Array.isArray(earlier.threads) && earlier.threads.every(isThread);
}

// Where each thread sits in the tour's Changes: a current thread on the changed side whose lines lie
// inside one hunk. Local HEAD is the PR head, so GitHub's line numbers are the hunk's new-side ones.
export function earlierThreadNotes(threads: readonly PullRequestReviewThread[], changes: readonly { id: string; file: string; kind: string; newStart?: number; newLines?: number }[]): ReviewDiffNote[] {
  return threads.flatMap((thread): ReviewDiffNote[] => {
    const end = thread.line;
    if (thread.outdated || thread.leftSide || end === undefined) return [];
    const start = thread.startLine ?? end;
    const change = changes.find(candidate => candidate.kind === 'hunk' && candidate.file === thread.path && candidate.newStart !== undefined && candidate.newLines !== undefined && start >= candidate.newStart && end < candidate.newStart + candidate.newLines);
    return change === undefined ? [] : [{ id: thread.id, changeId: change.id, side: 'additions', endLine: end }];
  });
}

// Resolving threads on the tour's Pull request: which I resolved here (`initial` from the saved
// draft), which are in flight, and why one failed. Without a github.com Project there is no route to
// resolve through, so `resolve` is absent.
export function useEarlierThreadResolve(request: Request, projectId: string | undefined, pullRequest: number | undefined, initial: readonly string[] = []) {
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set(initial));
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const toggle = (set: ReadonlySet<string>, id: string, on: boolean) => { const next = new Set(set); if (on) next.add(id); else next.delete(id); return next; };
  const resolve = useCallback(async (id: string) => {
    if (projectId === undefined || pullRequest === undefined || !window.confirm('Resolve this thread on GitHub?')) return;
    setBusy(set => toggle(set, id, true));
    setErrors(({ [id]: _cleared, ...rest }) => rest);
    let error: string | undefined;
    try {
      const response = await request(`/api/projects/${encodeURIComponent(projectId)}/github/pulls/${pullRequest}/threads/${encodeURIComponent(id)}/resolve`, { method: 'POST' });
      if (!response.ok) error = await refusal(response, 'resolve the thread');
    } catch { error = 'The console could not be reached.'; }
    setBusy(set => toggle(set, id, false));
    if (error === undefined) setResolved(set => toggle(set, id, true));
    else setErrors(current => ({ ...current, [id]: error }));
  }, [request, projectId, pullRequest]);
  return { resolved, busy, errors, ...(projectId === undefined || pullRequest === undefined ? {} : { resolve }) };
}
export type EarlierThreadResolve = ReturnType<typeof useEarlierThreadResolve>;

// "line 5", "lines 38-40", "old line 5" on the removed side, or nothing for a thread on a whole file
const linesLabel = (thread: PullRequestReviewThread): string => thread.line === undefined ? '' : `${thread.leftSide ? ' old' : ''} ${thread.startLine === undefined ? 'line' : 'lines'} ${threadLines(thread)}`;

// One of my earlier threads: its file and lines, its state, my first comment, the latest reply, and
// Resolve while it is open.
export function EarlierThread({ thread, resolving }: { thread: PullRequestReviewThread; resolving: EarlierThreadResolve }) {
  const [first, ...replies] = thread.comments as [PullRequestComment, ...PullRequestComment[]];
  const latest = replies.at(-1);
  const resolvedHere = resolving.resolved.has(thread.id);
  const busy = resolving.busy.has(thread.id);
  const state = [
    ...(resolvedHere ? ['resolved by you'] : thread.resolved ? [thread.resolvedBy === undefined ? 'resolved' : `resolved by @${thread.resolvedBy.login}`] : []),
    ...(thread.outdated ? ['outdated'] : []),
    ...(!resolvedHere && !thread.resolved && !thread.outdated ? ['open'] : [])
  ].join(' · ');
  const where = `${thread.path}${linesLabel(thread)}`;
  return <div className="review-tour-earlier" role="group" aria-label={`Your earlier comment on ${where}`}>
    <div className="review-tour-earlier-head"><strong title={thread.path}>{where}</strong><span>{state}</span></div>
    <p>{first.body}</p>
    {latest !== undefined && <p className="review-tour-earlier-reply">@{latest.author}: {latest.body}</p>}
    {resolving.errors[thread.id] !== undefined && <p className="review-tour-error" role="alert">{resolving.errors[thread.id]}</p>}
    <div><a href={first.url} target="_blank" rel="noreferrer">View on GitHub</a>{!thread.resolved && !resolvedHere && <WriteButton busy={busy} disabled={busy || resolving.resolve === undefined} title={resolving.resolve === undefined ? 'Add this repository as a Project to resolve threads here' : undefined} onClick={() => void resolving.resolve?.(thread.id)}><Icon name="check" />Resolve</WriteButton>}</div>
  </div>;
}

// The first step's list of my earlier threads, as the tour started.
export function EarlierThreadsSection({ earlier, resolving, fontSize }: { earlier: EarlierThreads; resolving: EarlierThreadResolve; fontSize: number }): ReactNode {
  const heading = `Your earlier comments (${earlier.threads.length})`;
  return <section className="review-tour-general review-tour-earlier-threads" aria-label={heading} style={{ '--diffs-font-size': `${fontSize}px` } as CSSProperties}>
    <small>{heading}</small>
    {earlier.partial && <p className="review-tour-earlier-note">Some older threads may be missing: GitHub listed only the pull request’s latest threads.</p>}
    {earlier.threads.length === 0 && <p className="review-tour-earlier-note">None: you opened no threads here, or resolved each one yourself.</p>}
    {earlier.threads.map(thread => <EarlierThread key={thread.id} thread={thread} resolving={resolving} />)}
  </section>;
}
