import { Skeleton } from './skeleton.js';
import { createPortal } from 'react-dom';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useViewportFlyout } from './viewport-flyout.js';
import { usePhoneLayout } from './panel-header.js';
import { FlyoutBackdrop } from './flyout-portal.js';
import { SettingsSelect } from './settings/select.js';
import type { EffortSelection, LaunchCatalogModel, LaunchKindManifest, LaunchOptionsResponse, LaunchSelectionTarget, ManualLaunchChoice, ModelSelection, NativeLaunchSecurity } from '../../server/src/launch/options-types.js';

// The closed registry of agent kinds, in resolution/priority order (duplicated from the
// server's `agentKinds` by design). A configured kind (one with a program) is launchable;
// recognition of a kind needs no configuration.
export type AgentKind = 'codex' | 'omx' | 'claude' | 'pi' | 'opencode';
export const agentKinds: readonly AgentKind[] = ['codex', 'omx', 'claude', 'pi', 'opencode'];
// per-kind badge glyph and display label, shared by the split button, tab badge and AGENTS card
export const agentKindGlyph: Record<AgentKind, string> = { codex: '◆', omx: '◈', claude: '✳', pi: 'π', opencode: '◇' };
export const agentKindLabel: Record<AgentKind, string> = { codex: 'Codex', omx: 'OMX', claude: 'Claude', pi: 'Pi', opencode: 'OpenCode' };
// keep version and update actions in the toolbar chooser
// a `pinned` Pi version reviews the console release instead of running its own installer
export type AgentUpdateStatus = { kind: AgentKind; currentVersion?: string; latestVersion?: string; updateAvailable: boolean; error?: string; pinned?: true };
type AgentLaunchSettings = { statuses: AgentUpdateStatus[]; loading: boolean; updating?: AgentKind; errors: string[]; retryVersions?: () => void; updateAgent: (kind: AgentKind) => void };
export const AgentLaunchSettingsContext = createContext<AgentLaunchSettings | undefined>(undefined);
// keep per-agent account controls in the launcher without coupling this module to settings
export type AgentAccountsMenu = { menus: Partial<Record<AgentKind, { content: ReactNode; activeName?: string }>>; onOpen: () => void; onClose: () => void };
export const AgentAccountsMenuContext = createContext<AgentAccountsMenu | undefined>(undefined);
// share authenticated launch-option reads without coupling cards to the dashboard
export const LaunchOptionsContext = createContext<((url: string, init?: RequestInit) => Promise<Response>) | undefined>(undefined);

// The capability record the Dashboard publishes per kind and Transport (ADR 0002, ADR 0015). The
// web reads presence and reasons; it never re-derives capabilities. `sandbox*` stay undefined
// until chunk 4 arms the sandbox, so every launch is unsandboxed here.
export type TransportCapability = { launchable: boolean; unavailableReason?: string; program?: string; stateSource: 'reported' | 'title' | 'both'; turnCapture: boolean; inlineQuestions: boolean; steer?: boolean; commands: boolean; sandbox: boolean; sandboxUnavailableReason?: string; /** absent uses the native default; empty denies launches */ allowedModels?: AllowedModel[]; efforts?: string[] };
// one of a kind's Allowed models: an exact `provider/id`, with the Effort it defaults to
export type AllowedModel = { model: string; effort?: string };
export type Transport = 'tmux' | 'structured';
// per kind: its capability over each Transport it can launch on, and flat, over the one its
// launches use by default; Launch controls read the flat record
export type AdapterCapability = TransportCapability & { transport: Transport; transports: Partial<Record<Transport, TransportCapability>> };
export type AdapterCapabilities = Partial<Record<AgentKind, AdapterCapability>>;
// an Agent's capability is its kind's over the Transport the Agent is driven over
export const agentCapability = (adapters: AdapterCapabilities | undefined, agent: { kind?: AgentKind; panel: 'terminal' | 'transcript' }): TransportCapability | undefined =>
  agent.kind === undefined ? undefined : adapters?.[agent.kind]?.transports[agent.panel === 'transcript' ? 'structured' : 'tmux'];

export type LaunchScope = 'worktree' | 'project' | 'scratch';
export type LaunchOrigin = LaunchScope | 'default';
// The Launch profile resolution the server publishes so the web renders the menu without
// re-deriving it: which kind a one-click Launch uses, why, and any remembered kind skipped.
export type LaunchResolution = { kind?: AgentKind; origin?: LaunchOrigin; skipped?: { kind: AgentKind; origin: LaunchScope; reason: string } };
// what a launch/restart row sends to a launch-family route; sandboxed, model and Effort are never remembered
export type LaunchChoice = ManualLaunchChoice;

// the per-kind adapter capabilities from the active dashboard, for the Launch controls
export const AdaptersContext = createContext<AdapterCapabilities | undefined>(undefined);

// the configured kinds (those with a program), in registry order
export const configuredKinds = (adapters: AdapterCapabilities | undefined): AgentKind[] => agentKinds.filter(kind => adapters?.[kind]?.program !== undefined);
// a launch of this kind starts Sandboxed by default whenever the console can enforce it
export const defaultSandboxed = (capability: TransportCapability | undefined): boolean => capability?.sandbox === true && capability.sandboxUnavailableReason === undefined;

// what a one-click Launch sends: the resolved kind, Sandboxed when it can be; no choice lets the
// server pick when the dashboard resolved no kind
export const resolvedLaunchChoice = (adapters: AdapterCapabilities | undefined, resolution: LaunchResolution | undefined): LaunchChoice | undefined =>
  resolution?.kind === undefined ? undefined : { kind: resolution.kind, sandboxed: defaultSandboxed(adapters?.[resolution.kind]) };

// POST body for a launch-family route: the chosen kind and whether to confine it
export const launchRequestInit = (choice: LaunchChoice): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(choice) });

