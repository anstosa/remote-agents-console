import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { structuredAdapterFor } from '../adapters/registry.js';
import type { AdapterConfigs, AgentKind } from '../adapters/types.js';
import type { Agent, AgentLifecycle } from '../domain/models.js';
import type { Place } from '../places/places.js';
import { expandCommand } from '../launch/service.js';
import { run } from '../tmux/command.js';
import { serverCheckout } from '../workspaces/server-checkout.js';
import { connectHolder, type Delivery, type StructuredConnection, type AgentUsage, type StructuredEvent, type TranscriptItem, type TranscriptTool } from './structured.js';
import { agentPanel } from './transport.js';

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
/** What a launch starts: one process of `kind` at `place`, for the Agent `id`. */
export type StructuredLaunch = { id: string; kind: AgentKind; place: Place };
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
    async start({ id, kind, place }, emit) {
      const adapter = structuredAdapterFor(kind);
      const configured = configs[kind];
      if (adapter === undefined || configured?.launchable !== true) return undefined;
      const spec = adapter.launch({ mode: 'fresh', cwd: place.home, sandboxed: false });
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

// what this console knows of one structured Agent's process while it drives it
type Live = { connection?: StructuredConnection; working: boolean; delivering: boolean; transcript: TranscriptItem[]; revision: number; status: Map<string, string>; usage?: AgentUsage; queuedNext?: boolean; stderr?: string; reported?: (reported: boolean) => void };
const maxTranscriptItems = 2_000;
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

  constructor(private readonly processes: StructuredProcesses, private readonly options: { file?: string; reportTimeoutMs?: number } = {}) {
    this.file = options.file ?? join(serverCheckout(), '.data/structured-agents.json');
  }

  /** Called whenever an Agent's state or transcript changes. */
  onChange(listener: () => void): void { this.listeners.add(listener); }

  /** Launch a `kind` Agent at the Place; false when its process could not start. */
  async launch(place: Place, kind: AgentKind): Promise<boolean> {
    const records = await this.load();
    const record: StructuredRecord = { id: randomUUID(), kind, placeId: place.id, home: place.home, sandboxed: false, lifecycle: 'starting', origin: 'operator', launchedAt: Date.now() };
    const live: Live = { working: false, delivering: false, transcript: [], revision: 0, status: new Map() };
    const reported = new Promise<boolean>(resolve => {
      live.reported = resolve;
      setTimeout(() => resolve(false), this.options.reportTimeoutMs ?? 30_000).unref();
    });
    records.push(record);
    this.live.set(record.id, live);
    const started = await this.processes.start({ id: record.id, kind, place }, event => this.observe(record, live, event)).catch(() => undefined);
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
    if (!await reported && record.lifecycle === 'starting') await this.fail(record, live, 'Its process did not report in after starting.', true);
    return true;
  }

  /**
   * Deliver a prompt as a Turn: only to a live Agent that is not already working. A prompt from
   * the queue is marked so in the transcript.
   */
  async deliver(id: string, prompt: string, { queued = false } = {}): Promise<Delivery | undefined> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    if (record === undefined) return undefined;
    const live = this.live.get(id);
    if (record.lifecycle !== 'live' || live?.connection === undefined || live.working || live.delivering) return 'refused';
    live.delivering = true;
    live.queuedNext = queued;
    try {
      const delivery = await live.connection.deliver(prompt);
      if (delivery !== 'started') live.queuedNext = undefined;
      return delivery;
    } finally { live.delivering = false; }
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
      return { id: record.id, transport: 'structured', panel: agentPanel('structured'), home: record.home, title: '', kind: record.kind, attention: live?.working === true ? 'working' : 'finished', placeId: record.placeId, ...(record.sandboxed ? { sandboxed: true } : {}), ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }), structured: { lifecycle, ...(record.reason === undefined ? {} : { reason: record.reason }), revision: live?.revision ?? 0 } };
    });
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
        record.conversationId = event.id;
        void this.save();
        break;
      case 'turn':
        live.working = event.turn.type === 'started';
        break;
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
        live.transcript = event.items.slice(-maxTranscriptItems);
        break;
      case 'status':
        if (event.text === undefined) live.status.delete(event.key); else live.status.set(event.key, event.text);
        break;
      case 'usage':
        live.usage = event.usage;
        break;
      case 'exited':
        live.working = false;
        live.connection = undefined;
        live.status.clear();
        live.reported?.(false);
        if (record.lifecycle === 'starting') { void this.fail(record, live, 'Its process exited before reporting in.'); return; }
        if (record.lifecycle === 'live') { record.lifecycle = 'exited'; void this.save(); }
        break;
    }
    this.changed(live);
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
