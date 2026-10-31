import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Skeleton } from './skeleton.js';

// The Overview (CONTEXT.md): the operator's Pull requests, Review requests and assigned Issues
// across every repository, as the server's GitHub module last read them, with what is Waiting on
// me called out by reason. It replaces the Workspace while open; the tab row stays.

// the server's `Overview` (src/github/service.ts), which the web cannot import: its module graph
// reaches Node-only code
export type Request = (url: string, init?: RequestInit) => Promise<Response>;
type Reason =
  | { kind: 'thread'; id: string; author: string; path: string }
  | { kind: 'checks' }
  | { kind: 'conflicts' }
  | { kind: 'changes'; id: string; author: string }
  | { kind: 'review'; reRequested?: true };
export type Item = {
  repository: string; number: number; title: string; url: string; author?: string; updatedAt?: string;
  draft?: true; checks?: 'passed' | 'pending' | 'failed'; reasons: Reason[]; unseen?: string[];
  newCommits?: true; approved?: true; closes?: number[]; linkedPullRequests?: number[]; labels?: string[];
  destination?: { kind: 'worktree' | 'project'; worktreeId: string; label: string };
};
export type Problem = { kind: 'no-token' | 'rate-limited' | 'failing'; message: string; until?: number };
type Overview = { mine: Item[]; reviews: Item[]; issues: Item[]; totals: { mine: number; reviews: number; issues: number }; fetchedAt?: number; problem?: Problem };
export type ColumnKey = 'mine' | 'reviews' | 'issues';

const columns: { key: ColumnKey; label: string; tab: string; icon: keyof typeof icons; search: string }[] = [
  { key: 'mine', label: 'My pull requests', tab: 'Mine', icon: 'pull', search: 'is:pr is:open author:@me archived:false' },
  { key: 'reviews', label: 'Review requests', tab: 'Reviews', icon: 'review', search: 'is:pr is:open review-requested:@me archived:false' },
  { key: 'issues', label: 'Assigned issues', tab: 'Issues', icon: 'issue', search: 'is:issue is:open assignee:@me archived:false' }
];

export const icons = {
  pull: <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12" /></>,
  review: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  issue: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="1.5" /></>,
  thread: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  cross: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="M20 6 9 17l-5-5" />,
  conflict: <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></>,
  external: <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  branch: <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="8" r="2" /><path d="M6 8v8M18 10c0 4-6 3-10 6" /></>,
  folder: <path d="M3 7h7l2 2h9v10H3z" />
};

export const Icon = ({ name }: { name: keyof typeof icons }) => <svg className="overview-icon" viewBox="0 0 24 24" aria-hidden="true">{icons[name]}</svg>;

// how long ago, briefly: 5m, 3h, 2d, 3w, 4mo, 1y
export function age(from: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - from) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return days < 365 ? `${Math.floor(days / 30)}mo` : `${Math.floor(days / 365)}y`;
}

export const waiting = (item: Item) => item.reasons.length > 0;
export const unseen = (item: Item) => (item.unseen?.length ?? 0) > 0;
// how long a row is shown before its reasons count as seen
const seenAfterMs = 700;
const basename = (path: string) => path.split('/').pop() ?? path;

// one chip per reason, except threads, which share one
export function reasonChips(item: Item): ReactNode[] {
  const threads = item.reasons.filter((reason): reason is Extract<Reason, { kind: 'thread' }> => reason.kind === 'thread');
  const authors = [...new Set(threads.map(thread => `@${thread.author}`))];
  const chips: ReactNode[] = [];
  if (threads.length === 1) chips.push(<span key="thread" className="overview-chip thread"><Icon name="thread" />{authors[0]} on {basename(threads[0]!.path)}</span>);
  else if (threads.length > 1) chips.push(<span key="thread" className="overview-chip thread"><Icon name="thread" />{threads.length} threads · {authors.slice(0, 2).join(', ')}{authors.length > 2 ? ` +${authors.length - 2}` : ''}</span>);
  item.reasons.forEach((reason, index) => {
    if (reason.kind === 'checks') chips.push(<span key="checks" className="overview-chip failing"><Icon name="cross" />checks failing</span>);
    if (reason.kind === 'conflicts') chips.push(<span key="conflicts" className="overview-chip conflicts"><Icon name="conflict" />merge conflicts</span>);
    if (reason.kind === 'changes') chips.push(<span key={`changes-${index}`} className="overview-chip failing"><Icon name="cross" />@{reason.author} requested changes</span>);
    if (reason.kind === 'review') chips.push(reason.reRequested ? <span key="review" className="overview-chip rerequested"><Icon name="refresh" />Re-requested</span> : <span key="review" className="overview-chip requested"><Icon name="review" />Review requested</span>);
  });
  return chips;
}

