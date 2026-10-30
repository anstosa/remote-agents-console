import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { structuredAdapterFor } from '../adapters/registry.js';
import type { AdapterConfigs, AgentKind, AllowedModel, StructuredAdapter } from '../adapters/types.js';
import type { Agent, AgentLifecycle } from '../domain/models.js';
import type { ShapedQuestion } from '../adapters/types.js';
import type { Place } from '../places/places.js';
import { expandCommand } from '../launch/service.js';
import { run } from '../tmux/command.js';
import { serverCheckout } from '../workspaces/server-checkout.js';
import { connectHolder, type AgentUsage, type HolderHello, type LineChannel, type Delivery, type ModelInfo, type ModelSetting, type StructuredConnection, type StructuredEvent, type StructuredQuestion, type TranscriptItem, type TranscriptTool } from './structured.js';
import { agentPanel, type InterruptOutcome, type QuestionAnswer, type TurnEvent } from './transport.js';
import { validPrompt } from '../prompts/validation.js';
import type { StructuredTurnTransport } from '../prompts/service.js';
import type { PromptLabel } from '../prompts/queue.js';
import { setAside } from '../set-aside.js';

/**
 * Where a structured Agent's process runs: its holder's socket and tmux pane (ADR 0016), the
 * process's pid, and how many of its lines the console had read at its last idle point, which a
 * console that restarts reconnects from.
 */
export type HolderRef = { agentId: string; socket: string; pane: string; tmuxSocket?: string; pid?: number; read?: number };
/** Whether a holder's process has exited, with its exit status. */
export type HolderStatus = { dead: boolean; status?: number };
/** The command a holder runs: the program and its arguments, its environment, and the setup run first. */
export type HolderLaunch = { program: string; args: string[]; env: Record<string, string>; setup?: string };
/**
 * A structured Agent as the console stores it, from launch until Close: its kind, Place, whether
 * it is Sandboxed, its current Conversation, its holder, its lifecycle, who launched it and its
 * role (the Conductor's). `access` is the hash of the console MCP token its current process holds,
 * while it runs.
 */
export type StructuredRecord = { id: string; kind: AgentKind; placeId: string; home: string; sandboxed: boolean; conversationId?: string; holder?: HolderRef; lifecycle: AgentLifecycle; reason?: string; origin: 'operator' | { conductor: string }; role?: 'conductor'; access?: string; launchedAt: number; version?: string };
/**
 * What a launch starts: one process of `kind` at `place`, for the Agent `id`, on a new
 * Conversation (on `model` when Allowed models are configured) or resuming the Conversation `resume`,
 * Sandboxed or not, and the nonce its launch report must echo.
 */
export type StructuredLaunch = { id: string; kind: AgentKind; place: Place; resume?: string; continue?: true; model?: ModelSetting; sandboxed: boolean; nonce: string; role?: 'conductor' };
/** One line between the console and an Agent's process, as it went over the wire. */
export type RawLine = { from: 'agent' | 'console'; line: string };
/**
 * A running process the console is connected to, how many of its lines the console has read, the
 * latest lines either way (Raw events), and, reattached, how many lines it could not replay.
 */
export type StructuredProcess = { connection: StructuredConnection; holder: HolderRef; cursor?: () => number; raw?: () => readonly RawLine[]; dropped?: number };
/** Starts, reads and stops structured Agent processes; the holder in tmux outside tests. */
export interface StructuredProcesses {
  /** Start the process and connect its protocol client, which reports through `emit`. */
  start(launch: StructuredLaunch, emit: (event: StructuredEvent) => void): Promise<StructuredProcess | undefined>;
  /**
   * Connect again to a process this console started before it restarted, from the lines it had
   * read (`holder.read`); undefined when the process is gone.
   */
  attach(holder: HolderRef, kind: AgentKind, emit: (event: StructuredEvent) => void): Promise<StructuredProcess | undefined>;
  /** The process's recent stderr, shown when it fails: what its holder window shows, its last `lines` (40). */
  stderr(holder: HolderRef, lines?: number): Promise<string | undefined>;
  /** Stop the process and remove its holder, then run its kind's teardown in its home. */
  stop(holder: HolderRef, agent: { kind: AgentKind; home: string }): Promise<void>;
}
/** Opens, reads and removes holder windows in a Place's Workspace session. */
export interface HolderWindows {
  openHolderWindow(place: Place, agentId: string, launch: HolderLaunch): Promise<HolderRef | undefined>;
  captureHolder(holder: HolderRef, lines?: number): Promise<string | undefined>;
  holderRunning(holder: HolderRef): Promise<boolean>;
  closeHolder(holder: HolderRef): Promise<void>;
}

