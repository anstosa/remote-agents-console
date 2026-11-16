import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hostHolderRuntime, verifyHostNode } from '../adapters/host-runtime.js';
import { run, tmuxFormatLiteral } from '../tmux/command.js';
import { nativePolicyGeneration, nativeRequestBytes, nativeTimeoutMs } from './native-policy.js';
import type { NativeReplySuggestionSource, NativeReplyScope } from './types.js';
import { nativeFailureReason, replySuggestionDiagnostics } from './diagnostics.js';

/** sanitized own-account metadata with no email, token or credential bytes */
export type NativeAccountObservation = {
  kind: 'codex' | 'claude';
  provider: 'openai' | 'anthropic';
  logicalIdentity: string;
  profile: 'chatgpt' | 'claude-pro';
  model: string;
  effort: string;
  programVersion: string;
  capabilityGeneration: string;
  credentialGeneration: string;
};

/** one fail-closed native helper result after its own postflight account check */
export type NativeGenerationResult = {
  status: 'completed' | 'failed';
  kind: 'codex' | 'claude';
  provider: 'openai' | 'anthropic';
  model: string;
  effort: string;
  accountBefore: string;
  accountAfter: string;
  finalText?: string;
  finalAnswerCount: number;
  terminalStatus: 'completed' | 'failed';
  toolEvents: number;
  rerouteEvents: number;
  serverRequests: number;
  errorEvents: number;
  cleanupComplete: boolean;
  historyPersisted: boolean;
};

/** private process port used by the runtime and fake-native tests */
export interface NativeProcessRunner {
  readonly policyGeneration: string;
  routeGeneration(): string | undefined;
  inspect(scope: NativeReplyScope, source: NativeReplySuggestionSource, signal: AbortSignal, expectedGeneration: string): Promise<NativeAccountObservation | undefined>;
  generate(scope: NativeReplyScope, source: NativeReplySuggestionSource, signal: AbortSignal, expectedAccount: string, expectedGeneration: string): Promise<NativeGenerationResult>;
}

/** one private socket or stdio worker request */
export type NativeWorkerRequest = {
  version: 1;
  action: 'inspect' | 'generate';
  scope: NativeReplyScope;
  source: NativeReplySuggestionSource;
  expectedAccount?: string;
};

/** one bounded worker reply with no raw account identity */
export type NativeWorkerResponse = {
  version: 1;
  ok: boolean;
  observation?: NativeAccountObservation;
  result?: NativeGenerationResult;
  errorCode?: string;
};

type NativeWorkerProcessRunnerOptions = {
  environment?: NodeJS.ProcessEnv;
  command?: typeof run;
  workerFile?: string;
};

const hostWorkerFiles = [
  'reply-suggestions/native-worker.js', 'reply-suggestions/native-policy.js', 'reply-suggestions/native-scope.js',
  'reply-suggestions/native-process.js', 'reply-suggestions/prompt.js', 'reply-suggestions/validation.js', 'reply-suggestions/diagnostics.js',
  'adapters/codex-processes.js', 'adapters/omx-processes.js', 'adapters/program-names.js'
] as const;

// quote trusted paths for the host shell
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// parse one bounded worker response
function workerResponse(value: string): NativeWorkerResponse | undefined {
  // reject oversized helper output
  if (Buffer.byteLength(value) > 64 * 1024) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  // require the exact response envelope
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const response = parsed as NativeWorkerResponse;
  return response.version === 1 && typeof response.ok === 'boolean' ? response : undefined;
}

// own the one-shot native worker transport in either namespace
export class NativeWorkerProcessRunner implements NativeProcessRunner {
  readonly policyGeneration = nativePolicyGeneration;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly command: typeof run;
  private readonly workerFile: string;

  // retain only explicit host/runtime seams
  constructor(options: NativeWorkerProcessRunnerOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.command = options.command ?? run;
    this.workerFile = options.workerFile ?? fileURLToPath(new URL('./native-worker.js', import.meta.url));
  }

  // bind one verified host closure to the shared native policy
  private hostGeneration(fingerprint: string): string {
    return createHash('sha256').update(JSON.stringify([nativePolicyGeneration, fingerprint])).digest('hex');
  }

