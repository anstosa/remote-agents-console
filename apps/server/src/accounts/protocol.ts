import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { record } from './validation.js';

export type CodexProtocolNotification = { method: string; params?: unknown };
export type CodexProtocolNotificationListener = (notification: CodexProtocolNotification) => void;

export interface CodexProtocolClient {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(listener: CodexProtocolNotificationListener): () => void;
  close(): Promise<void>;
}

export type CodexProtocolClientFactory = (codexHome: string, options?: JsonlClientOptions) => Promise<CodexProtocolClient>;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

export type JsonlClientOptions = {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

const maxProtocolLineBytes = 1024 * 1024;

export class JsonlCodexProtocolClient implements CodexProtocolClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<CodexProtocolNotificationListener>();
  private readonly lines: ReadlineInterface;
  private closed = false;

  // start an isolated app-server
  constructor(
    private readonly child: ChildProcessWithoutNullStreams
  ) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    // consume protocol lines
    this.lines.on('line', line => this.handleLine(line));
    // reject after spawn errors
    child.on('error', () => this.fail(new Error('Codex app-server failed')));
    // reject after unexpected exits
    child.on('exit', () => this.fail(new Error('Codex app-server exited')));
    // drain diagnostics without surfacing secrets
    child.stderr.resume();
  }

  // send a json-rpc request
  request(method: string, params?: unknown): Promise<unknown> {
    // reject closed clients
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = this.nextId++;
    const message: Record<string, unknown> = { method, id };
    // preserve parameter omission
    if (params !== undefined) message.params = params;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // reject failed writes
      this.child.stdin.write(`${JSON.stringify(message)}\n`, error => {
        // ignore successful writes
        if (!error) return;
        this.pending.delete(id);
        reject(new Error('Codex app-server request failed'));
      });
    });
  }

  // send a json-rpc notification
  notify(method: string, params?: unknown): void {
    // ignore closed clients
    if (this.closed) return;
    const message: Record<string, unknown> = { method };
    // preserve parameter omission
    if (params !== undefined) message.params = params;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  // subscribe to server notifications
  onNotification(listener: CodexProtocolNotificationListener): () => void {
    this.listeners.add(listener);
    // remove the exact listener
    return () => this.listeners.delete(listener);
  }

  // terminate the child and reject requests
  async close(): Promise<void> {
    // make cleanup idempotent
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    this.rejectPending(new Error('Codex app-server closed'));
    // skip waiting for exited children
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const force = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 250);
      force.unref();
      // finish after graceful exit
      this.child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
    });
  }

  // route one protocol line
  private handleLine(line: string): void {
    // reject oversized protocol output
    if (Buffer.byteLength(line) > maxProtocolLineBytes) {
      this.fail(new Error('Codex app-server response was too large'));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      this.fail(new Error('Codex app-server returned invalid JSON'));
      return;
    }
    const message = record(value);
    // reject invalid envelopes
    if (!message) {
      this.fail(new Error('Codex app-server returned an invalid response'));
      return;
    }
    // resolve matching responses
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      // ignore unknown response ids
      if (!pending) return;
      this.pending.delete(message.id);
      // reject protocol errors without their potentially sensitive payload
      if ('error' in message) pending.reject(new Error('Codex app-server rejected the request'));
      else pending.resolve(message.result);
      return;
    }
    // publish notifications only
    if (typeof message.method !== 'string') return;
    const notification = { method: message.method, ...('params' in message ? { params: message.params } : {}) };
    // notify current subscribers
    for (const listener of this.listeners) listener(notification);
  }

  // fail the client once
  private fail(error: Error): void {
    // avoid duplicate cleanup
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.stdin.destroy();
    this.child.kill('SIGTERM');
    this.rejectPending(error);
    // force cleanup only for a still-running child
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const force = setTimeout(() => this.child.kill('SIGKILL'), 250);
      force.unref();
      // cancel force after normal exit
      this.child.once('exit', () => clearTimeout(force));
    }
  }

  // reject all outstanding requests
  private rejectPending(error: Error): void {
    // reject each request once
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

// spawn the installed codex app-server
export async function createCodexProtocolClient(codexHome: string, options: JsonlClientOptions = {}): Promise<CodexProtocolClient> {
  // never spawn a bare `codex` from PATH; the console configures an absolute program
  if (options.command === undefined) throw new Error('Codex binary is not configured');
  // exclude server-only billing access from all protocol subprocesses
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, CODEX_HOME: codexHome };
  delete env.RAC_OPENAI_ADMIN_KEY;
  delete env.RAC_OPENAI_API_KEY_IDS;
  const child = spawn(options.command, options.args ?? ['app-server', '--listen', 'stdio://'], {
    env,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  return new JsonlCodexProtocolClient(child);
}

// perform the required app-server handshake
export async function initializeCodexProtocol(client: CodexProtocolClient): Promise<void> {
  await client.request('initialize', {
    clientInfo: { name: 'remote-agent-console', title: 'Remote Agent Console', version: '1.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false }
  });
  client.notify('initialized');
}
