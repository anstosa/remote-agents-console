import { readFile, readdir } from 'node:fs/promises';
import { recognizeProcess } from '../adapters/registry.js';
import type { AgentKind } from '../adapters/types.js';
import { parseProcStat, sameLiveProcStat, type ProcStat } from '../domain/proc-stat.js';
// srt/bwrap are the sandbox wrappers; an agent found beneath one is `wrapped`.
const sandboxWrapper = /^(?:bwrap|srt)$/u;

export type HostProcess = { pid: number; parentPid: number; startTime: string; comm: string; cmdline: string };
export interface HostProcessInspector { listProcesses(): Promise<HostProcess[]>; }

// One recognised agent beneath a pane: its kind, its own pid, and whether a
// bwrap/srt sandbox wrapper was seen on the way to it (a generic cross-check).
export type RecognizedAgent = { kind: AgentKind; pid: number; startTime?: string; wrapped: boolean };

export type RecognitionOptions = { reusePositive?: boolean };
export interface ProcessInspector { recognizeAgent(pid: number, options?: RecognitionOptions): Promise<RecognizedAgent | undefined>; }
type ProcessCommand = Pick<HostProcess, 'pid' | 'comm' | 'cmdline'> & { stat?: ProcStat };
type Recognition = { agent?: RecognizedAgent; path?: HostProcess[] };
type CachedRecognition = { agent: RecognizedAgent; path: HostProcess[]; expiresAt: number };
export class ProcInspector implements ProcessInspector {
  private readonly procRoot = process.env.RAC_HOST_PROC ?? '/proc';
  private readonly established = new Map<number, CachedRecognition>();
  private readonly recognizing = new Map<number, Promise<RecognizedAgent | undefined>>();
  // off-path competitors require a full walk, even while the known lineage survives
  private static readonly recognitionTtlMs = 2_000;
  private static readonly maxEstablishedRoots = 512;

  // only polling callers opt in; lifecycle and cleanup reads stay fresh by default
  async recognizeAgent(root: number, options: RecognitionOptions = {}): Promise<RecognizedAgent | undefined> {
    // invalidate both cached and pending publications before a lifecycle scan
    if (!options.reusePositive) {
      this.established.delete(root);
      this.recognizing.delete(root);
      return (await this.walk(root)).agent;
    }
    const pending = this.recognizing.get(root);
    // share concurrent polling reads without delaying a fresh caller
    if (pending !== undefined) return pending;
    const lookup = this.reuseOrWalk(root).then(({ agent, cached }) => {
      // fresh reads supersede older publications; expired results stay uncached
      if (cached !== undefined && cached.expiresAt > Date.now() && this.recognizing.get(root) === lookup) {
        // refresh recency without extending the full-scan deadline
        this.established.set(root, cached);
        // bound short-lived roots even within one expiry window
        while (this.established.size > ProcInspector.maxEstablishedRoots) this.established.delete(this.established.keys().next().value!);
      }
      return agent;
    }).finally(() => {
      // an older completion must not release a newer lookup
      if (this.recognizing.get(root) === lookup) this.recognizing.delete(root);
    });
    this.recognizing.set(root, lookup);
    return lookup;
  }

