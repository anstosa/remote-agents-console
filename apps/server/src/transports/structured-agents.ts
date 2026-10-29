import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { structuredAdapterFor } from '../adapters/registry.js';
import type { AdapterConfigs, AgentKind, AllowedModel } from '../adapters/types.js';
import type { Agent, AgentLifecycle } from '../domain/models.js';
import type { ShapedQuestion } from '../adapters/types.js';
import type { Place } from '../places/places.js';
import { expandCommand } from '../launch/service.js';
import { run } from '../tmux/command.js';
import { serverCheckout } from '../workspaces/server-checkout.js';
import { connectHolder, type AgentUsage, type Delivery, type ModelInfo, type ModelSetting, type StructuredConnection, type StructuredEvent, type StructuredQuestion, type TranscriptItem, type TranscriptTool } from './structured.js';
import { agentPanel, type InterruptOutcome, type QuestionAnswer, type TurnEvent } from './transport.js';
import { validPrompt } from '../prompts/validation.js';
import type { StructuredTurnTransport } from '../prompts/service.js';

/** Where a structured Agent's process runs: its holder's socket and tmux pane (ADR 0016). */
export type HolderRef = { agentId: string; socket: string; pane: string; tmuxSocket?: string };
/** The command a holder runs: the program and its arguments, its environment, and the setup run first. */
export type HolderLaunch = { program: string; args: string[]; env: Record<string, string>; setup?: string };
/**
 * A structured Agent as the console stores it, from launch until Close: its kind, Place, whether
 * it is Sandboxed, its current Conversation, its holder, its lifecycle, who launched it and its
 * role (the Conductor's, later).
 */
export type StructuredRecord = { id: string; kind: AgentKind; placeId: string; home: string; sandboxed: boolean; conversationId?: string; holder?: HolderRef; lifecycle: AgentLifecycle; reason?: string; origin: 'operator'; role?: 'conductor'; launchedAt: number };
/**
 * What a launch starts: one process of `kind` at `place`, for the Agent `id`, on a new
 * Conversation (on `model` when Allowed models are configured) or resuming the Conversation `resume`.
 */
export type StructuredLaunch = { id: string; kind: AgentKind; place: Place; resume?: string; model?: ModelSetting };
/** Starts, reads and stops structured Agent processes; the holder in tmux outside tests. */
export interface StructuredProcesses {
  /** Start the process and connect its protocol client, which reports through `emit`. */
  start(launch: StructuredLaunch, emit: (event: StructuredEvent) => void): Promise<{ connection: StructuredConnection; holder: HolderRef } | undefined>;
  /** The process's recent stderr, shown when it fails. */
  stderr(holder: HolderRef): Promise<string | undefined>;
  /** Stop the process and remove its holder, then run its kind's teardown in its home. */
  stop(holder: HolderRef, agent: { kind: AgentKind; home: string }): Promise<void>;
}
/** Opens, reads and removes holder windows in a Place's Workspace session. */
export interface HolderWindows {
  openHolderWindow(place: Place, agentId: string, launch: HolderLaunch): Promise<HolderRef | undefined>;
  captureHolder(holder: HolderRef): Promise<string | undefined>;
  closeHolder(holder: HolderRef): Promise<void>;
}

/** The structured Agents' processes, each run under a holder in its Place's Workspace session. */
export function holderProcesses(windows: HolderWindows, configs: AdapterConfigs): StructuredProcesses {
  return {
    async start({ id, kind, place, resume, model }, emit) {
      const adapter = structuredAdapterFor(kind);
      const configured = configs[kind];
      if (adapter === undefined || configured?.launchable !== true) return undefined;
      const located = resume === undefined ? undefined : await adapter.conversations.locate(resume, place.home);
      if (resume !== undefined && located === undefined) return undefined;
      const allowed = configured.allowedModels ?? [];
      const spec = adapter.launch({ cwd: place.home, sandboxed: false, ...(located === undefined ? {} : { resume: located }), ...(allowed.length === 0 ? {} : { models: { allowed: allowed.map(entry => entry.model), ...(model === undefined ? {} : { start: model }) } }) });
      const holder = await windows.openHolderWindow(place, id, { program: configured.program, args: [...spec.args, ...configured.args], env: { ...spec.env, ...configured.env }, ...(configured.setup === undefined ? {} : { setup: configured.setup }) });
      if (holder === undefined) return undefined;
      const connected = await connectHolder(holder.socket);
      if (connected === undefined) { await windows.closeHolder(holder); return undefined; }
      return { holder, connection: adapter.client(connected.channel, emit) };
    },
    stderr: holder => windows.captureHolder(holder),
    async stop(holder, { kind, home }) {
      await windows.closeHolder(holder);
      const teardown = configs[kind]?.teardown;
      // best-effort, as for a pane: a failed teardown never blocks the stop
      if (teardown !== undefined && (await run('/bin/sh', ['-c', expandCommand(teardown, { identity: home })], undefined, 60_000).catch(() => undefined))?.code !== 0) console.error(`[structured] adapters.${kind} teardown failed in ${JSON.stringify(home)}`);
    }
  };
}

