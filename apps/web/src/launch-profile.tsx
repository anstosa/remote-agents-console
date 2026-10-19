import { createPortal } from 'react-dom';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useViewportFlyout } from './viewport-flyout.js';
import { usePhoneLayout } from './panel-header.js';

// The closed registry of agent kinds, in resolution/priority order (duplicated from the
// server's `agentKinds` by design). A configured kind (one with a program) is launchable;
// recognition of a kind needs no configuration.
export type AgentKind = 'codex' | 'omx' | 'claude' | 'pi' | 'opencode';
export const agentKinds: readonly AgentKind[] = ['codex', 'omx', 'claude', 'pi', 'opencode'];
// per-kind badge glyph and display label, shared by the split button, tab badge and AGENTS card
export const agentKindGlyph: Record<AgentKind, string> = { codex: '◆', omx: '◈', claude: '✳', pi: 'π', opencode: '◇' };
export const agentKindLabel: Record<AgentKind, string> = { codex: 'Codex', omx: 'OMX', claude: 'Claude', pi: 'Pi', opencode: 'OpenCode' };
// keep version and update actions in the toolbar chooser
export type AgentUpdateStatus = { kind: AgentKind; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string };
type AgentLaunchSettings = { statuses: AgentUpdateStatus[]; updating?: AgentKind; errors: string[]; defaultAgent?: AgentKind; defaultPending: boolean; setDefaultAgent: (kind: AgentKind) => void; updateAgent: (kind: AgentKind) => void };
export const AgentLaunchSettingsContext = createContext<AgentLaunchSettings | undefined>(undefined);
// keep per-agent account controls in the launcher without coupling this module to settings
export type AgentAccountsMenu = { menus: Partial<Record<AgentKind, { content: ReactNode; activeName?: string }>>; onOpen: () => void; onClose: () => void };
export const AgentAccountsMenuContext = createContext<AgentAccountsMenu | undefined>(undefined);

// The capability record the Dashboard publishes per registered kind (ADR 0002). The web
// reads presence and reasons; it never re-derives capabilities. `sandbox*` stay undefined
// until chunk 4 arms the sandbox, so every launch is unsandboxed here.
export type AdapterCapability = { launchable: boolean; unavailableReason?: string; program?: string; stateSource: 'reported' | 'title' | 'both'; turnCapture: boolean; inlineQuestions: boolean; commands: boolean; sandbox: boolean; sandboxUnavailableReason?: string };
export type AdapterCapabilities = Partial<Record<AgentKind, AdapterCapability>>;

export type LaunchScope = 'worktree' | 'project' | 'scratch';
export type LaunchOrigin = LaunchScope | 'default';
// The Launch profile resolution the server publishes so the web renders the menu without
// re-deriving it: which kind a one-click Launch uses, why, and any remembered kind skipped.
export type LaunchResolution = { kind?: AgentKind; origin?: LaunchOrigin; skipped?: { kind: AgentKind; origin: LaunchScope; reason: string } };
// what a launch/restart row sends to a launch-family route; sandboxed is never remembered
export type LaunchChoice = { kind: AgentKind; sandboxed: boolean };

// the per-kind adapter capabilities from the active dashboard, for the Launch controls
export const AdaptersContext = createContext<AdapterCapabilities | undefined>(undefined);

// the configured kinds (those with a program), in registry order
export const configuredKinds = (adapters: AdapterCapabilities | undefined): AgentKind[] => agentKinds.filter(kind => adapters?.[kind]?.program !== undefined);
// a launch of this kind starts Sandboxed by default whenever the console can enforce it
export const defaultSandboxed = (capability: AdapterCapability | undefined): boolean => capability?.sandbox === true && capability.sandboxUnavailableReason === undefined;

// POST body for a launch-family route: the chosen kind and whether to confine it
export const launchRequestInit = (choice: LaunchChoice): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(choice) });

