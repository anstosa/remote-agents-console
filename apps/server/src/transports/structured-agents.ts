import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { structuredAdapterFor } from '../adapters/registry.js';
import type { AdapterConfigs, AgentKind } from '../adapters/types.js';
import type { Agent, AgentLifecycle } from '../domain/models.js';
import type { Place } from '../places/places.js';
import { serverCheckout } from '../workspaces/server-checkout.js';
import { connectHolder, type Delivery, type StructuredEvent, type StructuredSession, type TranscriptItem } from './structured.js';
import { agentPanel } from './transport.js';

/** Where a structured Agent's process runs: its holder's socket and tmux window (ADR 0016). */
export type HolderRef = { socket: string; window: string; pane: string; tmuxSocket?: string };
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
  start(launch: StructuredLaunch, emit: (event: StructuredEvent) => void): Promise<{ session: StructuredSession; holder: HolderRef } | undefined>;
  /** The process's recent stderr, shown when it fails. */
  stderr(holder: HolderRef): Promise<string | undefined>;
  /** Stop the process and remove its holder. */
  stop(holder: HolderRef): Promise<void>;
}
/** Opens, reads and removes holder windows in a Place's Workspace session. */
export interface HolderWindows {
  openHolderWindow(place: Place, agentId: string, argv: string[], env: Record<string, string>, setup?: string): Promise<HolderRef | undefined>;
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
      const holder = await windows.openHolderWindow(place, id, [configured.program, ...spec.args, ...configured.args], { ...spec.env, ...configured.env }, configured.setup);
      if (holder === undefined) return undefined;
      const connected = await connectHolder(holder.socket);
      if (connected === undefined) { await windows.closeHolder(holder); return undefined; }
      return { holder, session: adapter.client(connected.channel, emit) };
    },
    stderr: holder => windows.captureHolder(holder),
    stop: holder => windows.closeHolder(holder)
  };
}

// the console's view of one structured Agent's process while this console drives it
type Driven = { session?: StructuredSession; working: boolean; delivering: boolean; transcript: TranscriptItem[]; revision: number; stderr?: string; reported?: (reported: boolean) => void };
const maxTranscriptItems = 2_000;
const isRecord = (value: unknown): value is StructuredRecord => typeof value === 'object' && value !== null && typeof (value as StructuredRecord).id === 'string' && typeof (value as StructuredRecord).kind === 'string' && typeof (value as StructuredRecord).placeId === 'string' && typeof (value as StructuredRecord).home === 'string';

/**
 * The structured Agents (ADR 0015): each gets a console-minted id and a stored record, is
 * recorded at its Place, and is driven through its protocol client. Nothing is delivered before
 * its launch report arrives; without one the Agent is failed, with its stderr. Its Attention is
 * working from a Turn's start to its settling, finished otherwise.
 */
export class StructuredAgents {
  private readonly file: string;
  private records?: Promise<StructuredRecord[]>;
  private readonly driven = new Map<string, Driven>();
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
    const driven: Driven = { working: false, delivering: false, transcript: [], revision: 0 };
    const reported = new Promise<boolean>(resolve => {
      driven.reported = resolve;
      setTimeout(() => resolve(false), this.options.reportTimeoutMs ?? 30_000).unref();
    });
    records.push(record);
    this.driven.set(record.id, driven);
    const started = await this.processes.start({ id: record.id, kind, place }, event => this.observe(record, driven, event)).catch(() => undefined);
    if (started === undefined) {
      records.splice(records.indexOf(record), 1);
      this.driven.delete(record.id);
      return false;
    }
    driven.session = started.session;
    record.holder = started.holder;
    await this.save();
    this.changed(driven);
    if (!await reported && record.lifecycle === 'starting') await this.fail(record, driven, 'Its process did not report in after starting.');
    return true;
  }

  /** Deliver a prompt as a Turn: only to a live Agent that is not already working. */
  async deliver(id: string, prompt: string): Promise<Delivery | undefined> {
    const record = (await this.load()).find(candidate => candidate.id === id);
    if (record === undefined) return undefined;
    const driven = this.driven.get(id);
    if (record.lifecycle !== 'live' || driven?.session === undefined || driven.working || driven.delivering) return 'refused';
    driven.delivering = true;
    try { return await driven.session.deliver(prompt); } finally { driven.delivering = false; }
  }

  /** Close an Agent: stop its process, remove its holder and forget it. */
  async close(id: string): Promise<boolean> {
    const records = await this.load();
    const record = records.find(candidate => candidate.id === id);
    if (record === undefined) return false;
    const driven = this.driven.get(id);
    driven?.session?.close();
    if (record.holder !== undefined) await this.processes.stop(record.holder);
    records.splice(records.indexOf(record), 1);
    this.driven.delete(id);
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
      const driven = this.driven.get(record.id);
      // an Agent this console never connected to has no process it can drive
      const lifecycle: AgentLifecycle = driven === undefined && (record.lifecycle === 'starting' || record.lifecycle === 'live') ? 'exited' : record.lifecycle;
      return { id: record.id, transport: 'structured', panel: agentPanel('structured'), home: record.home, title: '', kind: record.kind, attention: driven?.working === true ? 'working' : 'finished', placeId: record.placeId, ...(record.sandboxed ? { sandboxed: true } : {}), ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }), structured: { lifecycle, ...(record.reason === undefined ? {} : { reason: record.reason }), revision: driven?.revision ?? 0 } };
    });
  }

  /** What an Agent's transcript Panel shows: its items, and its stderr once it failed. */
  async transcript(id: string): Promise<{ items: TranscriptItem[]; stderr?: string } | undefined> {
    if (!await this.has(id)) return undefined;
    const driven = this.driven.get(id);
    return { items: driven?.transcript ?? [], ...(driven?.stderr === undefined ? {} : { stderr: driven.stderr }) };
  }

  private observe(record: StructuredRecord, driven: Driven, event: StructuredEvent): void {
    if (this.driven.get(record.id) !== driven) return;
    switch (event.type) {
      case 'report':
        if (record.lifecycle !== 'starting') return;
        record.lifecycle = 'live';
        driven.reported?.(true);
        void this.save();
        break;
      case 'conversation':
        record.conversationId = event.id;
        void this.save();
        break;
      case 'turn':
        driven.working = event.turn.type === 'started';
        break;
      case 'transcript': {
        const index = driven.transcript.findIndex(item => item.id === event.item.id);
        if (index === -1) driven.transcript.push(event.item); else driven.transcript[index] = event.item;
        driven.transcript.splice(0, driven.transcript.length - maxTranscriptItems);
        break;
      }
      case 'exited':
        driven.working = false;
        driven.session = undefined;
        driven.reported?.(false);
        if (record.lifecycle === 'starting') { void this.fail(record, driven, 'Its process exited before reporting in.'); return; }
        if (record.lifecycle === 'live') { record.lifecycle = 'exited'; void this.save(); }
        break;
    }
    this.changed(driven);
  }

  private async fail(record: StructuredRecord, driven: Driven, reason: string): Promise<void> {
    record.lifecycle = 'failed';
    record.reason = reason;
    const stderr = record.holder === undefined ? undefined : await this.processes.stderr(record.holder).catch(() => undefined);
    if (stderr !== undefined) driven.stderr = stderr;
    await this.save();
    this.changed(driven);
  }

  private changed(driven?: Driven): void {
    if (driven !== undefined) driven.revision += 1;
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
    if (Array.isArray(parsed) && parsed.every(isRecord)) return parsed;
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
