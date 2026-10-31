import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { age, attentionOrder, freshness, Icon, NoTokenCard, reasonChips, RowCopy, staleNotice, unseen, useSeenRows, waiting, type Item, type Problem, type Request } from './github-overview.js';
import { PanelHeader, PanelIcon, panelIcons, usePanelExpand, usePhoneLayout } from './panel-header.js';
import { hunkClass, hunkLines, threadLines, unresolvedThreadCount, type PullRequestComment, type PullRequestComments, type PullRequestReviewThread } from './pull-request-comments.js';
import { Skeleton } from './skeleton.js';

// The GitHub panel (CONTEXT.md): one Project's Pull requests and Issues beside its Worktrees, the
// same in every Workspace of the Project. Rows are the Overview's: the same reasons, hints and
// unseen marks, and Mine and Review requested are the Overview's own rows. Picking a row shows its
// detail beside the list (in its place on a phone, or in a panel too narrow for both).

/** The item to show: an Overview row (`overview`, outlined as such) or Go to Worktree asked the panel for it. */
export type GithubFocus = { number: number; issue: boolean; overview?: true };
// the server's `GithubPanel` (src/github/service.ts)
type PanelItem = Item & { state?: 'merged' | 'closed' };
type GroupKey = 'mine' | 'reviews' | 'other' | 'done' | 'assigned' | 'issues';
type Lists = Record<GroupKey, PanelItem[]> & { fetchedAt?: number; problem?: Problem };
// the server's `PullRequestDetail` and `IssueDetail`
type Destination = { worktreeId: string; label: string };
type PullDetail = PullRequestComments & {
  repository: string; title: string; state: 'open' | 'merged' | 'closed'; draft: boolean; author?: string; mine: boolean; updatedAt?: string;
  branch: string; baseBranch?: string; mergeable: 'mergeable' | 'conflicting' | 'unknown';
  checkRuns: { name: string; status: 'passed' | 'failed' | 'pending' | 'skipped'; url?: string }[];
  reviewers: { login: string; bot?: true; team?: true; state?: 'approved' | 'changes' | 'commented' | 'dismissed'; requested?: true; newCommits?: true }[];
  linkedIssues: { number: number; title: string; url: string; state: 'open' | 'closed' }[];
  destination?: Destination;
};
type IssueDetail = {
  repository: string; number: number; title: string; url: string; state: 'open' | 'closed'; author?: string; updatedAt?: string; body: string; labels: string[];
  linkedPullRequests: { number: number; title: string; url: string; state: 'open' | 'merged' | 'closed'; draft: boolean }[];
  destination?: Destination;
};
type DetailRead = { pullRequest?: PullDetail; issue?: IssueDetail; fetchedAt?: number; problem?: Problem };
type Selection = { issue: boolean; number: number };
/** Go to a Worktree's Workspace, its GitHub panel showing `focus`. */
export type OpenWorktree = (worktreeId: string, focus: GithubFocus) => void;

const groups: { key: GroupKey; label: string; issue: boolean; collapsed?: true }[] = [
  { key: 'mine', label: 'Mine', issue: false },
  { key: 'reviews', label: 'Review requested', issue: false },
  { key: 'other', label: 'Other open', issue: false, collapsed: true },
  { key: 'done', label: 'Merged or closed, Worktree still here', issue: false },
  { key: 'assigned', label: 'Assigned to me', issue: true },
  { key: 'issues', label: 'Other open', issue: true, collapsed: true }
];
const rowId = (issue: boolean, number: number) => `${issue ? 'issue' : 'pull'}-${number}`;
// a panel narrower than this drills down from the list to a detail, as a phone does
const drillDownWidth = 544;

// whether the panel is on screen: a phone's carousel and an expanded sibling hide it without unmounting it
function useInView(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting === true));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return inView;
}