// sandbox line per kind and state — copy from the effort's Launch profile section
export const sandboxCopy = (kind: AgentKind, capability: AdapterCapability | undefined, sandboxed: boolean): string => {
  if (capability === undefined) return '';
  // Codex (and OMX, which runs Codex) names its own sandbox; other kinds say nothing until chunk 4 arms `sandbox`
  if (!capability.sandbox) return kind === 'codex' || kind === 'omx' ? "Uses Codex's own sandbox" : '';
  if (capability.sandboxUnavailableReason !== undefined) return kind === 'claude' ? `Sandbox as configured in Claude — ${capability.sandboxUnavailableReason}` : `Sandbox unavailable — ${capability.sandboxUnavailableReason}`;
  if (sandboxed) return kind === 'claude' ? 'Sandbox enforced by console' : 'Tool commands sandboxed by console';
  return kind === 'claude' ? 'Sandbox disabled for this launch' : 'Tool commands unsandboxed for this launch';
};
// why the resolved kind is resolved, shown against it in the menu (and the schedule pickers)
export const originCopy = (origin: LaunchOrigin | undefined): string => origin === 'worktree' ? 'last used here' : origin === 'project' ? 'last used in this project' : origin === 'scratch' ? 'last used for scratch' : 'default agent';
const scopeCopy = (scope: LaunchScope): string => scope === 'worktree' ? 'here' : scope === 'project' ? 'this project' : 'scratch';

export type LaunchVerb = 'Launch' | 'Restart';
const actionCopy = (verb: LaunchVerb, kind: AgentKind | undefined): string => kind === undefined ? `${verb} agent` : verb === 'Launch' ? `Launch ${agentKindLabel[kind]}` : `Restart as ${agentKindLabel[kind]}`;

const KindMark = ({ kind }: { kind: AgentKind }) => <span className={`launch-kind-mark launch-kind-${kind}`} aria-hidden="true">{agentKindGlyph[kind]}</span>;
const LockIcon = () => <svg className="launch-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
const UnlockIcon = () => <svg className="launch-lock open" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V7a4 4 0 0 1 7.5-2.2" /></svg>;
const ChevronIcon = () => <svg className="launch-chevron-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;

// the disabled-primary hint, or undefined when a one-click launch is possible. A resolved
// kind (including the legacy config's Codex, which has no `program`) means launchable.
const launchHint = (adapters: AdapterCapabilities | undefined, resolution: LaunchResolution | undefined): string | undefined =>
  resolution?.kind !== undefined ? undefined
    : configuredKinds(adapters).length === 0 ? 'No agents configured — add an adapters entry to the console config.'
      : 'No configured agent is launchable right now';

// A non-launch action a menu lists after the kinds (the + rows' Terminal and Empty workspace).
export type LaunchMenuEntry = { key: string; label: string; detail: string; icon: ReactNode; onSelect: () => void };

// the entries after the kinds, divided from them
function LaunchMenuEntries({ entries, divider = true }: { entries: readonly LaunchMenuEntry[]; divider?: boolean }) {
  if (entries.length === 0) return null;
  return <>{divider && <hr className="more-menu-divider" />}{entries.map(entry => <button key={entry.key} type="button" role="menuitem" className="launch-row launch-row-entry" onClick={entry.onSelect}><span className="launch-kind-mark launch-entry-icon" aria-hidden="true">{entry.icon}</span><span className="launch-row-copy"><strong>{entry.label}</strong><small>{entry.detail}</small></span></button>)}</>;
}

