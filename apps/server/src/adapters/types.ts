/**
 * The Adapter interface: every agent CLI the console knows is described by one
 * Adapter (ADR 0002). An Adapter *describes* its agent — how to recognise its
 * processes, what its title says, how a prompt is submitted, how a launch is
 * composed — while the console performs every side effect through its single
 * tmux and `/proc` layer.
 *
 * Chunk 1 populates `kind`, `stateSource`, `recognizes`, `inferState`,
 * `submission`, `launch` and `panes` (plus Codex's existing `turns`/
 * `conversations`, carried as facades). The remaining optional capabilities are
 * declared here so the derived capability record can read their presence; later
 * chunks fill them in.
 */
import type { HostProcess } from '../discovery/processes.js';
import type { CleanupTarget, Pane } from '../domain/models.js';
import type { ModelSetting, ProtocolClient } from '../transports/structured.js';

export const agentKinds = ['codex', 'omx', 'claude', 'pi', 'opencode'] as const;   // closed union in resolution order; the registry is code, not plugins
export type AgentKind = typeof agentKinds[number];
export type AttentionState = 'working' | 'finished' | 'question';
export type TmuxKey = 'Enter' | 'Tab' | 'Escape' | 'C-c' | 'Up' | 'Down' | 'M-Enter' | 'M-Up' | 'S-Left';

export type SubmissionMode = 'prompt' | 'shell';
export type SubmissionDraftState = 'visible' | 'cleared' | 'unknown';
// `keys` queues behind active work; `idleKeys` may use the Agent's direct submit path
export type Submission = { text: string; keys: TmuxKey[]; idleKeys?: TmuxKey[] };
export type Conversation = { id: string; title?: string };
/**
 * One Named conversation an Adapter's `list` returns: its id, the Conversation
 * name, whether that name is automatic where the kind can tell (Claude, Pi;
 * omitted for Codex), the agent-derived last-active time (epoch ms, never the
 * file mtime), and the directory it was started in.
 */
export type ConversationSummary = { id: string; name: string; automatic?: boolean; lastActiveAt: number; directory: string };
/** The pure tmux delivery for a CLI's own rename command: paste `text`, then send `keys`. */
export type ConversationRename = { text: string; keys: TmuxKey[] };
/** codex and omx share one rollout store (ADR 0005), so their Conversations are one family. */
export const codexFamily = (kind: AgentKind): boolean => kind === 'codex' || kind === 'omx';
/**
 * Whether two Conversation references name the same Conversation: equal ids and matching kinds,
 * treating codex and omx as one (ADR 0005), so a rollout resumed or named under either wrapper is
 * the same Conversation.
 */
export const sameConversation = (left: { kind: AgentKind; id: string }, right: { kind: AgentKind; id: string }): boolean =>
  left.id === right.id && (codexFamily(left.kind) ? codexFamily(right.kind) : left.kind === right.kind);
export type Turn = { prompt?: string; text: string; rows?: number };
// `source` is the web's dismissal-strategy discriminator, not the transport: a
// `parsed` question the client may optimistically dismiss, a `structured` one (OMX's
// file, Claude's reported payload) is server-published and waits for the server to
// stop reporting it. Not the same as the CONTEXT.md "Inline question" provenance.
// descriptions parallel choices ('' where an option has none) and are not part of the id.
// `field` is the Transport-neutral answer the question takes (ADR 0015) and `pane` where a question
// drawn on a tmux pane is answered. Adapters fill `choices` and `pane`; every question sent to the
// web is a ShapedQuestion, with `field` derived from the choices (`withQuestionShape`).
export type InlineQuestion = { id: string; text: string; choices: string[]; descriptions?: string[]; source: 'structured' | 'parsed'; field?: QuestionField; pane?: QuestionPane; expiresAt?: number };
export type ShapedQuestion = InlineQuestion & { field: QuestionField };
// one of the question's choices, or text: one line or several, prefilled or with a placeholder
export type QuestionField = { kind: 'choice'; choices: string[]; descriptions?: string[] } | { kind: 'text'; multiline: boolean; prefill?: string; placeholder?: string };
// selectedIndex is the live zero-based keyboard cursor, not part of the question id; rows maps
// each choice to its zero-based on-screen row when the menu skips a row the picker does not offer
// (Claude's `Type something.` input), identity otherwise; targetPaneId is the pane that draws the
// question when it is not the Agent's own (OMX's renderer)
export type QuestionPane = { rows?: number[]; selectedIndex?: number; targetPaneId?: string };
export type PromptCommand = { name: string; description?: string };