function PanelRow({ item, issue, showAuthor, now, isNew, here, selected, focused, onSelect }: { item: PanelItem; issue: boolean; showAuthor: boolean; now: number; isNew: boolean; here: boolean; selected: boolean; focused: boolean; onSelect: () => void }) {
  const updated = item.updatedAt === undefined ? Number.NaN : Date.parse(item.updatedAt);
  const status = item.state === undefined ? undefined : <span key="state" className={`overview-chip ${item.state === 'merged' ? 'merged' : 'failing'}`}>{item.state}{Number.isFinite(updated) && ` ${age(updated, now)} ago`}</span>;
  const worktree = item.destination?.label;
  const label = `${issue ? 'Issue' : 'Pull request'} #${item.number} ${item.title}${isNew ? ', new' : ''}${here ? ', here' : worktree === undefined ? '' : `, in ${worktree}`}`;
  return <div className={`overview-row github-row${waiting(item) ? ' waiting' : ''}${isNew ? ' new' : ''}${selected ? ' selected' : ''}${focused ? ' focus' : ''}`} data-row={rowId(issue, item.number)}>
    <button type="button" className="overview-row-main" aria-label={label} aria-current={selected || undefined} onClick={onSelect}>
      <RowCopy item={item} now={now} isNew={isNew} showAuthor={showAuthor} status={status} note={focused && <span className="github-from-overview">from the Overview</span>} />
      {here
        ? <span className="github-here" title="This Worktree">here</span>
        : worktree !== undefined && <span className="overview-destination worktree" title="Its Worktree"><Icon name="branch" />{worktree}</span>}
    </button>
    <a className="overview-row-browser" href={item.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label={`Open #${item.number} on GitHub`}><Icon name="external" /></a>
  </div>;
}

const ago = (iso: string | undefined, now: number) => {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) ? age(at, now) : undefined;
};
const Author = ({ comment, now, extra }: { comment: PullRequestComment; now: number; extra?: ReactNode }) => <span className="github-detail-who">
  <b className={comment.mine ? 'mine' : undefined}>@{comment.author}</b>{comment.bot && <span className="github-bot">bot</span>}<span>{ago(comment.createdAt, now)}</span>{extra}
</span>;
const Comment = ({ comment, now, extra }: { comment: PullRequestComment; now: number; extra?: ReactNode }) => <div className="github-comment"><Author comment={comment} now={now} extra={extra} /><p>{comment.body}</p></div>;
const Empty = ({ children }: { children: ReactNode }) => <p className="overview-none">{children}</p>;

// one detail section, open until its heading is tapped
function Section({ title, count, extra, closed, onToggle, children }: { title: string; count?: number; extra?: ReactNode; closed: boolean; onToggle: () => void; children: ReactNode }) {
  return <section className="github-detail-section" aria-label={title}>
    <button type="button" className="github-group-head" aria-expanded={!closed} onClick={onToggle}>
      {title}{count !== undefined && <span className="overview-count">{count}</span>}{extra !== undefined && <span className="github-detail-extra">{extra}</span>}
      <svg className="overview-icon github-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {!closed && children}
  </section>;
}

// where the item is checked out: here, in another Worktree to go to, or nowhere
function WorktreeStrip({ destination, worktreeId, none, onGoTo }: { destination?: Destination; worktreeId?: string; none?: string; onGoTo?: (worktreeId: string) => void }) {
  if (destination !== undefined && destination.worktreeId === worktreeId) return <div className="github-strip"><Icon name="branch" /><span>Checked out <b>here</b>, in {destination.label}.</span></div>;
  if (destination !== undefined) return <div className="github-strip"><Icon name="branch" /><span>Checked out in <b>{destination.label}</b>.</span>{onGoTo !== undefined && <button type="button" className="github-button go" onClick={() => onGoTo(destination.worktreeId)}>Go to Worktree</button>}</div>;
  return none === undefined ? null : <div className="github-strip none"><Icon name="branch" /><span>{none}</span></div>;
}