// what this console knows of one structured Agent's process while it drives it; `busy` while an
// operation (a delivery, a Conversation or model change) is in flight. `turn` is how the latest
// Turn ended; `draft` the text offered for the composer until the next prompt or steer, numbered
// by `offers` so the web takes each one once
type Live = { connection?: StructuredConnection; working: boolean; busy: boolean; turn?: Exclude<TurnEvent, { type: 'started' }>; questions: StructuredQuestion[]; steers: string[]; offers: number; draft?: { id: number; text: string }; transcript: TranscriptItem[]; revision: number; status: Map<string, string>; usage?: AgentUsage; queuedNext?: boolean; stderr?: string; reported?: (reported: boolean) => void; conversationName?: string; model?: ModelSetting; models?: ModelInfo[]; guarded?: boolean; noticeCount: number; notices: TranscriptItem[] };
/** Why an operation on a structured Agent did not run: no such live Agent, it is working, or it refused. */
export type StructuredRefusal = 'unavailable' | 'busy' | 'refused';
const maxTranscriptItems = 2_000;
// a question as every Inline question reaches the web: its choices, if any, are also its own
const shaped = ({ id, text, field, expiresAt }: StructuredQuestion): ShapedQuestion => ({ id, text, choices: field.kind === 'choice' ? field.choices : [], source: 'structured', field, ...(expiresAt === undefined ? {} : { expiresAt }) });

/** The status line above an Agent's composer: its extension's statuses, its cost so far and how full its context is. */
export type AgentStatusLine = { extension: string[] } & Partial<AgentUsage>;
/** A transcript item as the transcript lists it: a tool call carries its last lines and line count, not its whole output or source. */
export type TranscriptLine = TranscriptItem | (Omit<TranscriptTool, 'output' | 'source'> & { tail?: string; outputLines?: number });
const transcriptLine = (item: TranscriptItem): TranscriptLine => {
  if (item.kind !== 'tool') return item;
  const { output, source: _source, ...line } = item;
  // a call with a result line or a diff shows no output lines
  if (output === undefined || line.result !== undefined || line.diff !== undefined) return line;
  const lines = output.split('\n');
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return { ...line, tail: lines.slice(-5).join('\n'), outputLines: lines.length };
};
const isStoredRecord = (value: unknown): value is StructuredRecord => {
  const record = value as Partial<StructuredRecord> | null;
  const holder = record?.holder;
  return typeof record === 'object' && record !== null && typeof record.id === 'string' && typeof record.kind === 'string' && typeof record.placeId === 'string' && typeof record.home === 'string'
    && (holder === undefined || typeof holder.agentId === 'string' && typeof holder.socket === 'string' && typeof holder.pane === 'string');
};

/**
 * The structured Agents (ADR 0015): each gets a console-minted id and a stored record, is
 * recorded at its Place, and is driven through its protocol client. Nothing is delivered before
 * its launch report arrives; without one the Agent is failed, with its stderr. Its Attention is
 * working from a Turn's start to its settling, finished otherwise.
 */
export class StructuredAgents {
  private readonly file: string;
  private records?: Promise<StructuredRecord[]>;
  private readonly live = new Map<string, Live>();
  private readonly listeners = new Set<() => void>();
  private mutation = Promise.resolve();

