import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewDiffNote } from './code-panel/review-diffs.js';
import type { Verdict, VerdictStatus } from './code-review.js';
import { Icon } from './github-overview.js';
import { refusal, WriteButton } from './github-panel.js';
import { MarkdownBlocks } from './note-markdown.js';
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
const threadWhere = (thread: PullRequestReviewThread): string => `${thread.path}${linesLabel(thread)}`;

// The AI review's verdicts on my earlier threads, by thread id, and those I dismissed by
// `dismissalKey`: a dismissed verdict shows as none, and a later review's other verdict on that
// thread shows again. `judged` once a Code review completed, so a thread it gave none shows so.
export type EarlierVerdicts = { judged: boolean; verdicts: ReadonlyMap<string, Verdict>; dismissed: ReadonlySet<string>; onDismiss: (verdict: Verdict) => void; onRestore: (verdict: Verdict) => void };
export const dismissalKey = (verdict: Verdict): string => `${verdict.threadId}:${verdict.status}`;
const shownVerdict = (view: EarlierVerdicts, threadId: string): Verdict | undefined => {
  const verdict = view.verdicts.get(threadId);
  return verdict === undefined || view.dismissed.has(dismissalKey(verdict)) ? undefined : verdict;
};

// each verdict's badge and what its evidence lines show about its thread
const verdictText: Record<VerdictStatus, { label: string; evidence: string }> = {
  not_addressed: { label: 'Not addressed', evidence: 'Not fixed here' },
  partly: { label: 'Partly', evidence: 'Partly fixed here' },
  needs_you: { label: 'Needs you', evidence: 'Discussed here' },
  addressed: { label: 'Addressed', evidence: 'Fixed here' }
};
// what needs me first: not addressed, partly, needs you, no verdict, then addressed
const verdictOrder: readonly (VerdictStatus | undefined)[] = ['not_addressed', 'partly', 'needs_you', undefined, 'addressed'];
const verdictLabel = (status: VerdictStatus | undefined): string => status === undefined ? 'No verdict' : verdictText[status].label;
const VerdictBadge = ({ status }: { status: VerdictStatus | undefined }) => <span className={`review-tour-verdict-badge ${status ?? 'none'}`}>{verdictLabel(status)}</span>;

