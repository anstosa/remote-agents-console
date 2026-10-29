import { codexAdapter } from './codex.js';
import { omxAdapter } from './omx.js';
import { claudeAdapter } from './claude.js';
import { piAdapter } from './pi.js';
import type { Pane } from '../domain/models.js';
import type { Adapter, AdapterCapability, AdapterConfigs, AgentKind, ReviewRuns, StructuredAdapter } from './types.js';
import type { Transport } from '../transports/transport.js';

/**
 * The closed registry. It is code, not plugins: adding a kind means adding an
 * Adapter here. Codex, OMX and Claude are registered here, Pi among the structured-only
 * kinds (`structuredAdapters`), and OpenCode arrives later. Order is the resolution/priority
 * order (`codex`, `omx`, `claude`, `pi`, `opencode`) and the order cleanup rules are tried in. It plays no part in
 * telling OMX from Codex: the walker meets the OMX wrapper above the Codex child
 * in the pane's tree, and neither recognizer matches the other's process (ADR 0005).
 *
 * The process walker (`discovery/processes.ts`) imports this module, and this
 * module imports every Adapter, so an Adapter must never import the walker for
 * a value (types are fine): the Codex and OMX Adapters both hold the `codex-tui.ts`
 * objects at load time, which only works while the graph stays acyclic.
 */
// Each Adapter is declared with `satisfies Adapter`, not `: Adapter`, so its literal `kind` and
// whether it has `reviewRuns` survive into the types the Review run kinds are derived from.
const registered = [codexAdapter, omxAdapter, claudeAdapter] as const;
export const adapters: readonly Adapter[] = registered;

type ReviewRunsAdapter = Extract<typeof registered[number], { readonly reviewRuns: ReviewRuns }>;
/** The kinds that can run a Review run (ADR 0010): the Adapters that describe `reviewRuns`. */
export type ReviewAgentKind = ReviewRunsAdapter['kind'];
const reviewRunsAdapters = registered.filter((adapter): adapter is ReviewRunsAdapter => 'reviewRuns' in adapter);
/** The Review run kinds in registry order, as a non-empty tuple for schema enums. */
export const reviewAgentKinds = reviewRunsAdapters.map(adapter => adapter.kind) as [ReviewAgentKind, ...ReviewAgentKind[]];

/** How one kind runs a Review run. */
export function reviewRunsFor(kind: ReviewAgentKind): ReviewRuns {
  return reviewRunsAdapters.find(adapter => adapter.kind === kind)!.reviewRuns;
}

export function adapterFor(kind: AgentKind): Adapter | undefined {
  return adapters.find((adapter) => adapter.kind === kind);
}

/** The structured-only kinds (ADR 0015): driven through a protocol client, never recognised in a pane. */
export const structuredAdapters: readonly StructuredAdapter[] = [piAdapter];
export function structuredAdapterFor(kind: AgentKind): StructuredAdapter | undefined {
  return structuredAdapters.find(adapter => adapter.kind === kind);
}

/** The first registered Adapter that recognises the process, by registry order. */
export function recognizeProcess(process: { comm: string; argv: string[] }): Adapter | undefined {
  return adapters.find((adapter) => adapter.recognizes(process));
}

/** Whether any Adapter excludes this pane from the dashboard (e.g. OMX worker panes). */
export function paneExcluded(pane: Pane): boolean {
  return adapters.some((adapter) => adapter.panes?.exclude?.(pane) ?? false);
}

/**
 * The capability record the Dashboard publishes per registered kind (ADR 0002), derived from the
 * kind's Adapter and the Transport it is driven over (ADR 0015): tmux, or structured for a
 * structured-only kind. Launchability is config-gated: a kind is launchable only when its program is
 * configured and executable (`unavailableReason`/`program` carry the details); an observe-only
 * console (empty `adapters`) recognises every kind and launches none.
 */
export function adapterCapabilities(configs: AdapterConfigs): Partial<Record<AgentKind, AdapterCapability>> {
  return Object.fromEntries([
    ...adapters.map((adapter) => [adapter.kind, capability(adapter, 'tmux', configs[adapter.kind])]),
    ...structuredAdapters.map(adapter => [adapter.kind, structuredCapability(adapter, configs[adapter.kind])])
  ]);
}

// a structured kind reports its own state, Turns and questions, names its Conversations in place,
// and steers where its protocol client can; the rest arrive with later protocol features
function structuredCapability(adapter: StructuredAdapter, configured: AdapterConfigs[AgentKind]): AdapterCapability {
  return {
    ...launchability(configured),
    stateSource: 'reported',
    turnCapture: true,
    conversations: true,
    naming: true,
    allowedModels: configured?.allowedModels ?? [],
    efforts: [...adapter.efforts],
    inlineQuestions: true,
    steer: adapter.steers,
    commands: false,
    sandbox: false,
  };
}

const launchability = (configured: AdapterConfigs[AgentKind]): Pick<AdapterCapability, 'launchable' | 'unavailableReason' | 'program'> => ({
  launchable: configured?.launchable ?? false,
  ...(configured?.unavailableReason === undefined ? {} : { unavailableReason: configured.unavailableReason }),
  ...(configured?.program === undefined ? {} : { program: configured.program }),
});

// The pane-based members (Turn capture from the screen, questions read off the pane, a rename
// pasted into the composer) count only over tmux; a structured Transport reports its own.
function capability(adapter: Adapter, transport: Transport, configured: AdapterConfigs[AgentKind]): AdapterCapability {
  const tmux = transport === 'tmux';
  return {
    ...launchability(configured),
    stateSource: adapter.stateSource,
    turnCapture: tmux && adapter.turns !== undefined,
    conversations: adapter.conversations?.list !== undefined,
    naming: tmux && adapter.conversations?.rename !== undefined,
    inlineQuestions: tmux && adapter.questions !== undefined,
    steer: false,
    commands: adapter.commands !== undefined,
    sandbox: adapter.sandbox !== undefined,
  };
}