// sandbox line per kind and state — copy from the effort's Launch profile section
export const sandboxCopy = (kind: AgentKind, capability: TransportCapability | undefined, sandboxed: boolean): string => {
  if (capability === undefined) return '';
  // Codex (and OMX, which runs Codex) names its own sandbox; other kinds say nothing until chunk 4 arms `sandbox`
  if (!capability.sandbox) return kind === 'codex' || kind === 'omx' ? "Uses Codex's own sandbox" : '';
  if (capability.sandboxUnavailableReason !== undefined) return kind === 'claude' ? `Sandbox as configured in Claude — ${capability.sandboxUnavailableReason}` : `Sandbox unavailable — ${capability.sandboxUnavailableReason}`;
  if (sandboxed) return kind === 'claude' ? 'Sandbox enforced by console' : 'Tool commands sandboxed by console';
  return kind === 'claude' ? 'Sandbox disabled for this launch' : 'Tool commands unsandboxed for this launch';
};
// explain the resolved kind in primary-action hints and schedule pickers
export const originCopy = (origin: LaunchOrigin | undefined): string => origin === 'worktree' ? 'last used here' : origin === 'project' ? 'last used in this project' : origin === 'scratch' ? 'last used for scratch' : 'default agent';
const scopeCopy = (scope: LaunchScope): string => scope === 'worktree' ? 'here' : scope === 'project' ? 'this project' : 'scratch';

export type LaunchVerb = 'Launch' | 'Restart';
const actionCopy = (verb: LaunchVerb, kind: AgentKind | undefined): string => kind === undefined ? `${verb} agent` : verb === 'Launch' ? `Launch ${agentKindLabel[kind]}` : `Restart as ${agentKindLabel[kind]}`;

const KindMark = ({ kind }: { kind: AgentKind }) => <span className={`launch-kind-mark launch-kind-${kind}`} aria-hidden="true">{agentKindGlyph[kind]}</span>;
const LockIcon = () => <svg className="launch-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
const ChevronIcon = () => <svg className="launch-chevron-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
const ShieldIcon = ({ dangerous = false }: { dangerous?: boolean }) => <svg className="launch-security-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.7 2.8 8.2 7 10 4.2-1.8 7-5.3 7-10V6l-7-3Z" />{dangerous ? <path d="m9 9 6 6m0-6-6 6" /> : <path d="m9 12 2 2 4-5" />}</svg>;
// identify account actions without a competing text button
const AccountIcon = () => <svg className="launch-account-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg>;
// identify version installation without adding row text
const UpdateIcon = () => <svg className="launch-update-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" /></svg>;
const ModelIcon = () => <svg className="launch-model-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="7" r="3" /><circle cx="17" cy="7" r="3" /><circle cx="12" cy="17" r="3" /><path d="m9.5 8.5 1.6 5.5m3.4-5.5L12.9 14" /></svg>;

// identify each native security axis
function SecurityAxisIcon({
  icon,
}: {
  icon: "reset" | "file" | "shield" | "hand" | "warning";
}) {
  // render the matching outlined glyph
  if (icon === "file")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h8l4 4v14H6zM14 3v5h5" />
      </svg>
    );
  if (icon === "hand")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 12V7a1.5 1.5 0 0 1 3 0v4-6a1.5 1.5 0 0 1 3 0v6-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v5c0 4-2.5 7-7 7-3 0-5-1.5-7-4l-2-3a1.5 1.5 0 0 1 2.5-1.7L7 13" />
      </svg>
    );
  if (icon === "warning")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v.1" />
      </svg>
    );
  if (icon === "reset")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 10a8 8 0 1 1 2 7m-2 3v-6h6" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.7 2.8 8.2 7 10 4.2-1.8 7-5.3 7-10V6l-7-3Z" />
    </svg>
  );
}



// the disabled-primary hint, or undefined when a one-click launch is possible. A resolved
// kind (including the legacy config's Codex, which has no `program`) means launchable.
const launchHint = (adapters: AdapterCapabilities | undefined, resolution: LaunchResolution | undefined): string | undefined =>
  resolution?.kind !== undefined ? undefined
    : configuredKinds(adapters).length === 0 ? 'No agents configured — add an adapters entry to the console config.'
      : 'No configured agent is launchable right now';

// A non-launch action a menu lists after the kinds (the + rows' Terminal and Empty workspace).
export type LaunchMenuEntry = { key: string; label: string; detail: string; icon: ReactNode; onSelect: () => void };

// build a truthful compatibility manifest while the lazy endpoint is loading
function capabilityManifest(
  kind: AgentKind,
  capability: TransportCapability,
  verb: LaunchVerb,
): LaunchKindManifest {
  const allowed = capability.allowedModels ?? [];
  const explicitPolicy = capability.allowedModels !== undefined;
  const defaultSelection: ModelSelection =
    allowed[0] === undefined
      ? { mode: "native-default" }
      : { mode: "model", id: allowed[0].model };
  const sandboxed = defaultSandboxed(capability);
  return {
    kind,
    optionsRevision: "dashboard",
    modelPolicy: {
      state: explicitPolicy ? (allowed.length === 0 ? "empty" : "explicit") : "native-default",
      allowed,
      defaultSelection,
      catalog: allowed.map((entry) => ({
        id: entry.model,
        name: entry.model,
        efforts: [...(capability.efforts ?? [])],
        ...(entry.effort === undefined ? {} : { defaultEffort: entry.effort }),
      })),
      catalogStatus: explicitPolicy ? "ready" : "unavailable",
      ...(explicitPolicy
        ? allowed.length === 0 ? { message: "No models are allowed for this Agent." } : {}
        : {
            message: `${agentKindLabel[kind]} uses its configured native ${verb === "Restart" ? "conversation" : "model"} default.`,
          }),
    },
    security: {
      controls: [],
      defaults: {},
      constraints: [],
      status: "unsupported",
      message: sandboxCopy(kind, capability, sandboxed) || "Native security options are unavailable."
    },
  };
}

