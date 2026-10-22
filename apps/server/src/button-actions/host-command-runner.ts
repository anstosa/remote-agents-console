import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { run, tmuxFormatLiteral } from '../tmux/command.js';
import { serverCheckout, serverCheckoutOnHost } from '../workspaces/server-checkout.js';
import type { ValidatedConfig } from '../config/schema.js';

export type DirectoryExecutionLease = { canonicalHostPath: string; backendGeneration: string; expiresAt: number; identity: { dev: string; ino: string; kind: 'directory' }; current(): boolean };
export type ShellActionResult = { state: 'complete' | 'failed' | 'interrupted'; exitCode?: number; error?: string };
export type HostCommandInput = { command: string; cwd: string; lease?: DirectoryExecutionLease };
type Command = (binary: string, args: string[]) => Promise<{ code: number; stdout: string; stderr?: string }>;

// quote trusted scripts separately from context-derived paths
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// own one detached host process and its exact exit marker
export class HostCommandRunner {
  private readonly socketArgs: string[];
  private readonly binary: string;
  private readonly hostCheckout: string | undefined;
  private closed = false;

  // preserve the native versus bridged namespace boundary
  constructor(config: Pick<ValidatedConfig, 'projects'>, private readonly command: Command = run, private readonly checkout = serverCheckout(), private readonly pollMs = 250) {
    const socket = process.env.RAC_HOST_TMUX_DIR;
    this.socketArgs = socket === undefined ? [] : ['-S', join(socket, 'default')];
    this.binary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
    this.hostCheckout = socket === undefined ? checkout : serverCheckoutOnHost(config.projects, process.env.RAC_HOST_REPOSITORY?.trim() || process.env.RAC_HOST_WORKSPACE, checkout);
  }

  // stop observers without replaying or killing an uncertain host action
  close(): void { this.closed = true; }

  // wait for the command's exit rather than tmux creation or disappearance
  async execute(input: HostCommandInput): Promise<ShellActionResult> {
    // refuse container execution when the host checkout cannot be proven
    if (this.closed || this.hostCheckout === undefined) return { state: 'failed', error: 'host_execution_unavailable' };
    // bind a Files click to its current backend and token lifetime
    if (input.lease !== undefined && (!input.lease.current() || input.lease.expiresAt < Date.now())) return { state: 'failed', error: 'files_context_changed' };
    const session = `rac-button-${randomBytes(18).toString('hex')}`;
    let directory: string | undefined;
    let terminal = false;
    let uncertain = false;
    try {
      const parent = join(this.checkout, '.data', 'button-actions');
      await mkdir(parent, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(parent, 'action-'));
      const name = directory.slice(parent.length + 1);
      const hostDirectory = join(this.hostCheckout, '.data', 'button-actions', name);
      const marker = join(directory, 'exit');
      const hostMarker = join(hostDirectory, 'exit');
      const hostLog = join(hostDirectory, 'output');
      const path = process.env.RAC_HOST_PATH?.trim();
      const configured = `${path ? `export PATH=${quote(path)}; ` : ''}${input.command}`;
      const identity = input.lease?.identity;
      const check = identity === undefined ? '' : ` && [ "$(LC_ALL=C /usr/bin/stat -Lc '%d:%i:%F' -- .)" = ${quote(`${identity.dev}:${identity.ino}:directory`)} ]`;
      // inspect the opened cwd before any configured bytes and keep output bounded
      // inherit the outer login environment without rerunning startup files that can change cwd
      const script = `umask 077; if cd -- ${quote(input.cwd)}${check}; then BASH_ENV= /bin/bash -c ${quote(configured)} > >(/usr/bin/tail -c 65536 > ${quote(hostLog)}) 2>&1; code=$?; else code=125; fi; printf '%s' "$code" > ${quote(`${hostMarker}.next`)} && /bin/mv -- ${quote(`${hostMarker}.next`)} ${quote(hostMarker)}`;
      // generation changes before scheduling must not retarget this capability
      if (input.lease !== undefined && (!input.lease.current() || input.lease.expiresAt < Date.now())) return { state: 'failed', error: 'files_context_changed' };
      // a lost create response may still have started the host command
      uncertain = true;
      const started = await this.command(this.binary, [...this.socketArgs, 'new-session', '-d', '-s', session, '-c', tmuxFormatLiteral(this.hostCheckout), '/bin/bash', '-lc', script]);
      // a refused session cannot have a successful command outcome
      if (started.code !== 0) { uncertain = false; return { state: 'failed', error: 'command_start_failed' }; }
      // active work has no elapsed-time completion fallback
      while (!this.closed) {
        const value = await readFile(marker, 'utf8').catch(() => undefined);
        // accept only a complete integer exit record
        if (value !== undefined) {
          terminal = true;
          // malformed markers are uncertainty rather than success
          if (!/^(?:0|[1-9]\d{0,2})$/u.test(value) || Number(value) > 255) return { state: 'interrupted', error: 'command_status_invalid' };
          const exitCode = Number(value);
          return { state: exitCode === 0 ? 'complete' : 'failed', exitCode, ...(exitCode === 0 ? {} : { error: 'command_failed' }) };
        }
        const current = await this.command(this.binary, [...this.socketArgs, 'has-session', '-t', `=${session}`]);
        // disappearance alone never proves a successful exit
        if (current.code !== 0) {
          const final = await readFile(marker, 'utf8').catch(() => undefined);
          // close the marker-read versus session-exit race
          if (final !== undefined && /^(?:0|[1-9]\d{0,2})$/u.test(final) && Number(final) <= 255) {
            terminal = true;
            const exitCode = Number(final);
            return { state: exitCode === 0 ? 'complete' : 'failed', exitCode, ...(exitCode === 0 ? {} : { error: 'command_failed' }) };
          }
          return { state: 'interrupted', error: 'command_status_lost' };
        }
        // unref polling so server shutdown does not await an arbitrary user command
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, this.pollMs); timer.unref(); });
      }
      return { state: 'interrupted', error: 'server_stopped' };
    } catch { return { state: 'interrupted', error: 'host_execution_unavailable' }; }
    finally {
      // clean refused starts and terminal artifacts but preserve uncertain writers
      if (directory !== undefined && (terminal || !uncertain)) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