export type LaunchMode = 'fresh' | 'continue' | 'resume';
/**
 * What the console hands an Adapter to compose a launch. Chunk 1 supplies
 * `mode`, the `conversationId` for a `resume`, the `cwd`, and the `sandboxed`
 * flag; the Claude chunk adds `files` — the absolute paths of the console-owned
 * files this kind's `files` capability rendered at boot, keyed by name, as the
 * launching host sees them. The Adapter reads these and returns only arguments —
 * the console prepends the program and performs the launch.
 */
export type LaunchInput = { mode: LaunchMode; conversationId?: string; cwd: string; sandboxed: boolean; files?: Record<string, string> };
/** The CLI arguments (and optional environment) for a launch; the console prepends the program. */
export type LaunchSpec = { args: string[]; env?: Record<string, string> };
/** How an operator flag dropped from a launch takes values: none, the next argument, or every argument up to the next flag. */
export type ReplacedFlagValue = 'none' | 'one' | 'many';

/** The model and effort one Review run asks for; absent leaves the CLI's own default. */
export type ReviewRunSettings = { model?: string; effort?: string };
/**
 * The conversation a headless Review run joins: one it resumes, or a new one, under the id the console
 * chose for a CLI that takes one (`create`; a CLI that names its own ignores it).
 */
export type HeadlessRunConversation = { resume: string } | { create: string };
/**
 * One headless Review run: the Worktree it reads, its conversation, and the JSON Schema its reply must
 * match; without a schema the reply is Markdown text.
 */
export type HeadlessReviewRun = ReviewRunSettings & { workspace: string; schema?: object; conversation: HeadlessRunConversation };
/** A headless run's private files: its schema when it has one, written for it, and where it may write its reply. */
export type HeadlessRunFiles = { schema?: string; output: string };
/**
 * A finished headless run as the console saw it: the exit code, a bounded stderr tail, stdout when
 * it was kept (only its head, with `stdoutTruncated`, once it passed its bound), and the output
 * file when the run had one and wrote it.
 */
export type HeadlessRunOutcome = { code: number; diagnostics: string; stdout?: Buffer; stdoutTruncated?: boolean; output?: Buffer };
/** Why a headless run's reply was refused; only a missing login is not worth retrying. */
export type HeadlessRunFailure = 'authentication_required' | 'generation_failed' | 'malformed_result';
/** A headless run's parsed reply and, when the run reported it, its conversation; or why it failed. */
export type HeadlessRunResult = { ok: true; value: unknown; conversation?: string } | { ok: false; failure: HeadlessRunFailure };
/**
 * The pane an interactive Review run's reply is read from. Its Conversation is looked up only when
 * asked, as that may rescan the panes; read its directory after that lookup to see the rescan.
 */
export type ReplyPane = { pid?: number; cwd?: string; conversationId(): Promise<string | undefined>; directory(): string | undefined };

/**
 * How the console runs a Review run on this kind (ADR 0010): pure descriptions of the CLI, so
 * the console's headless and interactive engines perform every effect once for every kind. The
 * reply readers are the exception ADR 0002 allows, reading the agent's own transcript.
 */
