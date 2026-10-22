import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { safeEnv } from '../tmux/command.js';
import { ReviewRunError } from './runner.js';

const MAX_REVIEW_DIAGNOSTIC_CHARACTERS = 16_384;

export type ReviewProcessSpec = { binary: string; args: string[]; cwd?: string; stdin: string; timeoutMs: number; maxStdoutBytes?: number };
// a finished process: its exit code, a bounded stderr tail, and stdout when it was captured
// (only its first `maxStdoutBytes`, `overflowed`, once it passed them; the rest is drained, not kept)
export type ReviewProcessResult = { code: number; diagnostics: string; stdout: Buffer; overflowed: boolean };

// terminate the full generation tree
async function terminate(child: ChildProcess): Promise<void> {
  // stop an active process group
  if (child.pid !== undefined && child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await new Promise(resolve => setTimeout(resolve, 1_000));
    // force remaining descendants down
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }
}

// retain a bounded diagnostic tail while draining stderr
function collectDiagnostics(stream: Readable): () => string {
  let diagnostics = '';
  stream.setEncoding('utf8');
  // keep only the most recent diagnostic output
  stream.on('data', (chunk: string) => { diagnostics = `${diagnostics}${chunk}`.slice(-MAX_REVIEW_DIAGNOSTIC_CHARACTERS); });
  return () => diagnostics;
}

// retain a bounded stdout head while draining the rest
function collectOutput(stream: Readable, limit: number): () => { stdout: Buffer; overflowed: boolean } {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  // stop keeping output past the bound, but keep reading so the child never blocks
  stream.on('data', (chunk: Buffer) => {
    if (overflowed) return;
    if (size + chunk.length > limit) { overflowed = true; chunks.push(chunk.subarray(0, limit - size)); return; }
    size += chunk.length;
    chunks.push(chunk);
  });
  return () => ({ stdout: Buffer.concat(chunks), overflowed });
}

// run one Review run CLI in its own process group, with the prompt on stdin, killing the
// whole group on timeout or caller cancellation; a cancelled or timed-out run throws
export async function runReviewProcess(spec: ReviewProcessSpec, signal: AbortSignal): Promise<ReviewProcessResult> {
  const capture = spec.maxStdoutBytes !== undefined;
  const child = spawn(spec.binary, spec.args, { shell: false, detached: true, env: safeEnv(), stdio: ['pipe', capture ? 'pipe' : 'ignore', 'pipe'], ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }) });
  const diagnostics = collectDiagnostics(child.stderr!);
  const output = capture ? collectOutput(child.stdout!, spec.maxStdoutBytes!) : () => ({ stdout: Buffer.alloc(0), overflowed: false });
  const timedOut = new AbortController();
  const timer = setTimeout(() => timedOut.abort(), spec.timeoutMs);
  let abortedByTimeout = false;
  // stop on server timeout
  const timeoutAbort = () => { abortedByTimeout = true; void terminate(child); };
  // stop on caller cancellation
  const requestAbort = () => { void terminate(child); };
  timedOut.signal.addEventListener('abort', timeoutAbort, { once: true });
  signal.addEventListener('abort', requestAbort, { once: true });
  try {
    // reject already-cancelled requests
    if (signal.aborted) throw new ReviewRunError('cancelled', true);
    // a child that exits before reading its prompt must not crash the server with EPIPE
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(spec.stdin);
    const code = await new Promise<number>((resolve, reject) => {
      // surface spawn failures
      child.once('error', reject);
      child.once('close', value => resolve(value ?? -1));
    }).catch(() => -1);
    // preserve cancellation distinctions
    if (signal.aborted) throw new ReviewRunError('cancelled', true);
    // report timeout distinctly
    if (abortedByTimeout) throw new ReviewRunError('timed_out', true);
    return { code, diagnostics: diagnostics(), ...output() };
  } finally {
    clearTimeout(timer);
    timedOut.signal.removeEventListener('abort', timeoutAbort);
    signal.removeEventListener('abort', requestAbort);
    await terminate(child);
  }
}
