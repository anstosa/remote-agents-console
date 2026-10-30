import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Skeleton } from './skeleton.js';

// The Overview (CONTEXT.md): the operator's Pull requests, Review requests and assigned Issues
// across every repository, as the server's GitHub module last read them, with what is Waiting on
// me called out by reason. It replaces the Workspace while open; the tab row stays.

// the server's `Overview` (src/github/service.ts), which the web cannot import: its module graph
// reaches Node-only code
type Request = (url: string, init?: RequestInit) => Promise<Response>;
type Reason =
  | { kind: 'thread'; id: string; author: string; path: string }
  | { kind: 'checks' }
  | { kind: 'conflicts' }
  | { kind: 'changes'; id: string; author: string }
  | { kind: 'review'; reRequested?: true };
type Item = {
  repository: string; number: number; title: string; url: string; author?: string; updatedAt?: string;
  draft?: true; checks?: 'passed' | 'pending' | 'failed'; reasons: Reason[];
  newCommits?: true; approved?: true; closes?: number[]; linkedPullRequests?: number[]; labels?: string[];
  destination?: { kind: 'worktree' | 'project'; worktreeId: string; label: string };
};
type Problem = { kind: 'no-token' | 'rate-limited' | 'failing'; message: string; until?: number };
type Overview = { mine: Item[]; reviews: Item[]; issues: Item[]; totals: { mine: number; reviews: number; issues: number }; fetchedAt?: number; problem?: Problem };
type ColumnKey = 'mine' | 'reviews' | 'issues';

const columns: { key: ColumnKey; label: string; tab: string; icon: keyof typeof icons; search: string }[] = [
  { key: 'mine', label: 'My pull requests', tab: 'Mine', icon: 'pull', search: 'is:pr is:open author:@me archived:false' },
  { key: 'reviews', label: 'Review requests', tab: 'Reviews', icon: 'review', search: 'is:pr is:open review-requested:@me archived:false' },
  { key: 'issues', label: 'Assigned issues', tab: 'Issues', icon: 'issue', search: 'is:issue is:open assignee:@me archived:false' }
];

