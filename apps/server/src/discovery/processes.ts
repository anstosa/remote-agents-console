import { readFile, readdir } from 'node:fs/promises';
import { recognizeProcess } from '../adapters/registry.js';
import type { AgentKind } from '../adapters/types.js';
// srt/bwrap are the sandbox wrappers; an agent found beneath one is `wrapped`.
const sandboxWrapper = /^(?:bwrap|srt)$/u;

export type HostProcess = { pid: number; parentPid: number; startTime: string; comm: string; cmdline: string };
export interface HostProcessInspector { listProcesses(): Promise<HostProcess[]>; }

// One recognised agent beneath a pane: its kind, its own pid, and whether a
// bwrap/srt sandbox wrapper was seen on the way to it (a generic cross-check).
export type RecognizedAgent = { kind: AgentKind; pid: number; startTime?: string; wrapped: boolean };

export type RecognitionOptions = { reusePositive?: boolean };
export interface ProcessInspector { recognizeAgent(pid: number, options?: RecognitionOptions): Promise<RecognizedAgent | undefined>; }
type ProcessCommand = Pick<HostProcess, 'pid' | 'comm' | 'cmdline'>;
type Recognition = { agent?: RecognizedAgent; path: ProcessCommand[] };
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
      const path = await this.identifyPath(cached.path);
      // slow validation cannot extend expiry; lifetime and parent identity must still match
      if (cached.expiresAt > Date.now() && path?.every((node, index) => node.startTime === cached.path[index]!.startTime && node.parentPid === cached.path[index]!.parentPid)) return { agent: cached.agent, cached };
    }
    const { agent, path } = await this.walk(root);
    // never cache absence: an unchanged shell may launch an agent at any moment
    if (agent === undefined) return {};
    // a direct agent already needs only two reads and has no descendant walk to avoid
    if (path.length === 1) return { agent };
    const identified = await this.identifyPath(path, false);
    // restricted proc mounts still support ordinary uncached recognition
    if (identified === undefined) return { agent };
    return { agent, cached: { agent, path: identified, expiresAt: Date.now() + ProcInspector.recognitionTtlMs } };
  }

  // stat supplies comm and lifetime; cache hits also recheck argv for exec changes
  private async identifyPath(path: ProcessCommand[], recheckCommands = true): Promise<HostProcess[] | undefined> {
    try {
      const result: HostProcess[] = [];
      // bound each lineage to at most two in-flight proc reads
      for (const observed of path) {
        const { pid, cmdline: observedCommand } = observed;
        const [stat, cmdline] = await Promise.all([
          readFile(`${this.procRoot}/${pid}/stat`, 'utf8'),
          // the initial walk already read argv; do not pay for that read twice
          recheckCommands ? readFile(`${this.procRoot}/${pid}/cmdline`, 'utf8') : observedCommand
        ]);
        const open = stat.indexOf('(');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).trim().split(/\s+/u);
        const parentPid = Number(fields[1]);
        const startTime = fields[19];
        // fail closed when proc cannot establish a live process identity
        if (open < 0 || close <= open || Number(stat.slice(0, open).trim()) !== pid || !Number.isInteger(parentPid) || parentPid < 0 || startTime === undefined || !/^\d+$/u.test(startTime) || fields[0] === 'Z' || fields[0] === 'X') return undefined;
        const node = { pid, parentPid, startTime, comm: stat.slice(open + 1, close).trim(), cmdline };
        const parent = result.at(-1);
        // preserve both top-down adapter precedence and path-local wrapper recognition
        if (node.comm !== observed.comm || node.cmdline !== observed.cmdline || (parent !== undefined && node.parentPid !== parent.pid)) return undefined;
        result.push(node);
      }
      return result;
    } catch { return undefined; /* exited or unreadable identities are not reusable */ }
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
        const comm = (await readFile(`${this.procRoot}/${pid}/comm`, 'utf8')).trim();
        const cmdline = await readFile(`${this.procRoot}/${pid}/cmdline`, 'utf8');
        const adapter = recognizeProcess({ comm, argv: cmdline.split('\0').filter(Boolean) });
        const lineage = [...path, { pid, comm, cmdline }];
        // keep the command evidence only along the winning ancestor path
        if (adapter !== undefined) {
          const rawStat = await readFile(`${this.procRoot}/${pid}/stat`, 'utf8').catch(() => undefined);
          const fields = rawStat?.slice(rawStat.lastIndexOf(')') + 2).trim().split(/\s+/u);
          const startTime = fields?.[19];
          // retain reply identity when proc exposes a valid lifetime, without weakening dashboard recognition
          return { agent: { kind: adapter.kind, pid, ...(startTime !== undefined && /^\d+$/u.test(startTime) ? { startTime } : {}), wrapped: wrappedAbove }, path: lineage };
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
    return { path: [] };
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