const checkOrder = { failed: 0, pending: 1, passed: 2, skipped: 3 } as const;
// one check's mark and what it says (the Overview's say "Checks …" of a whole head)
const checkMark = { passed: ['ok', 'check', 'passed'], failed: ['failing', 'cross', 'failed'], pending: ['pending', 'clock', 'running'], skipped: ['skipped', 'check', 'skipped'] } as const;
const reviewerState = { approved: 'approved', changes: 'requested changes', commented: 'commented', dismissed: 'dismissed' } as const;
// a review summary's GitHub state as a reviewer's
const summaryState: Record<string, keyof typeof reviewerState> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };
const external = (href: string, label: string) => <a key={label} className="github-button" href={href} target="_blank" rel="noreferrer">{label}<Icon name="external" /></a>;

type DetailProps = { now: number; worktreeId?: string; closed: Record<string, boolean>; onToggle: (section: string) => void; onSelect: (selection: Selection) => void; onGoTo?: (worktreeId: string) => void };

function PullRequestView({ pull, item, now, worktreeId, closed, onToggle, onSelect, onGoTo }: DetailProps & { pull: PullDetail; item?: Item }) {
  const [showResolved, setShowResolved] = useState(false);
  const open = pull.state === 'open';
  const here = pull.destination !== undefined && pull.destination.worktreeId === worktreeId;
  const current = (thread: PullRequestReviewThread) => !thread.resolved && !thread.outdated;
  const threads = pull.threads.filter(thread => showResolved || current(thread)).sort((left, right) => left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0));
  const settled = pull.threads.filter(thread => !current(thread)).length;
  const checks = [...pull.checkRuns].sort((left, right) => checkOrder[left.status] - checkOrder[right.status]);
  const failing = checks.filter(check => check.status === 'failed').length;
  const links = open ? pull.mine
    ? [pull.draft ? external(pull.url, 'Ready for review') : external(pull.url, 'Merge')]
    : [external(`${pull.url}/files`, 'Submit review')] : [];
  const section = (key: string, title: string, body: ReactNode, extra: { count?: number; extra?: ReactNode } = {}) => <Section key={key} title={title} {...extra} closed={closed[key] === true} onToggle={() => onToggle(key)}>{body}</Section>;
  let lastPath: string | undefined;
  return <>
    <div className="github-detail-meta">
      <span className={`github-state ${pull.draft && open ? 'draft' : pull.state}`}>{pull.draft && open ? 'draft' : pull.state}</span>
      {pull.author !== undefined && <span>@{pull.author}</span>}
      <span className="github-detail-branch">{pull.branch} → {pull.baseBranch ?? '?'}</span>
      {ago(pull.updatedAt, now) !== undefined && <span>updated {ago(pull.updatedAt, now)} ago</span>}
    </div>
    {item !== undefined && item.reasons.length > 0 && <span className="overview-chips">{reasonChips(item)}</span>}
    <WorktreeStrip destination={pull.destination} worktreeId={worktreeId} none={open ? 'Not checked out.' : undefined} onGoTo={onGoTo} />
    {links.length > 0 && <div className="github-actions">{links}</div>}
    {open && pull.mergeable === 'conflicting' && <div className="github-strip conflict"><Icon name="conflict" /><span>Merge conflicts with {pull.baseBranch ?? 'the base branch'}. {pull.destination === undefined ? 'Check it out in a Worktree to rebase it.' : <>Rebase {here ? 'here' : <>in <b>{pull.destination.label}</b></>}, or let {here ? 'this Worktree\'s' : 'its'} Agent do it with <code>$fixup</code>.</>}</span></div>}
    {section('threads', 'Review threads', <>
      <div className="github-filters">Show <button type="button" className="github-filter" aria-pressed={showResolved} onClick={() => setShowResolved(value => !value)}>Resolved{settled > 0 && ` ${settled}`}</button></div>
      {threads.length === 0 ? <Empty>No unresolved threads.</Empty> : threads.map(thread => {
        const last = thread.comments.at(-1)!;
        // the server's Waiting on me rule: someone else spoke last on a current thread of my non-draft PR
        const onYou = pull.mine && !pull.draft && current(thread) && last.mine !== true;
        const file = thread.path === lastPath ? null : <p className="github-thread-file" title={thread.path}><span>{thread.path.slice(0, thread.path.lastIndexOf('/') + 1)}</span>{thread.path.slice(thread.path.lastIndexOf('/') + 1)}</p>;
        lastPath = thread.path;
        const hunk = thread.diffHunk.split('\n').slice(-hunkLines);
        const line = thread.line === undefined ? undefined : <span>line {threadLines(thread)}</span>;
        return <div key={thread.id}>
          {file}
          <article className={`github-thread${onYou ? ' waiting' : ''}${current(thread) ? '' : ' settled'}`} aria-label={`Review thread on ${thread.path}`}>
            {hunk.some(text => text.trim() !== '') && <pre className="github-hunk">{hunk.map((text, index) => <span key={index} className={hunkClass(text)}>{text}{'\n'}</span>)}</pre>}
            {thread.comments.map(comment => <Comment key={comment.id} comment={comment} now={now} extra={line} />)}
            <div className={`github-thread-bar${onYou ? ' you' : ''}`}>{thread.resolved ? 'resolved' : thread.outdated ? `outdated · @${last.author} spoke last` : last.mine ? 'you spoke last' : onYou ? `waiting on you · @${last.author} spoke last` : `@${last.author} spoke last`}</div>
          </article>
        </div>;
      })}
    </>, { count: unresolvedThreadCount(pull) })}
    {section('checks', 'Checks', checks.length === 0 ? <Empty>No checks.</Empty> : <div className="github-list">{checks.map((check, index) => {
      const [kind, icon, label] = checkMark[check.status];
      const content = <><span className={`overview-checks ${kind}`} role="img" title={label} aria-label={label}><Icon name={icon} /></span><span className="github-list-name">{check.name}</span></>;
      return check.url === undefined ? <span key={index} className="github-list-row">{content}</span> : <a key={index} className="github-list-row" href={check.url} target="_blank" rel="noreferrer">{content}<Icon name="external" /></a>;
    })}</div>, { extra: failing > 0 ? <span className="failing">{failing} failing</span> : `${checks.filter(check => check.status === 'passed').length}/${checks.length} pass` })}
    {section('reviewers', 'Reviewers', pull.reviewers.length === 0 ? <Empty>No reviewers yet.</Empty> : <div className="github-list">{pull.reviewers.map(reviewer => <span key={`${reviewer.team ? 'team:' : ''}${reviewer.login}`} className="github-list-row">
      <span className="github-list-name">{reviewer.team ? reviewer.login : `@${reviewer.login}`}{reviewer.bot && <span className="github-bot">bot</span>}</span>
      <span className={`github-review ${reviewer.state ?? 'pending'}`}>{reviewer.state === undefined ? 'review pending' : reviewerState[reviewer.state]}</span>
      {reviewer.state !== undefined && reviewer.requested && <small>review requested</small>}
      {reviewer.newCommits && <small>new commits since</small>}
    </span>)}</div>, { count: pull.reviewers.length })}
    {pull.linkedIssues.length > 0 && section('issues', 'Linked issues', <div className="github-list">{pull.linkedIssues.map(issue => <button key={issue.number} type="button" className="github-list-row" onClick={() => onSelect({ issue: true, number: issue.number })}>
      <Icon name="issue" /><span className="github-list-name">#{issue.number} {issue.title}</span><small>{issue.state === 'open' ? 'closes' : 'closed'}</small>
    </button>)}</div>, { count: pull.linkedIssues.length })}
    {section('description', 'Description', pull.description === undefined ? <Empty>No description.</Empty> : <p className="github-detail-text">{pull.description.body}</p>)}
    {section('reviews', 'Review summaries', pull.reviews.length === 0 ? <Empty>None.</Empty> : pull.reviews.map(review => <Comment key={review.id} comment={review} now={now} extra={<span className={`github-review ${summaryState[review.state] ?? 'commented'}`}>{reviewerState[summaryState[review.state] ?? 'commented']}</span>} />), { count: pull.reviews.length })}
    {section('conversation', 'Conversation', pull.comments.length === 0 ? <Empty>None.</Empty> : pull.comments.map(comment => <Comment key={comment.id} comment={comment} now={now} />), { count: pull.comments.length })}
  </>;
}