// One of my earlier threads: its file and lines, its state and verdict, my first comment, the latest
// reply, the verdict's explanation, and Resolve while it is open. An addressed one starts collapsed;
// `focus` opens and focuses it.
export function EarlierThread({ thread, resolving, verdicts, focus = false, onFocused }: { thread: PullRequestReviewThread; resolving: EarlierThreadResolve; verdicts: EarlierVerdicts; focus?: boolean; onFocused?: () => void }) {
  const [first, ...replies] = thread.comments as [PullRequestComment, ...PullRequestComment[]];
  const latest = replies.at(-1);
  const resolvedHere = resolving.resolved.has(thread.id);
  const busy = resolving.busy.has(thread.id);
  const verdict = shownVerdict(verdicts, thread.id);
  const dismissed = verdict === undefined ? verdicts.verdicts.get(thread.id) : undefined;
  // undefined until toggled, so a verdict arriving later still collapses an addressed thread
  const [expanded, setExpanded] = useState<boolean>();
  const collapsible = verdict?.status === 'addressed';
  const open = !collapsible || expanded === true;
  const row = useRef<HTMLDivElement>(null);
  // focus after the panel's own step-change effects, which reset the narration's scroll and focus
  // the compact notes drawer
  useEffect(() => {
    if (!focus) return;
    setExpanded(true);
    const frame = window.requestAnimationFrame(() => { row.current?.focus(); onFocused?.(); });
    return () => window.cancelAnimationFrame(frame);
  }, [focus, onFocused]);
  const state = [
    ...(resolvedHere ? ['resolved by you'] : thread.resolved ? [thread.resolvedBy === undefined ? 'resolved' : `resolved by @${thread.resolvedBy.login}`] : []),
    ...(thread.outdated ? ['outdated'] : []),
    ...(!resolvedHere && !thread.resolved && !thread.outdated ? ['open'] : [])
  ].join(' · ');
  const where = threadWhere(thread);
  return <div ref={row} className="review-tour-earlier" role="group" aria-label={`Your earlier comment on ${where}`} data-thread={thread.id} tabIndex={-1}>
    <div className="review-tour-earlier-head"><strong title={thread.path}>{where}</strong><span>{state}</span>{verdicts.judged && <VerdictBadge status={verdict?.status} />}{collapsible && <button type="button" className="review-tour-earlier-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>{open ? 'Hide' : 'Show'}</button>}</div>
    {open && <>
      <p>{first.body}</p>
      {latest !== undefined && <p className="review-tour-earlier-reply">@{latest.author}: {latest.body}</p>}
      {verdict !== undefined && <div className="note-markdown review-tour-verdict-body"><MarkdownBlocks text={verdict.body} /></div>}
      {resolving.errors[thread.id] !== undefined && <p className="review-tour-error" role="alert">{resolving.errors[thread.id]}</p>}
      <div><a href={first.url} target="_blank" rel="noreferrer">View on GitHub</a>{verdict !== undefined && <button type="button" onClick={() => verdicts.onDismiss(verdict)}>Dismiss verdict</button>}{dismissed !== undefined && <button type="button" onClick={() => verdicts.onRestore(dismissed)}>Restore verdict</button>}{!thread.resolved && !resolvedHere && <WriteButton busy={busy} disabled={busy || resolving.resolve === undefined} title={resolving.resolve === undefined ? 'Add this repository as a Project to resolve threads here' : undefined} onClick={() => void resolving.resolve?.(thread.id)}><Icon name="check" />Resolve</WriteButton>}</div>
    </>}
  </div>;
}

// The first step's list of my earlier threads, as the tour started, those needing me first;
// `focused` is the thread to open and focus.
export function EarlierThreadsSection({ earlier, resolving, verdicts, fontSize, focused, onFocused }: { earlier: EarlierThreads; resolving: EarlierThreadResolve; verdicts: EarlierVerdicts; fontSize: number; focused?: string; onFocused: () => void }): ReactNode {
  const heading = `Your earlier comments (${earlier.threads.length})`;
  const rank = (thread: PullRequestReviewThread) => verdictOrder.indexOf(shownVerdict(verdicts, thread.id)?.status);
  const ordered = [...earlier.threads].sort((left, right) => rank(left) - rank(right));
  return <section className="review-tour-general review-tour-earlier-threads" aria-label={heading} style={{ '--diffs-font-size': `${fontSize}px` } as CSSProperties}>
    <small>{heading}</small>
    {earlier.partial && <p className="review-tour-earlier-note">Some older threads may be missing: GitHub listed only the pull request’s latest threads.</p>}
    {earlier.threads.length === 0 && <p className="review-tour-earlier-note">None: you opened no threads here, or resolved each one yourself.</p>}
    {ordered.map(thread => <EarlierThread key={thread.id} thread={thread} resolving={resolving} verdicts={verdicts} focus={focused === thread.id} onFocused={onFocused} />)}
  </section>;
}

// the note id of a verdict's evidence on the tour's lines, and the thread it names
const evidencePrefix = 'evidence:';
export const evidenceThread = (noteId: string): string | undefined => noteId.startsWith(evidencePrefix) ? noteId.slice(evidencePrefix.length) : undefined;

// where each shown verdict's evidence sits on the tour's lines
export function verdictEvidenceNotes(threads: readonly PullRequestReviewThread[], verdicts: EarlierVerdicts): ReviewDiffNote[] {
  return threads.flatMap((thread): ReviewDiffNote[] => {
    const evidence = shownVerdict(verdicts, thread.id)?.evidence;
    return evidence === undefined ? [] : [{ id: `${evidencePrefix}${thread.id}`, changeId: evidence.changeId, side: evidence.side, endLine: evidence.endLine }];
  });
}

// The marker on a verdict's evidence lines, leading back to its thread.
export function VerdictEvidence({ thread, verdicts, onOpen }: { thread: PullRequestReviewThread; verdicts: EarlierVerdicts; onOpen: (threadId: string) => void }): ReactNode {
  const verdict = shownVerdict(verdicts, thread.id);
  if (verdict === undefined) return null;
  return <div className="review-tour-fixed-here"><VerdictBadge status={verdict.status} /><button type="button" onClick={() => onOpen(thread.id)}>{verdictText[verdict.status].evidence}: your comment on {threadWhere(thread)}</button></div>;
}

// The summary's count of my earlier threads per verdict, leading back to them, once a Code review
// judged them.
export function EarlierVerdictSummary({ earlier, verdicts, onReview }: { earlier: EarlierThreads; verdicts: EarlierVerdicts; onReview: () => void }): ReactNode {
  if (earlier.threads.length === 0 || !verdicts.judged) return null;
  const counts = verdictOrder.flatMap(status => {
    const count = earlier.threads.filter(thread => shownVerdict(verdicts, thread.id)?.status === status).length;
    return count === 0 ? [] : [`${count} ${verdictLabel(status).toLowerCase()}`];
  });
  return <section className="review-tour-earlier-summary" aria-label="Your earlier comments"><small>Your earlier comments</small><ul>{counts.map(count => <li key={count}>{count}</li>)}</ul><button type="button" onClick={onReview}>Review earlier comments</button></section>;
}