  // hash the current private helper closure without launching a process
  routeGeneration(): string | undefined {
    try {
      const modules = fileURLToPath(new URL('../', import.meta.url));
      const host = hostHolderRuntime(this.environment, { modules }, hostWorkerFiles);
      // host runtime already hashes the byte-identical deployed closure
      if (host !== undefined) return this.hostGeneration(host.fingerprint);
      const generation = createHash('sha256').update(nativePolicyGeneration);
      // local runtime hashes the same bounded helper closure
      for (const file of hostWorkerFiles) generation.update(file).update(readFileSync(join(modules, file)));
      return generation.digest('hex');
    } catch {
      return undefined;
    }
  }

  // inspect native account and capability metadata without inference
  async inspect(scope: NativeReplyScope, source: NativeReplySuggestionSource, signal: AbortSignal, expectedGeneration: string): Promise<NativeAccountObservation | undefined> {
    const response = await this.call({ version: 1, action: 'inspect', scope, source }, signal, expectedGeneration);
    // preserve only a closed metadata failure category
    if (response?.ok !== true) replySuggestionDiagnostics.record(response === undefined ? 'capability_unavailable' : nativeFailureReason(response.errorCode), source);
    return response?.ok === true ? response.observation : undefined;
  }

  // execute one bounded native generation on the pre-observed account
  async generate(scope: NativeReplyScope, source: NativeReplySuggestionSource, signal: AbortSignal, expectedAccount: string, expectedGeneration: string): Promise<NativeGenerationResult> {
    const response = await this.call({ version: 1, action: 'generate', scope, source, expectedAccount }, signal, expectedGeneration);
    // worker text and identifiers never enter the diagnostic sink
    if (response?.ok !== true) replySuggestionDiagnostics.record(nativeFailureReason(response?.errorCode), source);
    return response?.ok === true && response.result !== undefined ? response.result : {
      status: 'failed', kind: scope.kind, provider: scope.kind === 'codex' ? 'openai' : 'anthropic', model: source.nativeModel.id, effort: source.model.effort ?? '',
      accountBefore: expectedAccount, accountAfter: '', finalAnswerCount: 0, terminalStatus: 'failed', toolEvents: 0, rerouteEvents: 0, serverRequests: 0, errorEvents: 1, cleanupComplete: true, historyPersisted: false
    };
  }