export type ReviewRuns = {
  /** the effort levels the CLI accepts */
  readonly efforts: readonly string[];
  readonly headless: {
    /** the CLI help the capability check reads, the flags it must list, and a login check that must exit 0 */
    readonly probe: { readonly help: readonly string[]; readonly flags: readonly string[]; readonly login?: readonly string[] };
    /**
     * The arguments of one read-only run, the directory it runs in when not given by an argument,
     * and its conversation when that is known before it runs (one it resumes, or one it was told to create)
     */
    command(run: HeadlessReviewRun, files: HeadlessRunFiles): { args: string[]; cwd?: string; conversation?: string };
    /** how much stdout to keep for a reply bounded at `outputBytes`; absent when stdout is not read */
    stdoutBytes?(outputBytes: number): number;
    /** the reply of a finished run (JSON, or `text`), bounded at `outputBytes`, or why it failed */
    result(outcome: HeadlessRunOutcome, reply: { outputBytes: number; text: boolean }): HeadlessRunResult;
  };
  readonly interactive: {
    /** the per-launch arguments: the read-only restrictions, the model and effort, and read access to `readDirectory` */
    args(run: ReviewRunSettings & { readDirectory?: string }): string[];
    /**
     * The operator flags (`adapters.<kind>.args`) the launch drops: always the read-only ones (that
     * its arguments replace or that would loosen its policy), the model and effort ones only when
     * the run sets its own, so an operator's own model still applies to a run that names none
     */
    readonly readOnlyFlags: ReadonlyArray<readonly [string, ReplacedFlagValue]>;
    readonly modelFlags: readonly string[];
    readonly effortFlags: readonly string[];
    /**
     * MCP servers the launch must disable by name, for a CLI with no flag that drops them all: the
     * arguments that list them as the launch would load them, the names in that listing (undefined
     * when unreadable), and the arguments disabling them (undefined when a name cannot be addressed)
     */
    readonly mcp?: { readonly list: readonly string[]; servers(stdout: string): string[] | undefined; disable(names: string[]): string[] | undefined };
    readonly reply: {
      /** the transcript's position before a prompt, so a reply equal to the previous one is still seen */
      mark(pane: ReplyPane): Promise<unknown>;
      /**
       * The final message of the newest finished turn past `mark` (from the start of the
       * Conversation when `mark` is undefined), undefined while there is none; `maxBytes` bounds it,
       * read one past so an over-long reply still reads as too long.
       */
      since(pane: ReplyPane, mark: unknown, maxBytes: number): Promise<string | undefined>;
    };
  };
};

/**
 * What the console hands an Adapter's `files` renderer at boot: the host-visible
 * checkout root the rendered content and file paths are named against (under the
 * host bridge this is `RAC_HOST_REPOSITORY`), and the tmux binary to bake into a
 * hook command — omitted under the bridge, where the agent runs on the host and
 * the reporter resolves tmux from PATH instead.
 */
export type AdapterFileContext = { repoRoot: string; tmuxBin?: string };

/**
 * The agent-agnostic facts the console feeds `panes.classify`/`classifyProcess`
 * so an Adapter can reproduce its runtime-cleanup rules without embedding any
 * tmux or `/proc` knowledge (ADR 0002). The rules themselves live in each
 * Adapter — the worker/HUD rules in the OMX Adapter, the stale-Codex rule in the
 * Codex Adapter; the console only supplies the pane set, the process tree, and
 * the generic derivations (`identity`, `active`, `recognizedKind`, `excluded`,
 * `paneAncestor`).
 */
