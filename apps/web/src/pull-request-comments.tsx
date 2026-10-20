import { type ReactNode, useCallback, useEffect, useState } from 'react';

export type PullRequestComment = { id: string; author: string; bot: boolean; body: string; createdAt: string; url: string };
export type PullRequestReviewThread = { id: string; path: string; line?: number; startLine?: number; resolved: boolean; outdated: boolean; diffHunk: string; comments: PullRequestComment[] };
export type PullRequestReviewSummary = PullRequestComment & { state: string };
export type PullRequestComments = { number: number; url: string; threads: PullRequestReviewThread[]; reviews: PullRequestReviewSummary[]; comments: PullRequestComment[] };

type Item = { kind: 'thread'; id: string; thread: PullRequestReviewThread } | { kind: 'review'; id: string; review: PullRequestReviewSummary } | { kind: 'comment'; id: string; comment: PullRequestComment };
type Section = Item['kind'];

const hunkLines = 10;
const reviewStates: Record<string, string> = { CHANGES_REQUESTED: 'Changes requested', APPROVED: 'Approved', DISMISSED: 'Dismissed' };

export const unresolvedThreadCount = (comments: PullRequestComments): number => comments.threads.filter(thread => !thread.resolved && !thread.outdated).length;

const threadLines = (thread: PullRequestReviewThread): string => thread.line === undefined ? '' : thread.startLine === undefined ? `${thread.line}` : `${thread.startLine}-${thread.line}`;
const quote = (text: string): string => text.split('\n').map(line => line === '' ? '>' : `> ${line}`).join('\n');
// a fence longer than any backtick run inside, so a hunk that itself holds ``` stays one block
const fence = (text: string): string => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1)));

function itemBlock(item: Item): string {
  if (item.kind === 'thread') {
    const { thread } = item;
    const lines = threadLines(thread);
    const hunk = thread.diffHunk.split('\n').slice(-hunkLines).join('\n');
    const marker = fence(hunk);
    const code = hunk.trim() === '' ? [] : [`${marker}diff`, hunk, marker, ''];
    return [`Review thread on ${thread.path}${lines === '' ? '' : `:${lines}`}${thread.outdated ? ' (outdated: the code has changed since)' : ''}`, thread.comments[0]!.url, '', ...code, thread.comments.map(comment => quote(`@${comment.author}: ${comment.body}`)).join('\n>\n')].join('\n');
  }
  if (item.kind === 'review') {
    const state = reviewStates[item.review.state];
    return [`Review from @${item.review.author}${state === undefined ? '' : ` (${state.toLowerCase()})`}`, item.review.url, '', quote(item.review.body)].join('\n');
  }
  return [`Comment from @${item.comment.author}`, item.comment.url, '', quote(item.comment.body)].join('\n');
}

// the composer text for one or more pieces of feedback, in the order the list shows them
export function pullRequestFeedbackPrompt(number: number, items: readonly Item[]): string {
  const blocks = items.map(itemBlock);
  const body = blocks.length === 1 ? blocks[0]! : blocks.map((block, index) => `${index + 1}. ${block.split('\n').map((line, at) => at === 0 || line === '' ? line : `   ${line}`).join('\n')}`).join('\n\n');
  return `Address this feedback on PR #${number}:\n\n${body}`;
}

