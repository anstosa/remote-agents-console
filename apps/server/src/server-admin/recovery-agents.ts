import { randomBytes } from 'node:crypto';
import { readdir, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { codexProgramName, nodeProgramName, omxProgramName } from '../adapters/program-names.js';
import type { AgentKind } from '../adapters/types.js';
import type { AgentStopResult, HostReply, HostRequest, Installation } from '../settings/contracts.js';
import { HostSettingsTransport, settingsControlRoot } from '../settings/transport.js';
import { containerized, readBoundedText } from './recovery-proc.js';

const nodeValueFlags = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions']);
const nodeSwitches = new Set(['--no-warnings', '--enable-source-maps', '--preserve-symlinks', '--preserve-symlinks-main']);
const claudeEntry = /(?:^|\/)@anthropic-ai\/claude-code\/cli\.js$/u;
const tokenPattern = /^[A-Za-z0-9_-]{32}$/u;
const omxWorkerPath = /(?:^|\/)\.omx\/(?:team\/[^/]+\/worktrees\/worker-\d+(?:\/|$)|state\/team\/[^/]+\/runtime\/worker-\d+-startup\.sh(?:[\s'"/]|$))/u;
const codexHelpers = new Set(['app-server', 'auth', 'cloud', 'completion', 'debug', 'exec', 'features', 'login', 'logout', 'mcp', 'mcp-server', 'review', 'sandbox']);
const tokenTtlMs = 30_000;
const stopDeadlineMs = 8_000;
const maxTargets = 20;
const scanCacheMs = 1_000;

export type RecoveryAgent = { id: string; kind: Extract<AgentKind, 'codex' | 'omx' | 'claude' | 'pi'>; label: string; pid: number };
export type RecoveryAgentList = { available: boolean; canStop: boolean; agents: RecoveryAgent[]; reason?: string };
export type RecoveryAgentStopStatus = AgentStopResult['status'];
export type RecoveryAgentStopOutcome = { id: string; status: RecoveryAgentStopStatus; message?: string };
export type RecoveryAgentStopResponse = { available: boolean; canStop: boolean; results: RecoveryAgentStopOutcome[] };

type RecoveryIdentity = { pid: number; parentPid: number; startTime: string; uid: number; kind: RecoveryAgent['kind']; cwd: string; cmdline: string };
type TokenRecord = { id: string; identity: RecoveryIdentity; expiresAt: number };
type RecoveryTransport = { installation(): Promise<Installation | undefined>; request(request: HostRequest): Promise<HostReply> };
type RecoveryAgentOptions = { procRoot?: string; hostUid?: number; transport?: RecoveryTransport; now?: () => number; token?: () => string };

// resolve only the actual executable or node script, mirroring host verification
function entryIndex(argv: readonly string[]): number {
  if (!nodeProgramName.test(basename(argv[0] ?? ''))) return 0;
  // consume only supported node options before reaching the script
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    // the first positional argument is the script, never a later app argument
    if (argument === '--') return index + 1;
    if (!argument.startsWith('-')) return index;
    // skip supported runtime switches and their fixed arity values
    if (nodeSwitches.has(argument)) continue;
    if (nodeValueFlags.has(argument)) { index += 1; continue; }
    if (argument.startsWith('--') && argument.includes('=') && nodeValueFlags.has(argument.split('=', 1)[0]!)) continue;
    // unknown options, stdin, eval and run modes do not prove a script entry
    return -1;
  }
  return -1;
}

// find the first positional Codex argument after options whose values are known
function codexCommand(args: readonly string[]): string | undefined {
  const valued = new Set(['-c', '--config', '-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval', '--approval-policy', '-C', '--cd', '--add-dir', '-i', '--image', '-p', '--profile']);
  // inspect only the option prefix
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    // stop at a literal argument boundary
    if (argument === '--') return args[index + 1];
    // skip one separate value for fixed options
    if (valued.has(argument)) { index += 1; continue; }
    // attached options carry no following value
    if (argument.startsWith('-')) continue;
    return argument;
  }
  return undefined;
}

// require a stricter entry than regular dashboard discovery for signaling authority
function interactiveKind(argv: readonly string[]): RecoveryAgent['kind'] | undefined {
  const index = entryIndex(argv);
  const entry = argv[index] ?? '';
  const program = basename(entry);
  const args = argv.slice(index + 1);
  // exclude codex helpers and accept only OMX leader dispatch modes
  if (codexProgramName.test(program)) return codexHelpers.has(codexCommand(args) ?? '') ? undefined : 'codex';
  if (omxProgramName.test(program)) {
    const first = args[0];
    return first === undefined || first === 'launch' || first === 'resume' || first.startsWith('--') && first !== '--help' && first !== '--version' ? 'omx' : undefined;
  }
  // print and stream-json modes are managed workers rather than interactive terminals
  if (program !== 'claude' && (index <= 0 || !claudeEntry.test(entry))) return undefined;
  return args.some(argument => argument === '-p' || argument.startsWith('-p=') || argument === '--print' || argument.startsWith('--print=') || argument === '--input-format' || argument.startsWith('--input-format=') || argument === '--output-format' || argument.startsWith('--output-format=')) ? undefined : 'claude';
}

// recognize only a Pi child launched by RAC's exact holder and RPC extension
async function racPiProcess(procRoot: string, comm: string, argv: readonly string[], parentPid: number, uid: number): Promise<boolean> {
  // Pi overwrites its argv after startup, so its holder retains the launch proof
  if (comm !== 'pi' || argv.length !== 1 || argv[0] !== 'pi' || parentPid <= 1) return false;
  try {
    const parentRoot = join(procRoot, String(parentPid));
    const [rawCommand, status] = await Promise.all([readBoundedText(join(parentRoot, 'cmdline')), readBoundedText(join(parentRoot, 'status'), 16_384)]);
    const parent = rawCommand.split('\0').filter(Boolean);
    const boundary = parent.indexOf('--');
    const holder = parent[1] ?? '';
    const launched = boundary < 0 ? [] : parent.slice(boundary + 1);
    const cli = launched[1] ?? '';
    const mode = launched.findIndex(argument => argument === '--mode');
    const extension = launched.findIndex(argument => argument === '-e');
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu.exec(status)?.slice(1).map(Number);
    const repository = /^(.*)\/apps\/server\/(?:src|dist)\/transports\/holder\.(?:ts|js)$/u.exec(holder)?.[1];
    // require the same-user repository holder, pinned cli shape and repository extension
    return uids !== undefined && uids.slice(0, 3).every(value => value === uid) && boundary >= 3 && repository !== undefined
      && /\/@earendil-works\/pi-coding-agent\/dist\/bundle\/cli\.js$/u.test(cli)
      && mode > 0 && launched[mode + 1] === 'rpc' && launched.includes('-ne') && launched.includes('--offline') && launched.includes('--no-approve')
      && extension > 0 && new RegExp(`^${repository.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/apps/server/(?:src|dist)/adapters/pi-extension\\.(?:ts|js)$`, 'u').test(launched[extension + 1] ?? '');
  } catch {
    return false;
  }
}

// read one live same-user process identity from proc
async function inspectProcess(procRoot: string, pid: number, uid: number): Promise<RecoveryIdentity | undefined> {
  try {
    const root = join(procRoot, String(pid));
    const [comm, rawCmdline, stat, status, cwd] = await Promise.all([
      readBoundedText(join(root, 'comm'), 4_096),
      readBoundedText(join(root, 'cmdline')),
      readBoundedText(join(root, 'stat'), 4_096),
      readBoundedText(join(root, 'status'), 16_384),
      readlink(join(root, 'cwd')).catch(() => '')
    ]);
    const close = stat.lastIndexOf(')');
    const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
    const parentPid = Number(fields[1]);
    const startTime = fields[19];
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu.exec(status)?.slice(1).map(Number);
    // require a live exact lifetime and unchanged user credentials
    if (fields[0] === 'Z' || fields[0] === 'X' || !Number.isSafeInteger(parentPid) || parentPid < 0 || startTime === undefined || !/^\d+$/u.test(startTime) || uids === undefined || uids.slice(0, 3).some(value => value !== uid)) return undefined;
    const argv = rawCmdline.replace(/\0+$/u, '').split('\0');
    const kind = interactiveKind(argv) ?? (await racPiProcess(procRoot, comm.trim(), argv, parentPid, uid) ? 'pi' : undefined);
    // expose only proven interactive terminals or exact RAC Pi RPC children
    if (kind === undefined) return undefined;
    return { pid, parentPid, startTime, uid, kind, cwd, cmdline: rawCmdline };
  } catch {
    return undefined;
  }
}

// detect a recognised Agent through intervening wrapper or shell parents
async function hasAgentAncestor(procRoot: string, process: RecoveryIdentity, byPid: Map<number, RecoveryIdentity>): Promise<boolean> {
  let parent = process.parentPid;
  const seen = new Set<number>();
  // bound proc ancestry and reject cycles
  while (parent > 1 && !seen.has(parent) && seen.size < 64) {
    seen.add(parent);
    // a registered interactive ancestor owns this child Agent
    if (byPid.has(parent)) return true;
    try {
      const stat = await readBoundedText(join(procRoot, String(parent), 'stat'), 4_096);
      const close = stat.lastIndexOf(')');
      const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/u);
      const next = Number(fields[1]);
      // stop at unreadable or malformed parent identity
      if (!Number.isSafeInteger(next) || next < 0) return false;
      parent = next;
    } catch {
      return false;
    }
  }
  return false;
}

// scan proc with bounded concurrency so recovery inspection cannot amplify host pressure
async function scanProcesses(procRoot: string, uid: number): Promise<RecoveryIdentity[]> {
  const entries = await readdir(procRoot, { withFileTypes: true });
  const pids = entries.filter(entry => entry.isDirectory() && /^\d+$/u.test(entry.name)).map(entry => Number(entry.name));
  const found: RecoveryIdentity[] = [];
  let cursor = 0;
  // cap concurrent proc reads during degraded operation
  await Promise.all(Array.from({ length: Math.min(8, pids.length) }, async () => {
    // claim one pid at a time from the shared monotonic cursor
    while (cursor < pids.length) {
      const index = cursor;
      cursor += 1;
      const process = await inspectProcess(procRoot, pids[index]!, uid);
      // retain only readable identities
      if (process !== undefined) found.push(process);
    }
  }));
  const byPid = new Map(found.map(process => [process.pid, process]));
  const leaders: RecoveryIdentity[] = [];
  // keep ancestry reads bounded too; only found agents need this check
  for (const process of found) {
    // hide nested Agent children and known OMX team workers
    if (omxWorkerPath.test(process.cwd) || omxWorkerPath.test(process.cmdline.replaceAll('\0', ' '))) continue;
    if (!await hasAgentAncestor(procRoot, process, byPid)) leaders.push(process);
  }
  return leaders.sort((left, right) => left.pid - right.pid);
}

// provide tmux-independent recovery inspection and identity-bound stop requests
export class RecoveryAgentService {
  private readonly procRoot: string;
  private readonly explicitProcRoot: boolean;
  private readonly hostUid: number | undefined;
  private readonly transport: RecoveryTransport;
  private readonly now: () => number;
  private readonly token: () => string;
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly identities = new Map<string, TokenRecord>();
  private scan?: { expiresAt: number; processes: RecoveryIdentity[] };
  private scanInFlight?: Promise<RecoveryIdentity[]>;

  // bind host proc and the existing fixed settings control bridge
  constructor(options: RecoveryAgentOptions = {}) {
    const hostProcRoot = options.procRoot ?? process.env.RAC_HOST_PROC?.trim();
    this.procRoot = hostProcRoot || '/proc';
    this.explicitProcRoot = Boolean(hostProcRoot);
    const configuredUid = options.hostUid ?? Number(process.env.RAC_HOST_UID ?? process.getuid?.());
    this.hostUid = Number.isSafeInteger(configuredUid) && configuredUid >= 0 ? configuredUid : undefined;
    this.transport = options.transport ?? new HostSettingsTransport(settingsControlRoot(), 10_000);
    this.now = options.now ?? Date.now;
    this.token = options.token ?? (() => randomBytes(24).toString('base64url'));
  }

  // list only verified live Agents without consulting tmux
  async list(): Promise<RecoveryAgentList> {
    // fail closed when the host user identity is unavailable
    if (this.hostUid === undefined) return { available: false, canStop: false, agents: [], reason: 'Host process identity is unavailable.' };
    // a container without an explicit host proc bridge cannot prove host identities
    if (!this.explicitProcRoot && await containerized()) return { available: false, canStop: false, agents: [], reason: 'Host process namespace is unavailable.' };
    let processes: RecoveryIdentity[];
    try { processes = await this.processes(); }
    catch { return { available: false, canStop: false, agents: [], reason: 'Host process inspection is unavailable.' }; }
    const now = this.now();
    const live = new Set(processes.map(process => this.identityKey(process)));
    // remove identities no longer proven live or outside their short lease
    for (const [key, record] of this.identities) {
      if (record.expiresAt <= now || !live.has(key)) this.drop(key, record);
    }
    const agents = processes.map(process => {
      const key = this.identityKey(process);
      let record = this.identities.get(key);
      // mint one opaque token per exact process lifetime
      if (record === undefined) {
        const id = this.token();
        if (!tokenPattern.test(id) || this.tokens.has(id)) throw new Error('invalid recovery token source');
        record = { id, identity: process, expiresAt: now + tokenTtlMs };
        this.identities.set(key, record);
        this.tokens.set(id, record);
      } else record.expiresAt = now + tokenTtlMs;
      const kind = process.kind === 'omx' ? 'OMX' : process.kind === 'codex' ? 'Codex' : process.kind === 'pi' ? 'Pi' : 'Claude';
      const location = basename(process.cwd).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 64) || 'unknown location';
      return { id: record.id, kind: process.kind, label: `${kind} · ${location}`, pid: process.pid };
    });
    const canStop = await this.capability();
    return { available: true, canStop, agents, ...(canStop ? {} : { reason: 'Safe host process control is unavailable.' }) };
  }

  // stop exact selected lifetimes through one fixed host operation
  async stop(ids: unknown): Promise<RecoveryAgentStopResponse> {
    const now = this.now();
    // accept one bounded unique token list only
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > maxTargets || !ids.every(id => typeof id === 'string' && tokenPattern.test(id)) || new Set(ids).size !== ids.length) {
      return { available: true, canStop: false, results: [] };
    }
    const selections = ids.map(id => ({ id, record: this.tokens.get(id) })).filter((selection): selection is { id: string; record: TokenRecord } => selection.record !== undefined && selection.record.expiresAt > now);
    const selected = new Set(selections.map(selection => selection.id));
    const missing = ids.filter(id => !selected.has(id)).map(id => ({ id, status: 'not_found' as const, message: 'The Agent identity is no longer available.' }));
    const installation = await this.installation();
    // retain read-only recovery when the fixed host bridge is absent
    if (installation === undefined || selections.length === 0) return { available: true, canStop: false, results: [...missing, ...selections.map(({ id }) => ({ id, status: 'rejected' as const, message: 'Safe host process control is unavailable.' }))] };
    const deadline = now + stopDeadlineMs;
    const requestId = randomBytes(24).toString('base64url');
    try {
      const reply = await this.transport.request({
        version: 1,
        id: requestId,
        kind: 'agents-stop',
        generation: installation.generation,
        agentStop: { deadline, targets: selections.map(({ record }) => ({ pid: record.identity.pid, startTime: record.identity.startTime, uid: record.identity.uid, kind: record.identity.kind })) }
      });
      const results = this.results(reply.agentStops, selections);
      return { available: true, canStop: true, results: [...missing, ...results] };
    } catch {
      return { available: true, canStop: true, results: [...missing, ...selections.map(({ id }) => ({ id, status: 'failed' as const, message: 'The host did not accept the stop request.' }))] };
    }
  }

  // validate the installed helper belongs to the same host user
  private async installation(): Promise<Installation | undefined> {
    if (this.hostUid === undefined) return undefined;
    try {
      const installation = await this.transport.installation();
      return installation?.uid === this.hostUid ? installation : undefined;
    } catch {
      return undefined;
    }
  }

  // report whether exact host signaling can be requested
  private async capability(): Promise<boolean> {
    return await this.installation() !== undefined;
  }

  // coalesce concurrent scans and briefly reuse one bounded proc snapshot
  private processes(): Promise<RecoveryIdentity[]> {
    // a slow scan remains single-flight regardless of the cache window
    if (this.scanInFlight !== undefined) return this.scanInFlight;
    if (this.scan !== undefined && this.scan.expiresAt > this.now()) return Promise.resolve(this.scan.processes);
    this.scan = undefined;
    const pending = scanProcesses(this.procRoot, this.hostUid!).then(processes => {
      // start the full cache interval when the scan has actually completed
      this.scan = { expiresAt: this.now() + scanCacheMs, processes };
      return processes;
    }).finally(() => {
      // failure clears the in-flight slot without caching an empty inventory
      this.scanInFlight = undefined;
    });
    this.scanInFlight = pending;
    return pending;
  }

  // project only the exact result order and identity returned by the helper
  private results(results: AgentStopResult[] | undefined, selections: Array<{ id: string; record: TokenRecord }>): RecoveryAgentStopOutcome[] {
    if (results === undefined || results.length !== selections.length) return selections.map(({ id }) => ({ id, status: 'failed', message: 'The host returned an invalid stop result.' }));
    return selections.map(({ id, record }, index) => {
      const result = results[index]!;
      // reject reordered or substituted target results
      if (result.pid !== record.identity.pid || result.startTime !== record.identity.startTime) return { id, status: 'failed', message: 'The host returned an invalid stop result.' };
      return { id, status: result.status, ...(result.message === undefined ? {} : { message: result.message }) };
    });
  }

  // key the lease to the exact lifetime and recognition result
  private identityKey(identity: RecoveryIdentity): string {
    return `${identity.uid}:${identity.pid}:${identity.startTime}:${identity.kind}`;
  }

  // remove both token indexes together
  private drop(key: string, record: TokenRecord): void {
    this.identities.delete(key);
    this.tokens.delete(record.id);
  }
}