export type PaneScan = {
  panes: readonly Pane[];
  processes: readonly HostProcess[];
  identity(pane: Pane): string;
  sessionIdentity(pane: Pane): string;
  active(pane: Pane): boolean;
  recognizedKind(pane: Pane): AgentKind | undefined;
  /**
   * Whether any registered Adapter hides this pane from the dashboard (its own
   * `panes.exclude`), so one kind's rules never call another kind's hidden pane a
   * stale agent — a Codex rule need not know OMX's worker paths.
   */
  excluded(pane: Pane): boolean;
  paneAncestor(pid: number): Pane | undefined;
};
/** One runtime-cleanup classification an Adapter emits; the console wraps it with a stable id. */
export type CleanupClassification = Pick<CleanupTarget, 'kind' | 'label' | 'detail'>;
/** The pane's human-readable name for a cleanup classification's detail line. */
export const paneLabel = (pane: Pane): string => pane.displayLabel || pane.title || pane.sessionName || pane.paneId;
/**
 * The outcome of a turn read from the agent's structured event log: `pending`
 * while no terminal turn has been recorded past the baseline, `completed` (with
 * its answer) for a normal finish, `aborted` for an interrupt or cancellation.
 */
export type CompletionEvent =
  | { kind: 'pending' }
  | { kind: 'completed'; ordinal: number; answer: string }
  | { kind: 'aborted'; ordinal: number };
/**
 * A rollout completion baseline snapshotted before a turn starts, in one of two
 * shapes:
 *
 * - *Resolved* (`rollout`) — the exact event-log file the turn will be read from,
 *   pinned at capture with the file's `ordinal` at that instant. Pinning the file
 *   (rather than re-resolving it at completion) keeps `baseline` and `since`
 *   reading the same rollout even when a sibling pane's rollout later becomes the
 *   newest in a shared directory. An externally observed reset may additionally
 *   carry `resetPane`: `since` follows that exact pane to its first replacement
 *   rollout, then clears the marker and pins the replacement permanently.
 * - *Deferred* (`cwd` + `resetAt`) — a turn that starts a fresh conversation with
 *   `/new`. Codex opens the new thread's rollout only at its first turn, so there
 *   is no file to pin at capture; the baseline records the pane's working
 *   directory and the reset instant instead, and `since` resolves the newest
 *   cwd-matching rollout created after `resetAt`. `ordinal` is zero — the whole
 *   fresh thread is read.
 */
export type CompletionBaseline = { rollout: string; ordinal: number; resetPane?: { pid: number; cwd?: string } } | { cwd: string; resetAt: number; ordinal: number };

/** exact managed-turn evidence from a schema-validated native event stream */
export type ManagedPromptLifecycleEvidence =
  | { state: 'pending'; source: 'codex-rollout'; parserVersion: 1; receiptOrdinal?: number; startOrdinal?: number; turnId?: string; startedAt?: string }
  | { state: 'finished'; source: 'codex-rollout'; parserVersion: 1; receiptOrdinal: number; startOrdinal: number; terminalOrdinal: number; turnId: string; startedAt: string; finishedAt: string }
  | { state: 'invalid'; reason: 'missing_lifecycle_evidence' | 'unsupported_lifecycle_contract' };

/** versioned native correlation for one RAC-managed prompt */
export type ManagedPromptLifecycleV1 = {
  readonly version: 1;
  compatible(): boolean;
  inspect(baseline: CompletionBaseline, prompt: { fingerprint: string; transportFingerprint: string }, checkpoint?: { receiptOrdinal?: number; startOrdinal?: number; turnId?: string; startedAt?: string }): Promise<ManagedPromptLifecycleEvidence>;
};

/**
 * A pane snapshot the console feeds an Adapter's `newConversation` while it drives a
 * Run: the pane title, the Attention state the console derived, and the conversation
 * id the pane reported through `@rac_session` (undefined until one is reported).
 * `settled` reads a sequence of these taken after a reset command; `ready` reads one
 * taken while polling a fresh launch.
 */
export type PaneSnapshot = { title: string; attention: AttentionState; conversationId?: string };
/** How a new-conversation reset is progressing over the snapshots seen since the command. */
export type ResetSettling = 'pending' | 'settled' | 'lost';
/** Whether a freshly launched pane can take its first prompt yet. */
export type LaunchReadiness =
  | { state: 'pending' }
  | { state: 'ready' }
  | { state: 'blocked'; reason: string };

