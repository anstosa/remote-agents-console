import { codexAdapter } from './codex.js';
import { omxAdapter } from './omx.js';
import { claudeAdapter } from './claude.js';
import { piAdapter } from './pi.js';
import type { Pane } from '../domain/models.js';
import { agentKinds, type Adapter, type AdapterCapability, type AdapterConfigs, type AgentKind, type ReviewRuns, type StructuredAdapter, type TransportCapability } from './types.js';
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

/**
 * The kinds driven through a protocol client (ADR 0015). A kind here only is never recognised in
 * a pane; a kind also in `adapters` can launch over either Transport.
 */
export const structuredAdapters: readonly StructuredAdapter[] = [piAdapter];
export function structuredAdapterFor(kind: AgentKind): StructuredAdapter | undefined {
  return structuredAdapters.find(adapter => adapter.kind === kind);
}

/**
 * The Transport a launch of `kind` uses, undefined for an unregistered kind: the only one it has,
 * or for a kind with both, its configured default (tmux until `configs` can name one). Every
 * decision to launch over a structured Transport is made here.
 */
export function launchTransport(kind: AgentKind, configs: AdapterConfigs): Transport | undefined {
  if (adapterFor(kind) !== undefined) return 'tmux';
  return structuredAdapterFor(kind) === undefined ? undefined : 'structured';
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
 * kind's Adapter over each Transport it can launch on (ADR 0015), flattened over the one its
 * launches use. Launchability is config-gated: a kind is launchable only when its program is
 * configured and executable (`unavailableReason`/`program` carry the details); an observe-only
 * console (empty `adapters`) recognises every kind and launches none.
 */
export function adapterCapabilities(configs: AdapterConfigs): Partial<Record<AgentKind, AdapterCapability>> {
  return Object.fromEntries(agentKinds.flatMap(kind => {
    const tmux = adapterFor(kind);
    const structured = structuredAdapterFor(kind);
    const transports: Partial<Record<Transport, TransportCapability>> = {
      ...(tmux === undefined ? {} : { tmux: capability(tmux, configs[kind]) }),
      ...(structured === undefined ? {} : { structured: structuredCapability(structured, configs[kind]) }),
    };
    const transport = launchTransport(kind, configs);
    return transport === undefined ? [] : [[kind, { ...transports[transport]!, transport, transports }]];
  }));
}

// a structured kind reports its own state, Turns and questions, names its Conversations in place,
// and steers where its protocol client can; the rest arrive with later protocol features
function structuredCapability(adapter: StructuredAdapter, configured: AdapterConfigs[AgentKind]): TransportCapability {
  return {
    ...launchability(configured),
    stateSource: 'reported',
    turnCapture: true,
    conversations: true,
    naming: true,
    ...(configured?.allowedModels === undefined ? {} : { allowedModels: configured.allowedModels }),
    efforts: [...adapter.efforts],
    inlineQuestions: true,
    steer: adapter.steers,
    commands: false,
    sandbox: adapter.sandbox === true,
  };
}

const launchability = (configured: AdapterConfigs[AgentKind]): Pick<TransportCapability, 'launchable' | 'unavailableReason' | 'program'> => ({
  // explicit empty Allowed models disable launches without hiding configuration
  launchable: (configured?.launchable ?? false) && configured?.allowedModels?.length !== 0,
  ...(configured?.allowedModels?.length === 0
    ? { unavailableReason: 'No models are allowed for this Agent.' }
    : configured?.unavailableReason === undefined ? {} : { unavailableReason: configured.unavailableReason }),
  ...(configured?.program === undefined ? {} : { program: configured.program }),
});

// over tmux, from the pane-based members (Turn capture from the screen, questions read off the
// pane, a rename pasted into the composer)
function capability(adapter: Adapter, configured: AdapterConfigs[AgentKind]): TransportCapability {
  return {
    ...launchability(configured),
    stateSource: adapter.stateSource,
    turnCapture: adapter.turns !== undefined,
    conversations: adapter.conversations?.list !== undefined,
    naming: adapter.conversations?.rename !== undefined,
    inlineQuestions: adapter.questions !== undefined,
    steer: false,
    commands: adapter.commands !== undefined,
    sandbox: adapter.sandbox !== undefined,
    ...(configured?.allowedModels === undefined ? {} : { allowedModels: configured.allowedModels }),
    efforts: [...adapter.reviewRuns?.efforts ?? []],
  };
}
