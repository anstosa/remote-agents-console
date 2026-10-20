import { useEffect, useRef, useState } from 'react';

export type PullRequestIssues = { mergeConflicts?: boolean; failingChecks?: boolean; unresolvedComments?: boolean };
export type PullRequestCheckStatus = 'passed' | 'pending' | 'failed';
export type PullRequestSummary = { number: number; title: string; status: 'draft' | 'open' | 'merged'; url: string; baseBranch?: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues; unresolvedThreads?: number };

const statusLabel = { draft: 'Draft', open: 'Open', merged: 'Merged' } as const;
type IssueName = keyof PullRequestIssues;
type DisplayIssueName = Exclude<IssueName, 'failingChecks'>;
const issueLabels: Record<IssueName, string> = { mergeConflicts: 'Merge conflicts', failingChecks: 'Failing checks', unresolvedComments: 'Unresolved review comments' };
const checkLabels: Record<PullRequestCheckStatus, string> = { passed: 'CI checks passed', pending: 'CI checks running', failed: 'CI checks failed' };

export function PullRequestStatusIcon({ status, className = '' }: { status: PullRequestSummary['status']; className?: string }) {
  return <i className={`pull-request-status-icon status-${status}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}

function CheckStatusIcon({ status }: { status: PullRequestCheckStatus }) {
  const shape = status === 'passed'
    ? <path d="m5 12 4 4L19 6" />
    : status === 'pending'
      ? <circle cx="12" cy="12" r="7" />
      : <path d="M7 7l10 10M17 7 7 17" />;
  return <i className={`pull-request-checks checks-${status}`} role="img" aria-label={checkLabels[status]} title={checkLabels[status]}><svg viewBox="0 0 24 24" aria-hidden="true">{shape}</svg></i>;
}

function IssueIcon({ issue }: { issue: DisplayIssueName }) {
  const path = issue === 'mergeConflicts'
    ? 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 9v3a6 6 0 0 0 6 6h3M6 9v12'
    : 'M5 5h14v10H9l-4 4V5Zm4 4h6m-6 3h4';
  return <i className={`pull-request-issue issue-${issue}`} role="img" aria-label={issueLabels[issue]} title={issueLabels[issue]}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg></i>;
}

export function PullRequestIndicators({ checks, issues: issueFlags }: Pick<PullRequestSummary, 'checks' | 'issues'>) {
  const issueNames = (Object.keys(issueFlags ?? {}) as IssueName[]).filter(issue => issueFlags?.[issue] === true);
  const issues = issueNames.filter((issue): issue is DisplayIssueName => issue !== 'failingChecks');
  const checkStatus = checks ?? (issueFlags?.failingChecks === true ? 'failed' : 'pending');
  return <span className="pull-request-issues" aria-label="Pull request status"><CheckStatusIcon status={checkStatus} />{issues.map(issue => <IssueIcon key={issue} issue={issue} />)}</span>;
}

export type PullRequestCommentsToggle = { open: boolean; unresolved: number; onToggle: () => void };

// render the single-line current pr link and health indicators; with `comments`, an open pr's
// unresolved-comments indicator becomes the button that shows its comments
export function PullRequestCard({ pullRequest, comments }: { pullRequest?: PullRequestSummary; comments?: PullRequestCommentsToggle }) {
  // omit absent pull requests
  if (pullRequest === undefined) return null;
  const label = `${statusLabel[pullRequest.status]} pull request #${pullRequest.number}: ${pullRequest.title}`;
  const toggle = pullRequest.status === 'merged' ? undefined : comments;
  const { unresolvedComments: _unresolvedComments, ...otherIssues } = pullRequest.issues ?? {};
  const commentsLabel = toggle === undefined ? '' : `${toggle.open ? 'Hide' : 'Show'} PR comments${toggle.unresolved > 0 ? ` (${toggle.unresolved} unresolved)` : ''}`;
  return <div className={`pull-request-card status-${pullRequest.status}`}><a className="pull-request-card-main" href={pullRequest.url} target="_blank" rel="noreferrer" aria-label={label} title={label}><PullRequestStatusIcon status={pullRequest.status} className="pull-request-card-icon" /><strong>#{pullRequest.number}</strong><span>{pullRequest.title}</span></a><PullRequestIndicators checks={pullRequest.checks} issues={toggle === undefined ? pullRequest.issues : otherIssues} />{toggle !== undefined && <button type="button" className={`pull-request-comments-toggle${toggle.unresolved > 0 ? ' unresolved' : ''}`} aria-pressed={toggle.open} aria-label={commentsLabel} title={commentsLabel} onClick={toggle.onToggle}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H9l-4 4V5Zm4 4h6m-6 3h4" /></svg>{toggle.unresolved > 0 && <span>{toggle.unresolved}</span>}</button>}</div>;
}

// keep fixup queue state independent of the pr link
export function PullRequestFixup({ pullRequest, onFixup, pending = false }: { pullRequest?: PullRequestSummary; onFixup?: () => Promise<boolean>; pending?: boolean }) {
  const [queueing, setQueueing] = useState(false);
  const submitting = queueing || pending;
  const [queued, setQueued] = useState(false);
  const queuedTimer = useRef<number | undefined>(undefined);
  // release queued feedback on unmount
  useEffect(() => () => {
    // cancel outstanding feedback
    if (queuedTimer.current !== undefined) window.clearTimeout(queuedTimer.current);
  }, []);
  // omit absent pull requests
  if (pullRequest === undefined) return null;
  // offer fixes only for reported issues and live agents
  if (onFixup === undefined || !Object.values(pullRequest.issues ?? {}).includes(true)) return null;
  // queue one fixup and briefly acknowledge acceptance
  const queueFixup = async () => {
    // reject duplicate submissions
    if (submitting) return;
    setQueueing(true);
    try {
      // retain the action after rejected submissions
      if (!await onFixup()) return;
      setQueued(true);
      // replace earlier feedback
      if (queuedTimer.current !== undefined) window.clearTimeout(queuedTimer.current);
      // reset temporary acceptance feedback
      queuedTimer.current = window.setTimeout(() => {
        queuedTimer.current = undefined;
        setQueued(false);
      }, 1_600);
    } finally {
      setQueueing(false);
    }
  };
  return <button className={`pull-request-fixup${queued ? ' queued' : ''}${queueing ? ' progress-border progress-peach' : ''}`} type="button" aria-busy={queueing || undefined} disabled={submitting} aria-label="Queue $fixup" title="Queue $fixup" onClick={() => { /* submit the standalone action */ void queueFixup(); }}>{queueing && <span className="update-progress-ring" aria-hidden="true" />}{queued ? <><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>Queued</> : '$fixup'}</button>;
}
