/**
 * A command Watch's process (ADR 0019): run under the holder in its owner's Workspace, it runs one
 * shell command under the owner's sandbox policy, as the RAC Pi extension runs the model's `bash`:
 * the rendered policy (`RAC_SANDBOX_POLICY`) plus this session's own paths (its folder writable,
 * Pi's state directory protected, its git, a temp directory, the tmux socket), and only the
 * allowlisted environment. The policy is Pi's: Pi is the only kind with a sandbox. The command's stdout is this process's,
 * its stderr the window's, and this process exits with its status. It never runs the command
 * unsandboxed: when the sandbox cannot start, it says why on stderr and exits 126.
 *
 *   node sandboxed-command.js <command>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { commandEnv, piStateDir, sessionPolicyFrom, type SandboxPolicy } from '../adapters/pi-sandbox.js';

const command = process.argv[2];
const policyFile = process.env.RAC_SANDBOX_POLICY;
const tempDir = mkdtempSync(join(tmpdir(), 'rac-watch-'));
const done = (code: number): never => { rmSync(tempDir, { recursive: true, force: true }); process.exit(code); };

let wrapped: string;
let policy: SandboxPolicy;
try {
  if (command === undefined || command.trim() === '') throw new Error('no command was given');
  if (policyFile === undefined || policyFile === '') throw new Error('no sandbox policy was given');
  // read from this process's own environment, as the Agent's process reads it
  policy = sessionPolicyFrom(policyFile, { cwd: process.cwd(), stateDir: piStateDir(process.env), tempDir }, process.env);
  // the runtime points the command's TMPDIR here
  process.env.CLAUDE_CODE_TMPDIR = tempDir;
  await SandboxManager.initialize({ network: policy.network, filesystem: policy.filesystem });
  wrapped = await SandboxManager.wrapWithSandbox(command, '/bin/bash');
} catch (error) {
  process.stderr.write(`The sandbox did not start, so the command was not run: ${error instanceof Error ? error.message : String(error)}\n`);
  done(126);
}

const child = spawn('/bin/bash', ['-c', wrapped!], { stdio: 'inherit', env: commandEnv(process.env, policy!.env) });
for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, () => { child.kill(signal); });
child.on('close', (code, signal) => {
  SandboxManager.cleanupAfterCommand();
  void SandboxManager.reset().catch(() => undefined).finally(() => done(code ?? 128 + (signal === null ? 0 : constants.signals[signal])));
});