// The menu of launch actions: one row per configured kind (the resolved one annotated
// with why), unavailable kinds disabled with their reason, then "without sandbox" rows for
// kinds that default to Sandboxed, a footnote when a remembered kind was skipped, and last any
// `entries` the caller adds. `launchDisabled` holds every launch row back, leaving the entries.
// opt into global management only from the toolbar
export function LaunchMenu({ verb, label, resolution, onLaunch, entries = [], launchDisabled = false, showAgentSettings = false, accounts: providedAccounts, accountsView: controlledAccountsView, onAccountsViewChange }: { verb: LaunchVerb; label: string; resolution: LaunchResolution | undefined; onLaunch: (choice: LaunchChoice) => void; entries?: readonly LaunchMenuEntry[]; launchDisabled?: boolean; showAgentSettings?: boolean; accounts?: AgentAccountsMenu; accountsView?: AgentKind; onAccountsViewChange?: (kind: AgentKind | undefined) => void }) {
  const adapters = useContext(AdaptersContext);
  const sharedSettings = useContext(AgentLaunchSettingsContext);
  // reserve global agent details and controls for the toolbar
  const settings = showAgentSettings ? sharedSettings : undefined;
  const accounts = showAgentSettings ? providedAccounts : undefined;
  const [localAccountsView, setLocalAccountsView] = useState<AgentKind>();
  // preserve the toolbar submenu across desktop and phone render paths
  const accountsView = controlledAccountsView ?? localAccountsView;
  const setAccountsView = onAccountsViewChange ?? setLocalAccountsView;
  // load the selected name before opening the account submenu
  useEffect(() => {
    // skip consoles without account controls
    if (accounts === undefined) return;
    accounts.onOpen();
    return accounts.onClose;
  }, [accounts?.onOpen, accounts?.onClose]);
  // return to the kind list without closing the launcher flyout
  const openAccounts = accountsView === undefined ? undefined : accounts?.menus[accountsView];
  if (accountsView !== undefined && openAccounts !== undefined) return <div className="launch-accounts-submenu" role="group" aria-label={`${agentKindLabel[accountsView]} accounts`}><button className="launch-submenu-back" type="button" onClick={() => setAccountsView(undefined)}>‹ Back to agents</button>{openAccounts.content}</div>;
  const kinds = configuredKinds(adapters);
  if (kinds.length === 0) return <><p className="launch-menu-empty">No agents configured. Add an <code>adapters</code> entry to the console config to launch agents.</p><LaunchMenuEntries entries={entries} /></>;
  const unsandboxable = kinds.filter(kind => adapters?.[kind]?.launchable === true && defaultSandboxed(adapters?.[kind]));
  const skipped = resolution?.skipped;
  return <>
    <p className="launch-menu-heading">{verb} · {label}</p>
    {/* render choices with optional toolbar-only management */}{kinds.map(kind => {
      const capability = adapters![kind]!;
      const sandboxed = defaultSandboxed(capability);
      const resolved = resolution?.kind === kind;
      const status = settings?.statuses.find(candidate => candidate.kind === kind);
      // show both versions only while an update is available
      const version = status?.currentVersion === undefined ? undefined : status.currentVersion.startsWith('v') ? status.currentVersion : `v${status.currentVersion}`;
      const latest = status?.latestVersion === undefined ? undefined : status.latestVersion.startsWith('v') ? status.latestVersion : `v${status.latestVersion}`;
      const versionLabel = status?.updateAvailable && version !== undefined && latest !== undefined ? `${version} → ${latest}` : version;
      // identify the selected account beside its installed version
      const kindAccounts = accounts?.menus[kind];
      const accountName = kindAccounts?.activeName;
      return <div key={kind} role="group" aria-label={`${agentKindLabel[kind]} agent`} className="launch-agent-line"><button type="button" role="menuitem" className="launch-row" disabled={!capability.launchable || launchDisabled} title={capability.unavailableReason} onClick={() => onLaunch({ kind, sandboxed })}>
        <KindMark kind={kind} />
        <span className="launch-row-copy"><strong>{agentKindLabel[kind]}{resolved && <em> · {originCopy(resolution?.origin)}</em>}</strong>{(versionLabel !== undefined || accountName !== undefined) && <span className="launch-agent-details">{versionLabel !== undefined && <span className="launch-agent-version">{versionLabel}</span>}{accountName !== undefined && <span className="launch-agent-account" title={accountName}>{accountName}</span>}</span>}<small>{capability.launchable ? sandboxCopy(kind, capability, sandboxed) : capability.unavailableReason ?? 'Unavailable'}</small></span>
        {capability.launchable && sandboxed && <LockIcon />}
      </button>{/* keep the account submenu next to launch */}{kindAccounts !== undefined && <button type="button" role="menuitem" className="launch-agent-accounts" data-context-flyout aria-label={`${agentKindLabel[kind]} accounts`} aria-haspopup="menu" onClick={() => setAccountsView(kind)}>Accounts <span aria-hidden="true">›</span></button>}{/* put update before the default star */}{status?.updateAvailable && <button type="button" role="menuitem" className="launch-agent-update" aria-label={`Update ${agentKindLabel[kind]} to ${status.latestVersion ?? 'latest'}`} disabled={settings?.updating !== undefined} onClick={() => settings?.updateAgent(kind)}>{settings?.updating === kind ? <><span className="spinner" />Updating…</> : 'Update'}</button>}{/* keep an unavailable persisted default visible */}{settings !== undefined && (capability.launchable || settings.defaultAgent === kind) && <button type="button" role="menuitemradio" className="launch-agent-default" aria-label={`Make ${agentKindLabel[kind]} default`} aria-checked={settings.defaultAgent === kind} title={settings.defaultAgent === kind ? 'Default agent' : `Make ${agentKindLabel[kind]} default`} disabled={!capability.launchable || settings.defaultAgent === kind || settings.defaultPending} onClick={() => settings.setDefaultAgent(kind)}>{settings.defaultAgent === kind ? '★' : '☆'}</button>}</div>;
    })}
    {/* retain distinct version and operation errors */}{settings?.errors.map(error => <p key={error} className="launch-menu-error" role="alert">{error}</p>)}
    {unsandboxable.length > 0 && <><hr className="more-menu-divider" /><p className="launch-menu-heading launch-menu-subheading">Without sandbox — this launch only</p>{unsandboxable.map(kind => <button key={`${kind}-unsandboxed`} type="button" role="menuitem" className="launch-row launch-row-unsandboxed" disabled={launchDisabled} onClick={() => onLaunch({ kind, sandboxed: false })}><KindMark kind={kind} /><span className="launch-row-copy"><strong>{agentKindLabel[kind]}</strong><small>{sandboxCopy(kind, adapters?.[kind], false)}</small></span><UnlockIcon /></button>)}</>}
    {skipped !== undefined && <p className="launch-menu-note">Remembered {agentKindLabel[skipped.kind]} ({scopeCopy(skipped.origin)}) skipped — {skipped.reason}</p>}
    <LaunchMenuEntries entries={entries} />
  </>;
}

