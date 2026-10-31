import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { age, attentionOrder, freshness, Icon, NoTokenCard, RowCopy, staleNotice, unseen, useSeenRows, waiting, type Item, type Problem, type Request } from './github-overview.js';
import { PanelHeader, PanelIcon, panelIcons, usePanelExpand } from './panel-header.js';
import { Skeleton } from './skeleton.js';

// The GitHub panel (CONTEXT.md): one Project's Pull requests and Issues beside its Worktrees, the
// same in every Workspace of the Project. Rows are the Overview's: the same reasons, hints and
// unseen marks, and Mine and Review requested are the Overview's own rows.

/** The item an Overview row asked the panel to show. */
export type GithubFocus = { number: number; issue: boolean };
// the server's `GithubPanel` (src/github/service.ts)
type PanelItem = Item & { state?: 'merged' | 'closed' };
type GroupKey = 'mine' | 'reviews' | 'other' | 'done' | 'assigned' | 'issues';
type Lists = Record<GroupKey, PanelItem[]> & { fetchedAt?: number; problem?: Problem };

const groups: { key: GroupKey; label: string; issue: boolean; collapsed?: true }[] = [
  { key: 'mine', label: 'Mine', issue: false },
  { key: 'reviews', label: 'Review requested', issue: false },
  { key: 'other', label: 'Other open', issue: false, collapsed: true },
  { key: 'done', label: 'Merged or closed, Worktree still here', issue: false },
  { key: 'assigned', label: 'Assigned to me', issue: true },
  { key: 'issues', label: 'Other open', issue: true, collapsed: true }
];
const rowId = (issue: boolean, number: number) => `${issue ? 'issue' : 'pull'}-${number}`;

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

/**
 * The GitHub panel's lists. `repository` is the Project's `owner/name` on github.com (none in a
 * Place without one, which shows why instead); `worktreeId` is the Place's own Worktree, whose pull
 * request is pinned on top unless it is the `main` worktree. `revision` changes when GitHub's data
 * or the Worktrees change, and the lists are read again then. `focus` is an Overview row to select.
 */
export function GithubPanel({ request, projectId, repository, worktreeId, main, branch, hasPullRequest, revision, focus, onClose }: { request: Request; projectId?: string; repository?: string; worktreeId?: string; main: boolean; branch?: string; hasPullRequest: boolean; revision: string; focus?: GithubFocus; onClose: () => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const [lists, setLists] = useState<Lists>();
  const [unreachable, setUnreachable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [collapsed, setCollapsed] = useState<Partial<Record<GroupKey, boolean>>>({});
  const [selected, setSelected] = useState<string>();
  // the row an Overview tap brought here, outlined until another is picked
  const [focused, setFocused] = useState<string>();
  const inView = useInView(ref);
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
  // select the Overview's item once it is listed, opening its group
  const pendingFocus = useRef(focus);
  useEffect(() => { pendingFocus.current = focus; }, [focus]);
  useEffect(() => {
    const wanted = pendingFocus.current;
    if (wanted === undefined || lists === undefined) return;
    const group = groups.find(({ key, issue }) => issue === wanted.issue && lists[key].some(item => item.number === wanted.number));
    if (group === undefined) return;
    pendingFocus.current = undefined;
    const id = rowId(wanted.issue, wanted.number);
    setCollapsed(current => ({ ...current, [group.key]: false }));
    setSelected(id);
    setFocused(id);
    window.requestAnimationFrame(() => ref.current?.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [lists, focus]);
  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const listed = lists !== undefined && lists.fetchedAt !== undefined && lists.problem?.kind !== 'no-token';
  // This Worktree's pull request: an open one before a merged or closed one
  const pinned = main || worktreeId === undefined || lists === undefined ? undefined
    : groups.filter(group => !group.issue).flatMap(group => lists[group.key].map(item => ({ item, group }))).filter(({ item }) => item.destination?.worktreeId === worktreeId).sort((a, b) => Number(a.item.state !== undefined) - Number(b.item.state !== undefined))[0];
  const open = (key: GroupKey) => !(collapsed[key] ?? groups.find(group => group.key === key)?.collapsed === true);
  const shown = lists === undefined ? [] : [...pinned === undefined ? [] : [pinned.item], ...groups.filter(group => open(group.key)).flatMap(group => lists[group.key])];
  const isNew = useSeenRows(request, shown, listed && inView);

  const row = (item: PanelItem, group: (typeof groups)[number]) => {
    const id = rowId(group.issue, item.number);
    return <PanelRow key={id} item={item} issue={group.issue} showAuthor={group.key !== 'mine'} now={now} isNew={isNew(item)} here={worktreeId !== undefined && item.destination?.worktreeId === worktreeId} selected={selected === id} focused={focused === id} onSelect={() => { setSelected(id); setFocused(current => current === id ? current : undefined); }} />;
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
  if (repository === undefined || projectId === undefined) body = <div className="overview-card"><h3>Not a GitHub repository</h3><p>This Place has no github.com origin, so the GitHub panel has nothing to show here. The Overview still lists your pull requests, review requests and issues from every repository.</p><a className="github-overview-link" href="#overview">Open the Overview</a></div>;
  else if (problem?.kind === 'no-token') body = <NoTokenCard />;
  else if (lists === undefined && unreachable) body = <div className="overview-card"><h3>The console could not be reached</h3><p>The GitHub panel loads once the console answers again.</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;
  else if (lists === undefined || (lists.fetchedAt === undefined && problem === undefined)) body = <div className="overview-skeletons" role="status" aria-label="Loading the GitHub panel" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div className="overview-skeleton" key={index}><Skeleton className="overview-skeleton-title" /><Skeleton className="overview-skeleton-meta" /></div>)}</div>;
  else if (lists.fetchedAt === undefined) body = <div className="overview-card"><h3>GitHub is unreachable</h3><p>{problem?.message}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;
  else {
    const kind = (issue: boolean) => groups.filter(group => group.issue === issue).map(section).filter(Boolean);
    const [pulls, issues] = [kind(false), kind(true)];
    body = <>
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
  }

  return <section ref={ref} className={`github-pane${expanded ? ' expanded' : ''}`} role="region" aria-label="GitHub">
    <PanelHeader panelKey="github" label="GitHub" title={<span className="github-pane-title">GitHub{repository !== undefined && <> · {repository}</>}</span>} actions={<>
      {listed && <span className="github-freshness">{freshness(lists.fetchedAt!, now)}</span>}
      {repository !== undefined && <button type="button" className="panel-header-action" aria-label="Refresh" title="Refresh now" disabled={refreshing} aria-busy={refreshing || undefined} onClick={() => void refresh()}><PanelIcon path={panelIcons.refresh} /></button>}
    </>} close={{ key: 'close', label: 'Close GitHub panel', icon: <PanelIcon path={panelIcons.close} />, onSelect: onClose }} />
    {banner !== undefined && <div className="overview-banner" role="status"><Icon name="clock" /><span>{banner}</span><button type="button" onClick={() => void refresh()} disabled={refreshing}>Retry</button></div>}
    <div className="github-pane-body">{body}</div>
  </section>;
}