// load target-specific choices without making the browser an authority
function useLaunchOptions(
  target: LaunchSelectionTarget | undefined,
  kinds: AgentKind[],
  adapters: AdapterCapabilities | undefined,
  verb: LaunchVerb,
) {
  const request = useContext(LaunchOptionsContext);
  const [remote, setRemote] = useState<LaunchKindManifest[]>();
  const [error, setError] = useState<string>();
  const key = target === undefined ? "" : JSON.stringify(target);
  useEffect(() => {
    let live = true;
    // retain dashboard capabilities where no exact target exists
    if (request === undefined || target === undefined) {
      setRemote(undefined);
      setError(undefined);
      return () => {
        live = false;
      };
    }
    setRemote(undefined);
    setError(undefined);
    void (async () => {
      try {
        const response = await request("/api/launch/options", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(target),
        });
        const payload = (await response.json().catch(() => undefined)) as
          (Partial<LaunchOptionsResponse> & { error?: unknown }) | undefined;
        // keep the last-resort capability view visible on failure
        if (!live) return;
        if (!response.ok || !Array.isArray(payload?.kinds))
          return setError(
            typeof payload?.error === "string"
              ? payload.error
              : "Launch options are unavailable.",
          );
        setRemote(payload.kinds);
      } catch {
        // report transport loss without hiding cards
        if (live) setError("Launch options are unavailable.");
      }
    })();
    return () => {
      live = false;
    };
  }, [request, key]);
  const manifests = new Map<AgentKind, LaunchKindManifest>();
  // publish one manifest for every configured row
  for (const kind of kinds) {
    const capability = adapters?.[kind];
    if (capability !== undefined)
      manifests.set(
        kind,
        remote?.find((entry) => entry.kind === kind) ??
          capabilityManifest(kind, capability, verb),
      );
  }
  return {
    manifests,
    loading:
      request !== undefined &&
      target !== undefined &&
      remote === undefined &&
      error === undefined,
    error,
  };
}

// the entries after the kinds, divided from them
function LaunchMenuEntries({ entries, divider = true }: { entries: readonly LaunchMenuEntry[]; divider?: boolean }) {
  if (entries.length === 0) return null;
  return <>{divider && <hr className="more-menu-divider" />}{entries.map(entry => <button key={entry.key} type="button" role="menuitem" className="launch-row launch-row-entry" onClick={entry.onSelect}><span className="launch-kind-mark launch-entry-icon" aria-hidden="true">{entry.icon}</span><span className="launch-row-copy"><strong>{entry.label}</strong><small>{entry.detail}</small></span></button>)}</>;
}

// label the current transient model choice
function modelSelectionLabel(
  manifest: LaunchKindManifest,
  selection: ModelSelection,
): string {
  // keep native defaults explicit
  if (selection.mode === "native-default") return "Native default";
  // use the server's truthful current-model label when supplied
  if (selection.mode === "keep-current")
    return manifest.modelPolicy.message?.toLowerCase().includes("keep current")
      ? manifest.modelPolicy.message
      : "Keep current";
  const catalog = manifest.modelPolicy.catalog.find(
    (entry) => entry.id === selection.id,
  );
  return catalog?.name ?? selection.id;
}

// resolve the model owning the current effort controls
function effortModel(
  manifest: LaunchKindManifest,
  selection: ModelSelection,
): LaunchCatalogModel | undefined {
  // explicit selections map directly to a catalog entry
  if (selection.mode === "model")
    return manifest.modelPolicy.catalog.find((entry) => entry.id === selection.id);
  // infer only a server-labelled current model
  if (selection.mode === "keep-current") {
    // use the server-proven identity before compatibility labels from older manifests
    if (manifest.modelPolicy.currentModel !== undefined) return manifest.modelPolicy.catalog.find(entry => entry.id === manifest.modelPolicy.currentModel);
    const message = manifest.modelPolicy.message ?? "";
    // older manifests label the exact model token before any catalog-status sentence
    const currentId = /^Keep current(?: —)? (\S+)/u.exec(message)?.[1];
    return manifest.modelPolicy.catalog.find(entry => entry.id === currentId)
      ?? manifest.modelPolicy.catalog.find(entry => `${entry.id}.` === currentId);
  }
  return undefined;
}

// create the semantic launch request from one card draft
function launchCardChoice(
  kind: AgentKind,
  manifest: LaunchKindManifest,
  model: ModelSelection,
  effort: EffortSelection,
  effortDirty: boolean,
  security: NativeLaunchSecurity,
  securityDirty: boolean,
  capability: TransportCapability,
): LaunchChoice {
  const sandbox = security.sandbox;
  const sandboxed = sandbox === undefined ? defaultSandboxed(capability) : sandbox === "on";
  // preserve kind-only compatibility when the target manifest is unavailable
  if (manifest.optionsRevision === "dashboard" && manifest.modelPolicy.state === "native-default" && !securityDirty) return { kind, sandboxed };
  return {
    kind,
    model,
    ...(effortDirty ? { effort } : {}),
    ...(manifest.optionsRevision === "dashboard" ? {} : { optionsRevision: manifest.optionsRevision }),
    ...(securityDirty ? { security } : {}),
  };
}

type AgentLaunchCardProps = {
  verb: LaunchVerb;
  kind: AgentKind;
  capability: TransportCapability;
  manifest: LaunchKindManifest;
  disabled: boolean;
  loading: boolean;
  versionContent?: ReactNode;
  accountName?: string;
  updateControl?: ReactNode;
  accountControl?: ReactNode;
  onLaunch: (choice: LaunchChoice) => void;
};