const icons = {
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

const Icon = ({ name }: { name: keyof typeof icons }) => <svg className="overview-icon" viewBox="0 0 24 24" aria-hidden="true">{icons[name]}</svg>;

// how long ago, briefly: 5m, 3h, 2d, 3w, 4mo, 1y
function age(from: number, now: number): string {
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

const waiting = (item: Item) => item.reasons.length > 0;
const basename = (path: string) => path.split('/').pop() ?? path;

// one chip per reason, except threads, which share one
function reasonChips(item: Item): ReactNode[] {
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

function Row({ item, column, now, onOpen }: { item: Item; column: ColumnKey; now: number; onOpen: (worktreeId: string) => void }) {
  const destination = item.destination;
  const mark = item.checks === undefined ? undefined : checksMark[item.checks];
  const chips = [...reasonChips(item), ...hintChips(item)];
  const updated = item.updatedAt === undefined ? Number.NaN : Date.parse(item.updatedAt);
  const content = <>
    <span className="overview-row-copy">
      <span className="overview-row-title"><span className="overview-row-number">#{item.number}</span>{item.title}</span>
      <span className="overview-row-meta">
        {column !== 'mine' && item.author !== undefined && <span>@{item.author}</span>}
        {Number.isFinite(updated) && <span>{age(updated, now)}</span>}
        {mark !== undefined && <span className={`overview-checks ${mark[0]}`} title={mark[2]} aria-label={mark[2]}><Icon name={mark[1]} />checks</span>}
      </span>
      {chips.length > 0 && <span className="overview-chips">{chips}</span>}
    </span>
    {destination === undefined
      ? <span className="overview-destination" title="No Project for this repository: opens on github.com"><Icon name="external" />github.com</span>
      : <span className={`overview-destination ${destination.kind}`} title={destination.kind === 'worktree' ? 'Opens this Worktree\'s Workspace' : 'Opens the Project\'s main worktree'}><Icon name={destination.kind === 'worktree' ? 'branch' : 'folder'} />{destination.label}</span>}
  </>;
  const label = `#${item.number} ${item.title}`;
  return <div className={`overview-row${waiting(item) ? ' waiting' : ''}`}>
    {destination === undefined
      ? <a className="overview-row-main" href={item.url} target="_blank" rel="noreferrer" aria-label={`${label}, on GitHub`}>{content}</a>
      : <button className="overview-row-main" type="button" aria-label={`${label}, in ${destination.label}`} onClick={() => onOpen(destination.worktreeId)}>{content}</button>}
    {destination !== undefined && <a className="overview-row-browser" href={item.url} target="_blank" rel="noreferrer" title="Open on GitHub" aria-label={`Open #${item.number} on GitHub`}><Icon name="external" /></a>}
  </div>;
}

// a column's rows by repository: the busiest first, then by name; Waiting on me rows first in each
function RepositoryGroups({ items, column, now, onOpen }: { items: Item[]; column: ColumnKey; now: number; onOpen: (worktreeId: string) => void }) {
  if (items.length === 0) return <p className="overview-none">None.</p>;
  const groups = new Map<string, Item[]>();
  for (const item of items) groups.set(item.repository, [...groups.get(item.repository) ?? [], item]);
  const count = (rows: Item[]) => rows.filter(waiting).length;
  const sorted = [...groups].sort(([left, a], [right, b]) => count(b) - count(a) || left.localeCompare(right));
  return <>{sorted.map(([repository, rows]) => {
    const [owner, name] = repository.split('/');
    const waits = count(rows);
    return <section key={repository} className="overview-repository" aria-label={repository}>
      <h4 className="overview-repository-head"><span>{owner}/<b>{name}</b></span>{rows.some(row => row.destination !== undefined) && <span className="overview-project" title="Has a Project" aria-label="Has a Project"><Icon name="folder" /></span>}{waits > 0 && <span className="overview-waits" title={`${waits} waiting on me`}>{waits}</span>}</h4>
      {[...rows.filter(waiting), ...rows.filter(row => !waiting(row))].map(item => <Row key={item.url} item={item} column={column} now={now} onOpen={onOpen} />)}
    </section>;
  })}</>;
}

// when GitHub was last read, coarsely
const freshness = (fetchedAt: number, now: number) => now - fetchedAt < 60_000 ? 'updated just now' : `updated ${age(fetchedAt, now)} ago`;

/**
 * The Overview: three columns (tabs on a phone) grouped by repository. `revision` changes when the
 * server's GitHub data or the console's Worktrees change, and the lists are read again then.
 */
export function GithubOverview({ request, revision, phone, onClose, onOpen }: { request: Request; revision: string; phone: boolean; onClose: () => void; onOpen: (worktreeId: string) => void }) {
  const [overview, setOverview] = useState<Overview>();
  const [unreachable, setUnreachable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<ColumnKey>('mine');
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async (refresh: boolean) => {
    try {
      const response = await request(`/api/github/overview${refresh ? '?refresh=1' : ''}`);
      if (!response.ok) throw new Error();
      setOverview(await response.json() as Overview);
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

  const problem = overview?.problem;
  const items = overview === undefined ? [] : [...overview.mine, ...overview.reviews, ...overview.issues];
  const waits = overview === undefined ? 0 : [...overview.mine, ...overview.reviews].filter(waiting).length;
  const shown = overview !== undefined && problem?.kind !== 'no-token' && overview.fetchedAt !== undefined;
  const summary = shown ? <span className="overview-summary">{waits > 0 ? <><b>{waits}</b> waiting on me</> : 'Nothing waiting on me'}</span> : null;
  const staleSince = overview?.fetchedAt === undefined ? '' : ` Showing what was fetched ${age(overview.fetchedAt, now)} ago.`;
  const banner = unreachable && overview !== undefined
    ? `The console could not be reached.${staleSince}`
    : problem !== undefined && problem.kind !== 'no-token' && overview?.fetchedAt !== undefined
      ? `${problem.kind === 'rate-limited' && problem.until !== undefined ? `GitHub's rate limit holds requests until ${new Date(problem.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'GitHub is unreachable.'}${staleSince}`
      : undefined;

  let body: ReactNode;
  if (problem?.kind === 'no-token') body = <div className="overview-card"><h3>No GitHub token</h3><p>The server found no GitHub token. Run <code>gh auth login</code> on the host so the token lands in <code>~/.config/gh/hosts.yml</code>, or set <code>RAC_GITHUB_TOKEN</code> and restart the console.</p></div>;
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
          <RepositoryGroups items={rows} column={key} now={now} onOpen={onOpen} />
          {more > 0 && <a className="overview-more" href={`https://github.com/search?type=issues&q=${encodeURIComponent(search)}`} target="_blank" rel="noreferrer">{more} more on github.com</a>}
        </div>
      </section>;
    };
    body = phone
      ? <><div className="overview-tabs" role="tablist" aria-label="Overview lists">{columns.map(({ key, tab: name }) => {
        const waits = overview[key].filter(waiting).length;
        return <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{name}<span className={waits > 0 ? 'overview-waits' : 'overview-count'}>{waits > 0 ? waits : overview.totals[key]}</span></button>;
      })}</div>{column(tab)}</>
      : <div className="overview-columns">{columns.map(({ key }) => column(key))}</div>;
  }

  return <section className={`overview${phone ? ' phone' : ''}`} aria-label="Overview">
    <header className="overview-head">
      <div className="overview-title"><small>GITHUB</small><h2>Overview</h2></div>
      {!phone && summary}
      <span className="overview-grow" />
      {shown && <span className="overview-freshness">{freshness(overview.fetchedAt!, now)}</span>}
      <button type="button" className="overview-action" aria-label="Refresh" title="Refresh now" disabled={refreshing} aria-busy={refreshing || undefined} onClick={() => void refresh()}><Icon name="refresh" /></button>
      <button type="button" className="overview-action" aria-label="Close Overview" title="Back to the Workspace (Esc)" onClick={onClose}><Icon name="cross" /></button>
    </header>
    {phone && summary !== null && <div className="overview-subhead">{summary}</div>}
    {banner !== undefined && <div className="overview-banner" role="status"><Icon name="clock" /><span>{banner}</span><button type="button" onClick={() => void refresh()} disabled={refreshing}>Retry</button></div>}
    <div className={`overview-body${phone ? '' : ' columns'}`}>{body}</div>
  </section>;
}

/** The tab row's Overview button: it toggles the Overview, and shows active while it is open. */
export function OverviewButton({ open, phone, onToggle }: { open: boolean; phone: boolean; onToggle: () => void }) {
  return <button type="button" className={`overview-button${open ? ' active' : ''}`} aria-pressed={open} aria-label="Overview" title="Overview: pull requests, review requests and issues" onClick={onToggle}><Icon name="pull" />{!phone && <span>Overview</span>}</button>;
}
