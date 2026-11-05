import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ConfiguredButtonList, useConfiguredButtons, type ButtonSlot } from './configured-buttons.js';
import { FlyoutPortal } from './flyout-portal.js';
import { githubItemIdentity, githubItemKey, githubNewWorktreeContext, githubPullMutationContext, normalizeGithubRepository, resolveGithubItemContext, sameGithubItem, type GithubDashboardProject, type GithubItemContext, type GithubItemIdentity, type GithubNewWorktreeContext, type GithubTarget } from './github-client.js';
import { age, freshness, Icon, newWorktreeChoices, NoTokenCard, reasonChips, RepositoryGroups, staleNotice, unseen, useSeenRows, type ColumnKey, type Item, type NewWorktreeAction, type Overview, type Problem, type Request } from './github-overview.js';
import { PanelHeader, PanelIcon, panelIcons, usePanelExpand, usePhoneLayout } from './panel-header.js';
import { hunkClass, shownBody, unresolvedThreadCount, type PullRequestComment, type PullRequestComments, type PullRequestReviewThread } from './pull-request-comments.js';
import { feedbackPrompt, hunkLines, reviewThreadBlock, threadLines } from './review-thread-prompt.js';
import { Skeleton } from './skeleton.js';
import { useViewportFlyout } from './viewport-flyout.js';

// one workspace-owned github split with shared swim lanes and contextual item details

/** The item to show: old callers may omit its repository while unified callers pass the full identity. */
export type GithubFocus = { number: number; issue: boolean; overview?: true; repository?: string; repositoryKey?: string; kind?: 'pull' | 'issue' };
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
  reviewers: { login: string; id?: string; bot?: true; team?: true; state?: 'approved' | 'changes' | 'commented' | 'dismissed'; requested?: true; newCommits?: true }[];
  linkedIssues: { number: number; title: string; url: string; state: 'open' | 'closed' }[];
  destination?: Destination;
};
type IssueDetail = {
  repository: string; number: number; title: string; url: string; state: 'open' | 'closed'; author?: string; updatedAt?: string; body: string; labels: string[];
  linkedPullRequests: { number: number; title: string; url: string; state: 'open' | 'merged' | 'closed'; draft: boolean }[];
  destination?: Destination;
};
type DetailRead = { pullRequest?: PullDetail; issue?: IssueDetail; fetchedAt?: number; problem?: Problem };
type Selection = GithubItemIdentity;
/** Go to a Worktree's Workspace, its GitHub panel showing `focus`. */
export type OpenWorktree = (worktreeId: string, focus: GithubFocus) => void;
type GithubScope = 'repo' | 'all';
type GithubPanelNewWorktree = (item: Item, action: NewWorktreeAction, context?: GithubNewWorktreeContext) => void;
/**
 * What the Worktree strip acts with in this Place's Worktree. `notReady` is why Check out here and
 * Move here cannot run now (the branch switch's own readiness); `review` starts, or opens, the
 * guided review of the pull request checked out here; `onRemove` opens the Remove worktree dialog
 * for a Worktree; `onFeedback` reports how an action went, in this Workspace.
 */
export type StripActions = {
  notReady?: string;
  review?: { onReview?: () => void; open: boolean; generating: boolean; unavailable?: string };
  onRemove?: (worktreeId: string) => void;
  onFeedback: (feedback: { tone: 'success' | 'error'; message: string; detail: string }) => void;
};

// retain repository catalog identities without a separate grouped-list layout
const catalogGroups: { key: GroupKey; issue: boolean }[] = [
  { key: 'mine', issue: false },
  { key: 'reviews', issue: false },
  { key: 'other', issue: false },
  { key: 'done', issue: false },
  { key: 'assigned', issue: true },
  { key: 'issues', issue: true }
];
// keep row ids repository-aware while remaining safe in attribute selectors
const rowId = (identity: GithubItemIdentity) => `${encodeURIComponent(identity.repositoryKey)}-${identity.kind}-${identity.number}`;
// normalize old focus callers through the owning repository
const focusIdentity = (focus: GithubFocus | undefined, repository: string | undefined): GithubItemIdentity | undefined => focus === undefined ? undefined : githubItemIdentity(focus.repositoryKey ?? focus.repository ?? repository ?? '', focus.kind ?? (focus.issue ? 'issue' : 'pull'), focus.number);
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


const ago = (iso: string | undefined, now: number) => {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) ? age(at, now) : undefined;
};
const Author = ({ comment, now, extra }: { comment: PullRequestComment; now: number; extra?: ReactNode }) => <span className="github-detail-who">
  <b className={comment.mine ? 'mine' : undefined}>@{comment.author}</b>{comment.bot && <span className="github-bot">bot</span>}<span>{ago(comment.createdAt, now)}</span>{extra}
</span>;
const Comment = ({ comment, now, extra }: { comment: PullRequestComment; now: number; extra?: ReactNode }) => <div className="github-comment"><Author comment={comment} now={now} extra={extra} /><p>{shownBody(comment.body)}</p></div>;
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

// where the item is checked out: here, in another Worktree to go to, or nowhere (with `actions` to
// make one); `children` are the strip's further actions
function WorktreeStrip({ destination, worktreeId, none, actions, onGoTo, children }: { destination?: Destination; worktreeId?: string; none?: string; actions?: ReactNode; onGoTo?: (worktreeId: string) => void; children?: ReactNode }) {
  if (destination !== undefined && destination.worktreeId === worktreeId) return <div className="github-strip"><Icon name="branch" /><span>Checked out <b>here</b>, in {destination.label}.</span>{children}</div>;
  if (destination !== undefined) return <div className="github-strip"><Icon name="branch" /><span>Checked out in <b>{destination.label}</b>.</span>{onGoTo !== undefined && <button type="button" className="github-button go" onClick={() => onGoTo(destination.worktreeId)}>View in {destination.label}</button>}{children}</div>;
  return none === undefined ? null : <div className="github-strip none"><Icon name="branch" /><span>{none}</span>{children}{actions !== undefined && <div className="github-actions">{actions}</div>}</div>;
}

const jsonBody = (method: 'POST' | 'DELETE', body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// A merged or closed pull request's Worktree, still here at its final head: an orange Remove
// Worktree…, which opens the Remove worktree dialog, where deleting the branch is the operator's tick.
function RemoveStrip({ pull, holder, now, onRemove }: { pull: PullDetail; holder: Destination; now: number; onRemove?: (worktreeId: string) => void }) {
  return <div className="github-strip cleanup"><Icon name="pull" /><span>{pull.state === 'merged' ? 'Merged' : 'Closed without merging'}{ago(pull.updatedAt, now) !== undefined && ` ${ago(pull.updatedAt, now)} ago`}. Worktree <b>{holder.label}</b> is still here.</span>{onRemove !== undefined && <button type="button" className="github-button warn" onClick={() => onRemove(holder.worktreeId)}>Remove Worktree…</button>}</div>;
}

// An open pull request's Worktree strip: Check out here when no Worktree holds it, Move here from
// the Worktree that does (git checks a branch out only once), both through the branch switch and
// disabled while this Worktree is not ready for it; Start Review tour once it is checked out here.
function PullRequestStrip({ pull, worktreeId, actions, checkoutActions, onGoTo }: { pull: PullDetail; worktreeId?: string; actions?: StripActions; checkoutActions?: ReactNode; onGoTo?: (worktreeId: string) => void }) {
  const holder = pull.destination;
  const here = holder !== undefined && holder.worktreeId === worktreeId;
  const review = actions?.review;
  return <WorktreeStrip destination={holder} worktreeId={worktreeId} none="Not checked out." actions={holder === undefined ? checkoutActions : undefined} onGoTo={onGoTo}>
    {!here && holder !== undefined && checkoutActions}
    {here && review !== undefined && <button type="button" className="github-button tour" disabled={review.onReview === undefined || (!review.open && review.unavailable !== undefined)} aria-busy={review.generating || undefined} title={review.unavailable} onClick={() => review.onReview?.()}><Icon name="review" />{review.generating ? 'Generating Review tour…' : review.open ? 'Open Review tour' : 'Start Review tour'}</button>}
  </WorktreeStrip>;
}

const checkOrder = { failed: 0, pending: 1, passed: 2, skipped: 3 } as const;
// one check's mark and what it says (the Overview's say "Checks …" of a whole head)
const checkMark = { passed: ['ok', 'check', 'passed'], failed: ['failing', 'cross', 'failed'], pending: ['pending', 'clock', 'running'], skipped: ['skipped', 'check', 'skipped'] } as const;
const reviewerState = { approved: 'approved', changes: 'requested changes', commented: 'commented', dismissed: 'dismissed' } as const;
// a review summary's GitHub state as a reviewer's
const summaryState: Record<string, keyof typeof reviewerState> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };
const external = (href: string, label: string) => <a key={label} className="github-button" href={href} target="_blank" rel="noreferrer">{label}<Icon name="external" /></a>;

