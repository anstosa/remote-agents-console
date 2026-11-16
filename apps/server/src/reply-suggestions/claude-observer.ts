import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

export const claudeApprovedKeybindingsHash = '7a91e00277535715ef04542c7b2b592752158927dd780a44e7a43a059eac5556';
const maximumPolicyBytes = 64 * 1_024;
const maximumStateBytes = 64 * 1_024;

export type ClaudeReplyObserverConfiguration = { observerDir: string; policyNonce: string };
export type ClaudeReplyPolicySnapshot = ClaudeReplyObserverConfiguration & { generation: number; sourceConfigDir: string };
export type ClaudeReplyObserverState = {
  version: 1;
  sessionId: string;
  policyNonce: string;
  bootNonce: string;
  processPid: number;
  processStartTime: string;
  heartbeatSeq: number;
  sourceEpoch: number;
  hookSeq: number;
  statusHookSeq: number;
  transcriptSignalSeq: number;
  pendingModelSwitch: boolean;
  model: string;
  effort: string;
};

type ClaudeReplyPolicyOptions = {
  configDir: string;
  observerDir: string;
  sourceConfigDir?: string;
  expectedKeybindingsHash?: string;
  reporterPath?: string;
};
export type ClaudeReplyPolicyReadiness = { status: 'uninitialized' | 'ready' | 'rechecking' | 'unavailable' | 'untrusted' | 'closed'; generation: number };

let configuredTracker: ClaudeReplySourcePolicyTracker | undefined;

// serialize one json value with deterministic object-key order
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonical(item));
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  // preserve every object field in sorted order
  for (const key of Object.keys(record).sort()) sorted[key] = canonical(record[key]);
  return sorted;
}

// remove only documented model and effort selection fields from a settings object
function settingsSecuritySignature(value: unknown): string | undefined {
  // Claude settings must be one object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const settings = value as Record<string, unknown>;
  if (settings.model !== undefined && typeof settings.model !== 'string') return undefined;
  if (settings.effortLevel !== undefined && typeof settings.effortLevel !== 'string') return undefined;
  if (settings.modelSettings !== undefined) {
    // per-model settings may contain only the documented effort selection
    if (settings.modelSettings === null || typeof settings.modelSettings !== 'object' || Array.isArray(settings.modelSettings)) return undefined;
    for (const [model, candidate] of Object.entries(settings.modelSettings as Record<string, unknown>)) {
      // reject malformed model selectors and unknown nested fields
      if (model === '' || candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
      const fields = candidate as Record<string, unknown>;
      if (Object.keys(fields).some(key => key !== 'effortLevel') || (fields.effortLevel !== undefined && typeof fields.effortLevel !== 'string')) return undefined;
    }
  }
  const security: Record<string, unknown> = {};
  // retain every nonselection setting in the security signature
  for (const [key, candidate] of Object.entries(settings)) if (key !== 'model' && key !== 'effortLevel' && key !== 'modelSettings') security[key] = candidate;
  return createHash('sha256').update(JSON.stringify(canonical(security))).digest('hex');
}

// read one bounded regular policy file without following a replacement link
async function policyFile(path: string, optional: boolean): Promise<{ bytes?: Buffer; mode?: number } | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' && optional ? undefined : null);
  // distinguish an optional missing file from an unreadable one
  if (handle === undefined) return {};
  if (handle === null) return undefined;
  try {
    const info = await handle.stat();
    // reject nonfiles and oversized policy material
    if (!info.isFile() || info.size < 0 || info.size > maximumPolicyBytes) return undefined;
    const bytes = await handle.readFile();
    // require the complete size observed on the opened inode
    return bytes.length === info.size ? { bytes, mode: info.mode } : undefined;
  } finally {
    await handle.close();
  }
}

// expose only a currently valid policy to the generated Claude settings
export function claudeReplyObserverConfiguration(): ClaudeReplyObserverConfiguration | undefined {
  const snapshot = configuredTracker?.snapshot();
  return snapshot === undefined ? undefined : { observerDir: snapshot.observerDir, policyNonce: snapshot.policyNonce };
}

// hash one session id into a path-safe observer filename
export function claudeReplyObserverStatePath(directory: string, sessionId: string): string {
  return join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}

