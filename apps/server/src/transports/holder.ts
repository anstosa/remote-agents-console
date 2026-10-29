/**
 * The holder (ADR 0016): runs one stdio child in its own tmux window and serves the child's stdio
 * on a Unix socket, so the child outlives the console. It never parses the child's lines.
 *
 *   node holder.js <socket> -- <program> [args...]
 *
 * One client at a time; a new connection replaces the old. Each connection first receives the
 * hello `{"holder":1,"pid":<child pid>,"dropped":<n>}`, then every line the child wrote while no
 * client was connected (at most `replayBytes` of them; `dropped` counts the oldest ones that did
 * not fit), then the child's lines as they come. Complete lines from the client go to the child's
 * stdin. The child's stderr is the window's, so it stays readable there after the child exits.
 * When the child exits the holder exits with its status, and it never restarts it.
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
let unread: string[] = [];
let unreadBytes = 0;
let dropped = 0;

// split on LF only: the child's lines are opaque, and may hold U+2028 or U+2029
const splitter = (onLine: (line: string) => void) => {
  let partial = '';
  return { push(chunk: string) { partial += chunk; let end = partial.indexOf('\n'); while (end !== -1) { onLine(partial.slice(0, end)); partial = partial.slice(end + 1); end = partial.indexOf('\n'); } }, rest: () => partial };
};

const forward = (line: string): void => {
  if (client !== undefined && !client.destroyed) {
    // hold the child while a slow client catches up
    if (!client.write(`${line}\n`)) { child.stdout.pause(); client.once('drain', () => child.stdout.resume()); }
    return;
  }
  unread.push(line);
  unreadBytes += Buffer.byteLength(line) + 1;
  while (unreadBytes > replayBytes && unread.length > 0) { unreadBytes -= Buffer.byteLength(unread.shift()!) + 1; dropped += 1; }
};
const output = splitter(forward);
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => output.push(chunk));

rmSync(socketPath, { force: true });
const server = createServer(socket => {
  client?.destroy();
  client = socket;
  socket.setEncoding('utf8');
  socket.write(`${JSON.stringify({ holder: 1, pid: child.pid ?? 0, dropped })}\n`);
  for (const line of unread) socket.write(`${line}\n`);
  unread = []; unreadBytes = 0; dropped = 0;
  child.stdout.resume();
  // only whole lines reach the child, so a client that drops mid-line corrupts nothing
  const input = splitter(line => { child.stdin.write(`${line}\n`); });
  socket.on('data', (chunk: string) => input.push(chunk));
  socket.on('error', () => {});
  // a client gone mid-backpressure no longer holds the child; its lines buffer for the next one
  socket.on('close', () => { if (client === socket) { client = undefined; child.stdout.resume(); } });
});
server.on('error', error => { process.stderr.write(`holder: cannot serve ${socketPath}: ${error.message}\n`); child.kill('SIGTERM'); });
server.listen(socketPath, () => chmodSync(socketPath, 0o600));

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(signal, () => { child.kill(signal); });
child.stdin.on('error', () => {});
child.on('error', error => { process.stderr.write(`holder: ${error.message}\n`); process.exit(127); });
child.on('close', (code, signal) => {
  if (output.rest() !== '') forward(output.rest());
  process.stderr.write(`\n[holder] ${program} exited ${signal === null ? `with status ${code}` : `on ${signal}`}\n`);
  server.close();
  rmSync(socketPath, { force: true });
  const done = () => process.exit(code ?? 1);
  if (client !== undefined && !client.destroyed) client.end(done); else done();
});
