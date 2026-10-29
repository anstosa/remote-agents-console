/**
 * The holder (ADR 0016): runs one stdio child in its own tmux window and serves the child's stdio
 * on a Unix socket, so the child outlives the console. It never parses the child's lines.
 *
 *   node holder.js <socket> -- <program> [args...]
 *
 * The child's output lines are numbered from 0, and the latest `replayBytes` of them are kept.
 * A client's first line says how many it has read, `{"from":<n>}`; the holder answers
 * `{"holder":1,"pid":<child pid>,"from":<m>,"dropped":<m - n>}`, where `m` is the first line it
 * still has, replays every kept line from there, then passes the child's lines on as they come.
 * Every later line from the client goes whole to the child's stdin. One client at a time: a new
 * connection replaces the old. The child's stderr is the window's, so it stays readable there
 * after the child exits; the holder then exits with its status, and never restarts it.
 *
 * Only `node:` imports, so Node runs this file from source as well as compiled. Its protocol must
 * stay trivial: a running holder keeps its code across console deploys.
 */
import { spawn } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';

const replayBytes = 8 * 1024 * 1024;
const [socketPath, separator, program, ...args] = process.argv.slice(2);
if (socketPath === undefined || separator !== '--' || program === undefined) {
  process.stderr.write('usage: holder <socket> -- <program> [args...]\n');
  process.exit(2);
}

const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'inherit'] });
let client: Socket | undefined;
// the kept lines are numbered `first` up to `first + kept.length - 1`
const kept: string[] = [];
let first = 0;
let keptBytes = 0;
let paused = false;

// split on LF only: the child's lines are opaque, and may hold U+2028 or U+2029
const splitter = (onLine: (line: string) => void) => {
  let partial = '';
  return { push(chunk: string) { let end = chunk.indexOf('\n'); if (end !== -1) end += partial.length; partial += chunk; while (end !== -1) { onLine(partial.slice(0, end)); partial = partial.slice(end + 1); end = partial.indexOf('\n'); } }, rest: () => partial };
};

const resume = (): void => { paused = false; child.stdout.resume(); };
const send = (socket: Socket, line: string): void => {
  // hold the child while a slow client catches up
  if (!socket.write(`${line}\n`) && !paused) { paused = true; child.stdout.pause(); socket.once('drain', resume); }
};
const output = splitter(line => {
  kept.push(line);
  keptBytes += Buffer.byteLength(line) + 1;
  while (keptBytes > replayBytes && kept.length > 1) { keptBytes -= Buffer.byteLength(kept.shift()!) + 1; first += 1; }
  if (client !== undefined && !client.destroyed) send(client, line);
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => output.push(chunk));

rmSync(socketPath, { force: true });
const server = createServer(socket => {
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  let attached = false;
  const input = splitter(line => {
    if (attached) { child.stdin.write(`${line}\n`); return; }
    let read = Number.NaN;
    try { read = (JSON.parse(line) as { from?: unknown }).from as number; } catch { /* not a hello */ }
    if (!Number.isInteger(read) || read < 0) { socket.destroy(); return; }
    attached = true;
    if (client !== undefined) { client.destroy(); client = undefined; resume(); }
    client = socket;
    const from = Math.min(Math.max(read, first), first + kept.length);
    socket.write(`${JSON.stringify({ holder: 1, pid: child.pid ?? 0, from, dropped: Math.max(0, from - read) })}\n`);
    for (const line of kept.slice(from - first)) send(socket, line);
  });
  // only whole lines reach the child, so a client that drops mid-line corrupts nothing
  socket.on('data', (chunk: string) => input.push(chunk));
  // a client gone mid-backpressure no longer holds the child
  socket.on('close', () => { if (client === socket) { client = undefined; resume(); } });
});
server.on('error', error => { process.stderr.write(`holder: cannot serve ${socketPath}: ${error.message}\n`); child.kill('SIGTERM'); });
server.listen(socketPath, () => chmodSync(socketPath, 0o600));

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, () => { child.kill(signal); });
child.stdin.on('error', () => {});
child.on('error', error => { process.stderr.write(`holder: ${error.message}\n`); process.exit(127); });
child.on('close', (code, signal) => {
  if (output.rest() !== '') output.push('\n');
  process.stderr.write(`\n[holder] ${program} exited ${signal === null ? `with status ${code}` : `on ${signal}`}\n`);
  server.close();
  rmSync(socketPath, { force: true });
  const done = () => process.exit(code ?? 1);
  if (client !== undefined && !client.destroyed) client.end(done); else done();
});