// accept one bounded nonnegative counter
function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// parse only the fixed nonsecret observer state schema
function observerState(value: unknown): ClaudeReplyObserverState | undefined {
  // reject nonobjects and extra fields before reading values
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  const keys = ['bootNonce', 'effort', 'heartbeatSeq', 'hookSeq', 'model', 'pendingModelSwitch', 'policyNonce', 'processPid', 'processStartTime', 'sessionId', 'sourceEpoch', 'statusHookSeq', 'transcriptSignalSeq', 'version'];
  // require the exact bounded schema
  if (Object.keys(state).sort().join(',') !== keys.sort().join(',')) return undefined;
  if (state.version !== 1 || typeof state.sessionId !== 'string' || typeof state.policyNonce !== 'string' || typeof state.bootNonce !== 'string'
    || !Number.isSafeInteger(state.processPid) || (state.processPid as number) <= 0 || typeof state.processStartTime !== 'string' || !/^\d+$/u.test(state.processStartTime)
    || !counter(state.heartbeatSeq) || !counter(state.sourceEpoch) || !counter(state.hookSeq) || !counter(state.statusHookSeq) || !counter(state.transcriptSignalSeq)
    || typeof state.pendingModelSwitch !== 'boolean' || typeof state.model !== 'string' || typeof state.effort !== 'string') return undefined;
  // constrain identifiers and current settings before returning them
  if (state.sessionId.length > 128 || state.policyNonce.length > 128 || state.bootNonce.length > 128 || state.model.length === 0 || state.model.length > 256
    || state.effort.length === 0 || state.effort.length > 64 || /[\u0000-\u001f\u007f]/u.test(`${state.sessionId}${state.policyNonce}${state.bootNonce}${state.processStartTime}${state.model}${state.effort}`)) return undefined;
  return state as ClaudeReplyObserverState;
}