// render one isolated Agent launch draft
function AgentLaunchCard({
  verb,
  kind,
  capability,
  manifest,
  disabled,
  loading,
  versionContent,
  accountName,
  updateControl,
  accountControl,
  onLaunch,
}: AgentLaunchCardProps) {
  const [model, setModel] = useState<ModelSelection>(
    manifest.modelPolicy.defaultSelection,
  );
  const [effort, setEffort] = useState<EffortSelection>({
    mode: "model-default",
  });
  const [effortDirty, setEffortDirty] = useState(false);
  const [security, setSecurity] = useState<NativeLaunchSecurity>({
    ...manifest.security.defaults,
  });
  const [securityDirty, setSecurityDirty] = useState(false);
  const [panel, setPanel] = useState<"model" | "security">();
  const [search, setSearch] = useState("");
  const securityTrigger = useRef<HTMLButtonElement>(null);
  // align the model picker with its actual trigger while preserving security placement
  const modelPopover = useViewportFlyout<HTMLButtonElement>(panel === "model", { contentSized: true, align: 'start' });
  const securityPopover = useViewportFlyout<HTMLDivElement>(panel === "security", { contentSized: true });
  const modelTrigger = modelPopover.anchorRef;
  const controlsRef = securityPopover.anchorRef;
  const { flyoutRef: popoverRef, style: popoverStyle } = panel === "model" ? modelPopover : securityPopover;
  // reset transient defaults when the target manifest changes
  useEffect(() => {
    setModel(manifest.modelPolicy.defaultSelection);
    setEffort({ mode: "model-default" });
    setEffortDirty(false);
    setSecurity({ ...manifest.security.defaults });
    setSecurityDirty(false);
    setPanel(undefined);
    setSearch("");
  }, [manifest.optionsRevision]);
  // move keyboard entry into the active dialog after viewport positioning
  useLayoutEffect(() => {
    // hidden viewport measurements must finish before keyboard entry
    if (panel === undefined || popoverStyle.visibility !== 'visible') return;
    const popover = popoverRef.current;
    // prefer search when available and otherwise enter through the back link
    (popover?.querySelector<HTMLElement>('input:not(:disabled)') ?? popover?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
  }, [panel, popoverStyle.visibility]);
  const selectedModel = effortModel(manifest, model);
  const levels = selectedModel?.efforts ?? [];
  // show the effective configured default without turning an untouched launch into an override
  const defaultEffort = [
    model.mode === "keep-current" ? manifest.modelPolicy.currentEffort : undefined,
    selectedModel === undefined ? undefined : manifest.modelPolicy.effortDefaults?.[selectedModel.id],
    manifest.modelPolicy.allowed.find(entry => entry.model === selectedModel?.id)?.effort,
    selectedModel?.defaultEffort
  ].find((level): level is string => typeof level === 'string' && levels.includes(level));
  // retain saved entries when live discovery omits them
  const modelOptions = manifest.modelPolicy.allowed.map(entry => manifest.modelPolicy.catalog.find(candidate => candidate.id === entry.model) ?? { id: entry.model, name: entry.model, efforts: [] });
  // keep small model lists direct without hiding search while a larger list is filtered
  const showModelSearch = modelOptions.length > 5;
  // expose native default only when the native choice is truly opaque
  const showNativeDefault =
    manifest.modelPolicy.state === "native-default" &&
    manifest.modelPolicy.allowed.length === 0 &&
    manifest.modelPolicy.defaultSelection.mode === "native-default";
  const normalizedSearch = search.trim().toLowerCase();
  const visibleModels = modelOptions.filter(
    (entry) =>
      normalizedSearch === "" ||
      `${entry.name} ${entry.id} ${entry.provider ?? ""}`
        .toLowerCase()
        .includes(normalizedSearch),
  );
  const modelDisabled =
    disabled ||
    loading ||
    manifest.modelPolicy.state === "empty" ||
    (manifest.modelPolicy.catalogStatus !== "ready" &&
      modelOptions.length === 0 &&
      model.mode !== "keep-current");
  const securityDisabled =
    disabled ||
    loading ||
    manifest.security.status === "unsupported" ||
    manifest.security.controls.length === 0;
  const dangerous = manifest.security.controls.some(
    (control) =>
      control.options.find((option) => option.id === security[control.id])
        ?.risk === "danger",
  );
  // enforce currently active manifest constraints in the draft
  const activeConstraints = manifest.security.constraints.filter(constraint => Object.entries(constraint.when).every(([axis, value]) => security[axis] === value));
  const disabledSecurityAxes = activeConstraints.flatMap(constraint => constraint.disables);
  const unavailableReason = capability.launchable ? undefined : capability.unavailableReason ?? "Unavailable";
  const policyUnavailableReason = manifest.modelPolicy.state === "empty" ? manifest.modelPolicy.message ?? "No models are allowed for this Agent." : undefined;
  const launchUnavailableReason = unavailableReason ?? policyUnavailableReason;
  // keep inner flyouts ahead of the enclosing chooser's escape handler
  const closePanel = () => {
    const trigger = panel === "model" ? modelTrigger.current : securityTrigger.current;
    setPanel(undefined);
    setSearch("");
    // return keyboard focus to its trigger
    window.setTimeout(() => trigger?.focus(), 0);
  };
  // keep keyboard focus inside either launch subpanel
  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // close only the inner panel
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
      return;
    }
    // contain tab navigation within the inner dialog
    if (event.key === "Tab") {
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'));
      const first = focusable[0];
      const last = focusable.at(-1);
      // wrap from either edge
      if (first !== undefined && last !== undefined && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  };
  // keep the picker open after a model change so effort can be adjusted next
  const chooseModel = (selection: ModelSelection) => {
    setModel(selection);
    setEffort({ mode: "model-default" });
    setEffortDirty(false);
  };
  // update one native security axis
  const chooseSecurity = (control: string, value: string) => {
    setSecurity((current) => {
      const next = { ...current, [control]: value };
      const constraints = manifest.security.constraints.filter((constraint) =>
        Object.entries(constraint.when).every(
          ([axis, expected]) => next[axis] === expected,
        ),
      );
      // reset every axis owned by an activated constraint
      for (const constraint of constraints) {
        // restore each disabled axis to its manifest default
        for (const axis of constraint.disables) {
          const fallback = manifest.security.defaults[axis];
          // omit axes without a declared default
          if (fallback === undefined) delete next[axis];
          else next[axis] = fallback;
        }
      }
      return next;
    });
    setSecurityDirty(true);
  };
  return (
    <div className="launch-card-main">
      <div
        className="launch-row launch-card-summary"
        title={capability.unavailableReason}
      >
        <KindMark kind={kind} />
        <span className="launch-row-copy">
          <strong>{agentKindLabel[kind]}</strong>
          {(versionContent !== undefined || accountName !== undefined) && (
            <span className="launch-agent-details">
              {versionContent}
              {accountName !== undefined && (
                <span className="launch-agent-account" title={accountName}>
                  {accountName}
                </span>
              )}
            </span>
          )}
          {launchUnavailableReason !== undefined && <small>{launchUnavailableReason}</small>}
        </span>
      </div>
      <div
        ref={controlsRef}
        className="launch-card-controls"
        aria-label={`${agentKindLabel[kind]} launch options`}
      >
        <button
          ref={modelTrigger}
          type="button"
          className="launch-card-trigger launch-model-trigger"
          aria-label={`${agentKindLabel[kind]} model and Effort: ${modelSelectionLabel(manifest, model)}`}
          aria-haspopup="dialog"
          aria-expanded={panel === "model"}
          disabled={modelDisabled}
          title={manifest.modelPolicy.message}
          onClick={(event) => {
            event.stopPropagation();
            setPanel((current) => (current === "model" ? undefined : "model"));
            setSearch("");
          }}
        >
          <ModelIcon />
          <span>{modelSelectionLabel(manifest, model)}</span>
          <ChevronIcon />
        </button>
        {updateControl}
        {accountControl}
        <button
          ref={securityTrigger}
          type="button"
          className={`launch-card-trigger launch-security-trigger${dangerous ? " dangerous" : ""}`}
          data-context-flyout
          aria-label={`${agentKindLabel[kind]} security${dangerous ? ": dangerous override" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={panel === "security"}
          disabled={securityDisabled}
          title={
            manifest.security.message ??
            (securityDisabled
              ? "No native security overrides available."
              : "Security for this launch")
          }
          onClick={(event) => {
            event.stopPropagation();
            setPanel((current) =>
              current === "security" ? undefined : "security",
            );
          }}
        >
          <span className="flyout-caret" aria-hidden="true" />
          <ShieldIcon dangerous={dangerous} />
        </button>
        <button
          type="button"
          role="menuitem"
          className="launch-card-trigger launch-card-launch launch-card-action"
          aria-label={`${verb} ${agentKindLabel[kind]}`}
          title={launchUnavailableReason ?? `${verb} ${agentKindLabel[kind]}`}
          disabled={!capability.launchable || manifest.modelPolicy.state === "empty" || disabled || loading}
          onClick={() => {
            // launch only through the explicit action using this card's transient choices
            onLaunch(launchCardChoice(kind, manifest, model, effort, effortDirty, security, securityDirty, capability));
          }}
        >
          {verb}
        </button>
      </div>
      {panel !== undefined && <div className="launch-card-backdrop" aria-hidden="true" onPointerDown={event => { /* contain outside presses within the chooser */ event.stopPropagation(); }} onMouseDown={event => { /* block document mouse dismissal */ event.stopPropagation(); }} onClick={closePanel} />}
      {panel === "model" && (
        <div
          ref={popoverRef}
          style={popoverStyle}
          className="launch-card-popover launch-model-popover"
          role="dialog"
          aria-label={`${agentKindLabel[kind]} model and Effort`}
          onMouseDown={(event) => { /* keep portaled effort choices inside this picker */ event.stopPropagation(); }}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handlePanelKeyDown}
        >
          <button className="launch-submenu-back" type="button" onClick={closePanel}>
            ‹ Back to agents
          </button>
          {showModelSearch && <label className="launch-card-search">
            <span>Search models</span>
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search models"
            />
          </label>}
          <div
            className="launch-card-options"
            role="radiogroup"
            aria-label="Model"
          >
            {manifest.modelPolicy.defaultSelection.mode === "keep-current" && (
              <button
                type="button"
                role="radio"
                aria-checked={model.mode === "keep-current"}
                className="launch-card-option"
                onClick={() => chooseModel({ mode: "keep-current" })}
              >
                <strong>
                  {modelSelectionLabel(
                    manifest,
                    manifest.modelPolicy.defaultSelection,
                  )}
                </strong>
                <small>Current conversation</small>
              </button>
            )}
            {showNativeDefault && (
              <button
                type="button"
                role="radio"
                aria-checked={model.mode === "native-default"}
                className="launch-card-option"
                onClick={() => chooseModel({ mode: "native-default" })}
              >
                <strong>Native default</strong>
                <small>
                  {manifest.modelPolicy.message ??
                    `${agentKindLabel[kind]} chooses the model`}
                </small>
              </button>
            )}
            {visibleModels.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={model.mode === "model" && model.id === entry.id}
                className="launch-card-option"
                onClick={() => chooseModel({ mode: "model", id: entry.id })}
              >
                <strong>{entry.name}</strong>
                <small>
                  {entry.provider === undefined
                    ? entry.id
                    : `${entry.provider} · ${entry.id}`}
                </small>
              </button>
            ))}
            {visibleModels.length === 0 &&
              manifest.modelPolicy.state === "explicit" && (
                <p className="launch-card-empty">
                  {normalizedSearch === ""
                    ? (manifest.modelPolicy.message ??
                      "No selectable models are available.")
                    : "No models match your search."}
                </p>
              )}
            {manifest.modelPolicy.state === "empty" && (
              <p className="launch-card-empty">
                {manifest.modelPolicy.message ??
                  "No models are allowed for this Agent."}
              </p>
            )}
          </div>
          <div className="launch-effort">
            <span>Effort</span>
            <SettingsSelect
              label="Effort"
              value={effort.mode === "effort" ? effort.id : defaultEffort ?? ""}
              placeholder={levels.length === 0 ? "Unavailable" : "Select effort"}
              disabled={levels.length === 0}
              menuOnly
              menuClassName="launch-effort-menu"
              matchAnchorWidth={false}
              options={levels.map(level => ({ value: level, label: level }))}
              onChange={(value) => {
                // send a real supported level only after an explicit selection
                setEffort({ mode: "effort", id: value });
                setEffortDirty(true);
              }}
            />
          </div>
          {manifest.modelPolicy.catalogStatus !== "ready" &&
            manifest.modelPolicy.message !== undefined && (
              <p className="launch-card-status">
                {manifest.modelPolicy.message}
              </p>
            )}
        </div>
      )}
      {panel === "security" && (
        <div
          ref={popoverRef}
          style={popoverStyle}
          className="launch-card-popover launch-security-popover"
          role="dialog"
          aria-label={`${agentKindLabel[kind]} security`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handlePanelKeyDown}
        >
          <p className="launch-card-popover-title">
            Security · this launch only
          </p>
          {manifest.security.controls.map((control) => (
            <fieldset key={control.id} className="launch-security-control" disabled={disabledSecurityAxes.includes(control.id)}>
              <legend>
                <span className="launch-security-axis">
                  <SecurityAxisIcon icon={control.icon} />
                </span>
                {control.label}
              </legend>
              {control.options.map((option) => (
                <label
                  key={option.id}
                  className={`launch-security-option risk-${option.risk}`}
                >
                  <input
                    type="radio"
                    name={`${kind}-${control.id}`}
                    checked={security[control.id] === option.id}
                    onChange={() => chooseSecurity(control.id, option.id)}
                  />
                  <span>
                    <strong>
                      {option.label}
                      {option.risk === "danger"
                        ? " · Dangerous"
                        : option.risk === "warning"
                          ? " · Warning"
                          : ""}
                    </strong>
                    <small>{option.detail}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
          {activeConstraints.map((constraint) => (
              <p
                key={constraint.message}
                className="launch-card-status warning"
              >
                {constraint.message}
              </p>
            ))}
          {manifest.security.message !== undefined && (
            <p className="launch-card-status">{manifest.security.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

// list configured Agent cards and their transient controls
export function LaunchMenu({
  verb,
  label,
  resolution,
  target,
  onLaunch,
  onDismiss,
  entries = [],
  launchDisabled = false,
  showAgentSettings = false,
  accounts: providedAccounts,
  accountsView: controlledAccountsView,
  onAccountsViewChange,
}: {
  verb: LaunchVerb;
  label: string;
  resolution: LaunchResolution | undefined;
  target?: LaunchSelectionTarget;
  onLaunch: (choice: LaunchChoice) => void;
  onDismiss?: () => void;
  entries?: readonly LaunchMenuEntry[];
  launchDisabled?: boolean;
  showAgentSettings?: boolean;
  accounts?: AgentAccountsMenu;
  accountsView?: AgentKind;
  onAccountsViewChange?: (kind: AgentKind | undefined) => void;
}) {
  const adapters = useContext(AdaptersContext);
  const sharedSettings = useContext(AgentLaunchSettingsContext);
  const settings = showAgentSettings ? sharedSettings : undefined;
  const accounts = showAgentSettings ? providedAccounts : undefined;
  const [localAccountsView, setLocalAccountsView] = useState<AgentKind>();
  const accountsView = controlledAccountsView ?? localAccountsView;
  const setAccountsView = onAccountsViewChange ?? setLocalAccountsView;
  // load selected account names for toolbar rows
  useEffect(() => {
    // skip consoles without account controls
    if (accounts === undefined) return;
    accounts.onOpen();
    return accounts.onClose;
  }, [accounts?.onOpen, accounts?.onClose]);
  const openAccounts =
    accountsView === undefined ? undefined : accounts?.menus[accountsView];
  // keep catalog hooks mounted while visiting account submenus
  const kinds = configuredKinds(adapters);
  const options = useLaunchOptions(target, kinds, adapters, verb);
  // put the remembered launch kind first without changing the other adapters' registry order
  const orderedKinds = [...kinds].sort((left, right) => Number(right === resolution?.kind) - Number(left === resolution?.kind));
  // retain the existing account submenu
  if (accountsView !== undefined && openAccounts !== undefined)
    return (
      <div
        className="launch-accounts-submenu"
        role="group"
        aria-label={`${agentKindLabel[accountsView]} accounts`}
      >
        <button
          className="launch-submenu-back"
          type="button"
          onClick={() => setAccountsView(undefined)}
        >
          ‹ Back to agents
        </button>
        {openAccounts.content}
      </div>
    );
  // show configuration guidance when there are no cards
  if (kinds.length === 0)
    return (
      <>
        <p className="launch-menu-empty">
          No agents configured. Add an <code>adapters</code> entry to the
          console config to launch agents.
        </p>
        <LaunchMenuEntries entries={entries} />
      </>
    );
  const skipped = resolution?.skipped;
  return (
    <>
      <p className="launch-menu-heading">
        {verb} · {label}
      </p>
      {options.loading && (
        <p className="launch-menu-note" role="status">
          Loading target-specific launch options…
        </p>
      )}
      {options.error !== undefined && (
        <p className="launch-menu-note" role="status">
          {options.error} Showing configured fallback options.
        </p>
      )}
      {orderedKinds.map((kind) => {
        const capability = adapters![kind]!;
        const manifest =
          options.manifests.get(kind) ??
          capabilityManifest(kind, capability, verb);
        const status = settings?.statuses.find(
          (candidate) => candidate.kind === kind,
        );
        const version =
          status?.currentVersion === undefined
            ? undefined
            : status.currentVersion.startsWith("v")
              ? status.currentVersion
              : `v${status.currentVersion}`;
        const latest =
          status?.latestVersion === undefined
            ? undefined
            : status.latestVersion.startsWith("v")
              ? status.latestVersion
              : `v${status.latestVersion}`;
        const versionLabel =
          status?.updateAvailable &&
          version !== undefined &&
          latest !== undefined
            ? `${version} → ${latest}`
            : version;
        const kindAccounts = accounts?.menus[kind];
        const accountName = kindAccounts?.activeName;
        const versionContent =
          settings?.loading || versionLabel !== undefined ? (
            <span
              className="launch-agent-version-slot"
              role={settings?.loading ? "status" : undefined}
              aria-label={
                settings?.loading
                  ? `Loading ${agentKindLabel[kind]} version`
                  : undefined
              }
              aria-busy={settings?.loading || undefined}
            >
              {settings?.loading ? (
                <Skeleton className="launch-agent-version-skeleton" />
              ) : (
                <span className="launch-agent-version">{versionLabel}</span>
              )}
            </span>
          ) : undefined;
        const updateActionLabel = `Update ${agentKindLabel[kind]} to ${status?.latestVersion ?? "latest"}`;
        const updateActionTitle = kind === "pi" ? "Pi is bundled in RAC. Create a local pin-update prompt." : updateActionLabel;
        // bundled Pi offers a local change while other agents use their configured installer
        const updateControl = status?.updateAvailable && (status.pinned !== true || kind === "pi") ? (
          <button
            type="button"
            role="menuitem"
            className={`launch-card-trigger launch-agent-update${settings?.updating === kind ? " progress-border progress-mauve" : settings?.updating === undefined ? " update-attention" : ""}`}
            aria-busy={settings?.updating === kind || undefined}
            aria-label={updateActionLabel}
            title={updateActionTitle}
            disabled={settings?.updating !== undefined}
            onClick={() => {
              /* dismiss before update confirmation or install */ onDismiss?.();
              settings?.updateAgent(kind);
            }}
          >
            {settings?.updating === kind && (
              <span className="update-progress-ring" aria-hidden="true" />
            )}
            <UpdateIcon />
          </button>
        ) : undefined;
        return (
          <div
            key={kind}
            role="group"
            aria-label={`${agentKindLabel[kind]} agent`}
            className="launch-agent-line"
          >
            <AgentLaunchCard
              verb={verb}
              kind={kind}
              capability={capability}
              manifest={manifest}
              disabled={launchDisabled}
              loading={options.loading}
              versionContent={versionContent}
              accountName={accountName}
              updateControl={updateControl}
              accountControl={kindAccounts === undefined ? undefined : <button
                type="button"
                role="menuitem"
                className="launch-card-trigger launch-agent-accounts"
                data-context-flyout
                aria-label={`${agentKindLabel[kind]} accounts`}
                aria-haspopup="menu"
                title={`${agentKindLabel[kind]} accounts`}
                onClick={() => setAccountsView(kind)}
              >
                <span className="flyout-caret" aria-hidden="true" />
                <AccountIcon />
              </button>}
              onLaunch={onLaunch}
            />
          </div>
        );
      })}
      {settings?.errors.map((error) => (
        <p key={error} className="launch-menu-error" role="alert">
          {error}
        </p>
      ))}
      {settings?.retryVersions !== undefined && (
        <button
          type="button"
          role="menuitem"
          className="launch-row"
          disabled={settings.loading}
          aria-busy={settings.loading || undefined}
          onClick={settings.retryVersions}
        >
          <span className="launch-row-copy">
            <strong>Retry version check</strong>
          </span>
        </button>
      )}
      {skipped !== undefined && (
        <p className="launch-menu-note">
          Remembered {agentKindLabel[skipped.kind]} ({scopeCopy(skipped.origin)}
          ) skipped — {skipped.reason}
        </p>
      )}
      <LaunchMenuEntries entries={entries} />
    </>
  );
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
// `dialogLayer` raises only a picker intentionally opened from a modal.
// keep place actions compact and opt into toolbar management explicitly
export function LaunchSplitButton({ verb = 'Launch', label, resolution, target, onLaunch, disabled = false, disabledReason, pending = false, compact = false, quiet = false, primary, entries = [], launchDisabled = false, placeActions = false, alwaysShowMenu = false, showAgentSettings = false, dialogLayer = false, minimized }: { verb?: LaunchVerb; label: string; resolution: LaunchResolution | undefined; target?: LaunchSelectionTarget; onLaunch: (choice?: LaunchChoice) => void; disabled?: boolean; disabledReason?: string; pending?: boolean; compact?: boolean; quiet?: boolean; primary?: LaunchPrimary; entries?: readonly LaunchMenuEntry[]; launchDisabled?: boolean; placeActions?: boolean; alwaysShowMenu?: boolean; showAgentSettings?: boolean; dialogLayer?: boolean; minimized?: { count: number; onShow: () => void } }) {
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
  const openerRef = useRef<HTMLButtonElement>(null);
  // close both flyout pages for every dismissal path
  const closeMenu = useCallback(() => { setOpen(false); setAccountsView(undefined); }, []);
  // restore only keyboard dismissals to their exact opening control
  const closeMenuFromKeyboard = useCallback(() => {
    const opener = openerRef.current;
    closeMenu();
    window.setTimeout(() => {
      // avoid focusing a control removed with its containing view
      if (opener?.isConnected) opener.focus();
    }, 0);
  }, [closeMenu]);
  // remember the control that opened this menu instance
  const openMenu = (opener: HTMLButtonElement) => {
    openerRef.current = opener;
    setOpen(true);
  };
  // remeasure the recreated flyout when the phone control replaces the desktop split
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLSpanElement>(open, { align: phone ? 'center' : 'end', contentSized: true });
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
      if (event.defaultPrevented || event.key !== 'Escape' || document.querySelector('[data-launch-submenu-dialog]')) return;
      event.preventDefault();
      closeMenuFromKeyboard();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', closeOnEscape); };
  }, [open, closeMenu, closeMenuFromKeyboard]);
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
  // share dismissal across desktop and phone update actions
  const menu = <LaunchMenu verb={verb} label={label} resolution={resolution} target={target} onLaunch={launch} onDismiss={closeMenu} entries={menuEntries} launchDisabled={launchDisabled} showAgentSettings={showAgentSettings} accounts={accounts} accountsView={accountsView} onAccountsViewChange={setAccountsView} />;
  // consume outside clicks on every chooser page instead of activating background actions
  const flyout = open && createPortal(<><FlyoutBackdrop onDismiss={closeMenu} /><div ref={flyoutRef} style={style} className={`more-menu flyout-menu launch-menu${dialogLayer ? ' launch-menu-dialog-layer' : ''}`} role="menu" aria-label={menuLabel} onKeyDown={event => { /* close the chooser on escape */ if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenuFromKeyboard(); } }}>{menu}</div></>, document.body);
  const configured = configuredKinds(adapters);
  const resolvedKind = resolution?.kind;
  const resolvedPolicyEmpty = resolvedKind !== undefined && adapters?.[resolvedKind]?.allowedModels?.length === 0;
  const noConfiguredLaunchChoice = configured.length > 0 && configured.every(kind => adapters?.[kind]?.launchable !== true || adapters?.[kind]?.allowedModels?.length === 0);
  // the empty card keeps a direct action; place rows explicitly retain their chooser
  if (placeActions && entries.length === 0 && !alwaysShowMenu) return primaryButton ?? <button type="button" className={`${primaryClass}${pending ? ' progress-border progress-green' : ''}`} aria-busy={pending || undefined} aria-label={`Launch ${label}`} disabled={disabled || launchDisabled || pending || resolvedPolicyEmpty || (resolution !== undefined && resolution.kind === undefined)} onClick={() => launch(resolvedLaunchChoice(adapters, resolution))}>{pending && <span className="update-progress-ring" aria-hidden="true" />}{verb}</button>;
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
        <button type="button" className={`queue launch-menu-trigger${pending ? ' progress-border progress-green' : ''}`} aria-busy={pending || undefined} aria-label={updatesAvailable ? `${verb} agent — ${updateLabel}` : `${verb} agent`} aria-haspopup="menu" data-context-flyout aria-expanded={open} disabled={disabled || pending} title={disabled ? disabledReason : undefined} onClick={event => { /* toggle the same menu on phone */ if (open) closeMenu(); else openMenu(event.currentTarget); }}>
          {pending && <span className="update-progress-ring" aria-hidden="true" />}{resolution?.kind === undefined ? <span className="launch-kind-mark" aria-hidden="true">+</span> : <KindMark kind={resolution.kind} />}
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
  if (resolution === undefined && !alwaysShowMenu && !placeActions) return primaryButton ?? <button type="button" className={`${primaryClass}${quiet ? ' launch-quiet' : ''}${pending ? ' progress-border progress-green' : ''}`} aria-busy={pending || undefined} disabled={disabled || launchDisabled || pending || noConfiguredLaunchChoice} onClick={() => launch()}>{pending && <span className="update-progress-ring" aria-hidden="true" />}{actionCopy(verb, undefined)}</button>;
  const none = configured.length === 0;
  const sandboxed = defaultSandboxed(resolvedKind === undefined ? undefined : adapters?.[resolvedKind]);
  const hint = primary === undefined && resolution !== undefined && !placeActions ? launchHint(adapters, resolution) : undefined;
  // let the icon identify compact agents without widening the new-task column
  let visibleAction = actionCopy(verb, resolvedKind);
  // use a short verb for place and compact launch controls
  if (placeActions || ((compact || quiet) && resolvedKind !== undefined)) visibleAction = verb;
  const primaryTitle = (disabled ? disabledReason : undefined) ?? (resolvedPolicyEmpty ? 'No models are allowed for this Agent.' : undefined) ?? hint ?? (placeActions || resolvedKind === undefined ? undefined : `${agentKindLabel[resolvedKind]} — ${originCopy(resolution?.origin)}${sandboxed ? ' — sandboxed' : ''}`);
  return <>
    {!compact && hint !== undefined && <small className="launch-hint">{hint}</small>}
    <span className={`launch-split${compact ? ' compact' : ''}${quiet ? ' quiet' : ''}${updatesAvailable ? ' updates-available' : ''}${updateInProgress ? ' updates-in-progress' : ''}`} role="group" data-context-dropdown aria-label={`${verb} agent`} ref={anchorRef}>
      {primaryButton ?? (minimized !== undefined ? <button type="button" className={`${primaryClass} launch-primary`} aria-description={minimizedTitle} title={minimizedTitle} onClick={() => { closeMenu(); minimized.onShow(); }}>
        {resolvedKind !== undefined && <KindMark kind={resolvedKind} />}<span className="launch-primary-label">Show agent</span>{minimizedBadge}
      </button> : <button type="button" className={`${primaryClass} launch-primary${pending ? ' progress-border progress-green' : ''}`} aria-busy={pending || undefined} aria-label={placeActions ? `${verb} ${label}` : actionCopy(verb, resolvedKind)} disabled={(resolution !== undefined && resolvedKind === undefined) || resolvedPolicyEmpty || disabled || launchDisabled || pending} title={primaryTitle} onClick={() => launch(resolvedLaunchChoice(adapters, resolution))}>
        {/* identify resolved launches without replacing their glyph during progress */}{pending && <span className="update-progress-ring" aria-hidden="true" />}{resolvedKind !== undefined && <KindMark kind={resolvedKind} />}<span className="launch-primary-label">{visibleAction}</span>{!placeActions && sandboxed && <LockIcon />}
      </button>)}
      <button type="button" className={`launch-chevron${compact ? ' compact' : ''}`} aria-label={updatesAvailable ? `${menuLabel} — ${updateLabel}` : menuLabel} aria-haspopup="menu" data-context-flyout aria-expanded={open} disabled={(none && entries.length === 0) || disabled || pending} onClick={event => { /* toggle the split flyout */ if (open) closeMenu(); else openMenu(event.currentTarget); }}><ChevronIcon /></button>
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