// What a split button's primary does instead of launching: the + rows open the Agent already
// running at their Place.
export type LaunchPrimary = { label: string; ariaLabel: string; onSelect: () => void };

// the split button: primary launches the resolved kind in one click (naming it, with a
// lock when Sandboxed); the chevron opens the actions menu. `compact` gives the launcher
// rows the same control sized to a row, its menu the same anchored flyout. `quiet` is the Workspace
// toolbar's Launch beside a running Agent: the kind mark and the verb on a plain control.
// `disabledReason` titles a disabled primary with why it cannot launch. `primary` replaces the
// launch with another default action, and `entries` follow the kinds in the menu;
// `launchDisabled` holds back only the launches, so the other two stay usable. When the
// dashboard carries no resolution (`resolution === undefined`) the desktop control degrades to a
// single plain "Launch agent" that launches without a kind, as before the split button. On a
// phone, a single button always opens the agent menu instead of launching a default kind.
// `minimized` is the toolbar's hidden agent panel: the primary (the phone's single button) shows
// it again, badged with the Agents it holds, and the chevron still launches another.
// keep place actions compact and opt into toolbar management explicitly
export function LaunchSplitButton({ verb = 'Launch', label, resolution, onLaunch, disabled = false, disabledReason, pending = false, compact = false, quiet = false, primary, entries = [], launchDisabled = false, placeActions = false, alwaysShowMenu = false, showAgentSettings = false, minimized }: { verb?: LaunchVerb; label: string; resolution: LaunchResolution | undefined; onLaunch: (choice?: LaunchChoice) => void; disabled?: boolean; disabledReason?: string; pending?: boolean; compact?: boolean; quiet?: boolean; primary?: LaunchPrimary; entries?: readonly LaunchMenuEntry[]; launchDisabled?: boolean; placeActions?: boolean; alwaysShowMenu?: boolean; showAgentSettings?: boolean; minimized?: { count: number; onShow: () => void } }) {
  const adapters = useContext(AdaptersContext);
  const accounts = useContext(AgentAccountsMenuContext);
  const settings = useContext(AgentLaunchSettingsContext);
  // keep installer progress distinct from updates awaiting attention
  const updateInProgress = showAgentSettings && settings?.updating !== undefined;
  // reserve update attention for the persistent toolbar Launch control
  const updatesAvailable = updateInProgress || (showAgentSettings && settings?.statuses.some(status => status.updateAvailable) === true);
  // announce the same active state conveyed by the moving border
  const updateLabel = updateInProgress ? 'update in progress' : 'update available';
  const phone = usePhoneLayout();
  const [open, setOpen] = useState(false);
  const [accountsView, setAccountsView] = useState<AgentKind>();
  // close both flyout pages for every dismissal path
  const closeMenu = useCallback(() => { setOpen(false); setAccountsView(undefined); }, []);
  // remeasure the recreated flyout when the phone control replaces the desktop split
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLSpanElement>(open, { align: phone ? 'center' : 'end' });
  // an outside press closes the menu, including one inside the "+" launcher flyout these
  // rows live in — its backdrop only covers presses outside itself
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // keep the account submenu behind its own rename and login dialogs
      if (target instanceof Element && target.closest('[data-launch-submenu-dialog]')) return;
      if (anchorRef.current?.contains(target) || flyoutRef.current?.contains(target)) return;
      closeMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      // leave account dialogs to their own escape handling
      if (event.key !== 'Escape' || document.querySelector('[data-launch-submenu-dialog]')) return;
      closeMenu();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', closeOnEscape); };
  }, [open, closeMenu]);
  const primaryClass = compact ? 'launch-compact' : 'queue';
  const launch = (choice?: LaunchChoice) => { closeMenu(); onLaunch(choice); };
  // an entry closes the menu before it acts, as a launch does
  const menuEntries = entries.map(entry => ({ ...entry, onSelect: () => { closeMenu(); entry.onSelect(); } }));
  const minimizedTitle = minimized === undefined ? undefined : `Show the minimized agent panel (${minimized.count} Agent${minimized.count === 1 ? '' : 's'})`;
  const minimizedBadge = minimized !== undefined && <span className="saved-prompts-count launch-minimized-count" aria-hidden="true">{minimized.count}</span>;
  const primaryButton = primary === undefined ? undefined : <button type="button" className={`${primaryClass} launch-primary`} aria-label={primary.ariaLabel} disabled={disabled} onClick={() => { closeMenu(); primary.onSelect(); }}>{primary.label}</button>;
  // both phone and desktop controls open the same anchored menu, including extra actions
  let menuLabel = 'Choose agent';
  // name the place and mixed-action flyouts explicitly
  if (placeActions) menuLabel = 'More workspace actions';
  else if (entries.length > 0) menuLabel = 'More ways to open';
  // place rows choose agents without exposing toolbar management
  const menu = <LaunchMenu verb={verb} label={label} resolution={resolution} onLaunch={launch} entries={menuEntries} launchDisabled={launchDisabled} showAgentSettings={showAgentSettings} accounts={accounts} accountsView={accountsView} onAccountsViewChange={setAccountsView} />;
  const flyout = open && createPortal(<div ref={flyoutRef} style={style} className="more-menu flyout-menu launch-menu" role="menu" aria-label={menuLabel} onKeyDown={event => { /* close the chooser on escape */ if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); } }}>{menu}</div>, document.body);
  // the empty card keeps a direct action; place rows explicitly retain their chooser
  if (placeActions && entries.length === 0 && !alwaysShowMenu) return primaryButton ?? <button type="button" className={primaryClass} aria-label={`Launch ${label}`} disabled={disabled || launchDisabled || pending || (resolution !== undefined && resolution.kind === undefined)} onClick={() => launch(resolution?.kind === undefined ? undefined : { kind: resolution.kind, sandboxed: defaultSandboxed(adapters?.[resolution.kind]) })}>{pending ? <span className="spinner" /> : null}{verb}</button>;
  // launcher rows keep their split action even on a phone; the full-size Launch uses one chooser
  if (phone && !compact && primary === undefined) {
    // retain update feedback when the minimized panel replaces the phone chooser
    if (minimized !== undefined) return <span className={`launch-split launch-menu-only${quiet ? ' quiet' : ''}${updatesAvailable ? ' updates-available' : ''}${updateInProgress ? ' updates-in-progress' : ''}`}>
      <button type="button" className="queue launch-menu-trigger" aria-label={updatesAvailable ? `Show agent — ${updateLabel}` : 'Show agent'} aria-description={minimizedTitle} title={minimizedTitle} onClick={minimized.onShow}>
        {resolution?.kind === undefined ? <span className="launch-kind-mark" aria-hidden="true">+</span> : <KindMark kind={resolution.kind} />}
        <span className="launch-menu-trigger-label">Show agent</span>{minimizedBadge}
      </button>
      {updateInProgress && <span className="update-progress-ring" aria-hidden="true" />}
      {updatesAvailable && <span className="launch-update-dot" aria-hidden="true" />}
    </span>;
    return <>
      <span className={`launch-split launch-menu-only${quiet ? ' quiet' : ''}${updatesAvailable ? ' updates-available' : ''}${updateInProgress ? ' updates-in-progress' : ''}`} ref={anchorRef}>
        <button type="button" className="queue launch-menu-trigger" aria-label={updatesAvailable ? `${verb} agent — ${updateLabel}` : `${verb} agent`} aria-haspopup="menu" data-context-flyout aria-expanded={open} disabled={disabled || pending} title={disabled ? disabledReason : undefined} onClick={() => { /* toggle the same menu on phone */ if (open) closeMenu(); else setOpen(true); }}>
          {pending ? <span className="spinner" /> : resolution?.kind === undefined ? <span className="launch-kind-mark" aria-hidden="true">+</span> : <KindMark kind={resolution.kind} />}
          <span className="launch-menu-trigger-label">{verb} agent</span><span className="flyout-caret" aria-hidden="true" />
        </button>
        {updateInProgress && <span className="update-progress-ring" aria-hidden="true" />}
        {updatesAvailable && <span className="launch-update-dot" aria-hidden="true" />}
      </span>
      {flyout}
    </>;
  }
  // no resolution from the server: a plain, chevron-less launch of the default kind (or the
  // replacement primary), rendered exactly like the pre-split-button launch control
  if (resolution === undefined && !alwaysShowMenu && !placeActions) return primaryButton ?? <button type="button" className={`${primaryClass}${quiet ? ' launch-quiet' : ''}`} disabled={disabled || launchDisabled || pending} onClick={() => launch()}>{pending ? <span className="spinner" /> : null}{actionCopy(verb, undefined)}</button>;
  const none = configuredKinds(adapters).length === 0;
  const resolvedKind = resolution?.kind;
  const sandboxed = defaultSandboxed(resolvedKind === undefined ? undefined : adapters?.[resolvedKind]);
  const hint = primary === undefined && resolution !== undefined && !placeActions ? launchHint(adapters, resolution) : undefined;
  // let the icon identify compact agents without widening the new-task column
  let visibleAction = actionCopy(verb, resolvedKind);
  // use a short verb for place and compact launch controls
  if (placeActions || ((compact || quiet) && resolvedKind !== undefined)) visibleAction = verb;
  const primaryTitle = (disabled ? disabledReason : undefined) ?? hint ?? (placeActions || resolvedKind === undefined ? undefined : `${agentKindLabel[resolvedKind]} — ${originCopy(resolution?.origin)}${sandboxed ? ' — sandboxed' : ''}`);
  return <>
    {!compact && hint !== undefined && <small className="launch-hint">{hint}</small>}
    <span className={`launch-split${compact ? ' compact' : ''}${quiet ? ' quiet' : ''}${updatesAvailable ? ' updates-available' : ''}${updateInProgress ? ' updates-in-progress' : ''}`} role="group" data-context-dropdown aria-label={`${verb} agent`} ref={anchorRef}>
      {primaryButton ?? (minimized !== undefined ? <button type="button" className={`${primaryClass} launch-primary`} aria-description={minimizedTitle} title={minimizedTitle} onClick={() => { closeMenu(); minimized.onShow(); }}>
        {resolvedKind !== undefined && <KindMark kind={resolvedKind} />}<span className="launch-primary-label">Show agent</span>{minimizedBadge}
      </button> : <button type="button" className={`${primaryClass} launch-primary`} aria-label={placeActions ? `${verb} ${label}` : actionCopy(verb, resolvedKind)} disabled={(resolution !== undefined && resolvedKind === undefined) || disabled || launchDisabled || pending} title={primaryTitle} onClick={() => launch(resolvedKind === undefined ? undefined : { kind: resolvedKind, sandboxed })}>
        {/* identify resolved launches without adding management details */}{pending ? <span className="spinner" /> : resolvedKind !== undefined && <KindMark kind={resolvedKind} />}<span className="launch-primary-label">{visibleAction}</span>{!placeActions && sandboxed && <LockIcon />}
      </button>)}
      <button type="button" className={`launch-chevron${compact ? ' compact' : ''}`} aria-label={updatesAvailable ? `${menuLabel} — ${updateLabel}` : menuLabel} aria-haspopup="menu" data-context-flyout aria-expanded={open} disabled={(none && entries.length === 0) || disabled || pending} onClick={() => { /* toggle the split flyout */ if (open) closeMenu(); else setOpen(true); }}><ChevronIcon /></button>
      {updateInProgress && <span className="update-progress-ring" aria-hidden="true" />}
      {updatesAvailable && <span className="launch-update-dot" aria-hidden="true" />}
    </span>
    {flyout}
  </>;
}

// the kind glyph and optional sandbox lock before an agent tab's label
export function LaunchTabBadge({ kind, sandboxed }: { kind: AgentKind; sandboxed?: boolean }) {
  return <span className={`launch-tab-badge launch-kind-${kind}`} aria-hidden="true" title={`${agentKindLabel[kind]}${sandboxed ? ' · sandboxed' : ''}`}><KindMark kind={kind} />{sandboxed === true && <LockIcon />}</span>;
}