// read one atomically replaced observer state without accepting a symlink or race
export async function readClaudeReplyObserverState(directory: string, sessionId: string): Promise<ClaudeReplyObserverState | undefined> {
  const path = claudeReplyObserverStatePath(directory, sessionId);
  const before = await lstat(path).catch(() => undefined);
  // require one private regular state file
  if (before?.isFile() !== true || before.isSymbolicLink() || before.size <= 0 || before.size > maximumStateBytes || (before.mode & 0o077) !== 0) return undefined;
  const bytes = await readFile(path).catch(() => undefined);
  const after = await lstat(path).catch(() => undefined);
  // atomic replacement or append during the read invalidates this observation
  if (bytes === undefined || after === undefined || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return undefined;
  let parsed: unknown;
  // malformed state never falls back to a cached tuple
  try { parsed = JSON.parse(bytes.toString('utf8')) as unknown; } catch { return undefined; }
  return observerState(parsed);
}

// watch one approved Claude profile before any managed launch can acknowledge it
export class ClaudeReplySourcePolicyTracker {
  private watcher?: FSWatcher;
  private reporterWatcher?: FSWatcher;
  private reporterGeneration?: string;
  private valid = false;
  private generation = 0;
  private policyNonce = randomUUID();
  private initialized = false;
  private closed = false;
  private untrusted = false;
  private initialSecuritySignature?: string;
  private pending?: Promise<void>;

  constructor(private readonly options: ClaudeReplyPolicyOptions) {}

  // establish the directory watch before reading the approved policy baseline
  async initialize(): Promise<boolean> {
    // initialization is one boot-scoped admission decision
    if (this.initialized || this.closed) return this.valid;
    this.initialized = true;
    if (!isAbsolute(this.options.configDir) || !isAbsolute(this.options.observerDir)) return false;
    const canonical = await realpath(this.options.configDir).catch(() => undefined);
    // reject missing or redirected profile directories
    if (canonical !== this.options.configDir) return false;
    try {
      // tracked reporter edits retire every acknowledgement from this boot
      if (this.options.reporterPath !== undefined) {
        if (!isAbsolute(this.options.reporterPath)) return false;
        this.reporterWatcher = watch(dirname(this.options.reporterPath), { persistent: false }, (_event, filename) => {
          // unnamed events cannot prove the reporter remained unchanged
          if (filename === null || filename.toString() === basename(this.options.reporterPath!)) this.invalidatePermanently();
        });
        this.reporterWatcher.on('error', () => this.invalidatePermanently());
        this.reporterGeneration = this.readReporterGeneration();
        if (this.reporterGeneration === undefined) return false;
      }
      this.watcher = watch(this.options.configDir, { persistent: false }, (_event, filename) => {
        const name = filename?.toString();
        // unnamed and key-policy events cannot be safely requalified this boot
        if (name === undefined || name === 'keybindings.json') this.invalidatePermanently();
        else if (name === 'settings.json') this.settingsChanged();
      });
      this.watcher.on('error', () => this.invalidatePermanently());
    } catch {
      return false;
    }
    const baseline = await this.readBaseline();
    // do not revalidate after a watch event raced the baseline read
    if (baseline !== undefined && this.generation === 0) {
      this.initialSecuritySignature = baseline;
      this.valid = true;
    } else if (baseline === undefined) {
      this.untrusted = true;
    }
    configuredTracker = this;
    return this.valid;
  }

  // bind ordinary checkout integrity without claiming same-uid hostile-host isolation
  private readReporterGeneration(): string | undefined {
    const path = this.options.reporterPath;
    if (path === undefined) return undefined;
    try {
      const before = lstatSync(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size <= 0n || before.size > BigInt(maximumPolicyBytes)) return undefined;
      const bytes = readFileSync(path);
      const after = lstatSync(path, { bigint: true });
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return undefined;
      return createHash('sha256').update(bytes).update(`${after.dev}:${after.ino}:${after.mtimeNs}:${after.ctimeNs}`).digest('hex');
    } catch { return undefined; }
  }

  // expose one immutable current boot policy generation
  snapshot(): ClaudeReplyPolicySnapshot | undefined {
    if (!this.valid) return undefined;
    // close the watch-delivery race before publishing source evidence
    if (this.options.reporterPath !== undefined && this.readReporterGeneration() !== this.reporterGeneration) {
      this.invalidatePermanently();
      return undefined;
    }
    return {
      observerDir: this.options.observerDir,
      policyNonce: this.policyNonce,
      generation: this.generation,
      sourceConfigDir: this.options.sourceConfigDir ?? this.options.configDir
    };
  }

  // expose policy readiness without paths, file contents or native metadata
  readiness(): ClaudeReplyPolicyReadiness {
    if (this.closed) return { status: 'closed', generation: this.generation };
    if (!this.initialized) return { status: 'uninitialized', generation: this.generation };
    if (this.untrusted) return { status: 'untrusted', generation: this.generation };
    if (this.pending !== undefined) return { status: 'rechecking', generation: this.generation };
    return { status: this.valid ? 'ready' : 'unavailable', generation: this.generation };
  }

  // await the latest bounded settings re-read for deterministic startup and tests
  async settled(): Promise<boolean> {
    // a later event may replace the pending promise while this one settles
    while (this.pending !== undefined) await this.pending;
    return this.valid;
  }

  // invalidate all acknowledged sources after a profile mutation or watcher failure
  private invalidatePermanently(): void {
    this.generation += 1;
    this.valid = false;
    this.untrusted = true;
  }

  // retire old work immediately, then requalify only harmless selection changes
  private settingsChanged(): void {
    if (this.closed || this.untrusted) return;
    this.generation += 1;
    this.valid = false;
    const epoch = this.generation;
    const recheck = this.readBaselineBounded().then(signature => {
      // only the latest healthy watcher generation may restore readiness
      if (this.closed || this.untrusted || this.generation !== epoch) return;
      if (signature === undefined || signature !== this.initialSecuritySignature) {
        this.untrusted = true;
        return;
      }
      this.valid = true;
    }).catch(() => {
      // unreadable settings are a permanent security-boundary failure
      if (!this.closed && this.generation === epoch) this.untrusted = true;
    }).finally(() => {
      // release only this generation's recheck
      if (this.pending === recheck) this.pending = undefined;
    });
    this.pending = recheck;
  }

  // tolerate one in-progress atomic or truncate-write settings update within a fixed bound
  private async readBaselineBounded(): Promise<string | undefined> {
    // retry only unreadable intermediate bytes, never a valid changed security signature
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const signature = await this.readBaseline();
      if (signature !== undefined) return signature;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return undefined;
  }

  // verify the exact approved key policy and absence of an operator status line
  private async readBaseline(): Promise<string | undefined> {
    const keybindingsPath = join(this.options.configDir, 'keybindings.json');
    const settingsPath = join(this.options.configDir, 'settings.json');
    const [keybindings, settings] = await Promise.all([policyFile(keybindingsPath, false), policyFile(settingsPath, true)]);
    // require the owner-private approved keybinding file
    if (keybindings?.bytes === undefined || keybindings.mode === undefined || (keybindings.mode & 0o077) !== 0) return undefined;
    const expected = this.options.expectedKeybindingsHash ?? claudeApprovedKeybindingsHash;
    // accept only the exact approved two-null policy bytes
    if (createHash('sha256').update(keybindings.bytes).digest('hex') !== expected || settings === undefined) return undefined;
    if (settings.bytes !== undefined) {
      // oversized or malformed settings cannot prove customization safety
      let parsed: unknown;
      try { parsed = JSON.parse(settings.bytes.toString('utf8')) as unknown; } catch { return undefined; }
      // preserve an existing operator status line by leaving Claude unsupported
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'statusLine')) return undefined;
      return settingsSecuritySignature(parsed);
    }
    return settingsSecuritySignature({});
  }

  // stop only this private directory observer
  close(): void {
    this.closed = true;
    this.generation += 1;
    this.watcher?.close();
    this.watcher = undefined;
    this.reporterWatcher?.close();
    this.reporterWatcher = undefined;
    this.valid = false;
    if (configuredTracker === this) configuredTracker = undefined;
  }
}