const running = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
// SIGTERM a process, and SIGKILL it if it is still running after the grace
async function terminate(pid: number, graceMs = 5_000): Promise<void> {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (const deadline = Date.now() + graceMs; Date.now() < deadline && running(pid);) await new Promise(resolve => setTimeout(resolve, 100));
  if (running(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone meanwhile */ }
}

// the Raw events kept per Agent, each line cut short
const maxRawLines = 500;
const maxRawLine = 4_096;
// a protocol client over a holder connection, counting the child's lines it reads from the
// holder's cursor and keeping the latest lines either way
function clientOver(adapter: StructuredAdapter, holder: HolderRef, { channel, hello }: { channel: LineChannel; hello: HolderHello }, emit: (event: StructuredEvent) => void, attached?: { dropped: number }): StructuredProcess {
  let read = hello.from;
  const raw: RawLine[] = [];
  const keep = (from: RawLine['from'], line: string) => { raw.push({ from, line: line.slice(0, maxRawLine) }); raw.splice(0, raw.length - maxRawLines); };
  const counted: LineChannel = { ...channel, send: line => { keep('console', line); channel.send(line); }, onLine: listener => channel.onLine(line => { read += 1; keep('agent', line); listener(line); }) };
  // the pid is signalled on Close, so only a real one is kept
  const pid = Number.isSafeInteger(hello.pid) && hello.pid > 1 ? { pid: hello.pid } : {};
  return { holder: { ...holder, ...pid }, connection: adapter.client(counted, emit, attached), cursor: () => read, raw: () => raw, ...(attached === undefined ? {} : { dropped: attached.dropped }) };
}

/**
 * The structured Agents' processes, each run under a holder in its Place's Workspace session.
 * `files` are the kind's console-rendered files. The operator's `env` cannot replace what the
 * Adapter composes from them and the launch (its sandbox policy, the nonce its report must echo).
 */
export function holderProcesses(windows: HolderWindows, configs: AdapterConfigs, files: (kind: AgentKind) => Promise<Record<string, string> | undefined> = async () => undefined): StructuredProcesses {
  return {
    async start({ id, kind, place, resume, continue: latest, model, sandboxed, nonce, role }, emit) {
      const adapter = structuredAdapterFor(kind);
      const configured = configs[kind];
      if (adapter === undefined || configured?.launchable !== true) return undefined;
      const located = resume === undefined ? undefined : await adapter.conversations.locate(resume, place.home);
      if (resume !== undefined && located === undefined) return undefined;
      const allowed = configured.allowedModels ?? [];
      const rendered = await files(kind);
      const spec = adapter.launch({ cwd: place.home, sandboxed, nonce, ...(role === undefined ? {} : { role }), ...(rendered === undefined ? {} : { files: rendered }), ...(located === undefined ? {} : { resume: located }), ...(latest === true ? { continue: true as const } : {}), ...(allowed.length === 0 ? {} : { models: { allowed: allowed.map(entry => entry.model), ...(model === undefined ? {} : { start: model }) } }) });
      const holder = await windows.openHolderWindow(place, id, { program: configured.program, args: [...spec.args, ...configured.args], env: { ...configured.env, ...spec.env }, ...(configured.setup === undefined ? {} : { setup: configured.setup }) });
      if (holder === undefined) return undefined;
      // a holder that a slow login shell or setup holds up is waited for as long as its launch
      // report is (30 s), not given up on first
      const connected = await connectHolder(holder.socket, { attempts: 300 });
      if (connected === undefined) { await windows.closeHolder(holder); return undefined; }
      return clientOver(adapter, holder, connected, emit);
    },
    async attach(holder, kind, emit) {
      const adapter = structuredAdapterFor(kind);
      // a holder that is gone, or not this Agent's any more, is never reached
      if (adapter === undefined || !await windows.holderRunning(holder)) return undefined;
      const connected = await connectHolder(holder.socket, { from: holder.read ?? 0, attempts: 3 });
      return connected === undefined ? undefined : clientOver(adapter, holder, connected, emit, { dropped: connected.hello.dropped });
    },
    stderr: (holder, lines) => windows.captureHolder(holder, lines),
    async stop(holder, { kind, home }) {
      // the process is asked to stop, then killed; only while the window is still this Agent's holder
      if (holder.pid !== undefined && await windows.holderRunning(holder)) await terminate(holder.pid);
      await windows.closeHolder(holder);
      const teardown = configs[kind]?.teardown;
      // best-effort, as for a pane: a failed teardown never blocks the stop
      if (teardown !== undefined && (await run('/bin/sh', ['-c', expandCommand(teardown, { identity: home })], undefined, 60_000).catch(() => undefined))?.code !== 0) console.error(`[structured] adapters.${kind} teardown failed in ${JSON.stringify(home)}`);
    }
  };
}

// What this console knows of one structured Agent's process while it drives it. `generation`
// counts the processes it started for the Agent, `cursor` the lines read from the current one,
// `prompt` is the latest Turn's prompt, and `offPin` is set while the process runs another
// version than the pinned one. `resyncing` from a reattach until the process has reported its
// Conversation (after the replay) or ended a Turn: until then it may be working. `busy` while an operation (a delivery, a Conversation or model
// change, a relaunch or reattach) is in flight. `turn` is how the latest
// Turn ended; `draft` the text offered for the composer until the next prompt or steer, numbered
// by `offers` so the web takes each one once. `nonce` is what the latest process's launch report
// must echo, and `refusal` why its report refused it. `access` is the console MCP token a
// Conductor's process is given once it reports in, and `scripts` the deadlines of its scripts running
type Live = { generation: number; nonce?: string; access?: string; scripts?: Map<string, NodeJS.Timeout>; refusal?: string; connection?: StructuredConnection; cursor?: () => number; raw?: () => readonly RawLine[]; prompt?: string; offPin?: boolean; resyncing?: boolean; working: boolean; busy: boolean; turn?: Exclude<TurnEvent, { type: 'started' }>; questions: StructuredQuestion[]; steers: string[]; offers: number; draft?: { id: number; text: string }; transcript: TranscriptItem[]; revision: number; status: Map<string, string>; usage?: AgentUsage; queuedNext?: boolean; labelNext?: PromptLabel; stderr?: string; reported?: (reported: boolean) => void; conversationName?: string; model?: ModelSetting; models?: ModelInfo[]; guarded?: boolean; noticeCount: number; notices: TranscriptItem[] };
/** Why an operation on a structured Agent did not run: no such live Agent, it is working, or it refused. */
export type StructuredRefusal = 'unavailable' | 'busy' | 'refused';
const maxTranscriptItems = 2_000;
/** What every console MCP token a structured Agent holds starts with, so the gateway can tell it from OAuth's. */
export const consoleTokenPrefix = 'rac-conductor.';
const consoleTokenPattern = new RegExp(`${consoleTokenPrefix.replace('.', '\\.')}[A-Za-z0-9_-]+`, 'gu');
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('base64url');
/** What the console gives the Conductor: its MCP endpoint, the model a fresh Conversation starts on, and how long a script may run. */
export type ConductorOptions = { endpoint: string; model: ModelSetting; scriptDeadlineMs: number };
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
// a transcript item as plain text lines, as a log tail reads it; thinking is left out
const transcriptText = (item: TranscriptItem): string | undefined => {
  switch (item.kind) {
    case 'message': return item.role === 'user' ? `> ${item.text}` : item.text;
    case 'notice': return `* ${item.text}`;
    case 'settled': return `(${item.outcome})`;
    case 'tool': return `${item.parentId === undefined ? '' : '  '}- ${item.name}(${item.summary})${item.result === undefined ? '' : ` -> ${item.result}`}`;
    default: return undefined;
  }
};
const nonNegativeInt = (value: unknown): boolean => value === undefined || Number.isSafeInteger(value) && (value as number) >= 0;
const isStoredRecord = (value: unknown): value is StructuredRecord => {
  const record = value as Partial<StructuredRecord> | null;
  const holder = record?.holder;
  return typeof record === 'object' && record !== null && typeof record.id === 'string' && typeof record.kind === 'string' && typeof record.placeId === 'string' && typeof record.home === 'string'
    && (holder === undefined || typeof holder.agentId === 'string' && typeof holder.socket === 'string' && typeof holder.pane === 'string' && nonNegativeInt(holder.read) && (holder.pid === undefined || nonNegativeInt(holder.pid) && holder.pid > 1));
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
   * Launch a `kind` Agent at the Place, Sandboxed or not, resuming `resume` on the model it was on,
   * or on a new Conversation on `model`, else the first Allowed model, at the Effort asked for, else
   * the entry's default. Answers the new Agent's id once its process started (it may then have
   * failed to report in); undefined when it could not start, or `model` is not an Allowed model.
   */
  async launch(place: Place, kind: AgentKind, { resume, continue: latest, model, sandboxed = false, role, spawnedBy }: { resume?: string; continue?: true; model?: ModelSetting; sandboxed?: boolean; role?: 'conductor'; spawnedBy?: string } = {}): Promise<string | undefined> {
    // the Conductor starts on its configured model
    if (role === 'conductor') model ??= this.conductor?.model;
    const entry = model === undefined ? (resume === undefined && latest !== true ? this.allowed(kind)[0] : undefined) : this.allowed(kind).find(candidate => candidate.model === model.model);
    if (model !== undefined && entry === undefined) return undefined;
    const records = await this.load();
    const record: StructuredRecord = { id: randomUUID(), kind, placeId: place.id, home: place.home, sandboxed, lifecycle: 'starting', origin: spawnedBy === undefined ? 'operator' : { conductor: spawnedBy }, ...(role === undefined ? {} : { role }), launchedAt: Date.now() };
    const live = this.idle();
    records.push(record);
    this.live.set(record.id, live);
    const effort = model?.effort ?? entry?.effort;
    const started = await this.start(record, live, { id: record.id, kind, place, ...(resume === undefined ? {} : { resume }), ...(latest === true ? { continue: true as const } : {}), ...(entry === undefined ? {} : { model: { model: entry.model, ...(effort === undefined ? {} : { effort }) } }) });
    if (started === undefined) {
      records.splice(records.indexOf(record), 1);
      this.live.delete(record.id);
      this.changed();
    }
    return started === true ? record.id : undefined;
  }

  /**
   * Spawn a Sandboxed worker for the Conductor `by` (ADR 0018), on `model` if given: one at a time,
   * and none while it has `max` workers starting or live.
   */
  spawn(place: Place, kind: AgentKind, by: string, max: number, model?: ModelSetting): Promise<string | 'at-capacity' | undefined> {
    const spawning = this.spawning.then(async () => {
      const live = (await this.load()).filter(record => typeof record.origin === 'object' && record.origin.conductor === by && (record.lifecycle === 'starting' || record.lifecycle === 'live'));
      if (live.length >= max) return 'at-capacity' as const;
      return await this.launch(place, kind, { sandboxed: true, spawnedBy: by, ...(model === undefined ? {} : { model }) });
    });
    this.spawning = spawning.then(() => undefined, () => undefined);
    return spawning;
  }
  private spawning: Promise<unknown> = Promise.resolve();

  /** How the console gives the Conductor its access, model and script deadline. */
  useConductor(options: ConductorOptions): void { this.conductor = options; }
  private conductor?: ConductorOptions;

  /** The Places a resume relaunches an Agent at, by id. */
  usePlaces(place: (placeId: string) => Promise<Place | undefined>): void { this.place = place; }
  private place: (placeId: string) => Promise<Place | undefined> = async () => undefined;

  /**
   * Resume an Exited Agent: relaunch its process with the same id on its Conversation (or on
   * `conversationId`), and its held queue drains once it reports in. False when it is not Exited
   * or could not start again; it stays Exited then.
   */
  async resume(id: string, conversationId?: string): Promise<boolean> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    const live = this.live.get(id) ?? this.idle();
    if (record === undefined || record.lifecycle !== 'exited' || live.busy) return false;
    this.live.set(id, live);
    return await this.relaunch(record, live, conversationId ?? record.conversationId) === true;
  }

  /**
   * Stop the Agent's process, if it runs, and start it again on its Conversation, keeping its id and
   * queue. Not while it works: its Turn would never end, and the queue behind it would not wait.
   */
  async restart(id: string): Promise<boolean> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    const live = this.live.get(id) ?? this.idle();
    if (record === undefined || live.busy || live.working || record.lifecycle === 'starting') return false;
    this.live.set(id, live);
    return await this.relaunch(record, live, record.conversationId) === true;
  }

  /** Stop the Agent's process and leave it Exited, saying why; a resume or restart starts it again. */
  async stop(id: string, reason: string): Promise<boolean> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    const live = this.live.get(id) ?? this.idle();
    if (record === undefined || live.busy) return false;
    this.live.set(id, live);
    // its process's last events change nothing now: it ends here as an exit does, its queue waiting for a resume
    live.generation += 1;
    live.connection?.close();
    this.processExited(record, live);
    live.resyncing = false;
    if (record.holder !== undefined) await this.processes.stop(record.holder, record);
    record.holder = undefined;
    Object.assign(record, { lifecycle: 'exited', reason });
    await this.save();
    this.changed(live);
    return true;
  }

  /** The Agent whose current process holds this console MCP token, if any. */
  async tokenHolder(token: string): Promise<StructuredRecord | undefined> {
    const hash = tokenHash(token);
    return (await this.load()).find(record => record.access === hash);
  }

  // start the Agent's process again under a new holder, on `conversationId` when its kind's store
  // still has it (a Conversation never saved starts afresh); the old holder window goes first
  private async relaunch(record: StructuredRecord, live: Live, conversationId: string | undefined): Promise<boolean | undefined> {
    live.busy = true;
    try {
      const place = await this.place(record.placeId);
      if (place === undefined) return false;
      const resume = conversationId === undefined || await structuredAdapterFor(record.kind)?.conversations.locate(conversationId, record.home) === undefined ? undefined : conversationId;
      // the old process's last events (its exit) are not this Agent's any more
      live.generation += 1;
      live.connection?.close();
      this.endScripts(live);
      if (record.holder !== undefined) await this.processes.stop(record.holder, record);
      record.holder = undefined;
      record.lifecycle = 'starting';
      delete record.reason;
      Object.assign(live, { working: false, questions: [], steers: [], guarded: false, connection: undefined, stderr: undefined });
      live.status.clear();
      // a Conductor's fresh Conversation starts on its configured model
      const model = resume === undefined && record.role === 'conductor' ? this.conductor?.model : undefined;
      const started = await this.start(record, live, { id: record.id, kind: record.kind, place, ...(resume === undefined ? {} : { resume }), ...(model === undefined ? {} : { model }) });
      // one that did not start, or did not report in, stays Exited, so it can be resumed again
      if (started === undefined || (record.lifecycle as AgentLifecycle) === 'failed') { record.lifecycle = 'exited'; record.reason ??= 'It could not be started again.'; await this.save(); this.changed(live); return false; }
      return started;
    } finally { live.busy = false; }
  }

  // Start a process for the record and wait for its launch report: true once started (it may
  // then have failed to report in), false when it was closed meanwhile, undefined when no process
  // started. Events from an earlier process of the same Agent are ignored.
  private async start(record: StructuredRecord, live: Live, launch: Omit<StructuredLaunch, 'sandboxed' | 'nonce'>): Promise<boolean | undefined> {
    const generation = live.generation += 1;
    // each process reports in under its own nonce, Sandboxed as the Agent was launched; a
    // Conductor's gets its own console token, and the one before it no longer works
    live.nonce = randomBytes(16).toString('base64url');
    delete live.refusal;
    if (record.role === 'conductor') {
      live.access = `${consoleTokenPrefix}${randomBytes(32).toString('base64url')}`;
      record.access = tokenHash(live.access);
    } else delete record.access;
    const reported = new Promise<boolean>(resolve => {
      live.reported = resolve;
      setTimeout(() => resolve(false), this.options.reportTimeoutMs ?? 30_000).unref();
    });
    const started = await this.processes.start({ ...launch, sandboxed: record.sandboxed, nonce: live.nonce, ...(record.role === undefined ? {} : { role: record.role }) }, event => this.observe(record, live, generation, event)).catch(() => undefined);
    // closed while it started: nothing may keep running for it
    if (this.live.get(record.id) !== live || live.generation !== generation) {
      if (started !== undefined) { started.connection.close(); await this.processes.stop(started.holder, record); }
      return false;
    }
    if (started === undefined) return undefined;
    await this.adopt(record, live, started);
    if (await reported) { if (await this.grantAccess(record, live)) await this.noteUnreachableModels(record, live); }
    else if (record.lifecycle === 'starting') await this.fail(record, live, live.refusal ?? 'Its process did not report in after starting.', true);
    return true;
  }

  /**
   * Reconnect to the processes of the live Agents this console drove before it restarted (ADR
   * 0016): each holder replays the lines read since the Agent's last idle point, so a Turn in
   * flight completes. An Agent whose process is gone is Exited. One with no process (Exited,
   * failed, or launched by a console that stopped before it reported in) shows its stderr again.
   */
  async reattach(): Promise<void> {
    await Promise.all((await this.load()).filter(record => record.holder !== undefined && !this.live.has(record.id)).map(async record => {
      const live = this.idle();
      this.live.set(record.id, live);
      live.resyncing = record.lifecycle === 'live';
      if (record.lifecycle !== 'live') {
        // only a live process this console reattaches to keeps its console token
        delete record.access;
        if (record.lifecycle === 'starting') record.lifecycle = 'exited';
        await this.save();
        await this.readStderr(record, live);
        return;
      }
      const generation = live.generation += 1;
      // a deploy may have moved the pin on under it: it restarts on the pinned version once idle
      const pinned = structuredAdapterFor(record.kind)?.pinned()?.version;
      live.offPin = record.version !== undefined && pinned !== undefined && record.version !== pinned;
      const attached = await this.processes.attach(record.holder!, record.kind, event => this.observe(record, live, generation, event)).catch(() => undefined);
      if (this.live.get(record.id) !== live || live.generation !== generation) { attached?.connection.close(); return; }
      if (attached === undefined) {
        record.lifecycle = 'exited';
        delete record.access;
        await this.save();
        await this.readStderr(record, live);
        return;
      }
      await this.adopt(record, live, attached);
      // its state may have arrived before it was adopted
      this.restartOffPin(record, live);
      // lines the holder could no longer replay may have held a question, which then waits unseen
      if ((attached.dropped ?? 0) > 0) this.notice(live, `The console missed ${attached.dropped} lines of this Agent's output while it restarted. If a question was asked then, it is waiting unseen: cancel the Turn if it does not finish.`, 'warning');
    }));
  }

  // drive the Agent through a process it started or reattached to
  private async adopt(record: StructuredRecord, live: Live, process: StructuredProcess): Promise<void> {
    live.connection = process.connection;
    live.cursor = process.cursor;
    live.raw = process.raw;
    record.holder = process.holder;
    await this.save();
    this.changed(live);
  }

  // Give a Conductor's process the console's MCP access over its protocol before it goes live; one
  // whose client cannot take it fails. The token is kept nowhere else in the console, only its hash.
  private async grantAccess(record: StructuredRecord, live: Live): Promise<boolean> {
    const token = live.access;
    delete live.access;
    if (token === undefined || record.lifecycle !== 'starting') return true;
    const generation = live.generation;
    const granted = this.conductor !== undefined && await live.connection?.consoleAccess?.({ url: this.conductor.endpoint, token }).catch(() => false) === true;
    // a process that exited or was replaced meanwhile has been dealt with
    if (live.generation !== generation || record.lifecycle !== 'starting') return false;
    if (!granted) { await this.fail(record, live, 'It could not be given the console\'s tools: its kind cannot host the Conductor.', true); return false; }
    record.lifecycle = 'live';
    this.idlePoint(record, live);
    this.changed(live);
    return true;
  }

  // restart an Agent whose process runs another version than the pin, once it is idle, on its Conversation
  private restartOffPin(record: StructuredRecord, live: Live): void {
    if (live.offPin !== true || live.connection === undefined || live.resyncing === true || live.working || live.busy || live.questions.length > 0) return;
    live.offPin = false;
    void this.relaunch(record, live, record.conversationId).catch(error => { console.error(`[structured] ${record.id} could not restart on the pinned version:`, error); });
  }

  // where a restarted console would reconnect from: the lines read through this idle point
  private idlePoint(record: StructuredRecord, live: Live): void {
    if (record.holder !== undefined && live.cursor !== undefined) record.holder = { ...record.holder, read: live.cursor() };
    void this.save();
  }

  // what this console knows of an Agent it has no process for yet
  private idle(): Live {
    return { generation: 0, working: false, busy: false, questions: [], steers: [], offers: 0, transcript: [], revision: 0, status: new Map(), noticeCount: 0, notices: [] };
  }


  /**
   * Deliver a prompt as a Turn: only to a live Agent that is not already working (`busy` until
   * then, as is one not live). A prompt from the queue is marked so in the transcript.
   */
  async deliver(id: string, prompt: string, { queued = false, label }: { queued?: boolean; label?: PromptLabel } = {}): Promise<Delivery | undefined> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    if (record === undefined) return undefined;
    const live = this.live.get(id);
    if (record.lifecycle !== 'live' || live?.connection === undefined || live.working || live.busy || live.resyncing === true) return 'busy';
    live.busy = true;
    live.queuedNext = queued;
    live.labelNext = label;
    // the Turn this prompt starts settles afresh, and an offered draft is spent
    live.turn = undefined;
    live.draft = undefined;
    try {
      const connection = live.connection;
      const delivery = await connection.deliver(prompt);
      if (delivery !== 'started') { live.queuedNext = undefined; live.labelNext = undefined; }
      // a process that went with the prompt unanswered refused nothing: the queue waits for a resume
      return delivery === 'refused' && live.connection !== connection ? 'busy' : delivery;
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
      const delivery = await this.deliver(id, prompt, { queued: options.waited === true, ...(options.sender?.label === undefined ? {} : { label: options.sender.label }) });
      if (delivery === undefined) return { status: 'refused' };
      if (delivery === 'busy') return { status: 'busy' };
      return delivery === 'refused' ? { status: 'held' } : { status: 'submitted', instant: delivery === 'handled', prompt };
    },
    observe: async agent => {
      const live = this.live.get(agent.id);
      return live?.working === true ? { type: 'started', mark: {} } : live?.turn;
    },
    // work the queue adopted while a reattached Agent resynced ended without a Turn: release it
    externalReset: async id => { const live = this.live.get(id); return live !== undefined && !live.working && live.resyncing !== true; },
    // after a console restart, the answer to a prompt whose Turn settled once the console reattached
    recoverAnswer: async (id, entries) => {
      const live = this.live.get(id);
      if (live?.resyncing === true) return 'pending';
      const entry = live?.turn?.type === 'settled' ? entries.find(candidate => candidate.answer === undefined && candidate.text === live.prompt) : undefined;
      return entry === undefined || live?.turn?.type !== 'settled' ? 'settled' : { entryId: entry.id, text: live.turn.message };
    },
    clearDraft: async () => true,
    answer: async (id, questionId, answer) => await this.answer(id, questionId, answer),
    // a working Agent's latest answer may be partial, so none is given until its Turn ends
    latestAnswer: async id => this.live.get(id)?.working === true ? undefined : this.live.get(id)?.transcript.filter((item): item is Extract<TranscriptItem, { kind: 'message' }> => item.kind === 'message' && item.role === 'assistant').at(-1)?.text,
    recentLines: async (id, rows) => {
      if (!await this.has(id)) return undefined;
      const lines = (this.live.get(id)?.transcript ?? []).flatMap(item => transcriptText(item)?.split('\n') ?? []);
      return { text: lines.slice(-rows).join('\n'), older: lines.length > rows };
    },
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
    // the Conductor runs on its configured model
    if (record?.role === 'conductor') return 'refused';
    return await this.whileIdle(id, async ({ live, connection }) => {
      const previous = live.model;
      const effort = setting.effort ?? entry?.effort ?? previous?.effort;
      if (!await connection.setModel({ model: setting.model, ...(effort === undefined ? {} : { effort }) })) return false;
      const now = live.model?.effort ?? effort;
      this.notice(live, previous?.model === setting.model ? `Effort → ${now}` : `Model → ${this.modelName(live, setting.model)}, effort ${now}`);
      return true;
    });
  }

  /**
   * Close an Agent: stop its process, remove its holder and forget it. The Conductor is closed only
   * when it is `retired` (its configuration removed), never by an operation on Agents.
   */
  async close(id: string, { retired = false } = {}): Promise<boolean> {
    const records = await this.load();
    const record = records.find(candidate => candidate.id === id);
    if (record === undefined || record.role === 'conductor' && !retired) return false;
    // nothing is stopped or forgotten until the Close is recorded: an Agent whose Close cannot be
    // written stays, its queue with it
    const index = records.indexOf(record);
    records.splice(index, 1);
    if (!await this.save()) {
      records.splice(index, 0, record);
      throw new Error(`The Agent could not be closed: ${this.file} could not be written.`);
    }
    this.live.get(id)?.connection?.close();
    this.live.delete(id);
    if (record.holder !== undefined) await this.processes.stop(record.holder, record);
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
      const lifecycle = record.lifecycle;
      const current = live?.model;
      const name = current === undefined ? undefined : live?.models?.find(model => model.id === current.model)?.name;
      const questions = (live?.questions ?? []).map(shaped);
      // one resyncing after a reattach may be working: nothing takes it to have finished
      const attention = questions.length > 0 ? 'question' : live?.working === true || live?.resyncing === true ? 'working' : 'finished';
      const model = current === undefined ? undefined : { id: current.model, ...(name === undefined ? {} : { name }), ...(current.effort === undefined ? {} : { effort: current.effort }) };
      return { id: record.id, transport: 'structured', panel: agentPanel('structured'), home: record.home, title: '', kind: record.kind, attention, placeId: record.placeId, ...(record.sandboxed ? { sandboxed: true } : {}), ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }), ...(questions[0] === undefined ? {} : { question: questions[0] }), structured: { lifecycle, ...(record.role === undefined ? {} : { role: record.role }), ...(typeof record.origin === 'object' ? { spawnedBy: record.origin.conductor } : {}), ...(record.reason === undefined ? {} : { reason: record.reason }), revision: live?.revision ?? 0, ...(model === undefined ? {} : { model }), switchable: record.role === undefined && this.allowed(record.kind).length > 0, ...(questions.length === 0 ? {} : { questions }), ...(live === undefined || live.steers.length === 0 ? {} : { steers: live.steers }), ...(live?.draft === undefined ? {} : { draft: live.draft }) } };
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

  /** The latest lines between the console and the Agent's process (Raw events), oldest first. */
  async rawEvents(id: string): Promise<readonly RawLine[] | undefined> {
    // a console token sent to the process is never shown
    return await this.has(id) ? (this.live.get(id)?.raw?.() ?? []).map(({ from, line }) => ({ from, line: line.replace(consoleTokenPattern, `${consoleTokenPrefix}[redacted]`) })) : undefined;
  }

  /** What the Agent's holder window shows (its process's stderr), and its tmux pane. */
  async holderWindow(id: string): Promise<{ pane: string; text: string } | undefined> {
    const holder = (await this.load()).find(record => record.id === id)?.holder;
    if (holder === undefined) return undefined;
    return { pane: holder.pane, text: await this.processes.stderr(holder, 500).catch(() => undefined) ?? '' };
  }

  /** One transcript item in full, with a tool call's whole output and a script's source. */
  async transcriptItem(id: string, itemId: string): Promise<TranscriptItem | undefined> {
    if (!await this.has(id)) return undefined;
    return this.live.get(id)?.transcript.find(item => item.id === itemId);
  }

  private observe(record: StructuredRecord, live: Live, generation: number, event: StructuredEvent): void {
    if (this.live.get(record.id) !== live || live.generation !== generation) return;
    switch (event.type) {
      case 'report':
        if (record.lifecycle !== 'starting' || event.report.nonce !== live.nonce) return;
        // a Sandboxed Agent whose sandbox did not arm never runs (ADR 0004)
        if (record.sandboxed && !event.report.sandbox.engaged) {
          live.refusal = `Its sandbox did not start: ${event.report.sandbox.reason ?? 'no reason given'}`;
          // nothing else may report this process in
          delete live.nonce;
          live.reported?.(false);
          return;
        }
        record.version = event.report.version;
        // a Conductor goes live once it holds the console's access
        if (record.role !== 'conductor') { record.lifecycle = 'live'; this.idlePoint(record, live); }
        live.reported?.(true);
        break;
      case 'conversation':
        // the console's own notices belong to the Conversation they were made in
        if (record.conversationId !== undefined && record.conversationId !== event.id) live.notices = [];
        record.conversationId = event.id;
        live.conversationName = event.name;
        live.resyncing = false;
        void this.save();
        this.restartOffPin(record, live);
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
        if (event.turn.type !== 'started') { live.turn = event.turn; live.resyncing = false; this.endScripts(live); this.idlePoint(record, live); this.restartOffPin(record, live); }
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
        if (item.kind === 'message' && item.role === 'user' && item.steer !== true) {
          live.prompt = item.text;
          if (live.queuedNext === true) item = { ...item, queued: true };
          if (live.labelNext !== undefined) item = { ...item, label: live.labelNext };
          live.queuedNext = undefined;
          live.labelNext = undefined;
        }
        if (item.kind === 'tool' && item.source !== undefined && item.parentId === undefined) this.watchScript(record, live, item);
        const index = live.transcript.findIndex(candidate => candidate.id === item.id);
        if (index === -1) live.transcript.push(item); else live.transcript[index] = item;
        live.transcript.splice(0, live.transcript.length - maxTranscriptItems);
        break;
      }
      case 'history':
        // a history (loaded on a launch or a Conversation change) replaces the transcript, but not the
        // notices the console made for this Conversation since
        live.transcript = [...event.items, ...live.notices].slice(-maxTranscriptItems);
        live.prompt = event.items.filter((item): item is Extract<TranscriptItem, { kind: 'message' }> => item.kind === 'message' && item.role === 'user' && item.steer !== true).at(-1)?.text;
        break;
      case 'status':
        if (event.text === undefined) live.status.delete(event.key); else live.status.set(event.key, event.text);
        break;
      case 'usage':
        live.usage = event.usage;
        break;
      case 'exited':
        this.processExited(record, live);
        if (record.lifecycle === 'starting') { void this.fail(record, live, 'Its process exited before reporting in.'); return; }
        if (record.lifecycle === 'live') { record.lifecycle = 'exited'; void this.save(); void this.readStderr(record, live); }
        break;
    }
    this.changed(live);
  }

  // A Conductor's script that runs past its deadline cancels its Turn, which the transcript says.
  // Sandbox dialogs it waits on count against the time.
  private watchScript(record: StructuredRecord, live: Live, script: TranscriptTool): void {
    const deadline = record.role === 'conductor' ? this.conductor?.scriptDeadlineMs : undefined;
    if (deadline === undefined) return;
    const timers = live.scripts ??= new Map();
    if (script.state !== 'running') { clearTimeout(timers.get(script.id)); timers.delete(script.id); return; }
    if (timers.has(script.id)) return;
    timers.set(script.id, setTimeout(() => {
      timers.delete(script.id);
      const shown = live.transcript.find(item => item.id === script.id);
      if (this.live.get(record.id) !== live || shown?.kind !== 'tool' || shown.state !== 'running') return;
      this.notice(live, `A script ran past its ${Math.round(deadline / 60_000)}-minute deadline, so its Turn was cancelled.`, 'warning');
      void this.interrupt(record.id).catch(() => undefined);
    }, deadline));
  }

  // an Agent's process is gone: a Turn in flight ends failed, the queue waits for a resume, and
  // the console token the process held works no more
  private processExited(record: StructuredRecord, live: Live): void {
    if (live.working) live.transcript.push({ id: `exited-${live.revision}`, kind: 'settled', outcome: 'failed' });
    live.turn = { type: 'exited' };
    live.working = false;
    live.questions = [];
    live.steers = [];
    live.connection = undefined;
    live.status.clear();
    live.reported?.(false);
    delete record.access;
    delete live.access;
    this.endScripts(live);
  }

  // a Turn's end ends its scripts' deadlines
  private endScripts(live: Live): void {
    for (const timer of live.scripts?.values() ?? []) clearTimeout(timer);
    live.scripts?.clear();
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

  // keep what the Agent's holder window shows of its process: its stderr, once it failed or exited
  private async readStderr(record: StructuredRecord, live: Live): Promise<void> {
    const stderr = record.holder === undefined ? undefined : await this.processes.stderr(record.holder).catch(() => undefined);
    if (stderr === undefined) return;
    live.stderr = stderr;
    this.changed(live);
  }

  // mark the Agent failed with its stderr; a process still running unheard is stopped, its stderr kept
  private async fail(record: StructuredRecord, live: Live, reason: string, stop = false): Promise<void> {
    record.lifecycle = 'failed';
    record.reason = reason;
    delete record.access;
    await this.readStderr(record, live);
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
    await setAside(this.file, 'structured');
    return [];
  }

  // write the records in order, each write replacing the file whole
  // (whether it was written, which a caller that must not go on without it checks)
  private save(): Promise<boolean> {
    const write = this.mutation.then(async () => {
      const records = await this.load();
      await mkdir(dirname(this.file), { recursive: true });
      const next = `${this.file}.next`;
      await writeFile(next, JSON.stringify(records), { mode: 0o600 });
      await rename(next, this.file);
    });
    this.mutation = write.catch(error => { console.error(`[structured] ${this.file} could not be written:`, error instanceof Error ? error.message : error); });
    return write.then(() => true, () => false);
  }
}

// an answer the question's field takes: one of its choices, text as a prompt would be for a text field, or dismissing it
const answerFits = (question: StructuredQuestion, answer: QuestionAnswer): boolean => typeof answer === 'object'
  || (question.field.kind === 'choice' ? Number.isInteger(answer) && (answer as number) >= 0 && (answer as number) < question.field.choices.length : typeof answer === 'string' && validPrompt(answer));