  /**
   * `allowedModels` is the approval boundary for a kind's models (`adapters.<kind>.allowedModels`),
   * in the operator's order: the first is the default, and none means the kind's own default.
   */
  constructor(private readonly processes: StructuredProcesses, private readonly options: { file?: string; reportTimeoutMs?: number; allowedModels?: (kind: AgentKind) => readonly AllowedModel[] } = {}) {
    this.file = options.file ?? join(serverCheckout(), '.data/structured-agents.json');
  }

  /** Called whenever an Agent's state or transcript changes. */
  onChange(listener: () => void): void { this.listeners.add(listener); }

  /**
   * Launch a `kind` Agent at the Place, resuming `resume` on the model it was on, or on a new
   * Conversation on `model`, else the first Allowed model, at the Effort asked for, else the
   * entry's default. False when its process could not start, or `model` is not an Allowed model.
   */
  async launch(place: Place, kind: AgentKind, { resume, model }: { resume?: string; model?: ModelSetting } = {}): Promise<boolean> {
    const entry = model === undefined ? (resume === undefined ? this.allowed(kind)[0] : undefined) : this.allowed(kind).find(candidate => candidate.model === model.model);
    if (model !== undefined && entry === undefined) return false;
    const records = await this.load();
    const record: StructuredRecord = { id: randomUUID(), kind, placeId: place.id, home: place.home, sandboxed: false, lifecycle: 'starting', origin: 'operator', launchedAt: Date.now() };
    const live: Live = { working: false, busy: false, questions: [], steers: [], offers: 0, transcript: [], revision: 0, status: new Map(), noticeCount: 0, notices: [] };
    const reported = new Promise<boolean>(resolve => {
      live.reported = resolve;
      setTimeout(() => resolve(false), this.options.reportTimeoutMs ?? 30_000).unref();
    });
    records.push(record);
    this.live.set(record.id, live);
    const effort = model?.effort ?? entry?.effort;
    const launch = { id: record.id, kind, place, ...(resume === undefined ? {} : { resume }), ...(entry === undefined ? {} : { model: { model: entry.model, ...(effort === undefined ? {} : { effort }) } }) };
    const started = await this.processes.start(launch, event => this.observe(record, live, event)).catch(() => undefined);
    // closed while it started: nothing may keep running for it
    if (this.live.get(record.id) !== live) {
      if (started !== undefined) { started.connection.close(); await this.processes.stop(started.holder, record); }
      return false;
    }
    if (started === undefined) {
      records.splice(records.indexOf(record), 1);
      this.live.delete(record.id);
      this.changed();
      return false;
    }
    live.connection = started.connection;
    record.holder = started.holder;
    await this.save();
    this.changed(live);
    if (await reported) await this.noteUnreachableModels(record, live);
    else if (record.lifecycle === 'starting') await this.fail(record, live, 'Its process did not report in after starting.', true);
    return true;
  }