function hintChips(item: Item): ReactNode[] {
  return [
    item.newCommits && <span key="commits" className="overview-chip soft">new commits since your review</span>,
    item.approved && <span key="approved" className="overview-chip approved"><Icon name="check" />approved</span>,
    item.draft && <span key="draft" className="overview-chip soft">draft</span>,
    ...(item.closes ?? []).map(number => <span key={`closes-${number}`} className="overview-chip soft">closes #{number}</span>),
    ...(item.linkedPullRequests ?? []).map(number => <span key={`linked-${number}`} className="overview-chip soft"><Icon name="pull" />#{number}</span>),
    ...(item.labels ?? []).map(label => <span key={`label-${label}`} className="overview-chip label">{label}</span>)
  ].filter(Boolean);
}

const checksMark = { passed: ['ok', 'check', 'Checks pass'], failed: ['failing', 'cross', 'Checks failing'], pending: ['pending', 'clock', 'Checks running'] } as const;

/**
 * A row's copy, the same in the Overview and the GitHub panel: the new dot, number and title; the
 * author (unless `showAuthor` is off), age and checks mark, then `note`; the reason chips, then
 * `status`, then the hints.
 */
export function RowCopy({ item, now, isNew, showAuthor, status, note }: { item: Item; now: number; isNew: boolean; showAuthor: boolean; status?: ReactNode; note?: ReactNode }) {
  const mark = item.checks === undefined ? undefined : checksMark[item.checks];
  const chips = [...reasonChips(item), ...(status === undefined ? [] : [status]), ...hintChips(item)];
  const updated = item.updatedAt === undefined ? Number.NaN : Date.parse(item.updatedAt);
  return <span className="overview-row-copy">
    <span className="overview-row-title">{isNew && <i className="overview-new-dot" title="New since you last looked" />}<span className="overview-row-number">#{item.number}</span>{item.title}</span>
    <span className="overview-row-meta">
      {showAuthor && item.author !== undefined && <span>@{item.author}</span>}
      {Number.isFinite(updated) && <span>{age(updated, now)}</span>}
      {mark !== undefined && <span className={`overview-checks ${mark[0]}`} title={mark[2]} aria-label={mark[2]}><Icon name={mark[1]} />checks</span>}
      {note}
    </span>
    {chips.length > 0 && <span className="overview-chips">{chips}</span>}
  </span>;
}

function Row({ item, column, now, isNew, onOpen }: { item: Item; column: ColumnKey; now: number; isNew: boolean; onOpen: OpenItem }) {
  const destination = item.destination;
  const content = <>
    <RowCopy item={item} now={now} isNew={isNew} showAuthor={column !== 'mine'} />
    {destination === undefined
      ? <span className="overview-destination" title="No Project for this repository: opens on github.com"><Icon name="external" />github.com</span>
      : <span className={`overview-destination ${destination.kind}`} title={destination.kind === 'worktree' ? 'Opens this Worktree\'s Workspace' : 'Opens the Project\'s main worktree'}><Icon name={destination.kind === 'worktree' ? 'branch' : 'folder'} />{destination.label}</span>}
  </>;
  const label = `#${item.number} ${item.title}${isNew ? ', new' : ''}`;
  return <div className={`overview-row${waiting(item) ? ' waiting' : ''}${isNew ? ' new' : ''}`}>
    {destination === undefined
      ? <a className="overview-row-main" href={item.url} target="_blank" rel="noreferrer" aria-label={`${label}, on GitHub`}>{content}</a>
      : <button className="overview-row-main" type="button" aria-label={`${label}, in ${destination.label}`} onClick={() => onOpen(destination.worktreeId, item, column)}>{content}</button>}
    {destination !== undefined && <a className="overview-row-browser" href={item.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label={`Open #${item.number} on GitHub`}><Icon name="external" /></a>}
  </div>;
}

// a column's rows by repository: those holding something new first, then the busiest, then by
// name; in each, Waiting on me rows first, new ones first among those
function RepositoryGroups({ items, column, now, isNew, onOpen }: { items: Item[]; column: ColumnKey; now: number; isNew: (item: Item) => boolean; onOpen: OpenItem }) {
  if (items.length === 0) return <p className="overview-none">None.</p>;
  const groups = new Map<string, Item[]>();
  for (const item of items) groups.set(item.repository, [...groups.get(item.repository) ?? [], item]);
  const count = (rows: Item[]) => rows.filter(waiting).length;
  const holdsNew = (rows: Item[]) => rows.some(isNew) ? 1 : 0;
  const sorted = [...groups].sort(([left, a], [right, b]) => holdsNew(b) - holdsNew(a) || count(b) - count(a) || left.localeCompare(right));
  return <>{sorted.map(([repository, rows]) => {
    const [owner, name] = repository.split('/');
    const waits = count(rows);
    return <section key={repository} className="overview-repository" aria-label={repository}>
      <h4 className="overview-repository-head"><span>{owner}/<b>{name}</b></span>{rows.some(row => row.destination !== undefined) && <span className="overview-project" title="Has a Project" aria-label="Has a Project"><Icon name="folder" /></span>}{waits > 0 && <span className="overview-waits" title={`${waits} waiting on me`}>{waits}</span>}</h4>
      {attentionOrder(rows, isNew).map(item => <Row key={item.url} item={item} column={column} now={now} isNew={isNew(item)} onOpen={onOpen} />)}
    </section>;
  })}</>;
}

/** Opens a row with a destination in its Worktree's (or Project's) Workspace. */
export type OpenItem = (worktreeId: string, item: Item, column: ColumnKey) => void;

/** Rows in the order they ask for attention: Waiting on me first, new ones first among those. */
export function attentionOrder<T extends Item>(rows: readonly T[], isNew: (item: T) => boolean): T[] {
  return [...rows.filter(row => waiting(row) && isNew(row)), ...rows.filter(row => waiting(row) && !isNew(row)), ...rows.filter(row => !waiting(row))];
}

/**
 * Report the unseen reasons of the rows on screen (`shown`, while `active` and the page is
 * visible) seen once they have shown a moment; the server's badge drops on every device. Returns
 * whether a row is new this visit: unseen, or shown unseen earlier in it, so its mark stays after
 * the server counts it seen.
 */
export function useSeenRows(request: Request, shown: readonly Item[], active: boolean): (item: Item) => boolean {
  const [shownNew, setShownNew] = useState<ReadonlySet<string>>(() => new Set());
  const reported = useRef(new Set<string>());
  // a hidden page shows nothing, so it marks nothing seen
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const rows = shown.filter(unseen);
  const pending = [...new Set(rows.flatMap(item => item.unseen ?? []))].filter(key => !reported.current.has(key));
  const latest = useRef(rows);
  latest.current = rows;
  // the keys travel as one string, so the timer restarts only when they change
  const signature = pending.join('\n');
  useEffect(() => {
    if (!active || !visible || signature === '') return;
    const keys = signature.split('\n');
    const timer = window.setTimeout(() => {
      for (const key of keys) reported.current.add(key);
      setShownNew(previous => new Set([...previous, ...latest.current.map(item => item.url)]));
      void request('/api/github/overview/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) })
        .then(response => { if (!response.ok) throw new Error(); })
        // a report that did not land is sent again with the next lists
        .catch(() => { for (const key of keys) reported.current.delete(key); });
    }, seenAfterMs);
    return () => window.clearTimeout(timer);
  }, [active, visible, signature, request]);
  return item => unseen(item) || shownNew.has(item.url);
}

/** What the yellow banner says when the lists shown are older than they should be; nothing while they are current. */
export function staleNotice(lists: { fetchedAt?: number; problem?: Problem } | undefined, unreachable: boolean, now: number): string | undefined {
  const staleSince = lists?.fetchedAt === undefined ? '' : ` Showing what was fetched ${age(lists.fetchedAt, now)} ago.`;
  const problem = lists?.problem;
  if (unreachable && lists !== undefined) return `The console could not be reached.${staleSince}`;
  if (problem === undefined || problem.kind === 'no-token' || lists?.fetchedAt === undefined) return undefined;
  return `${problem.kind === 'rate-limited' && problem.until !== undefined ? `GitHub's rate limit holds requests until ${new Date(problem.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'GitHub is unreachable.'}${staleSince}`;
}

export const NoTokenCard = () => <div className="overview-card"><h3>No GitHub token</h3><p>The server found no GitHub token. Run <code>gh auth login</code> on the host so the token lands in <code>~/.config/gh/hosts.yml</code>, or set <code>RAC_GITHUB_TOKEN</code> and restart the console.</p></div>;

// when GitHub was last read, coarsely
export const freshness = (fetchedAt: number, now: number) => now - fetchedAt < 60_000 ? 'updated just now' : `updated ${age(fetchedAt, now)} ago`;

/**
 * The Overview: three columns (tabs on a phone) grouped by repository. `revision` changes when the
 * server's GitHub data or the console's Worktrees change, and the lists are read again then.
 */
export function GithubOverview({ request, revision, phone, onClose, onOpen }: { request: Request; revision: string; phone: boolean; onClose: () => void; onOpen: OpenItem }) {
  const [overview, setOverview] = useState<Overview>();
  const [unreachable, setUnreachable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<ColumnKey>('mine');
  const [now, setNow] = useState(() => Date.now());
  // a phone opens on the first tab holding something unseen, once the lists first land
  const tabChosen = useRef(false);
  const load = useCallback(async (refresh: boolean) => {
    try {
      const response = await request(`/api/github/overview${refresh ? '?refresh=1' : ''}`);
      if (!response.ok) throw new Error();
      const next = await response.json() as Overview;
      setOverview(next);
      if (!tabChosen.current && next.fetchedAt !== undefined) {
        tabChosen.current = true;
        setTab(columns.find(({ key }) => next[key].some(unseen))?.key ?? 'mine');
      }
      setUnreachable(false);
    } catch { setUnreachable(true); }
    setNow(Date.now());
  }, [request]);
  useEffect(() => { void load(false); }, [load, revision]);
  // keep "updated … ago" and row ages moving
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]') !== null)) return;
      // a flyout or dialog over the Overview takes Esc first
      if (document.querySelector('.flyout-backdrop, [role="dialog"][aria-modal="true"]') !== null) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };
  // the rows on screen (every column, or a phone's open tab) count as seen once shown a moment
  const listed = overview !== undefined && overview.fetchedAt !== undefined && overview.problem?.kind !== 'no-token';
  const isNew = useSeenRows(request, overview === undefined ? [] : phone ? overview[tab] : [...overview.mine, ...overview.reviews], listed);

  const problem = overview?.problem;
  const items = overview === undefined ? [] : [...overview.mine, ...overview.reviews, ...overview.issues];
  const waits = overview === undefined ? 0 : [...overview.mine, ...overview.reviews].filter(waiting).length;
  const newCount = items.filter(isNew).length;
  const summary = listed ? <span className="overview-summary">{waits > 0 ? <><b>{waits}</b> waiting on me</> : 'Nothing waiting on me'}{newCount > 0 && <> · <b>{newCount}</b> new</>}</span> : null;
  const banner = staleNotice(overview, unreachable, now);

  let body: ReactNode;
  if (problem?.kind === 'no-token') body = <NoTokenCard />;
  else if (overview === undefined && unreachable) body = <div className="overview-card"><h3>The console could not be reached</h3><p>The Overview loads once the console answers again.</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;
  else if (overview === undefined || (overview.fetchedAt === undefined && problem === undefined)) body = <div className="overview-skeletons" role="status" aria-label="Loading the Overview" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div className="overview-skeleton" key={index}><Skeleton className="overview-skeleton-title" /><Skeleton className="overview-skeleton-meta" /></div>)}</div>;
  else if (overview.fetchedAt === undefined) body = <div className="overview-card"><h3>GitHub is unreachable</h3><p>{problem?.message}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;
  else if (items.length === 0) body = <div className="overview-card"><h3>Nothing open</h3><p>You have no open pull requests, review requests or assigned issues in any repository you can access.</p></div>;
  else {
    const column = (key: ColumnKey) => {
      const { label, icon, search } = columns.find(candidate => candidate.key === key)!;
      const rows = overview[key];
      const waits = rows.filter(waiting).length;
      const more = overview.totals[key] - rows.length;
      return <section key={key} className="overview-column" aria-label={label}>
        {!phone && <header className="overview-column-head"><Icon name={icon} /><h3>{label}</h3><span className="overview-count">{overview.totals[key]}</span>{waits > 0 && <span className="overview-waits">{waits} waiting on me</span>}</header>}
        <div className="overview-column-body">
          <RepositoryGroups items={rows} column={key} now={now} isNew={isNew} onOpen={onOpen} />
          {more > 0 && <a className="overview-more" href={`https://github.com/search?type=issues&q=${encodeURIComponent(search)}`} target="_blank" rel="noreferrer">{more} more on github.com</a>}
        </div>
      </section>;
    };
    body = phone
      ? <><div className="overview-tabs" role="tablist" aria-label="Overview lists">{columns.map(({ key, tab: name }) => {
        const [waits, total] = [overview[key].filter(waiting).length, overview.totals[key]];
        return <button key={key} type="button" role="tab" aria-selected={tab === key} aria-label={`${name}, ${total}${waits > 0 ? `, ${waits} waiting on me` : ''}`} className={tab === key ? 'active' : ''} onClick={() => { tabChosen.current = true; setTab(key); }}>{name}<span className="overview-count">{total}</span>{waits > 0 && <span className="overview-waits" title="Waiting on me">{waits}</span>}{overview[key].some(unseen) && <i className="overview-tab-dot" role="img" aria-label="Holds something new" />}</button>;
      })}</div>{column(tab)}</>
      : <div className="overview-columns">{columns.map(({ key }) => column(key))}</div>;
  }

  return <section className={`overview${phone ? ' phone' : ''}`} aria-label="Overview">
    <header className="overview-head">
      <div className="overview-title"><small>GITHUB</small><h2>Overview</h2></div>
      {!phone && summary}
      <span className="overview-grow" />
      {listed && <span className="overview-freshness">{freshness(overview.fetchedAt!, now)}</span>}
      <button type="button" className="overview-action" aria-label="Refresh" title="Refresh now" disabled={refreshing} aria-busy={refreshing || undefined} onClick={() => void refresh()}><Icon name="refresh" /></button>
      <button type="button" className="overview-action" aria-label="Close Overview" title="Back to the Workspace (Esc)" onClick={onClose}><Icon name="cross" /></button>
    </header>
    {phone && summary !== null && <div className="overview-subhead">{summary}</div>}
    {banner !== undefined && <div className="overview-banner" role="status"><Icon name="clock" /><span>{banner}</span><button type="button" onClick={() => void refresh()} disabled={refreshing}>Retry</button></div>}
    <div className={`overview-body${phone ? '' : ' columns'}`}>{body}</div>
  </section>;
}

/**
 * The tab row's Overview button: it toggles the Overview, shows active while it is open, and
 * counts the Pull requests holding something the operator has not been shown (a corner badge on a
 * phone).
 */
export function OverviewButton({ open, phone, badge, onToggle }: { open: boolean; phone: boolean; badge: number; onToggle: () => void }) {
  return <button type="button" className={`overview-button${open ? ' active' : ''}`} aria-pressed={open} aria-label={badge > 0 ? `Overview, ${badge} new` : 'Overview'} title={`Overview: pull requests, review requests and issues${badge > 0 ? ` (${badge} new)` : ''}`} onClick={onToggle}><Icon name="pull" />{!phone && <span>Overview</span>}{badge > 0 && <span className={`overview-badge${phone ? ' corner' : ''}`}>{badge}</span>}</button>;
}