  // validate only the established path between periodic full tree walks
  private async reuseOrWalk(root: number): Promise<{ agent?: RecognizedAgent; cached?: CachedRecognition }> {
    const cached = this.established.get(root);
    this.established.delete(root);
    // expiry is fixed at full-scan completion rather than extended on cache hits
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      const valid = await this.recheckCachedPath(cached.path);
      // slow validation cannot extend expiry
      if (valid && cached.expiresAt > Date.now()) return { agent: cached.agent, cached };
    }
    const { agent, path } = await this.walk(root);
    // never cache absence: an unchanged shell may launch an agent at any moment
    if (agent === undefined) return {};
    // uncached recognition covers restricted mounts and direct agents
    if (path === undefined || path.length === 1) return { agent };
    return { agent, cached: { agent, path, expiresAt: Date.now() + ProcInspector.recognitionTtlMs } };
  }

  // read one optional proc identity without losing dashboard-only discovery
  private async readStat(pid: number): Promise<ProcStat | undefined> {
    const raw = await readFile(`${this.procRoot}/${pid}/stat`, 'utf8').catch(() => undefined);
    return raw === undefined ? undefined : parseProcStat(raw, pid);
  }

  // compare exact cache identities and bracket argv reads across the lineage
  private async recheckCachedPath(path: HostProcess[]): Promise<boolean> {
    try {
      const observed: ProcessCommand[] = [];
      // read only the cached path, not siblings
      for (const node of path) {
        const stat = await this.readStat(node.pid);
        // reject pid reuse, exit, reparenting or an obvious exec before reading argv
        if (stat === undefined || !sameLiveProcStat({ ...node, live: true }, stat)) return false;
        const cmdline = await readFile(`${this.procRoot}/${node.pid}/cmdline`, 'utf8');
        // argv matters for adapter precedence even if comm has not changed
        if (cmdline !== node.cmdline) return false;
        observed.push({ ...node, stat });
      }
      return Array.isArray(await this.identifyPath(observed));
    } catch { return false; /* exited or unreadable identities are not reusable */ }
  }

  // distinguish an inaccessible lifetime from a contradicted snapshot
  private async identifyPath(path: ProcessCommand[]): Promise<HostProcess[] | 'unproven' | undefined> {
    const proven: HostProcess[] = [];
    // close the lineage only after reading all commands along it
    for (const [index, node] of path.entries()) {
      const after = await this.readStat(node.pid);
      // without either stat read, the command is only dashboard evidence
      if (node.stat === undefined && after === undefined) continue;
      // discard torn snapshots rather than attributing old metadata to a new lifetime
      if (node.stat === undefined || after === undefined || !sameLiveProcStat(node.stat, after) || (index > 0 && after.parentPid !== path[index - 1]!.pid)) return undefined;
      proven.push({ pid: node.pid, comm: node.comm, cmdline: node.cmdline, parentPid: after.parentPid, startTime: after.startTime });
    }
    return proven.length === path.length ? proven : 'unproven';
  }

  // walk one pane tree, asking every registered Adapter (registry order) per process
  private async walk(root: number): Promise<Recognition> {
    // carry wrapper-ancestry per path, so `wrapped` reflects this agent's own ancestors, not a sibling branch's
    const pending: Array<{ pid: number; wrappedAbove: boolean; path: ProcessCommand[] }> = [{ pid: root, wrappedAbove: false, path: [] }];
    const seen = new Set<number>();
    // retain the existing traversal bound and stack order
    while (pending.length && seen.size < 256) {
      const { pid, wrappedAbove, path } = pending.pop()!;
      // skip duplicate descendants and cycles
      if (seen.has(pid)) continue;
      seen.add(pid);
      try {
        const stat = await this.readStat(pid);
        // dead processes cannot represent a live dashboard agent
        if (stat?.live === false) continue;
        const comm = stat?.comm ?? (await readFile(`${this.procRoot}/${pid}/comm`, 'utf8')).trim();
        const cmdline = await readFile(`${this.procRoot}/${pid}/cmdline`, 'utf8');
        const adapter = recognizeProcess({ comm, argv: cmdline.split('\0').filter(Boolean) });
        const lineage = [...path, { pid, comm, cmdline, stat }];
        // keep the command evidence only along the winning ancestor path
        if (adapter !== undefined) {
          const identified = await this.identifyPath(lineage);
          // continue to other candidates if the observed lineage changed
          if (identified === undefined) continue;
          const agent = { kind: adapter.kind, pid, wrapped: wrappedAbove };
          // publish a lifetime only when both reads prove a coherent path
          if (identified === 'unproven') return { agent };
          return { agent: { ...agent, startTime: identified.at(-1)!.startTime }, path: identified };
        }
        const wrappedBelow = wrappedAbove || sandboxWrapper.test(comm);
        const children = (await readFile(`${this.procRoot}/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
        // descendants share their already-read ancestor commands
        for (const child of children) {
          // ignore malformed child ids
          if (Number.isInteger(child) && child > 0) pending.push({ pid: child, wrappedAbove: wrappedBelow, path: lineage });
        }
      } catch { /* exited/unreadable is not an agent */ }
    }
    return {};
  }

  async listProcesses(): Promise<HostProcess[]> {
    const entries = await readdir(this.procRoot, { withFileTypes: true }).catch(() => []);
    const processes: HostProcess[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      const pid = Number(entry.name);
      try {
        const [comm, cmdline, stat] = await Promise.all([
          readFile(`${this.procRoot}/${pid}/comm`, 'utf8'),
          readFile(`${this.procRoot}/${pid}/cmdline`, 'utf8'),
          readFile(`${this.procRoot}/${pid}/stat`, 'utf8')
        ]);
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
        const parentPid = Number(fields[1]);
        const startTime = fields[19];
        if (Number.isInteger(parentPid) && parentPid >= 0 && startTime) processes.push({ pid, parentPid, startTime, comm: comm.trim(), cmdline });
      } catch { /* exited or unreadable */ }
    }
    return processes;
  }
}
export async function tmuxServerPids(uid: number): Promise<number[]> { const procRoot = process.env.RAC_HOST_PROC ?? '/proc'; const entries = await readdir(procRoot, { withFileTypes: true }); const found: number[] = []; for (const entry of entries) { if (!/^\d+$/.test(entry.name)) continue; try { const status = await readFile(`${procRoot}/${entry.name}/status`, 'utf8'); if (!new RegExp(`^Uid:\\s+${uid}\\b`, 'm').test(status)) continue; const cmd = await readFile(`${procRoot}/${entry.name}/cmdline`, 'utf8'); if (/\btmux(?::|\0).*server|tmux: server/.test(cmd)) found.push(Number(entry.name)); } catch { } } return found; }