function IssueView({ issue, now, worktreeId, closed, onToggle, onSelect, onGoTo }: DetailProps & { issue: IssueDetail }) {
  const section = (key: string, title: string, body: ReactNode, count?: number) => <Section title={title} count={count} closed={closed[key] === true} onToggle={() => onToggle(key)}>{body}</Section>;
  return <>
    <div className="github-detail-meta">
      <span className={`github-state ${issue.state}`}>{issue.state}</span>
      {issue.author !== undefined && <span>@{issue.author}</span>}
      {ago(issue.updatedAt, now) !== undefined && <span>updated {ago(issue.updatedAt, now)} ago</span>}
    </div>
    {issue.labels.length > 0 && <span className="overview-chips">{issue.labels.map(label => <span key={label} className="overview-chip label">{label}</span>)}</span>}
    <WorktreeStrip destination={issue.destination} worktreeId={worktreeId} none="No Worktree for this Issue." onGoTo={onGoTo} />
    {section('description', 'Description', issue.body.trim() === '' ? <Empty>No description.</Empty> : <p className="github-detail-text">{issue.body}</p>)}
    {section('linked', issue.linkedPullRequests.length > 1 ? 'Linked pull requests' : 'Linked pull request', issue.linkedPullRequests.length === 0 ? <Empty>None yet.</Empty> : <div className="github-list">{issue.linkedPullRequests.map(pull => <button key={pull.number} type="button" className="github-list-row" onClick={() => onSelect({ issue: false, number: pull.number })}>
      <Icon name="pull" /><span className="github-list-name">#{pull.number} {pull.title}</span><small>{pull.draft && pull.state === 'open' ? 'draft' : pull.state}</small>
    </button>)}</div>, issue.linkedPullRequests.length)}
    <div className="github-actions">{external(issue.url, 'Assign / label')}</div>
  </>;
}