type DetailProps = { identity: GithubItemIdentity; now: number; worktreeId?: string; closed: Record<string, boolean>; onToggle: (section: string) => void; onSelect: (selection: Selection) => void; onGoTo?: (worktreeId: string) => void; checkoutActions?: ReactNode; onAddToPrompt?: (text: string) => void };
/** Send one write to the shown pull request (a path under it, and a JSON body); its result or why it failed. */
type Write = (path: string, body?: unknown) => Promise<{ result?: unknown; error?: string }>;
// why the console did not do what was asked: the server's own message, else its status
export const refusal = async (response: Response, action: string) => {
  const error = (await response.json().catch(() => undefined) as { error?: unknown } | undefined)?.error;
  return typeof error === 'string' ? error : `The console could not ${action} (${response.status}).`;
};

type TargetReadiness = { loading: boolean; enabled?: boolean; error?: string };
type SwitchAvailability = { enabled: boolean };
type GithubCardProfile = { open: boolean; mine: boolean };

// render the shared adjacent action for Mine, Reviews, and Issues
function GithubItemActions({ item, context, request, dynamicWorktrees, ownerNotReady, onOpenWorktree, onNewWorktree, onFeedback, profile, review, variant = 'card' }: { item: Item; context: GithubItemContext; request: Request; dynamicWorktrees: boolean; ownerNotReady?: string; onOpenWorktree?: OpenWorktree; onNewWorktree?: GithubPanelNewWorktree; onFeedback?: StripActions['onFeedback']; profile?: GithubCardProfile; review?: StripActions['review']; variant?: 'card' | 'detail' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [readiness, setReadiness] = useState<Record<string, TargetReadiness>>({});
  const focusMenu = useRef(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLButtonElement>(open, { align: 'end' });
  const holder = context.holder;
  const owner = context.owner;
  const cardProfile = variant === 'card' && context.identity.kind === 'pull' ? profile : undefined;
  const checkoutAllowed = cardProfile?.open !== false;
  const configuredSlot: ButtonSlot | undefined = cardProfile?.open === true && context.heldHere ? cardProfile.mine ? 'pullRequest' : 'reviewRequest' : undefined;
  const configuredActions = useConfiguredButtons(configuredSlot);
  const newProject = holder?.project ?? context.detailProject;
  const canCreate = checkoutAllowed && dynamicWorktrees && newProject !== undefined && newProject.manageWorktrees !== false && onNewWorktree !== undefined;
  const crossTargets = context.sameRepository ? [] : context.existingTargets;
  const directTarget = checkoutAllowed && context.identity.kind === 'pull' && !dynamicWorktrees
    ? context.sameRepository ? context.heldHere ? undefined : owner : crossTargets.length === 1 && holder?.worktree.id !== crossTargets[0]?.worktree.id ? crossTargets[0] : undefined
    : undefined;
  const menuTargets = checkoutAllowed && context.identity.kind === 'pull'
    ? context.sameRepository ? dynamicWorktrees && owner !== undefined ? [owner] : [] : crossTargets
    : [];
  const requiresFreshRead = (target: GithubTarget): boolean => !context.sameRepository || dynamicWorktrees;
  // read candidate readiness in parallel
  const readTargets = useCallback(async (targets: readonly GithubTarget[]) => {
    const unique = [...new Map(targets.map(target => [target.worktree.id, target])).values()];
    // show every target while its exact readiness loads
    setReadiness(current => ({ ...current, ...Object.fromEntries(unique.map(target => [target.worktree.id, { loading: true }])) }));
    await Promise.all(unique.map(async target => {
      try {
        const response = await request(`/api/worktrees/${encodeURIComponent(target.worktree.id)}/switch-prs`);
        // retain server refusal text when available
        if (!response.ok) throw new Error(await refusal(response, 'read checkout readiness'));
        const available = await response.json() as SwitchAvailability;
        setReadiness(current => ({ ...current, [target.worktree.id]: { loading: false, enabled: available.enabled } }));
      } catch (error) {
        setReadiness(current => ({ ...current, [target.worktree.id]: { loading: false, error: error instanceof Error ? error.message : 'Checkout readiness is unavailable.' } }));
      }
    }));
  }, [request]);
  useEffect(() => {
    // a direct foreign sole target must be proven before it can post
    if (directTarget !== undefined && requiresFreshRead(directTarget)) void readTargets([directTarget]);
  }, [directTarget?.worktree.id, readTargets]);
  useEffect(() => {
    // keyboard opening moves into the first enabled action
    if (!open || !focusMenu.current) return;
    focusMenu.current = false;
    const frame = window.requestAnimationFrame(() => flyoutRef.current?.querySelector<HTMLElement>('button:not(:disabled), a[href]')?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [flyoutRef, open]);

  // explain exact target refusals
  const disabledReason = (target: GithubTarget): string | undefined => {
    // retain unavailable targets visibly
    if (!target.project.available || !target.worktree.available) return 'Worktree unavailable';
    // prevent duplicate checkout at the holder
    if (holder?.worktree.id === target.worktree.id && holder.project.id === target.project.id) return 'Already checked out here';
    // prevent moves between separate clones
    if (holder !== undefined && holder.project.id !== target.project.id) return `Checked out in ${holder.project.label}`;
    // reject structurally unsafe destinations
    const fresh = readiness[target.worktree.id];
    // wait for exact candidate readiness
    if (requiresFreshRead(target) && (fresh === undefined || fresh.loading)) return 'Checking readiness…';
    // preserve readiness failures
    if (fresh?.error !== undefined) return fresh.error;
    // report dirty or busy readiness
    if (fresh?.enabled === false) return 'Commit or stash uncommitted changes first';
    // reuse the owner's local readiness
    if (context.sameRepository && owner?.worktree.id === target.worktree.id && ownerNotReady !== undefined) return ownerNotReady;
    return undefined;
  };
  // post one contextual target mutation
  const run = async (target: GithubTarget) => {
    // refuse non-pull or disabled actions locally
    if (context.identity.kind !== 'pull' || disabledReason(target) !== undefined) return;
    const moving = holder !== undefined;
    const action = moving ? 'move-pr' : 'switch-pr';
    setBusy(target.worktree.id);
    try {
      const mutation = githubPullMutationContext(context, target);
      const response = await request(`/api/worktrees/${encodeURIComponent(target.worktree.id)}/${action}`, jsonBody('POST', { number: context.identity.number, context: mutation }));
      // keep server refusal authoritative
      if (!response.ok) {
        onFeedback?.({ tone: 'error', message: moving ? 'Pull request could not be moved' : 'Pull request could not be checked out', detail: await refusal(response, moving ? 'move it' : 'check it out') });
        // refresh refusal-sensitive readiness in place
        if (requiresFreshRead(target)) await readTargets([target]);
      } else onFeedback?.({ tone: 'success', message: moving ? `Pull request moved to ${target.worktree.label}` : `Pull request checked out in ${target.worktree.label}`, detail: moving ? 'The source worktree was detached and its uncommitted changes were restored at the selected target.' : 'The selected worktree now holds the pull request.' });
    } catch {
      onFeedback?.({ tone: 'error', message: 'Pull request checkout could not be completed', detail: 'The console could not be reached.' });
    } finally {
      setBusy(undefined);
      setOpen(false);
    }
  };
  // dismiss flyouts and restore their trigger
  const dismiss = () => {
    setOpen(false);
    window.requestAnimationFrame(() => anchorRef.current?.focus());
  };
  // navigate without mutating checkout state
  const view = variant === 'detail' || holder === undefined || onOpenWorktree === undefined ? null : <button type="button" className="github-item-menu-action view" onClick={() => { setOpen(false); onOpenWorktree(holder.worktree.id, { ...context.identity, issue: context.identity.kind === 'issue', repository: context.identity.repositoryKey, overview: true }); }}><Icon name="branch" /><span>View in {holder.worktree.label}<small>{holder.project.label}</small></span></button>;
  // bind new worktrees to the chosen project and source
  const create = (action: NewWorktreeAction) => {
    // closed pulls and dynamic-off never offer new worktrees
    if (!checkoutAllowed || !dynamicWorktrees || newProject === undefined || onNewWorktree === undefined) return null;
    // name checkout and move operations before their destinations
    const operation = holder === undefined ? 'Checkout in' : 'Move checkout to';
    const label = action === 'issue' ? `New Worktree in ${newProject.label}` : `${operation} a new Worktree in ${newProject.label}`;
    return <button type="button" className={action} disabled={!canCreate} title={canCreate ? undefined : newProject.manageWorktreesReason ?? 'New Worktree is unavailable'} onClick={() => { setOpen(false); onNewWorktree(item, action, githubNewWorktreeContext(context, newProject)); }}><Icon name={newWorktreeChoices[action].icon} /><span>{label}<small>{newProject.manageWorktreesReason ?? (holder === undefined ? 'check out there' : `move from ${holder.worktree.label}`)}</small></span></button>;
  };
  // render one exact destination choice
  const targetButton = (target: GithubTarget, here: boolean) => {
    const reason = disabledReason(target);
    const moving = holder !== undefined;
    const label = holder?.worktree.id === target.worktree.id && holder.project.id === target.project.id ? 'Already checked out here' : here ? moving ? 'Move checkout here' : 'Checkout here' : `${moving ? 'Move checkout to' : 'Checkout in'} ${target.worktree.label}`;
    return <button key={`${target.project.id}:${target.worktree.id}`} type="button" disabled={reason !== undefined || busy !== undefined} aria-busy={busy === target.worktree.id || readiness[target.worktree.id]?.loading || undefined} title={reason} onClick={() => void run(target)}><Icon name="branch" /><span>{label}<small>{here ? target.project.label : `${target.project.label}${reason === undefined ? '' : ` · ${reason}`}`}</small></span></button>;
  };

  const cardReview = cardProfile?.open === true && context.heldHere ? review : undefined;
  const workflowActions = configuredActions.length > 0 || cardReview !== undefined;
  const displayedMenuTargets = directTarget === undefined ? menuTargets : [];
  const menuView = directTarget === undefined ? view : null;
  const hasMenu = menuView !== null || displayedMenuTargets.length > 0 || checkoutAllowed && dynamicWorktrees && newProject !== undefined || workflowActions;
  let direct: ReactNode | undefined;
  let directView: ReactNode | undefined;
  // keep dynamic-off single-target actions direct
  if (directTarget !== undefined) {
    const reason = disabledReason(directTarget);
    const moving = holder !== undefined;
    const label = moving ? context.sameRepository ? 'Move checkout here' : `Move checkout to ${directTarget.worktree.label}` : context.sameRepository ? 'Checkout here' : `Checkout in ${directTarget.worktree.label}`;
    direct = <button type="button" className={variant === 'detail' ? 'github-button go github-item-direct' : 'overview-row-new github-item-direct'} disabled={reason !== undefined || busy !== undefined} aria-busy={busy !== undefined || readiness[directTarget.worktree.id]?.loading || undefined} title={reason ?? label} aria-label={label} onClick={() => void run(directTarget)}><Icon name="branch" />{variant === 'detail' && <span>{label}</span>}</button>;
    directView = variant !== 'card' || holder === undefined || onOpenWorktree === undefined ? null : <button type="button" className="github-card-view" aria-label={`View in ${holder.worktree.label}`} title={`View in ${holder.worktree.label} · ${holder.project.label}`} onClick={() => onOpenWorktree(holder.worktree.id, { ...context.identity, issue: context.identity.kind === 'issue', repository: context.identity.repositoryKey, overview: true })}><Icon name="worktree" /></button>;
  }
  // omit empty adjacent controls
  if (!hasMenu) {
    // detail strips retain their direct mutation without card-only links
    if (variant === 'detail') return direct ?? null;
    // an unconfigured repository explains checkout without a useless flyout
    const unavailable = checkoutAllowed && context.identity.kind === 'pull' && newProject === undefined ? <button type="button" className="overview-row-new github-item-direct" disabled aria-label="Checkout unavailable" title="Add this repository as a Project to check it out"><Icon name="branch" /></button> : null;
    return <div className="github-direct-actions">{directView}{direct ?? unavailable}</div>;
  }
  const name = `Actions for ${context.identity.kind === 'pull' ? 'pull request' : 'issue'} #${context.identity.number}`;
  const triggerName = context.identity.kind === 'pull' ? `Checkout and actions for pull request #${context.identity.number}` : name;
  const menu = <div className="github-item-actions">
    <button ref={anchorRef} type="button" className={variant === 'detail' ? 'github-button go github-checkout-menu' : 'overview-row-new github-checkout-menu'} data-context-flyout aria-expanded={open} title={triggerName} aria-label={variant === 'detail' ? context.identity.kind === 'pull' ? 'Checkout' : 'Worktree' : triggerName} onClick={event => {
      const next = !open;
      focusMenu.current = next && event.detail === 0;
      setOpen(next);
      // fetch target readiness only when the menu opens
      if (next) void readTargets(displayedMenuTargets.filter(requiresFreshRead));
    }}><Icon name="branch" />{variant === 'detail' && <span>{context.identity.kind === 'pull' ? 'Checkout' : 'Worktree'}</span>}<span className="flyout-caret" aria-hidden="true" /></button>
    {open && <FlyoutPortal onDismiss={dismiss}><div ref={flyoutRef} className="overview-row-menu github-item-menu" style={style} role="group" aria-label={name}>
      {menuView}
      {checkoutAllowed && context.identity.kind === 'pull' && newProject === undefined && <button type="button" disabled title="Add this repository as a Project to check it out"><Icon name="branch" /><span>Checkout unavailable<small>No local Project for this repository</small></span></button>}
      {checkoutAllowed && directTarget === undefined && !context.sameRepository && owner !== undefined && <button type="button" disabled title="Here belongs to a different repository"><Icon name="branch" /><span>Checkout here<small>Different repository</small></span></button>}
      {displayedMenuTargets.map(target => targetButton(target, owner?.project.id === target.project.id && owner.worktree.id === target.worktree.id))}
      {context.identity.kind === 'issue' ? create('issue') : create('checkout')}
      {configuredSlot !== undefined && <ConfiguredButtonList slot={configuredSlot} className="configured-nav-menu" onSelect={dismiss} />}
      {cardReview !== undefined && <button type="button" className="tour" disabled={cardReview.onReview === undefined || (!cardReview.open && cardReview.unavailable !== undefined)} aria-busy={cardReview.generating || undefined} title={cardReview.unavailable} onClick={() => { setOpen(false); cardReview.onReview?.(); }}><Icon name="review" />{cardReview.generating ? 'Generating Review tour…' : cardReview.open ? 'Open Review tour' : 'Start Review tour'}</button>}
    </div></FlyoutPortal>}
  </div>;
  // card checkout and optional worktree navigation remain separate from detail strips
  return variant === 'card' ? <div className="github-direct-actions">{directView}{direct}{menu}</div> : direct === undefined ? menu : <div className="github-direct-actions">{direct}{menu}</div>;
}
// a write's button, its border travelling while the write is in flight
export const WriteButton = ({ busy, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy: boolean }) => <button type="button" className={`github-button${className === undefined ? '' : ` ${className}`}${busy ? ' progress-border progress-blue' : ''}`} aria-busy={busy || undefined} {...props}>{busy && <span className="update-progress-ring" aria-hidden="true" />}{children}</button>;

// a thread's foot: who spoke last, Reply (a box inside the card, open while `draft` is set) and
// Resolve, and how the last write went
function ThreadFoot({ thread, label, you, pullUrl, write, canWrite = true, pick, draft, onDraft }: { thread: PullRequestReviewThread; label: string; you: boolean; pullUrl: string; write: Write; canWrite?: boolean; pick?: { picked: boolean; onChange: (picked: boolean) => void }; draft?: string; onDraft: (text?: string) => void }) {
  const [busy, setBusy] = useState<'reply' | 'resolve'>();
  const [error, setError] = useState<string>();
  // GitHub put the reply in the operator's Draft review instead of publishing it
  const [held, setHeld] = useState(false);
  const last = thread.comments.at(-1)!;
  const send = async (path: 'reply' | 'resolve', body?: unknown) => {
    setBusy(path);
    setError(undefined);
    const { result, error: failed } = await write(`threads/${encodeURIComponent(thread.id)}/${path}`, body);
    setBusy(undefined);
    if (failed !== undefined) { setError(failed); return false; }
    setHeld((result as { pending?: unknown } | undefined)?.pending === true);
    return true;
  };
  return <>
    {draft !== undefined && <div className="github-reply">
      <textarea aria-label={`Reply to @${last.author}`} placeholder={`Reply to @${last.author}…`} value={draft} disabled={!canWrite} autoFocus onChange={event => onDraft(event.target.value)} />
      <div className="github-actions">
        <button type="button" className="github-button" onClick={() => { onDraft(undefined); setError(undefined); }}>Cancel</button>
        <WriteButton busy={busy === 'reply'} className="go" aria-label="Send reply" disabled={!canWrite || busy !== undefined || draft.trim() === ''} onClick={() => void send('reply', { body: draft }).then(sent => { if (sent) onDraft(undefined); })}><Icon name="thread" />Reply</WriteButton>
      </div>
    </div>}
    {held && <p className="github-thread-note" role="status">GitHub added your reply to your Draft review, so others see it only once you submit that review.{external(`${pullUrl}/files`, 'Submit review')}</p>}
    {error !== undefined && <p className="github-thread-note error" role="alert">{error}</p>}
    <div className={`github-thread-bar${you ? ' you' : ''}`}>
      <span className="github-thread-who">{label}</span>
      {!thread.resolved && <>
        {pick !== undefined && <label className="github-pick"><input type="checkbox" aria-label={`Select the thread on ${thread.path}`} checked={pick.picked} onChange={event => pick.onChange(event.target.checked)} />select</label>}
        {draft === undefined && <button type="button" className="github-button" disabled={!canWrite || busy !== undefined} title={canWrite ? undefined : 'Add this repository as a Project to reply here'} onClick={() => { onDraft(''); setHeld(false); }}><Icon name="thread" />Reply</button>}
        <WriteButton busy={busy === 'resolve'} disabled={!canWrite || busy !== undefined} title={canWrite ? undefined : 'Add this repository as a Project to resolve threads here'} onClick={() => void send('resolve')}><Icon name="check" />Resolve</WriteButton>
      </>}
    </div>
  </>;
}

// preserve project-scoped review writes while allowing repository-only reads
function PullRequestView({ pull, item, identity, now, worktreeId, closed, onToggle, onSelect, onGoTo, checkoutActions, onAddToPrompt, write, canWrite = true, actions }: DetailProps & { pull: PullDetail; item?: Item; write: Write; canWrite?: boolean; actions?: StripActions }) {
  const [rerequesting, setRerequesting] = useState<string>();
  const [rerequestError, setRerequestError] = useState<string>();
  const [showResolved, setShowResolved] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // each open reply box's text by thread, kept through a read that resolves or outdates its thread
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const open = pull.state === 'open';
  const here = pull.destination !== undefined && pull.destination.worktreeId === worktreeId;
  // prompt actions go to the Agent of the Worktree holding the pull request, so only there
  const slot: ButtonSlot | undefined = open && here ? pull.mine ? 'pullRequest' : 'reviewRequest' : undefined;
  const current = (thread: PullRequestReviewThread) => !thread.resolved && !thread.outdated;
  const threads = pull.threads.filter(thread => showResolved || current(thread) || drafts[thread.id] !== undefined).sort((left, right) => left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0));
  // only what is on screen goes: a filter can hide a picked outdated thread
  const chosen = slot === undefined ? [] : threads.filter(thread => picked.has(thread.id) && !thread.resolved);
  const chosenText = chosen.length === 0 ? '' : feedbackPrompt(pull.number, chosen.map(reviewThreadBlock));
  const pick = (thread: PullRequestReviewThread) => slot === undefined ? undefined : { picked: picked.has(thread.id), onChange: (on: boolean) => setPicked(set => { const next = new Set(set); if (on) next.add(thread.id); else next.delete(thread.id); return next; }) };
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
    {open ? <PullRequestStrip pull={pull} worktreeId={worktreeId} actions={actions} checkoutActions={checkoutActions} onGoTo={onGoTo} /> : pull.destination !== undefined && <RemoveStrip pull={pull} holder={pull.destination} now={now} onRemove={actions?.onRemove} />}
    {(links.length > 0 || slot !== undefined) && <div className="github-actions" role="group" aria-label="Pull request actions">{slot !== undefined && <ConfiguredButtonList slot={slot} />}{links}</div>}
    {open && pull.mergeable === 'conflicting' && <div className="github-strip conflict"><Icon name="conflict" /><span>Merge conflicts with {pull.baseBranch ?? 'the base branch'}. {pull.destination === undefined ? 'Check it out in a Worktree to rebase it.' : <>Rebase {here ? 'here' : <>in <b>{pull.destination.label}</b></>}, or let {here ? 'this Worktree\'s' : 'its'} Agent do it with <code>$fixup</code>.</>}</span></div>}
    {section('threads', 'Review threads', <>
      <div className="github-filters">Show <button type="button" className="github-filter" aria-pressed={showResolved} onClick={() => setShowResolved(value => !value)}>Resolved{settled > 0 && ` ${settled}`}</button></div>
      {open && !here && pull.threads.some(thread => !thread.resolved) && <p className="github-prompt-elsewhere">Selecting threads for a prompt, and this pull request's buttons, are in {pull.destination === undefined ? 'a Worktree for it' : <b>{pull.destination.label}</b>}, so its Agent gets them.</p>}
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
            <ThreadFoot thread={thread} you={onYou} pullUrl={pull.url} write={write} canWrite={canWrite} pick={pick(thread)} draft={drafts[thread.id]} onDraft={text => setDrafts(({ [thread.id]: _closed, ...open }) => text === undefined ? open : { ...open, [thread.id]: text })} label={thread.resolved ? 'resolved' : thread.outdated ? `outdated · @${last.author} spoke last` : last.mine ? 'you spoke last' : onYou ? `waiting on you · @${last.author} spoke last` : `@${last.author} spoke last`} />
          </article>
        </div>;
      })}
      {slot !== undefined && chosen.length > 0 && <div className="github-selection" role="group" aria-label="Selected threads">
        <span>{chosen.length} selected</span>
        <button type="button" className="github-button" onClick={() => setPicked(new Set())}>Clear</button>
        <button type="button" className="github-button go" disabled={onAddToPrompt === undefined} title={onAddToPrompt === undefined ? 'No composer is open here' : undefined} onClick={() => { onAddToPrompt?.(chosenText); setPicked(new Set()); }}>Add {chosen.length} to prompt</button>
        <ConfiguredButtonList slot={slot} append={{ text: chosenText, count: chosen.length }} onSelect={() => setPicked(new Set())} />
      </div>}
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
      {open && pull.mine && reviewer.id !== undefined && !reviewer.team && reviewer.state !== undefined && reviewer.newCommits && !reviewer.requested && <WriteButton busy={rerequesting === reviewer.login} aria-label={`Re-request review from @${reviewer.login}`} disabled={!canWrite || rerequesting !== undefined} title={canWrite ? undefined : 'Add this repository as a Project to re-request reviews here'} onClick={() => {
        setRerequesting(reviewer.login);
        setRerequestError(undefined);
        void write('rerequest', { login: reviewer.login }).then(({ error }) => { setRerequesting(undefined); setRerequestError(error); });
      }}><Icon name="refresh" />Re-request</WriteButton>}
    </span>)}{rerequestError !== undefined && <p className="github-thread-note error" role="alert">{rerequestError}</p>}</div>, { count: pull.reviewers.length })}
    {pull.linkedIssues.length > 0 && section('issues', 'Linked issues', <div className="github-list">{pull.linkedIssues.map(issue => <button key={issue.number} type="button" className="github-list-row" onClick={() => onSelect({ repositoryKey: identity.repositoryKey, kind: 'issue', number: issue.number })}>
      <Icon name="issue" /><span className="github-list-name">#{issue.number} {issue.title}</span><small>{issue.state === 'open' ? 'closes' : 'closed'}</small>
    </button>)}</div>, { count: pull.linkedIssues.length })}
    {section('description', 'Description', pull.description === undefined ? <Empty>No description.</Empty> : <p className="github-detail-text">{pull.description.body}</p>)}
    {section('reviews', 'Review summaries', pull.reviews.length === 0 ? <Empty>None.</Empty> : pull.reviews.map(review => <Comment key={review.id} comment={review} now={now} extra={<span className={`github-review ${summaryState[review.state] ?? 'commented'}`}>{reviewerState[summaryState[review.state] ?? 'commented']}</span>} />), { count: pull.reviews.length })}
    {section('conversation', 'Conversation', pull.comments.length === 0 ? <Empty>None.</Empty> : pull.comments.map(comment => <Comment key={comment.id} comment={comment} now={now} />), { count: pull.comments.length })}
  </>;
}