  /**
   * Deliver a prompt as a Turn: only to a live Agent that is not already working (`busy` until
   * then, as is one not live). A prompt from the queue is marked so in the transcript.
   */
  async deliver(id: string, prompt: string, { queued = false } = {}): Promise<Delivery | undefined> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    if (record === undefined) return undefined;
    const live = this.live.get(id);
    if (record.lifecycle !== 'live' || live?.connection === undefined || live.working || live.busy) return 'busy';
    live.busy = true;
    live.queuedNext = queued;
    // the Turn this prompt starts settles afresh, and an offered draft is spent
    live.turn = undefined;
    live.draft = undefined;
    try {
      const delivery = await live.connection.deliver(prompt);
      if (delivery !== 'started') live.queuedNext = undefined;
      return delivery;
    } finally { live.busy = false; }
  }

  /** Steer a working Agent with `prompt`, where its kind can steer; `refused` when it is not working or its process refused. */
  async steer(id: string, prompt: string): Promise<'sent' | 'unsupported' | 'refused'> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    if (record === undefined || structuredAdapterFor(record.kind)?.steers !== true) return 'unsupported';
    const live = await this.connected(id);
    if (live === undefined || !live.working || !await live.connection.steer(prompt)) return 'refused';
    live.draft = undefined;
    return 'sent';
  }

  /**
   * Cancel a working Agent's Turn: its pending steers are dropped, then the Turn is aborted. The
   * dropped steers go to `returned`, or are offered for the composer when nobody asked for them.
   */
  async interrupt(id: string, returned?: (steers: string[]) => void): Promise<InterruptOutcome> {
    const live = await this.connected(id);
    if (live === undefined) return 'unavailable';
    if (!live.working) return 'not-working';
    const steers = await live.connection.cancel();
    if (steers === undefined) return 'unavailable';
    if (returned !== undefined) returned(steers);
    else if (steers.length > 0) this.offer(live, steers.join('\n\n'));
    return 'ok';
  }

  private offer(live: Live, text: string): void {
    live.draft = { id: live.offers += 1, text };
    this.changed(live);
  }

  /** Answer one of a live Agent's open questions, or dismiss it. */
  async answer(id: string, questionId: string, answer: QuestionAnswer): Promise<boolean> {
    const live = await this.connected(id);
    const question = live?.questions.find(candidate => candidate.id === questionId);
    if (live === undefined || question === undefined || !answerFits(question, answer) || !await live.connection.answer(questionId, answer)) return false;
    this.closeQuestion(live, questionId);
    return true;
  }

  // a live Agent this console holds a connection to
  private async connected(id: string): Promise<(Live & { connection: StructuredConnection }) | undefined> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    const live = this.live.get(id);
    return record?.lifecycle === 'live' && live?.connection !== undefined ? live as Live & { connection: StructuredConnection } : undefined;
  }

  private closeQuestion(live: Live, questionId: string): void {
    const before = live.questions.length;
    live.questions = live.questions.filter(candidate => candidate.id !== questionId);
    if (live.questions.length !== before) this.changed(live);
  }

  /**
   * The structured Agents' Transport for the queue policy: a prompt is delivered as a Turn, and
   * the Turn is read from the events its protocol client reported. A busy Agent leaves the prompt
   * queued; an outright refusal holds the queue, which becomes Notes. Nothing here is held by a
   * reset or recovered after a restart.
   */
  readonly turns: StructuredTurnTransport = {
    owns: async id => await this.has(id),
    target: async id => {
      const agent = (await this.agents()).find(candidate => candidate.id === id);
      return agent === undefined ? undefined : { agent };
    },
    gate: async () => 'none',
    held: () => false,
    mark: async () => ({}),
    deliver: async (id, prompt, _attachments, options) => {
      const delivery = await this.deliver(id, prompt, { queued: options.waited === true });
      if (delivery === undefined) return { status: 'refused' };
      if (delivery === 'busy') return { status: 'busy' };
      return delivery === 'refused' ? { status: 'held' } : { status: 'submitted', instant: delivery === 'handled', prompt };
    },
    observe: async agent => {
      const live = this.live.get(agent.id);
      return live?.working === true ? { type: 'started', mark: {} } : live?.turn;
    },
    externalReset: async () => false,
    recoverAnswer: async () => 'settled',
    clearDraft: async () => true,
    answer: async (id, questionId, answer) => await this.answer(id, questionId, answer),
    steer: async (id, prompt) => await this.steer(id, prompt),
    interrupt: async (id, returned) => await this.interrupt(id, returned),
    close: async id => await this.close(id)
  };

  /** Start a new Conversation in place while the Agent is idle; it keeps the model and Effort. */
  async newConversation(id: string): Promise<'ok' | StructuredRefusal> {
    return await this.whileIdle(id, async ({ record, live, connection }) => {
      if (!await connection.newConversation()) return false;
      await this.holdToAllowedModels(record, live);
      return true;
    });
  }

  /** Switch to one of the kind's Conversations in place while idle, restoring its model if allowed. */
  async switchConversation(id: string, conversationId: string): Promise<'ok' | StructuredRefusal> {
    return await this.whileIdle(id, async ({ record, live, connection }) => {
      const reference = await structuredAdapterFor(record.kind)?.conversations.locate(conversationId, record.home);
      if (reference === undefined || !await connection.switchConversation(reference)) return false;
      await this.holdToAllowedModels(record, live);
      return true;
    });
  }

  /** Name the current Conversation while the Agent is idle. */
  async rename(id: string, name: string): Promise<'ok' | StructuredRefusal> {
    return await this.whileIdle(id, async ({ connection }) => await connection.renameConversation(name));
  }

  /** The Allowed models the Agent can reach, in the operator's order, and the one it is on. */
  async models(id: string): Promise<{ models: ModelInfo[]; current?: ModelSetting } | undefined> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    const live = this.live.get(id);
    if (record === undefined || live?.connection === undefined || record.lifecycle !== 'live') return undefined;
    // an empty list may be a failed read, so it is read again next time
    const reachable = live.models ?? await live.connection.models();
    if (reachable.length > 0) live.models = reachable;
    return { models: this.allowed(record.kind).flatMap(entry => reachable.find(model => model.id === entry.model) ?? []), ...(live.model === undefined ? {} : { current: live.model }) };
  }

  /**
   * Switch the Agent's model or Effort between Turns: only to an Allowed model, at the Effort asked
   * for, else the entry's default, else the current one. The transcript marks the change.
   */
  async setModel(id: string, setting: ModelSetting): Promise<'ok' | 'not-allowed' | StructuredRefusal> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    const entry = record === undefined ? undefined : this.allowed(record.kind).find(candidate => candidate.model === setting.model);
    if (record !== undefined && entry === undefined) return 'not-allowed';
    return await this.whileIdle(id, async ({ live, connection }) => {
      const previous = live.model;
      const effort = setting.effort ?? entry?.effort ?? previous?.effort;
      if (!await connection.setModel({ model: setting.model, ...(effort === undefined ? {} : { effort }) })) return false;
      const now = live.model?.effort ?? effort;
      this.notice(live, previous?.model === setting.model ? `Effort → ${now}` : `Model → ${this.modelName(live, setting.model)}, effort ${now}`);
      return true;
    });
  }

  /** Close an Agent: stop its process, remove its holder and forget it. */
  async close(id: string): Promise<boolean> {
    const records = await this.load();
    const record = records.find(candidate => candidate.id === id);
    if (record === undefined) return false;
    this.live.get(id)?.connection?.close();
    records.splice(records.indexOf(record), 1);
    this.live.delete(id);
    if (record.holder !== undefined) await this.processes.stop(record.holder, record);
    await this.save();
    this.changed();
    return true;
  }

  async has(id: string): Promise<boolean> {
    return (await this.load()).some(record => record.id === id);
  }

  /** The dashboard's view of every structured Agent, at its Place. */
  async agents(): Promise<Agent[]> {
    return (await this.load()).map(record => {
      const live = this.live.get(record.id);
      // an Agent this console never connected to has no process it can drive
      const lifecycle: AgentLifecycle = live === undefined && (record.lifecycle === 'starting' || record.lifecycle === 'live') ? 'exited' : record.lifecycle;
      const current = live?.model;
      const name = current === undefined ? undefined : live?.models?.find(model => model.id === current.model)?.name;
      const questions = (live?.questions ?? []).map(shaped);
      const attention = questions.length > 0 ? 'question' : live?.working === true ? 'working' : 'finished';
      const model = current === undefined ? undefined : { id: current.model, ...(name === undefined ? {} : { name }), ...(current.effort === undefined ? {} : { effort: current.effort }) };
      return { id: record.id, transport: 'structured', panel: agentPanel('structured'), home: record.home, title: '', kind: record.kind, attention, placeId: record.placeId, ...(record.sandboxed ? { sandboxed: true } : {}), ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }), ...(questions[0] === undefined ? {} : { question: questions[0] }), structured: { lifecycle, ...(record.reason === undefined ? {} : { reason: record.reason }), revision: live?.revision ?? 0, ...(model === undefined ? {} : { model }), switchable: this.allowed(record.kind).length > 0, ...(questions.length === 0 ? {} : { questions }), ...(live === undefined || live.steers.length === 0 ? {} : { steers: live.steers }), ...(live?.draft === undefined ? {} : { draft: live.draft }) } };
    });
  }

  async agent(id: string): Promise<Agent | undefined> {
    return (await this.agents()).find(agent => agent.id === id);
  }

  /** The current Conversation's name, as the Agent last reported it. */
  conversationName(id: string): string | undefined {
    return this.live.get(id)?.conversationName;
  }

  /**
   * What an Agent's transcript Panel shows: its latest `limit` items as lines, how many earlier
   * items there are, and its stderr once it failed.
   */
  async transcript(id: string, limit: number): Promise<{ items: TranscriptLine[]; earlier: number; status: AgentStatusLine; stderr?: string } | undefined> {
    if (!await this.has(id)) return undefined;
    const live = this.live.get(id);
    const items = live?.transcript ?? [];
    const shown = items.slice(-limit);
    const status: AgentStatusLine = { extension: [...live?.status.values() ?? []], ...live?.usage };
    return { items: shown.map(transcriptLine), earlier: items.length - shown.length, status, ...(live?.stderr === undefined ? {} : { stderr: live.stderr }) };
  }

  /** One transcript item in full, with a tool call's whole output and a script's source. */
  async transcriptItem(id: string, itemId: string): Promise<TranscriptItem | undefined> {
    if (!await this.has(id)) return undefined;
    return this.live.get(id)?.transcript.find(item => item.id === itemId);
  }

  private observe(record: StructuredRecord, live: Live, event: StructuredEvent): void {
    if (this.live.get(record.id) !== live) return;
    switch (event.type) {
      case 'report':
        if (record.lifecycle !== 'starting') return;
        record.lifecycle = 'live';
        live.reported?.(true);
        void this.save();
        break;
      case 'conversation':
        // the console's own notices belong to the Conversation they were made in
        if (record.conversationId !== undefined && record.conversationId !== event.id) live.notices = [];
        record.conversationId = event.id;
        live.conversationName = event.name;
        void this.save();
        break;
      case 'model':
        live.model = event.current;
        // the first model a launch reports is held to the Allowed models, as a resume may restore any
        if (live.guarded !== true) {
          live.guarded = true;
          // nothing is delivered until the Agent is on an Allowed model
          live.busy = true;
          void this.holdToAllowedModels(record, live).finally(() => { live.busy = false; });
        }
        break;
      case 'turn':
        live.working = event.turn.type === 'started';
        if (event.turn.type !== 'started') live.turn = event.turn;
        break;
      case 'steers':
        live.steers = event.pending;
        break;
      case 'question':
        live.questions = [...live.questions.filter(candidate => candidate.id !== event.question.id), event.question];
        break;
      case 'question-closed':
        this.closeQuestion(live, event.id);
        return;
      case 'draft':
        this.offer(live, event.text);
        return;

      case 'transcript': {
        let item = event.item;
        // one prompt is delivered at a time, so the next prompt shown (not a steer) is the delivered one
        if (item.kind === 'message' && item.role === 'user' && item.steer !== true && live.queuedNext !== undefined) {
          if (live.queuedNext) item = { ...item, queued: true };
          live.queuedNext = undefined;
        }
        const index = live.transcript.findIndex(candidate => candidate.id === item.id);
        if (index === -1) live.transcript.push(item); else live.transcript[index] = item;
        live.transcript.splice(0, live.transcript.length - maxTranscriptItems);
        break;
      }
      case 'history':
        // a history (loaded on a launch or a Conversation change) replaces the transcript, but not the
        // notices the console made for this Conversation since
        live.transcript = [...event.items, ...live.notices].slice(-maxTranscriptItems);
        break;
      case 'status':
        if (event.text === undefined) live.status.delete(event.key); else live.status.set(event.key, event.text);
        break;
      case 'usage':
        live.usage = event.usage;
        break;
      case 'exited':
        live.working = false;
        live.questions = [];
        live.steers = [];
        live.connection = undefined;
        live.status.clear();
        live.reported?.(false);
        if (record.lifecycle === 'starting') { void this.fail(record, live, 'Its process exited before reporting in.'); return; }
        if (record.lifecycle === 'live') { record.lifecycle = 'exited'; void this.save(); }
        break;
    }
    this.changed(live);
  }

  private allowed(kind: AgentKind): readonly AllowedModel[] {
    return this.options.allowedModels?.(kind) ?? [];
  }

  private modelName(live: Live, model: string): string {
    return live.models?.find(candidate => candidate.id === model)?.name ?? model;
  }

  private notice(live: Live, text: string, tone: 'info' | 'warning' | 'error' = 'info'): void {
    live.noticeCount += 1;
    const item: TranscriptItem = { id: `notice-${live.noticeCount}`, kind: 'notice', text, tone };
    live.notices.push(item);
    live.transcript.push(item);
    this.changed(live);
  }

  // run one operation on a live, idle Agent, refusing while it works or another operation runs
  private async whileIdle(id: string, operation: (agent: { record: StructuredRecord; live: Live; connection: StructuredConnection }) => Promise<boolean>): Promise<'ok' | StructuredRefusal> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    const live = this.live.get(id);
    if (record === undefined || record.lifecycle !== 'live' || live?.connection === undefined) return 'unavailable';
    if (live.working || live.busy) return 'busy';
    live.busy = true;
    try { return await operation({ record, live, connection: live.connection }) ? 'ok' : 'refused'; } finally { live.busy = false; }
  }

  // read the models the Agent can reach once it reports in, and say which Allowed models match none
  private async noteUnreachableModels(record: StructuredRecord, live: Live): Promise<void> {
    const allowed = this.allowed(record.kind);
    if (allowed.length === 0 || live.connection === undefined) return;
    const reachable = await live.connection.models().catch(() => undefined);
    if (reachable === undefined || reachable.length === 0) return;
    live.models = reachable;
    const unmatched = allowed.filter(entry => !reachable.some(model => model.id === entry.model)).map(entry => entry.model);
    if (unmatched.length > 0) this.notice(live, `Allowed models that match nothing reachable: ${unmatched.join(', ')}. Check the spelling and the login.`, 'warning');
    else this.changed(live);
  }

  // hold the Agent to its Allowed models: one on any other moves to the first that it can take,
  // marked in the transcript, and says so when it can take none
  private async holdToAllowedModels(record: StructuredRecord, live: Live): Promise<void> {
    const allowed = this.allowed(record.kind);
    const current = live.model;
    if (allowed.length === 0 || current === undefined || allowed.some(entry => entry.model === current.model)) return;
    for (const fallback of allowed) {
      const effort = fallback.effort ?? current.effort;
      if (live.connection === undefined || !await live.connection.setModel({ model: fallback.model, ...(effort === undefined ? {} : { effort }) })) continue;
      this.notice(live, `Model → ${this.modelName(live, fallback.model)}, effort ${live.model?.effort ?? effort}: ${current.model} is not an Allowed model`, 'warning');
      return;
    }
    this.notice(live, `${current.model} is not an Allowed model, and no Allowed model could be applied. Check Settings → Agents → Pi and the logins.`, 'error');
  }

  // mark the Agent failed with its stderr; a process still running unheard is stopped, its stderr kept
  private async fail(record: StructuredRecord, live: Live, reason: string, stop = false): Promise<void> {
    record.lifecycle = 'failed';
    record.reason = reason;
    const stderr = record.holder === undefined ? undefined : await this.processes.stderr(record.holder).catch(() => undefined);
    if (stderr !== undefined) live.stderr = stderr;
    if (stop && record.holder !== undefined) { live.connection?.close(); live.connection = undefined; await this.processes.stop(record.holder, record); }
    await this.save();
    this.changed(live);
  }

  private changed(live?: Live): void {
    if (live !== undefined) live.revision += 1;
    for (const listener of this.listeners) listener();
  }

  private load(): Promise<StructuredRecord[]> {
    this.records ??= this.read();
    return this.records;
  }

  private async read(): Promise<StructuredRecord[]> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      parsed = undefined;
    }
    if (Array.isArray(parsed) && parsed.every(isStoredRecord)) return parsed;
    console.warn(`[structured] ${this.file} is not a valid list of structured Agents; starting with none`);
    return [];
  }

  // write the records in order, each write replacing the file whole
  private save(): Promise<void> {
    const write = this.mutation.then(async () => {
      const records = await this.load();
      await mkdir(dirname(this.file), { recursive: true });
      const next = `${this.file}.next`;
      await writeFile(next, JSON.stringify(records), { mode: 0o600 });
      await rename(next, this.file);
    });
    this.mutation = write.catch(error => { console.error(`[structured] ${this.file} could not be written:`, error instanceof Error ? error.message : error); });
    return this.mutation;
  }
}

// an answer the question's field takes: one of its choices, text as a prompt would be for a text field, or dismissing it
const answerFits = (question: StructuredQuestion, answer: QuestionAnswer): boolean => typeof answer === 'object'
  || (question.field.kind === 'choice' ? Number.isInteger(answer) && (answer as number) >= 0 && (answer as number) < question.field.choices.length : typeof answer === 'string' && validPrompt(answer));