/**
 * One pull request's or Issue's detail, read when it is picked and again when `revision` moves
 * (the server answers from what it kept while the item is unchanged). `item` is its list row, for
 * its reason chips; `refreshes` counts the header's Refresh taps, each read again from GitHub.
 */
function Detail({ request, projectId, selection, item, revision, refreshes, focused, back, ...props }: Omit<DetailProps, 'closed' | 'onToggle'> & { request: Request; projectId: string; selection: Selection; item?: Item; revision: string; refreshes: number; focused: boolean; back?: () => void }) {
  // sections the operator folded on this item; each item opens with every one expanded
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const sections = { closed, onToggle: (section: string) => setClosed(current => ({ ...current, [section]: !current[section] })) };
  const key = `${selection.issue ? 'issues' : 'pulls'}/${selection.number}`;
  // the panel keys this by item, so what it read is always the item's
  const [read, setRead] = useState<{ detail?: DetailRead; unreachable?: true }>();
  const lastRefresh = useRef(refreshes);
  useEffect(() => {
    let current = true;
    const fresh = lastRefresh.current !== refreshes;
    lastRefresh.current = refreshes;
    void request(`/api/projects/${encodeURIComponent(projectId)}/github/${key}${fresh ? '?refresh=1' : ''}`)
      .then(async response => { if (!response.ok) throw new Error(); return await response.json() as DetailRead; })
      .then(detail => { if (current) setRead({ detail }); }, () => { if (current) setRead(previous => ({ ...previous, unreachable: true })); });
    return () => { current = false; };
  }, [request, projectId, key, revision, refreshes]);
  const detail = read?.detail;
  const found = detail?.pullRequest ?? detail?.issue;
  const kind = selection.issue ? 'Issue' : 'Pull request';
  let body: ReactNode;
  if (found === undefined && detail?.problem?.kind === 'no-token') body = <NoTokenCard />;
  else if (found === undefined && (detail?.problem !== undefined || read?.unreachable)) body = <div className="overview-card"><h3>{kind} #{selection.number} could not be read</h3><p>{detail?.problem?.message ?? 'The console could not be reached.'}</p></div>;
  else if (found === undefined) body = <div className="github-detail-loading" role="status" aria-label={`Loading ${kind} #${selection.number}`} aria-busy="true"><Skeleton className="overview-skeleton-title" /><Skeleton className="overview-skeleton-meta" /><Skeleton className="overview-skeleton-meta" /></div>;
  else body = detail?.pullRequest !== undefined ? <PullRequestView pull={detail.pullRequest} item={item} {...props} {...sections} /> : <IssueView issue={detail!.issue!} {...props} {...sections} />;
  return <article className="github-detail" aria-label={`${kind} #${selection.number}`}>
    {(back !== undefined || focused) && <div className="github-detail-crumbs">
      {back !== undefined && <button type="button" className="github-button" onClick={back}>‹ All</button>}
      {focused && <span className="github-from-overview">from the Overview</span>}
    </div>}
    <header className="github-detail-head">
      <h3><span className="overview-row-number">#{selection.number}</span>{found?.title ?? item?.title}</h3>
      {(found?.url ?? item?.url) !== undefined && <a className="overview-row-browser" href={found?.url ?? item?.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label="Open on GitHub"><Icon name="external" /></a>}
    </header>
    {found !== undefined && detail?.problem !== undefined && <p className="github-detail-problem" role="status">{detail.problem.message}</p>}
    {body}
  </article>;
}

/**
 * The GitHub panel's lists and the picked item's detail. `repository` is the Project's `owner/name`
 * on github.com (none in a Place without one, which shows why instead); `worktreeId` is the Place's
 * own Worktree, whose pull request is pinned on top unless it is the `main` worktree, and shown
 * when nothing is picked in a wide panel. `revision` changes when GitHub's data or the Worktrees
 * change, and the lists and detail are read again then. `focus` is an item to select;
 * `onOpenWorktree` is Go to Worktree.
 */
export function GithubPanel({ request, projectId, repository, worktreeId, main, branch, hasPullRequest, revision, focus, onClose, onOpenWorktree }: { request: Request; projectId?: string; repository?: string; worktreeId?: string; main: boolean; branch?: string; hasPullRequest: boolean; revision: string; focus?: GithubFocus; onClose: () => void; onOpenWorktree?: OpenWorktree }) {
  const ref = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  // a phone, or a panel too narrow for the list and the detail side by side, drills down from one to the other
  const phone = usePhoneLayout() || narrow;
  const [lists, setLists] = useState<Lists>();
  const [unreachable, setUnreachable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState<Partial<Record<GroupKey, boolean>>>({});
  const [selected, setSelected] = useState<Selection | undefined>(focus === undefined ? undefined : { issue: focus.issue, number: focus.number });
  // the row an Overview tap brought here, outlined until another is picked
  const [focused, setFocused] = useState<string>();
  const inView = useInView(ref);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (pane === null) return;
    const measure = () => {
      const width = pane.getBoundingClientRect().width;
      // a hidden panel measures zero; keep its last layout
      if (width > 0) setNarrow(width < drillDownWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    measure();
    return () => observer.disconnect();
  }, []);
  const expanded = usePanelExpand('github')?.expanded === true;
  const load = useCallback(async (refresh: boolean) => {
    if (projectId === undefined) return;
    try {
      const response = await request(`/api/projects/${encodeURIComponent(projectId)}/github${refresh ? '?refresh=1' : ''}`);
      if (!response.ok) throw new Error();
      setLists(await response.json() as Lists);
      setUnreachable(false);
    } catch { setUnreachable(true); }
    setNow(Date.now());
  }, [request, projectId]);
  useEffect(() => { void load(false); }, [load, revision]);
  // keep "updated … ago" and row ages moving
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  // show the asked-for item at once; once it is listed, open its group and, for an Overview row, outline it
  const pendingFocus = useRef(focus);
  useEffect(() => {
    pendingFocus.current = focus;
    if (focus !== undefined) setSelected({ issue: focus.issue, number: focus.number });
  }, [focus]);
  useEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted === undefined || lists === undefined) return;
    const group = groups.find(({ key, issue }) => issue === wanted.issue && lists[key].some(item => item.number === wanted.number));
    if (group === undefined) return;
    pendingFocus.current = undefined;
    const id = rowId(wanted.issue, wanted.number);
    setCollapsed(current => ({ ...current, [group.key]: false }));
    if (wanted.overview) setFocused(id);
    window.requestAnimationFrame(() => ref.current?.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [lists, focus]);
  const refresh = async () => {
    setRefreshing(true);
    setRefreshes(count => count + 1);
    await load(true);
    setRefreshing(false);
  };

  const listed = lists !== undefined && lists.fetchedAt !== undefined && lists.problem?.kind !== 'no-token';
  // This Worktree's pull request: an open one before a merged or closed one
  const pinned = main || worktreeId === undefined || lists === undefined ? undefined
    : groups.filter(group => !group.issue).flatMap(group => lists[group.key].map(item => ({ item, group }))).filter(({ item }) => item.destination?.worktreeId === worktreeId).sort((a, b) => Number(a.item.state !== undefined) - Number(b.item.state !== undefined))[0];
  // a wide panel shows This Worktree's pull request until another is picked; drilling down starts at the list
  const shownSelection = selected ?? (phone || pinned === undefined ? undefined : { issue: false, number: pinned.item.number });
  const listItem = (selection: Selection | undefined) => selection === undefined || lists === undefined ? undefined : groups.filter(group => group.issue === selection.issue).flatMap(group => lists[group.key]).find(item => item.number === selection.number);
  const shownItem = listItem(shownSelection);
  const open = (key: GroupKey) => !(collapsed[key] ?? groups.find(group => group.key === key)?.collapsed === true);
  const listShown = !phone || shownSelection === undefined;
  // the rows on screen, and an open detail, count as shown
  const shown = lists === undefined ? [] : [...listShown ? [...pinned === undefined ? [] : [pinned.item], ...groups.filter(group => open(group.key)).flatMap(group => lists[group.key])] : [], ...shownItem === undefined ? [] : [shownItem]];
  const isNew = useSeenRows(request, shown, listed && inView);
  const select = (selection: Selection) => {
    setSelected(selection);
    setFocused(current => current === rowId(selection.issue, selection.number) ? current : undefined);
  };

  const row = (item: PanelItem, group: (typeof groups)[number]) => {
    const id = rowId(group.issue, item.number);
    const isSelected = shownSelection !== undefined && rowId(shownSelection.issue, shownSelection.number) === id;
    return <PanelRow key={id} item={item} issue={group.issue} showAuthor={group.key !== 'mine'} now={now} isNew={isNew(item)} here={worktreeId !== undefined && item.destination?.worktreeId === worktreeId} selected={isSelected} focused={focused === id} onSelect={() => select({ issue: group.issue, number: item.number })} />;
  };
  const section = (group: (typeof groups)[number]) => {
    const rows = (lists?.[group.key] ?? []).filter(item => pinned === undefined || group.issue || item !== pinned.item);
    if (rows.length === 0) return null;
    const expanded = open(group.key);
    const waits = rows.filter(waiting).length;
    const fresh = rows.filter(unseen).length;
    return <section key={group.key} className="github-group" aria-label={`${group.issue ? 'Issues' : 'Pull requests'}: ${group.label}`}>
      <button type="button" className="github-group-head" aria-expanded={expanded} onClick={() => setCollapsed(current => ({ ...current, [group.key]: expanded }))}>
        {group.label}<span className="overview-count">{rows.length}</span>{waits > 0 && <span className="overview-waits">{waits} waiting</span>}{!expanded && fresh > 0 && <span className="overview-waits">{fresh} new</span>}
        <svg className="overview-icon github-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {expanded && <div className="github-rows">{attentionOrder(rows, isNew).map(item => row(item, group))}</div>}
    </section>;
  };

  const problem = lists?.problem;
  const banner = staleNotice(lists, unreachable, now);
  let body: ReactNode;
  let split = false;
  if (repository === undefined || projectId === undefined) body = <div className="overview-card"><h3>Not a GitHub repository</h3><p>This Place has no github.com origin, so the GitHub panel has nothing to show here. The Overview still lists your pull requests, review requests and issues from every repository.</p><a className="github-overview-link" href="#overview">Open the Overview</a></div>;
  else if (problem?.kind === 'no-token') body = <NoTokenCard />;
  else if (lists === undefined && unreachable) body = <div className="overview-card"><h3>The console could not be reached</h3><p>The GitHub panel loads once the console answers again.</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;
  else if (lists === undefined || (lists.fetchedAt === undefined && problem === undefined)) body = <div className="overview-skeletons" role="status" aria-label="Loading the GitHub panel" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div className="overview-skeleton" key={index}><Skeleton className="overview-skeleton-title" /><Skeleton className="overview-skeleton-meta" /></div>)}</div>;
  else if (lists.fetchedAt === undefined) body = <div className="overview-card"><h3>GitHub is unreachable</h3><p>{problem?.message}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;
  else {
    const kind = (issue: boolean) => groups.filter(group => group.issue === issue).map(section).filter(Boolean);
    const [pulls, issues] = [kind(false), kind(true)];
    const list = <>
      {!main && worktreeId !== undefined && (pinned !== undefined || !hasPullRequest) && <section className="github-pinned" aria-label="This Worktree">
        <h4 className="github-kind"><Icon name="branch" />This Worktree</h4>
        {pinned !== undefined
          ? row(pinned.item, pinned.group)
          // Push and create PR takes this spot
          : <div className="github-create"><b>{branch ?? 'This branch'}</b><span>No pull request yet.</span></div>}
      </section>}
      <h4 className="github-kind">Pull requests</h4>
      {pulls.length > 0 ? pulls : <p className="overview-none">No open pull requests.</p>}
      <h4 className="github-kind">Issues</h4>
      {issues.length > 0 ? issues : <p className="overview-none">No open issues.</p>}
    </>;
    const detail = shownSelection === undefined ? undefined : <Detail key={rowId(shownSelection.issue, shownSelection.number)} request={request} projectId={projectId} selection={shownSelection} item={shownItem} revision={revision} refreshes={refreshes} focused={focused === rowId(shownSelection.issue, shownSelection.number)} now={now} worktreeId={worktreeId} onSelect={select} onGoTo={onOpenWorktree === undefined ? undefined : target => onOpenWorktree(target, shownSelection)} {...(phone ? { back: () => { setSelected(undefined); setFocused(undefined); } } : {})} />;
    split = !phone;
    body = phone
      ? detail ?? list
      : <><div className="github-list-column">{list}</div><div className="github-detail-column">{detail ?? <p className="github-detail-placeholder">Pick a pull request or issue.</p>}</div></>;
  }

  return <section ref={ref} className={`github-pane${expanded ? ' expanded' : ''}`} role="region" aria-label="GitHub">
    <PanelHeader panelKey="github" label="GitHub" title={<span className="github-pane-title">GitHub{repository !== undefined && <> · {repository}</>}</span>} actions={<>
      {listed && <span className="github-freshness">{freshness(lists.fetchedAt!, now)}</span>}
      {repository !== undefined && <button type="button" className="panel-header-action" aria-label="Refresh" title="Refresh now" disabled={refreshing} aria-busy={refreshing || undefined} onClick={() => void refresh()}><PanelIcon path={panelIcons.refresh} /></button>}
    </>} close={{ key: 'close', label: 'Close GitHub panel', icon: <PanelIcon path={panelIcons.close} />, onSelect: onClose }} />
    {banner !== undefined && <div className="overview-banner" role="status"><Icon name="clock" /><span>{banner}</span><button type="button" onClick={() => void refresh()} disabled={refreshing}>Retry</button></div>}
    <div className={`github-pane-body${split ? ' split' : ''}`}>{body}</div>
  </section>;
}