export interface Adapter {
  readonly kind: AgentKind;
  readonly stateSource: 'reported' | 'title' | 'both';
  /**
   * Operator arguments this Adapter must own, so the console warns (and ignores
   * them) when an `adapters.<kind>.args` entry supplies one — a mode flag or a
   * setting the console composes itself. Codex declares none.
   */
  readonly conflictingArgs?: readonly string[];
  /** Classify one process by its own identity; the wrapper ancestor is the walker's concern. */
  recognizes(process: { comm: string; argv: string[] }): boolean;
  /** The title-derived Attention state, or `undefined` when the title carries no signal. */
  inferState(pane: { title: string; command?: string }): AttentionState | undefined;
  /** The CLI arguments for a fresh/continue/resume launch; the console prepends the program and acts. */
  launch(input: LaunchInput): LaunchSpec;
  readonly submission: {
    prepare(prompt: string, mode: SubmissionMode): Submission;
    /** Observe durable acceptance; absence keeps this adapter on best-effort tmux delivery. */
    observeDraft?(capture: string, prompt: string): SubmissionDraftState;
    /** require exact draft ownership before recovery keys; undefined keeps recovery pending */
    ownsDraft?(capture: string, prompt: string): boolean | undefined;
    /** clear an observed failed draft without submitting or interrupting work */
    readonly clearDraft?: readonly TmuxKey[];
    /**
     * A prompt that completes without ever reporting `working` — an instant
     * conversation-control command like Claude's `/clear`, which returns straight
     * to an idle composer with no model turn. The console must not open an
     * awaiting-start phase for it: that phase would wait for a `working` report
     * that never comes, time out, and sweep any queued follow-up into saved
     * prompts. Absent (or `false`) keeps the normal tracked-completion path.
     */
    completesWithoutWork?(prompt: string): boolean;
    readonly interrupt: TmuxKey[];
    /** navigate from the freshly observed cursor when the question provides one */
    selectOption(index: number, selectedIndex?: number): TmuxKey[];
  };
  readonly turns?: {
    latestCompleted(capture: string): Turn | undefined;
    lastPrompt(capture: string): string | undefined;
    latestMessage(capture: string): string | undefined;
    failed(capture: string): boolean;
  };
  readonly questions?: {
    parse?(capture: string): InlineQuestion | undefined;
    /** navigate to a verified text editor before bracketed paste and enter */
    textEntry?(question: InlineQuestion, capture: string): TmuxKey[] | undefined;
    /** reshape a text answer before it is pasted, for an editor that cannot hold it verbatim */
    textAnswer?(text: string): string;
    /** native follow-up presence, with an opening-only shortcut when collapsed */
    queued?(capture: string): { key?: TmuxKey } | undefined;
    pending?(workspace: string, paneId: string): Promise<InlineQuestion | undefined>;
    /**
     * The Inline question an Agent reported on its own pane (`@rac_question`),
     * confirmed live against the pane's capture (ADR 0006). Pure: the base64 hook
     * payload and the capture in, one question out. A call carrying several
     * questions is walked one tab at a time — the single question drawn on screen,
     * then a Submit answers / Cancel step at its review page. `undefined` when the
     * payload is unrenderable (multiSelect, no options), when no question is on
     * screen (cancelled or already answered), or when the on-screen tab is
     * indistinguishable (two questions sharing a text and first option).
     */
    reported?(payload: string, capture: string): InlineQuestion | undefined;
  };
  readonly commands?: {
    /** prefer the runtime's effective command catalog when supported */
    readonly runtimeCatalog?: 'codex-app-server';
    /** the agent's own config/state directory (its skills root), resolved from injectable env roots */
    stateDirectory(env?: NodeJS.ProcessEnv): string;
    skillDirectories(workspace: string, stateDirectory: string): string[];
    slash(): PromptCommand[];
    skillInvocation(name: string): string;
  };
  readonly conversations?: {
    /**
     * Whether `id` is a well-formed Conversation id for this kind. The console
     * interpolates a resumed id into the host launch command, so this MUST reject
     * any id that is not safe to place there unquoted (both current implementations
     * are strict anchored UUID patterns); the resume path relies on it in place of a
     * hard-coded pattern.
     */
    validId(id: string): boolean;
    /**
     * The pane's current Conversation. The pane's `pid` drives the `/proc`
     * fd-walk; its `cwd` (supplied only when unique among live panes) is the
     * privilege-free fallback a confined service uses when it cannot readlink
     * the pane's descriptors — the same pair `completion.baseline` reads.
     */
    discover?(pane: { pid: number; cwd?: string }): Promise<Conversation | undefined>;
    /**
     * The Named conversations under the given directories, newest-first — only
     * Conversations that carry a Conversation name. `directory` is the one each was
     * started in, matched exactly as the agents' own pickers do. Later chunks fill
     * this in per kind; a kind that lists must also implement `readName`.
     */
    list?(directories: readonly string[]): Promise<ConversationSummary[]>;
    /**
     * The pure tmux delivery for the CLI's own rename command (Claude `/rename`,
     * Codex/OMX `/rename ` with a trailing space): the console pastes `text` and
     * sends `keys` on the pane. `keys` is `['Enter']` in every Attention state.
     */
    rename?(name: string): ConversationRename;
    /**
     * The Conversation's current name, read from the agent's own store by id — the
     * read-back after a console rename, and the name `discovery.conversation` reads
     * for a pane. The pane's `cwd` is supplied for Adapters (Claude) whose transcript is
     * keyed by working directory; an Adapter that finds its store by id alone
     * (Codex) ignores it. `undefined` when the Conversation has no name, or on any
     * read error — an unknown id, an unknown cwd, or an unreadable/absent store.
     */
    readName?(id: string, cwd?: string): Promise<string | undefined>;
    /** the latest unanswered assistant message from this pane's bounded transcript tail */
    latestMessage?(pane: { pid: number; cwd?: string; conversationId?: string }): Promise<string | undefined>;
  };
  /**
   * Turn completion read from the agent's own structured event log rather than the
   * TUI (ADR 0002). Native Codex renders no `─ Worked for` footer, so `turns`
   * (a pure TUI-string parse) never observes a completion; the rollout's
   * `task_complete`/`turn_aborted` events are the authoritative signal instead.
   * `baseline` resolves the pane's rollout and snapshots its state *before* a turn
   * starts; `since` returns the newest terminal turn recorded in that same rollout
   * past the baseline — its answer for a completion. The pane's `pid` drives the
   * `/proc` fd-walk; its `cwd` (supplied only when unique among live panes) is the
   * privilege-free fallback a confined service uses when it cannot readlink a
   * sandboxed pane's descriptors. `baseline` returns `undefined` when no single
   * rollout resolves, at which point the console falls back to `turns`.
   *
   * `resetAt` marks a turn that first resets the conversation with `/new`: Codex
   * opens the new thread's rollout only at its first turn, so `baseline` returns a
   * *deferred* baseline (the cwd and the instant) rather than pinning the pane's
   * still-open pre-reset rollout, and `since` resolves the post-reset rollout when
   * it appears. Deferred resolution keys on the cwd, so a reset turn without one is
   * unresolvable (`undefined`, the same `turns` fallback). `followReset` handles a
   * reset observed after the fact, when no trustworthy reset instant exists: the
   * resolved baseline follows the exact pane to its first rollout replacement.
   */
  readonly completion?: {
    baseline(pane: { pid: number; cwd?: string }, resetAt?: number, followReset?: boolean): Promise<CompletionBaseline | undefined>;
    /** confirm the exact prompt was durably recorded after its pre-send baseline */
    accepted?(baseline: CompletionBaseline, prompt: string): Promise<boolean>;
    since(baseline: CompletionBaseline): Promise<CompletionEvent | undefined>;
  };
  /** exact correlation only; adapters must omit this when native evidence is unproved */
  readonly managedPromptLifecycleV1?: ManagedPromptLifecycleV1;
  /**
   * How a Run resets an existing pane to a fresh conversation and how it knows a
   * freshly launched pane is ready for its first prompt (Scheduled prompts). Pure
   * descriptions over captures and pane snapshots (ADR 0002); the console performs
   * the paste, the keys and the polling. A kind that omits this capability launches
   * a fresh agent for every Run.
   *
   * - `command` — the reset text (`/clear` for Claude, `/new` for Codex and OMX,
   *   which shares Codex's object by reference). Submitted through the normal
   *   `submission.prepare` path, so Codex's trailing space and idle Enter apply.
   * - `composerEmpty(capture)` — whether the composer holds no draft and no open
   *   dialog, so the reset command will be run rather than merged into a prompt.
   * - `settled(before, observed, elapsedMs)` — reads the pane snapshots seen since
   *   the command (`before` is the snapshot taken just before it) to say whether the
   *   reset took (`settled`), is still in flight (`pending`), or was swallowed
   *   (`lost`). `elapsedMs` is the time since the command was submitted.
   * - `ready(snapshot, capture)` — whether a fresh launch can take its first prompt
   *   yet, or is `blocked` for a reason the operator must clear (Claude's
   *   untrusted-directory safety check).
   */
  readonly newConversation?: {
    readonly command: string;
    /** equivalent reset commands accepted by this TUI */
    readonly aliases?: readonly string[];
    composerEmpty(capture: string): boolean;
    settled(before: PaneSnapshot, observed: readonly PaneSnapshot[], elapsedMs: number): ResetSettling;
    ready(snapshot: PaneSnapshot, capture: string): LaunchReadiness;
  };
  /**
   * Console-owned files this Adapter needs on disk (hook settings, sandbox policy).
   * At boot the console renders each into `<RAC_ADAPTER_FILES_DIR ?? .data/adapters>/
   * <kind>/<name>` (0644, rewritten every boot) and hands the absolute paths back
   * through `LaunchInput.files`. Both the paths inside the content and the file
   * paths themselves are named against `context.repoRoot` (host paths under the
   * bridge), so a bridge without a host repository leaves the kind unlaunchable.
   */
  readonly files?: (context: AdapterFileContext) => Record<string, string>;
  readonly sandbox?: {
    needs: { domains: string[]; statePaths: string[]; protectedPaths: string[]; secrets: string[] };
    policyRequired: boolean;
  };
  /**
   * Runtime-cleanup rules for this agent's panes and processes. `exclude` names
   * the panes the console never shows on the dashboard (the OMX Adapter's worker
   * panes); `classify`/`classifyProcess` recognise the stale runtime targets the
   * Cleanup screen offers. Every agent-specific rule lives in its own Adapter
   * rather than in discovery or cleanup (ADR 0002); a kind that hides no panes or
   * runs no helper processes simply omits `exclude`/`classifyProcess`. The console
   * builds one immutable `PaneScan` per cleanup pass and calls `classify`/
   * `classifyProcess` once per pane/process against it — in registry order, first
   * classification wins — so an Adapter may memoise derived sets keyed on the scan.
   */
  readonly panes?: {
    exclude?(pane: Pane): boolean;
    classify(pane: Pane, scan: PaneScan): CleanupClassification | undefined;
    classifyProcess?(process: HostProcess, scan: PaneScan): CleanupClassification | undefined;
  };
  /** How this kind runs a Review run; the kinds that can run one are the Adapters that have it. */
  readonly reviewRuns?: ReviewRuns;
}