function IssueView({ issue, identity, now, worktreeId, closed, onToggle, onSelect, onGoTo, checkoutActions }: DetailProps & { issue: IssueDetail }) {
  const section = (key: string, title: string, body: ReactNode, count?: number) => <Section title={title} count={count} closed={closed[key] === true} onToggle={() => onToggle(key)}>{body}</Section>;
  return <>
    <div className="github-detail-meta">
      <span className={`github-state ${issue.state}`}>{issue.state}</span>
      {issue.author !== undefined && <span>@{issue.author}</span>}
      {ago(issue.updatedAt, now) !== undefined && <span>updated {ago(issue.updatedAt, now)} ago</span>}
    </div>
    {issue.labels.length > 0 && <span className="overview-chips">{issue.labels.map(label => <span key={label} className="overview-chip label">{label}</span>)}</span>}
    <WorktreeStrip destination={issue.destination} worktreeId={worktreeId} none="No Worktree for this Issue." actions={issue.state === 'open' ? checkoutActions : undefined} onGoTo={onGoTo} />
    {section('description', 'Description', issue.body.trim() === '' ? <Empty>No description.</Empty> : <p className="github-detail-text">{issue.body}</p>)}
    {section('linked', issue.linkedPullRequests.length > 1 ? 'Linked pull requests' : 'Linked pull request', issue.linkedPullRequests.length === 0 ? <Empty>None yet.</Empty> : <div className="github-list">{issue.linkedPullRequests.map(pull => <button key={pull.number} type="button" className="github-list-row" onClick={() => onSelect({ repositoryKey: identity.repositoryKey, kind: 'pull', number: pull.number })}>
      <Icon name="pull" /><span className="github-list-name">#{pull.number} {pull.title}</span><small>{pull.draft && pull.state === 'open' ? 'draft' : pull.state}</small>
    </button>)}</div>, issue.linkedPullRequests.length)}
    <div className="github-actions" role="group" aria-label="Issue actions">{worktreeId !== undefined && issue.destination?.worktreeId === worktreeId && <ConfiguredButtonList slot="issue" />}{external(issue.url, 'Assign / label')}</div>
  </>;
}