function age(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

function hunkClass(line: string): string | undefined {
  if (line.startsWith('@@')) return 'hunk-header';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return undefined;
}

function CommentCard({ item, now, selected, open, onSelect, onToggle, onAdd }: { item: Item; now: number; selected: boolean; open: boolean; onSelect: (selected: boolean) => void; onToggle: () => void; onAdd?: () => void }) {
  const first = item.kind === 'thread' ? item.thread.comments[0]! : item.kind === 'review' ? item.review : item.comment;
  const replies = item.kind === 'thread' ? item.thread.comments.slice(1) : [];
  const lines = item.kind === 'thread' ? threadLines(item.thread) : '';
  const state = item.kind === 'review' ? reviewStates[item.review.state] : undefined;
  // a short summary or comment is shown whole, so it needs no toggle
  const expandable = item.kind === 'thread' || first.body.length > 240 || first.body.split('\n').length > 3;
  const hunk = item.kind === 'thread' ? item.thread.diffHunk.split('\n').slice(-hunkLines) : [];
  return <article className={`pr-comment${selected ? ' selected' : ''}${open ? ' open' : ''}`}>
    <input type="checkbox" checked={selected} aria-label={`Select ${item.kind === 'thread' ? 'review thread' : item.kind === 'review' ? 'review' : 'comment'} by @${first.author}`} onChange={event => onSelect(event.target.checked)} />
    <div className="pr-comment-main">
      <div className="pr-comment-meta">
        <strong className={first.bot ? 'bot' : undefined}>@{first.author}</strong>
        {lines !== '' && <span className="pr-comment-lines">L{lines}</span>}
        <span className="pr-comment-age" title={new Date(first.createdAt).toLocaleString()}>{age(first.createdAt, now)}</span>
        {item.kind === 'thread' && item.thread.outdated && <span className="pr-comment-badge outdated">Outdated</span>}
        {item.kind === 'thread' && item.thread.resolved && <span className="pr-comment-badge resolved">Resolved</span>}
        {state !== undefined && <span className={`pr-comment-badge state-${item.kind === 'review' ? item.review.state.toLowerCase() : ''}`}>{state}</span>}
        {first.bot && <span className="pr-comment-badge">Bot</span>}
      </div>
      {open && hunk.some(line => line.trim() !== '') && <pre className="pr-comment-hunk">{hunk.map((line, index) => <span key={index} className={hunkClass(line)}>{line}{'\n'}</span>)}</pre>}
      <p className="pr-comment-body">{first.body}</p>
      {open
        ? replies.map(reply => <div key={reply.id} className="pr-comment-reply"><div className="pr-comment-meta"><strong className={reply.bot ? 'bot' : undefined}>@{reply.author}</strong><span className="pr-comment-age">{age(reply.createdAt, now)}</span></div><p className="pr-comment-body">{reply.body}</p></div>)
        : replies.length > 0 && <span className="pr-comment-replies">+{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>}
      <div className="pr-comment-actions">
        <button type="button" className="pr-comment-add" disabled={onAdd === undefined} title={onAdd === undefined ? 'No composer is open here' : undefined} onClick={onAdd}>Add to prompt</button>
        {expandable && <button type="button" className="pr-comment-toggle" aria-expanded={open} onClick={onToggle}>{open ? 'Less' : item.kind === 'thread' ? 'Show code + thread' : 'More'}</button>}
        <a className="pr-comment-link" href={first.url} target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </div>
  </article>;
}

// The git flyout's view of one pull request's feedback, read fresh from GitHub whenever it opens.
// Rendered as the flyout's header and scrolling body; the flyout keeps its own footer.
export function PullRequestCommentsPanel({ load, onLoaded, onAddToPrompt }: { load: () => Promise<PullRequestComments>; onLoaded?: (comments: PullRequestComments) => void; onAddToPrompt?: (text: string) => void }) {
  const [comments, setComments] = useState<PullRequestComments>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number>();
  const [showResolved, setShowResolved] = useState(false);
  const [showBots, setShowBots] = useState(false);
  const [folded, setFolded] = useState<Record<Section, boolean>>({ thread: false, review: true, comment: true });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const loaded = await load();
      setComments(loaded);
      setError(undefined);
      setFetchedAt(Date.now());
      onLoaded?.(loaded);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load the pull request comments.');
    } finally {
      setLoading(false);
    }
  }, [load, onLoaded]);
  // read once per opening; the refresh button reads again
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, []);

  const now = fetchedAt ?? Date.now();
  const threads = (comments?.threads ?? [])
    .filter(thread => (showResolved || !thread.resolved && !thread.outdated) && (showBots || !thread.comments[0]!.bot))
    .sort((left, right) => left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0));
  const reviews = (comments?.reviews ?? []).filter(review => showBots || !review.bot);
  const conversation = (comments?.comments ?? []).filter(comment => showBots || !comment.bot);
  const hiddenThreads = (comments?.threads.length ?? 0) - threads.length;
  const hiddenReviews = (comments?.reviews.length ?? 0) - reviews.length;
  const hiddenConversation = (comments?.comments.length ?? 0) - conversation.length;
  const items: Item[] = [
    ...threads.map(thread => ({ kind: 'thread' as const, id: thread.id, thread })),
    ...reviews.map(review => ({ kind: 'review' as const, id: review.id, review })),
    ...conversation.map(comment => ({ kind: 'comment' as const, id: comment.id, comment }))
  ];
  const chosen = items.filter(item => selected.has(item.id));
  const add = (picked: readonly Item[]) => {
    if (comments === undefined || onAddToPrompt === undefined || picked.length === 0) return;
    setSelected(new Set());
    onAddToPrompt(pullRequestFeedbackPrompt(comments.number, picked));
  };
  const toggleIn = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) next.add(id); else next.delete(id);
    return next;
  };
  const card = (item: Item) => <CommentCard key={item.id} item={item} now={now} selected={selected.has(item.id)} open={open.has(item.id)} onSelect={on => setSelected(current => toggleIn(current, item.id, on))} onToggle={() => setOpen(current => toggleIn(current, item.id, !current.has(item.id)))} onAdd={onAddToPrompt === undefined ? undefined : () => add([item])} />;
  const section = (kind: Section, title: string, list: readonly Item[], hidden: string | undefined, body: () => ReactNode) => {
    if (list.length === 0 && hidden === undefined) return null;
    return <section className="pr-comments-section" aria-label={title}>
      <h3><button type="button" aria-expanded={!folded[kind]} onClick={() => setFolded(current => ({ ...current, [kind]: !current[kind] }))}><svg className="pr-comments-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>{title}<span className="pr-comments-count">{list.length}</span></button></h3>
      {!folded[kind] && <>{body()}{hidden !== undefined && <p className="pr-comments-hidden">{hidden}</p>}</>}
    </section>;
  };
  const threadItems = items.filter(item => item.kind === 'thread');
  const threadBody = () => threadItems.map((item, index) => {
    const path = item.thread.path;
    const slash = path.lastIndexOf('/');
    const header = index === 0 || threadItems[index - 1]!.thread.path !== path;
    return <div key={item.id}>{header && <p className="pr-comments-file" title={path}><span>{path.slice(0, slash + 1)}</span>{path.slice(slash + 1)}</p>}{card(item)}</div>;
  });
  const reviewItems = items.filter(item => item.kind === 'review');
  const commentItems = items.filter(item => item.kind === 'comment');
  const empty = comments !== undefined && items.length === 0;

  return <>
    <span className="git-status-panel-header pr-comments-header">
      <strong>PR comments</strong>
      <span className="pr-comments-bar">
        <small className="pr-comments-fetched" role="status">{loading ? 'Loading…' : fetchedAt === undefined ? '' : `Fetched ${new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</small>
        <span className="pr-comments-show">Show</span>
        <button type="button" className="pr-comments-chip" aria-pressed={showResolved} title="Show resolved and outdated review threads" onClick={() => setShowResolved(value => !value)}>Resolved</button>
        <button type="button" className="pr-comments-chip" aria-pressed={showBots} title="Show comments from bots" onClick={() => setShowBots(value => !value)}>Bots</button>
        <button type="button" className={`pr-comments-refresh${loading ? ' progress-border progress-blue' : ''}`} aria-busy={loading || undefined} aria-label="Refresh from GitHub" title="Refresh from GitHub" disabled={loading} onClick={() => void refresh()}>{loading && <span className="update-progress-ring" aria-hidden="true" />}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg></button>
      </span>
    </span>
    <div className="git-status-files pr-comments">
      {error !== undefined && <p className="pr-comments-error" role="alert">{error}</p>}
      {comments === undefined && error === undefined && <p className="pr-comments-empty progress-border progress-blue" role="status" aria-busy="true"><span className="update-progress-ring" aria-hidden="true" />Loading review threads…</p>}
      {empty && <p className="pr-comments-empty">{hiddenThreads + hiddenReviews + hiddenConversation > 0 ? 'Nothing to show. Resolved threads and bot comments are hidden.' : 'No review comments on this PR yet.'}</p>}
      {!empty && comments !== undefined && <>
        {section('thread', 'Review threads', threadItems, hiddenThreads > 0 ? `${hiddenThreads} hidden` : undefined, threadBody)}
        {section('review', 'Review summaries', reviewItems, hiddenReviews > 0 ? `${hiddenReviews} from bots hidden` : undefined, () => reviewItems.map(card))}
        {section('comment', 'Conversation', commentItems, hiddenConversation > 0 ? `${hiddenConversation} from bots hidden` : undefined, () => commentItems.map(card))}
      </>}
      {chosen.length > 0 && <div className="pr-comments-selection">
        <span>{chosen.length} selected</span>
        <button type="button" onClick={() => setSelected(new Set())}>Clear</button>
        <button type="button" className="pr-comment-add" disabled={onAddToPrompt === undefined} onClick={() => add(chosen)}>Add {chosen.length} to prompt</button>
      </div>}
    </div>
  </>;
}