/**
 * An Adapter for a kind driven only over a structured Transport (ADR 0015, ADR 0002 amendment).
 * It is never recognised in a pane, so it has none of the pane members: it describes the launch
 * and names the protocol client the console drives the process with.
 */
export interface StructuredAdapter {
  readonly kind: AgentKind;
  /** The CLI arguments for a launch; the console prepends the program and runs it under a holder. */
  launch(input: StructuredLaunchInput): LaunchSpec;
  readonly client: ProtocolClient;
  /** Every Effort the kind's models may take; each model offers some of them. */
  readonly efforts: readonly string[];
  /**
   * The kind's Conversation store: the Named conversations under directories (`list`), a
   * Conversation's name (`readName`), and the reference a launch resumes and a switch takes
   * (`locate`), each for a Conversation started in `cwd`.
   */
  readonly conversations: {
    validId(id: string): boolean;
    list(directories: readonly string[]): Promise<ConversationSummary[]>;
    readName(id: string, cwd?: string): Promise<string | undefined>;
    locate(id: string, cwd: string): Promise<string | undefined>;
  };
  /** whether its protocol client can steer a working Agent */
  readonly steers: boolean;
  /** The npm package and version the console pins the kind's CLI at; its launch report should show the version (ADR 0017). */
  pinned(): { package: string; version: string } | undefined;
}
/**
 * What a structured launch starts: a new Conversation, the one at `resume` (located by the
 * kind's store), or (`continue`) the latest one started in `cwd`; with Allowed models configured,
 * `models` scopes the Agent to them and names the model a new Conversation starts on.
 */