  // choose the local or verified host worker without fallback
  private async call(request: NativeWorkerRequest, signal: AbortSignal, expectedGeneration: string): Promise<NativeWorkerResponse | undefined> {
    // reject oversized private payloads before process launch
    const payload = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(payload) > nativeRequestBytes || signal.aborted || this.routeGeneration() !== expectedGeneration) return undefined;
    const host = hostHolderRuntime(this.environment, { modules: fileURLToPath(new URL('../', import.meta.url)) }, hostWorkerFiles);
    // a changed deployed closure cannot cross the launch boundary
    if (host !== undefined && this.hostGeneration(host.fingerprint) !== expectedGeneration) return undefined;
    return host === undefined ? await this.local(payload, signal) : await this.host(payload, signal, host);
  }

  // run one local worker with a clean environment and stdin payload
  private async local(payload: string, signal: AbortSignal): Promise<NativeWorkerResponse | undefined> {
    const child = spawn(process.execPath, [this.workerFile], {
      cwd: dirname(this.workerFile), shell: false, detached: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...(this.environment.RAC_HOST_PROC === undefined ? {} : { RAC_HOST_PROC: this.environment.RAC_HOST_PROC }) },
      stdio: ['pipe', 'pipe', 'ignore']
    });
    let output = '';
    let overflow = false;
    // retain one bounded response line
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 64 * 1024) { overflow = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } } });
    const abort = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ } };
    signal.addEventListener('abort', abort, { once: true });
    child.stdin.end(payload);
    const code = await new Promise<number>(resolve => { child.once('error', () => resolve(-1)); child.once('close', value => resolve(value ?? -1)); });
    signal.removeEventListener('abort', abort);
    // accept one complete successful worker envelope
    return code === 0 && !overflow && !signal.aborted ? workerResponse(output.trim()) : undefined;
  }

  // run one verified host worker over a transient private unix socket
  private async host(payload: string, signal: AbortSignal, host: { node: string; modules: string; fingerprint: string }): Promise<NativeWorkerResponse | undefined> {
    const repository = this.environment.RAC_HOST_REPOSITORY!;
    const socketRoot = join(repository, '.data', 'reply-suggestions');
    await mkdir(socketRoot, { recursive: true, mode: 0o700 });
    const [canonical, info] = await Promise.all([realpath(socketRoot), lstat(socketRoot)]);
    const uid = process.getuid?.();
    // require one same-path private socket parent
    if (canonical !== socketRoot || !info.isDirectory() || info.isSymbolicLink() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0) return undefined;
    const worker = join(host.modules, 'reply-suggestions', 'native-worker.js');
    await verifyHostNode(host.node, this.environment, this.command, [socketRoot]);
    // cancellation during host verification cannot launch a worker
    if (signal.aborted) return undefined;
    const socketPath = join(socketRoot, `${randomUUID()}.sock`);
    let client: Socket | undefined;
    let server: Server | undefined;
    let output = '';
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const response = new Promise<NativeWorkerResponse | undefined>(resolve => {
      server = createServer(socket => {
        // allow only the first private worker connection
        if (client !== undefined) { socket.destroy(); return; }
        client = socket;
        socket.setEncoding('utf8');
        // retain one bounded response line
        socket.on('data', chunk => {
          output += chunk;
          // abort oversized worker output
          if (Buffer.byteLength(output) > 64 * 1024) { socket.destroy(); resolve(undefined); return; }
          const newline = output.indexOf('\n');
          // parse the first complete response only
          if (newline >= 0) { resolve(workerResponse(output.slice(0, newline))); socket.end(); }
        });
        socket.once('error', () => resolve(undefined));
        socket.once('close', () => resolve(undefined));
        socket.write(payload);
      });
      server.once('error', error => { readyReject(error); resolve(undefined); });
      server.listen(socketPath, () => { void chmod(socketPath, 0o600).then(readyResolve, readyReject); });
    });
    const listening = await ready.then(() => true).catch(() => false);
    // a failed private socket never launches a host helper
    if (!listening) { server?.close(); await rm(socketPath, { force: true }); return undefined; }
    const abort = () => { client?.destroy(); server?.close(); };
    signal.addEventListener('abort', abort, { once: true });
    const command = `/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 RAC_NATIVE_SOCKET_ROOT=${shellQuote(socketRoot)} ${shellQuote(host.node)} ${shellQuote(worker)} --socket ${shellQuote(socketPath)}`;
    const launched = this.command(this.environment.RAC_TMUX_BIN ?? '/usr/bin/tmux', ['-S', join(this.environment.RAC_HOST_TMUX_DIR!, 'default'), 'run-shell', tmuxFormatLiteral(command)], undefined, nativeTimeoutMs + 2_000);
    let timer: NodeJS.Timeout | undefined;
    let boundedAbort: (() => void) | undefined;
    const boundedResponse = new Promise<NativeWorkerResponse | undefined>(resolve => {
      // bound a worker that never reaches the socket
      timer = setTimeout(() => resolve(undefined), nativeTimeoutMs + 2_000);
      boundedAbort = () => resolve(undefined);
      signal.addEventListener('abort', boundedAbort, { once: true });
    });
    const [answer, launch] = await Promise.all([Promise.race([response.catch(() => undefined), boundedResponse]), launched.catch(() => undefined)]);
    // release the bounded response timer after either terminal path
    if (timer !== undefined) clearTimeout(timer);
    if (boundedAbort !== undefined) signal.removeEventListener('abort', boundedAbort);
    signal.removeEventListener('abort', abort);
    client?.destroy();
    server?.close();
    await rm(socketPath, { force: true });
    // launch status and verified runtime fingerprint both bind the result
    return launch?.code === 0 && host.fingerprint.length === 64 && !signal.aborted ? answer : undefined;
  }
}