/**
 * One pull request's or Issue's detail, read when it is picked and again when `revision` moves
 * (the server answers from what it kept while the item is unchanged). `item` is its list row, for
 * its reason chips; `refreshes` counts the header's Refresh taps, each read again from GitHub.
 */
function Detail({ request, projectId, projectRepository, selection, item, revision, refreshes, focused, back, actions, renderActions, ...props }: Omit<DetailProps, 'closed' | 'onToggle' | 'identity'> & { request: Request; projectId?: string; projectRepository?: string; selection: Selection; item?: Item; revision: string; refreshes: number; focused: boolean; back?: () => void; actions?: StripActions; renderActions?: (item: Item) => ReactNode }) {
  // sections the operator folded on this item; each item opens with every one expanded
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const sections = { closed, onToggle: (section: string) => setClosed(current => ({ ...current, [section]: !current[section] })) };
  const key = `${selection.kind === 'issue' ? 'issues' : 'pulls'}/${selection.number}`;
  // repository-only reads never borrow the owning workspace's project
  const endpoint = projectId === undefined ? `/api/github/repos/${selection.repositoryKey.split('/').map(encodeURIComponent).join('/')}/${key}` : `/api/projects/${encodeURIComponent(projectId)}/github/${key}`;
  // upstream items keep their namespace when a verified local fork owns the checkout
  const repositoryQuery = projectId !== undefined && normalizeGithubRepository(projectRepository) !== selection.repositoryKey ? `repository=${encodeURIComponent(selection.repositoryKey)}` : '';
  // the panel keys this by item, so what it read is always the item's
  const [read, setRead] = useState<{ detail?: DetailRead; unreachable?: true }>();
  // each write reads the detail again, which the server read from GitHub anew after it
  const [writes, setWrites] = useState(0);
  const lastRefresh = useRef(refreshes);
  useEffect(() => {
    let current = true;
    const fresh = lastRefresh.current !== refreshes;
    lastRefresh.current = refreshes;
    const query = [repositoryQuery, fresh ? 'refresh=1' : ''].filter(Boolean).join('&');
    void request(`${endpoint}${query === '' ? '' : `?${query}`}`)
      .then(async response => { if (!response.ok) throw new Error(); return await response.json() as DetailRead; })
      .then(detail => { if (current) setRead({ detail }); }, () => { if (current) setRead(previous => ({ ...previous, unreachable: true })); });
    return () => { current = false; };
  }, [request, endpoint, repositoryQuery, revision, refreshes, writes]);
  const write = useCallback<Write>(async (path, body) => {
    // read-only repositories cannot invoke project-scoped review mutations
    if (projectId === undefined) return { error: 'Add this repository as a Project to use review actions here.' };
    try {
      const response = await request(`${endpoint}/${path}${repositoryQuery === '' ? '' : `?${repositoryQuery}`}`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      if (!response.ok) return { error: await refusal(response, 'send it') };
      return { result: response.status === 204 ? undefined : await response.json().catch(() => undefined) };
    } catch {
      return { error: 'The console could not be reached.' };
    } finally {
      // a write that failed may still have reached GitHub
      setWrites(count => count + 1);
    }
  }, [request, projectId, endpoint, repositoryQuery]);
  const detail = read?.detail;
  const found = detail?.pullRequest ?? detail?.issue;
  const resolvedItem: Item | undefined = found === undefined ? item : { repository: found.repository, number: found.number, title: found.title, url: found.url, reasons: item?.reasons ?? [], ...(found.destination === undefined ? {} : { destination: { kind: 'worktree', ...found.destination } }) };
  const checkoutActions = resolvedItem === undefined ? props.checkoutActions : renderActions?.(resolvedItem) ?? props.checkoutActions;
  const kind = selection.kind === 'issue' ? 'Issue' : 'Pull request';
  let body: ReactNode;
  if (found === undefined && detail?.problem?.kind === 'no-token') body = <NoTokenCard />;
  else if (found === undefined && (detail?.problem !== undefined || read?.unreachable)) body = <div className="overview-card"><h3>{kind} #{selection.number} could not be read</h3><p>{detail?.problem?.message ?? 'The console could not be reached.'}</p></div>;
  else if (found === undefined) body = <div className="github-detail-loading" role="status" aria-label={`Loading ${kind} #${selection.number}`} aria-busy="true"><Skeleton className="overview-skeleton-title" /><Skeleton className="overview-skeleton-meta" /><Skeleton className="overview-skeleton-meta" /></div>;
  else body = detail?.pullRequest !== undefined ? <PullRequestView pull={detail.pullRequest} item={item} identity={selection} actions={actions} write={write} canWrite={projectId !== undefined} {...props} checkoutActions={checkoutActions} {...sections} /> : <IssueView issue={detail!.issue!} identity={selection} {...props} checkoutActions={checkoutActions} {...sections} />;
  return <article className="github-detail" aria-label={`${kind} #${selection.number}`}>
    {(back !== undefined || focused) && <div className="github-detail-crumbs">
      {back !== undefined && <button type="button" className="github-button" onClick={back}>‹ Back to cards</button>}
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

// the server's `PullRequestDraft`
type PullRequestDraft = { branch: string; base: string; title: string; issue?: number };
type PullRequestForm = { title: string; body: string; base: string; draft: boolean };

/**
 * This Worktree's branch with no pull request. Push and create PR… opens an inline form, prefilled
 * from the branch (its first commit's title, origin's default base, "Closes #N" for the Worktree's
 * Issue); submitting pushes the branch with an upstream and opens the pull request, which then
 * takes this spot once the lists show it. A failure keeps what was typed.
 */
function CreatePullRequest({ request, worktreeId, branch }: { request: Request; worktreeId: string; branch?: string }) {
  const [form, setForm] = useState<PullRequestForm>();
  const [busy, setBusy] = useState<'open' | 'create'>();
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<{ number: number; url: string }>();
  const url = `/api/worktrees/${encodeURIComponent(worktreeId)}/github/pull-request`;
  const open = async () => {
    setBusy('open');
    setError(undefined);
    try {
      const response = await request(url);
      if (response.ok) {
        const draft = await response.json() as PullRequestDraft;
        setForm({ title: draft.title, body: draft.issue === undefined ? '' : `Closes #${draft.issue}`, base: draft.base, draft: false });
      } else setError(await refusal(response, 'read the branch'));
    } catch { setError('The console could not be reached.'); }
    setBusy(undefined);
  };
  const create = async (values: PullRequestForm) => {
    setBusy('create');
    setError(undefined);
    try {
      const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
      if (response.ok) setCreated(await response.json() as { number: number; url: string }); else setError(await refusal(response, 'create the pull request'));
    } catch { setError('The console could not be reached.'); }
    setBusy(undefined);
  };
  const name = branch ?? 'This branch';
  if (created !== undefined) return <div className="github-create" role="status"><b>{name}</b><span>Pushed, and opened <a href={created.url} target="_blank" rel="noreferrer">#{created.number}</a>.</span></div>;
  if (form === undefined) return <div className="github-create">
    <b>{name}</b><span>No pull request yet.</span>
    {branch !== undefined && <div className="github-actions"><WriteButton busy={busy === 'open'} className="go" disabled={busy !== undefined} onClick={() => void open()}><Icon name="pull" />Push and create PR…</WriteButton></div>}
    {error !== undefined && <p className="github-create-error" role="alert">{error}</p>}
  </div>;
  const set = (change: Partial<PullRequestForm>) => setForm({ ...form, ...change });
  return <section className="github-create github-create-form" aria-label="Push and create a pull request">
    <b>Push and create a pull request</b>
    <label>Title<input type="text" value={form.title} onChange={event => set({ title: event.target.value })} /></label>
    <label>Into<input type="text" value={form.base} onChange={event => set({ base: event.target.value })} /></label>
    <label>Description<textarea value={form.body} onChange={event => set({ body: event.target.value })} /></label>
    <label className="github-create-check"><input type="checkbox" checked={form.draft} onChange={event => set({ draft: event.target.checked })} />Create as draft</label>
    {error !== undefined && <p className="github-create-error" role="alert">{error}</p>}
    <div className="github-actions">
      <WriteButton busy={busy === 'create'} className="go" disabled={busy !== undefined || form.title.trim() === '' || form.base.trim() === ''} onClick={() => void create(form)}><Icon name="pull" />Push {name} and create PR</WriteButton>
      <button type="button" className="github-button" disabled={busy !== undefined} onClick={() => { setForm(undefined); setError(undefined); }}>Cancel</button>
    </div>
    <span>Pushes {name} to origin with an upstream, then opens the pull request on GitHub.</span>
  </section>;
}

/**
 * one shared triage layout filtered by the owning repository or left global
 * the repository catalog also resolves direct focus and current-worktree utilities
 */
export type GithubPanelProps = {
  request: Request;
  projectId?: string;
  repository?: string;
  worktreeId?: string;
  main: boolean;
  branch?: string;
  hasPullRequest: boolean;
  revision: string;
  focus?: GithubFocus;
  projects?: readonly GithubDashboardProject[];
  scope?: GithubScope;
  onScopeChange?: (scope: GithubScope) => void;
  dynamicWorktrees?: boolean;
  actions?: StripActions;
  onClose: () => void;
  onOpenWorktree?: OpenWorktree;
  onNewWorktree?: GithubPanelNewWorktree;
  onAddToPrompt?: (text: string) => void;
  // what this panel last showed in its Workspace, restored on mount; `onSaveView` takes it back as it changes
  savedView?: GithubPanelView;
  onSaveView?: (view: GithubPanelView) => void;
};
export type GithubPanelView = { selection?: GithubItemIdentity; tab?: ColumnKey };

// host repository and cross-repository GitHub browsing in one Workspace split
export function GithubPanel({ request, projectId, repository, worktreeId, main, branch, hasPullRequest, revision, focus, projects = [], scope, onScopeChange, dynamicWorktrees = true, actions, onClose, onOpenWorktree, onNewWorktree, onAddToPrompt, savedView, onSaveView }: GithubPanelProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  // a phone, or a panel too narrow for list and detail, drills down
  const phone = usePhoneLayout() || narrow;
  const [localScope, setLocalScope] = useState<GithubScope>(() => repository === undefined ? 'all' : 'repo');
  const activeScope: GithubScope = repository === undefined ? 'all' : scope ?? localScope;
  const [lists, setLists] = useState<Lists>();
  const [overview, setOverview] = useState<Overview>();
  const [unreachable, setUnreachable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshes, setRefreshes] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [allTab, setAllTab] = useState<ColumnKey>(savedView?.tab ?? 'mine');
  // choose the first unseen phone tab only once, and never over a restored one
  const allTabChosen = useRef(savedView?.tab !== undefined);
  const initialFocus = focusIdentity(focus, repository);
  const [selected, setSelected] = useState<Selection | undefined>(initialFocus ?? savedView?.selection);
  useEffect(() => onSaveView?.({ selection: selected, tab: allTabChosen.current ? allTab : undefined }), [selected, allTab]);
  const [focused, setFocused] = useState<string>();
  const inView = useInView(ref);
  const expanded = usePanelExpand('github')?.expanded === true;
  const normalizedOwnerRepository = normalizeGithubRepository(repository);
  const effectiveProjects: readonly GithubDashboardProject[] = projects.length > 0 || projectId === undefined ? projects : [{
    id: projectId,
    label: repository ?? 'Repository',
    ...(repository === undefined ? {} : { github: repository }),
    available: true,
    manageWorktrees: true,
    worktrees: worktreeId === undefined ? [] : [{ id: worktreeId, projectId, label: main ? repository?.split('/').at(-1) ?? 'Repository' : branch ?? 'Worktree', available: true, main }]
  }];
  const ownerForkRepository = normalizeGithubRepository(effectiveProjects.find(project => project.id === projectId)?.githubForkOf);

  useLayoutEffect(() => {
    const pane = ref.current;
    if (pane === null) return;
    const measure = () => {
      const width = pane.getBoundingClientRect().width;
      // retain the last useful layout while another panel hides this one
      if (width > 0) setNarrow(width < drillDownWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    measure();
    return () => observer.disconnect();
  }, []);

  // read repository-scoped lists
  const loadRepo = useCallback(async (refresh: boolean) => {
    // repository reads require a project
    if (projectId === undefined) return;
    try {
      const response = await request(`/api/projects/${encodeURIComponent(projectId)}/github${refresh ? '?refresh=1' : ''}`);
      if (!response.ok) return;
      setLists(await response.json() as Lists);
    } catch { /* the optional catalog never replaces swim-lane read status */ }
    setNow(Date.now());
  }, [request, projectId]);
  // read cross-repository lists
  const loadAll = useCallback(async (refresh: boolean) => {
    try {
      const response = await request(`/api/github/overview${refresh ? '?refresh=1' : ''}`);
      if (!response.ok) throw new Error();
      const next = await response.json() as Overview;
      setOverview(next);
      setUnreachable(false);
    } catch { setUnreachable(true); }
    setNow(Date.now());
  }, [request]);
  // both scopes share one triage snapshot; repo scope is only a local filter
  useEffect(() => {
    void loadAll(false);
    // retain the catalog for direct item focus and current-worktree utilities
    if (projectId !== undefined) void loadRepo(false);
  }, [loadAll, loadRepo, projectId, revision]);
  // derive identical swim lanes with exact canonical repository filtering
  const scopedOverview = useMemo(() => {
    // all repositories use the unchanged global snapshot
    if (overview === undefined || activeScope === 'all') return overview;
    // include the authenticated parent of this local fork without conflating item identities
    const matches = (item: Item) => {
      const key = normalizeGithubRepository(item.repository);
      return key !== undefined && (key === normalizedOwnerRepository || key === ownerForkRepository);
    };
    const mine = overview.mine.filter(matches);
    const reviews = overview.reviews.filter(matches);
    const issues = overview.issues.filter(matches);
    return { ...overview, mine, reviews, issues, totals: { mine: mine.length, reviews: reviews.length, issues: issues.length } };
  }, [overview, activeScope, normalizedOwnerRepository, ownerForkRepository]);
  // choose the first unseen tab from the visible scope only once per visit
  useEffect(() => {
    // an explicit tab selection always wins over incoming data
    if (allTabChosen.current || scopedOverview?.fetchedAt === undefined) return;
    allTabChosen.current = true;
    setAllTab((['mine', 'reviews', 'issues'] as ColumnKey[]).find(column => scopedOverview[column].some(unseen)) ?? 'mine');
  }, [scopedOverview]);
  useEffect(() => {
    // keep relative ages current
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const pendingFocus = useRef(focus);
  useEffect(() => {
    pendingFocus.current = focus;
    const identity = focusIdentity(focus, repository);
    if (identity !== undefined) setSelected(identity);
  }, [focus, repository]);

  const repoEntries = lists === undefined ? [] : catalogGroups.flatMap(group => (lists[group.key] ?? []).map(item => ({ item, group, identity: githubItemIdentity(item.repository, group.issue ? 'issue' : 'pull', item.number) }))).filter((entry): entry is { item: PanelItem; group: (typeof catalogGroups)[number]; identity: GithubItemIdentity } => entry.identity !== undefined);
  const overviewEntries = scopedOverview === undefined ? [] : ([['mine', scopedOverview.mine], ['reviews', scopedOverview.reviews], ['issues', scopedOverview.issues]] as const).flatMap(([column, items]) => items.map(item => ({ item, column, identity: githubItemIdentity(item.repository, column === 'issues' ? 'issue' : 'pull', item.number) }))).filter((entry): entry is { item: Item; column: ColumnKey; identity: GithubItemIdentity } => entry.identity !== undefined);
  const activeEntries = overviewEntries;

  useEffect(() => {
    const wanted = focusIdentity(pendingFocus.current, repository);
    if (wanted === undefined || ![...activeEntries, ...repoEntries].some(entry => sameGithubItem(entry.identity, wanted))) return;
    pendingFocus.current = undefined;
    const id = rowId(wanted);
    const entry = overviewEntries.find(candidate => sameGithubItem(candidate.identity, wanted));
    // reveal the focused item's shared swim lane when it is in triage
    if (entry !== undefined) setAllTab(entry.column);
    if (focus?.overview) setFocused(id);
    window.requestAnimationFrame(() => ref.current?.querySelector(`[data-row="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [activeEntries, activeScope, focus, overviewEntries, repoEntries, repository]);

  useEffect(() => {
    // repository scope cannot retain a foreign repository selection
    if (activeScope === 'repo' && selected !== undefined && selected.repositoryKey !== normalizedOwnerRepository && selected.repositoryKey !== ownerForkRepository) setSelected(undefined);
  }, [activeScope, normalizedOwnerRepository, ownerForkRepository, selected]);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshes(count => count + 1);
    await Promise.all([loadAll(true), ...(projectId === undefined ? [] : [loadRepo(true)])]);
    setRefreshing(false);
  };
  // update controlled and compatibility scope state
  const changeScope = (next: GithubScope) => {
    // non-git owners cannot select repository scope
    if (next === 'repo' && normalizedOwnerRepository === undefined) return;
    setLocalScope(next);
    onScopeChange?.(next);
  };
  // resolve one row against current dashboard projects
  const contextFor = (item: Item, identity: GithubItemIdentity) => resolveGithubItemContext({ identity, destination: item.destination, projects: effectiveProjects, ownerProjectId: projectId, ownerWorktreeId: worktreeId });
  // select one normalized item
  const select = (identity: Selection) => {
    setSelected(identity);
    setFocused(current => current === rowId(identity) ? current : undefined);
  };
  // create one shared adjacent action control
  const itemActions = (item: Item, identity: GithubItemIdentity, variant: 'card' | 'detail' = 'card', column?: ColumnKey) => {
    const context = contextFor(item, identity);
    const profile = variant === 'card' && identity.kind === 'pull' && column !== undefined
      ? { open: (item as PanelItem).state === undefined, mine: column === 'mine' }
      : undefined;
    return <GithubItemActions item={item} context={context} request={request} dynamicWorktrees={dynamicWorktrees} ownerNotReady={actions?.notReady} onOpenWorktree={onOpenWorktree} onNewWorktree={onNewWorktree} onFeedback={actions?.onFeedback} variant={variant} profile={profile} review={context.heldHere ? actions?.review : undefined} />;
  };

  // upstream fork checkouts may be in triage even when the origin-only catalog has no pr
  const pinned = main || worktreeId === undefined ? undefined : [...repoEntries, ...overviewEntries].filter(entry => entry.identity.kind === 'pull' && contextFor(entry.item, entry.identity).heldHere).sort((left, right) => Number((left.item as PanelItem).state !== undefined) - Number((right.item as PanelItem).state !== undefined))[0];
  const shownSelection = selected;
  const shownEntry = shownSelection === undefined ? undefined : [...activeEntries, ...repoEntries].find(entry => sameGithubItem(entry.identity, shownSelection));
  const shownItem = shownEntry?.item;
  const shownContext = shownSelection === undefined ? undefined : resolveGithubItemContext({ identity: shownSelection, destination: shownItem?.destination, projects: effectiveProjects, ownerProjectId: projectId, ownerWorktreeId: worktreeId });
  const detailProject = shownContext?.detailProject;
  // repository-only details never inherit a non-git owner's local actions
  const detailOwnedHere = detailProject !== undefined && detailProject.id === projectId;
  const detailWorktreeId = detailOwnedHere ? worktreeId : undefined;
  const exactOwnerActions = detailOwnedHere ? actions : undefined;
  // seen state follows the shared filtered lists and visible detail
  const shownRows = scopedOverview === undefined ? [] : phone && shownSelection !== undefined ? shownItem === undefined ? [] : [shownItem]
    : phone || shownSelection !== undefined ? [...scopedOverview[allTab], ...shownItem === undefined ? [] : [shownItem]]
      : [...scopedOverview.mine, ...scopedOverview.reviews, ...scopedOverview.issues];
  const activePayload = scopedOverview;
  const listed = activePayload !== undefined && activePayload.fetchedAt !== undefined && activePayload.problem?.kind !== 'no-token';
  const isNew = useSeenRows(request, shownRows, listed && inView);

  const noOpen = (() => undefined) as (worktreeId: string, item: Item, column: ColumnKey) => void;
  // render one shared swim lane for either scope
  const allColumn = (column: ColumnKey) => {
    const labels: Record<ColumnKey, string> = { mine: 'My pull requests', reviews: 'Review requests', issues: 'Assigned issues' };
    const items = scopedOverview?.[column] ?? [];
    return <section key={column} className="overview-column" aria-label={labels[column]}>
      {!phone && <header className="overview-column-head"><Icon name={column === 'mine' ? 'pull' : column === 'reviews' ? 'review' : 'issue'} /><h3>{labels[column]}</h3><span className="overview-count">{scopedOverview?.totals[column] ?? items.length}</span></header>}
      <div className="overview-column-body"><RepositoryGroups items={items} column={column} now={now} isNew={isNew} onOpen={noOpen} selectable={(item, kind) => {
        // every valid identity opens locally, even without a configured project
        return githubItemIdentity(item.repository, kind === 'issues' ? 'issue' : 'pull', item.number) !== undefined;
      }} onSelect={(item, kind) => {
        const identity = githubItemIdentity(item.repository, kind === 'issues' ? 'issue' : 'pull', item.number);
        if (identity !== undefined) { setAllTab(kind); select(identity); }
      }} actions={(item, kind) => {
        const identity = githubItemIdentity(item.repository, kind === 'issues' ? 'issue' : 'pull', item.number);
        return identity === undefined ? null : itemActions(item, identity, 'card', kind);
      }} rowState={(item, kind) => {
        const identity = githubItemIdentity(item.repository, kind === 'issues' ? 'issue' : 'pull', item.number);
        if (identity === undefined) return {};
        const context = contextFor(item, identity);
        return { id: rowId(identity), here: context.heldHere, selected: shownSelection !== undefined && sameGithubItem(shownSelection, identity), focused: focused === rowId(identity) };
      }} /></div>
    </section>;
  };

  const detail = shownSelection === undefined ? undefined : <Detail
    key={`${githubItemKey(shownSelection)}:${detailProject?.id ?? 'repository'}`}
    request={request}
    projectId={detailProject?.id}
    projectRepository={detailProject?.github}
    selection={shownSelection}
    item={shownItem}
    revision={revision}
    refreshes={refreshes}
    focused={focused === rowId(shownSelection)}
    now={now}
    worktreeId={detailWorktreeId}
    actions={exactOwnerActions}
    onSelect={select}
    checkoutActions={shownContext === undefined || shownItem === undefined ? undefined : itemActions(shownItem, shownSelection, 'detail')}
    renderActions={resolvedItem => itemActions(resolvedItem, shownSelection, 'detail')}
    onAddToPrompt={detailOwnedHere ? onAddToPrompt : undefined}
    onGoTo={onOpenWorktree === undefined ? undefined : target => onOpenWorktree(target, { ...shownSelection, issue: shownSelection.kind === 'issue', repository: shownSelection.repositoryKey, overview: true })}
    back={() => { /* return to the same scope's swim lanes on either layout */ setSelected(undefined); setFocused(undefined); }}
  />;

  const problem = activePayload?.problem;
  const banner = staleNotice(activePayload, unreachable, now);
  let body: ReactNode;
  let split = false;
  if (problem?.kind === 'no-token') body = <NoTokenCard />;
  else if (activePayload === undefined && unreachable) body = <div className="overview-card"><h3>The console could not be reached</h3><p>GitHub loads once the console answers again.</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;
  else if (activePayload === undefined || (activePayload.fetchedAt === undefined && problem === undefined)) body = <div className="overview-skeletons" role="status" aria-label="Loading GitHub" aria-busy="true">{Array.from({ length: 6 }, (_, index) => <div className="overview-skeleton" key={index}><Skeleton className="overview-skeleton-title" /><Skeleton className="overview-skeleton-meta" /></div>)}</div>;
  else if (activePayload.fetchedAt === undefined) body = <div className="overview-card"><h3>GitHub is unreachable</h3><p>{problem?.message}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;
  else {
    // keep the same lane shells and tabs when a successful read contains no items
    const tabs = <div className="overview-tabs" role="tablist" aria-label="GitHub lists">{(['mine', 'reviews', 'issues'] as ColumnKey[]).map(column => <button key={column} type="button" role="tab" aria-selected={allTab === column} className={allTab === column ? 'active' : ''} onClick={() => { /* keep deliberate tab choice */ allTabChosen.current = true; setAllTab(column); }}>{column === 'mine' ? 'Mine' : column === 'reviews' ? 'Reviews' : 'Issues'}<span className="overview-count">{scopedOverview?.totals[column] ?? 0}</span>{scopedOverview?.[column].some(isNew) && <i className="overview-tab-dot" role="img" aria-label="Holds something new" />}</button>)}</div>;
    const list = phone || shownSelection !== undefined ? <>{tabs}{allColumn(allTab)}</> : <div className="overview-columns github-all-columns">{(['mine', 'reviews', 'issues'] as ColumnKey[]).map(allColumn)}</div>;
    split = !phone && shownSelection !== undefined;
    body = phone ? detail ?? list : shownSelection === undefined ? list : <><div className="github-list-column github-all-list">{list}</div><div className="github-detail-column">{detail}</div></>;
  }
  // current-worktree utilities stay available without changing either swim-lane layout
  const worktreeTools = main || worktreeId === undefined ? null : pinned !== undefined
    ? <div className="github-worktree-tools" role="group" aria-label="This Worktree"><button type="button" className="github-button" onClick={() => select(pinned.identity)}><Icon name="branch" />View PR #{pinned.identity.number} in this worktree</button></div>
    : hasPullRequest ? null : <CreatePullRequest key={`${worktreeId}:${branch ?? ''}`} request={request} worktreeId={worktreeId} branch={branch} />;

  const repoLabel = repository?.split('/').at(-1) ?? 'Repository';
  return <section ref={ref} className={`github-pane github-scope-${activeScope}${expanded ? ' expanded' : ''}`} role="region" aria-label="GitHub">
    <PanelHeader panelKey="github" label="GitHub" title={<span className="github-pane-title">GitHub{activeScope === 'repo' && repository !== undefined && <> · {repository}</>}</span>} actions={<>
      <div className="github-scope-toggle" role="group" aria-label="GitHub scope">
        <button type="button" aria-pressed={activeScope === 'repo'} disabled={normalizedOwnerRepository === undefined} title={normalizedOwnerRepository === undefined ? 'This Workspace is not a GitHub repository' : `Show ${repository}`} onClick={() => changeScope('repo')}>{repoLabel}</button>
        <button type="button" aria-pressed={activeScope === 'all'} onClick={() => changeScope('all')}>All repos</button>
      </div>
      {listed && <span className="github-freshness">{freshness(activePayload.fetchedAt!, now)}</span>}
      <button type="button" className="panel-header-action" aria-label="Refresh" title="Refresh now" disabled={refreshing} aria-busy={refreshing || undefined} onClick={() => void refresh()}><PanelIcon path={panelIcons.refresh} /></button>
    </>} close={{ key: 'close', label: 'Close GitHub panel', icon: <PanelIcon path={panelIcons.close} />, onSelect: onClose }} />
    {banner !== undefined && <div className="overview-banner" role="status"><Icon name="clock" /><span>{banner}</span><button type="button" onClick={() => void refresh()} disabled={refreshing}>Retry</button></div>}
    <div className={`github-pane-body${split ? ' split' : ''}`}>{worktreeTools !== null && <div className="github-worktree-utility">{worktreeTools}</div>}{body}</div>
  </section>;
}