export type StructuredLaunchInput = { cwd: string; sandboxed: boolean; resume?: string; continue?: true; models?: { allowed: readonly string[]; start?: ModelSetting } };
/** One Allowed model (`adapters.pi.allowedModels`): an exact `provider/id` and an optional default Effort. */
export type AllowedModel = { model: string; effort?: string };

/**
 * One configured adapter program (config `adapters.<kind>`). The console launches
 * a kind by prepending `program` to the Adapter's own arguments and appending the
 * operator's `args`, merging the operator's `env` over the Adapter's. `launchable`
 * and `unavailableReason` come from the boot executable check (skipped under the
 * host bridge, where `program` is a host path the container cannot stat).
 * `setup` runs in the launched pane before the program (a failure aborts the
 * launch); `teardown` runs best-effort in the agent's home after a stop.
 */
/** Trusted shell commands used to inspect and update one configured agent CLI. */
export type AdapterUpdateCommands = { current: string; latest: string; run: string };
export type AdapterLaunchConfig = { program: string; args: string[]; env: Record<string, string>; launchable: boolean; unavailableReason?: string; setup?: string; teardown?: string; updates?: AdapterUpdateCommands; allowedModels?: AllowedModel[] };
/** The configured adapters, keyed by kind; empty for an observe-only console. */
export type AdapterConfigs = Partial<Record<AgentKind, AdapterLaunchConfig>>;

/**
 * The capability record the console derives per registered kind and publishes on
 * the Dashboard (ADR 0002). Presence of an optional capability object becomes a
 * boolean the web reads; the resolution logic itself never leaves the server.
 * `launchable` is config-gated (a configured, executable program), and `program`
 * / `unavailableReason` carry the configured path and the reason it cannot launch.
 */
export type AdapterCapability = {
  launchable: boolean;
  unavailableReason?: string;
  program?: string;
  stateSource: Adapter['stateSource'];
  turnCapture: boolean;
  /** the Adapter lists its Named conversations (`conversations.list` present) */
  conversations: boolean;
  /** the Adapter renames a Conversation from the console (`conversations.rename` present) */
  naming: boolean;
  inlineQuestions: boolean;
  /** a working Agent can be redirected mid-Turn (a structured Transport whose protocol steers) */
  steer: boolean;
  commands: boolean;
  sandbox: boolean;
  /** a structured kind's Allowed models, in the operator's order, which a launch may choose from, and every Effort its models may take */
  allowedModels?: AllowedModel[];
  efforts?: string[];
};
