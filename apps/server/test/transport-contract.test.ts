import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { piAdapter } from '../src/adapters/pi.js';
import type { StructuredAdapter } from '../src/adapters/types.js';
import { LaunchService } from '../src/launch/service.js';
import { adhocScratchPlace } from '../src/places/places.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { run } from '../src/tmux/command.js';
import { interactiveShellName } from '../src/tmux/interactive-shell.js';
import { holderProcesses, type StructuredProcess, type StructuredProcesses } from '../src/transports/structured-agents.js';
import type { StructuredConnection, StructuredEvent } from '../src/transports/structured.js';
import type { SocketRef } from '../src/domain/models.js';
import { testConfig } from './helpers/config.js';
import { socketFinder } from './helpers/discovery-stubs.js';
import { stubModels, stubProvider } from './helpers/stub-provider.js';

// The Transport contract suite (ADR 0017's gate on pin bumps): each protocol client drives its
// pinned CLI under the real holder in a tmux window, against a stub OpenAI-compatible provider,
// through the console's own launch path. A second protocol client is one more entry in
// `clients`; the cases are shared. Unix sockets are blocked in the build sandbox, so this is
// skipped there and runs on the host and in CI.

// One protocol client under test: its Adapter, the launch arguments and environment that point
// its CLI at the stub provider and away from the operator's own state (the console reads the
// same Conversation store), and two of the stub's models: the one it starts on and one with Efforts.
type ContractClient = { name: string; adapter: StructuredAdapter; pinned: string; models: { start: string; reasoning: string }; stub(baseUrl: string, state: string): Promise<{ args: string[]; env: Record<string, string> }> };
const clients: ContractClient[] = [{
  name: 'pi',
  adapter: piAdapter,
  pinned: (JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8')) as { version: string }).version,
  models: { start: 'stub/echo', reasoning: 'stub/think' },
  async stub(baseUrl, state) {
    await writeFile(join(state, 'models.json'), stubModels(baseUrl));
    vi.stubEnv('PI_CODING_AGENT_DIR', state);
    return { args: ['--model', 'stub/echo'], env: { PI_CODING_AGENT_DIR: state, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' } };
  }
}];

const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();
// the window's login shell, as the console-shell suite resolves it (the default /usr/bin/zsh may not exist)
const loginShell = [process.env.RAC_INTERACTIVE_SHELL?.trim(), process.env.SHELL?.trim(), '/usr/bin/zsh', '/bin/bash'].find((path): path is string => path !== undefined && ['zsh', 'bash', 'fish'].includes(interactiveShellName(path)) && existsSync(path));
const tmuxSocketsWork = (() => {
  if (tmux === '' || process.platform !== 'linux') return false;
  let dir = '';
  try {
    dir = mkdtempSync(join(tmpdir(), 'rac-contract-probe-'));
    const socket = join(dir, 'sock');
    const started = spawnSync(tmux, ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'probe', 'sleep 1'], { encoding: 'utf8' });
    spawnSync(tmux, ['-S', socket, 'kill-server']);
    return started.status === 0;
  } catch {
    return false;
  } finally {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  }
})();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined); });

type Next = (type: StructuredEvent['type'], match?: (event: StructuredEvent) => boolean) => Promise<StructuredEvent>;
// events collected in order, and a wait for the next of a type after the last one awaited, so
// each wait moves forward in the stream (`describe` says what was running when it times out)
function collector(describe: () => Promise<string | undefined>): { events: StructuredEvent[]; emit: (event: StructuredEvent) => void; next: Next } {
  const events: StructuredEvent[] = [];
  const waiters: Array<() => void> = [];
  let seen = 0;
  const next: Next = async (type, match = () => true) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const index = events.findIndex((event, at) => at >= seen && event.type === type && match(event));
      if (index !== -1) { seen = index + 1; return events[index]!; }
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 250); });
    }
    throw new Error(`no ${type} event within 30 s; saw ${JSON.stringify(events)}; holder pane: ${await describe()}`);
  };
  return { events, emit: event => { events.push(event); for (const waiter of waiters.splice(0)) waiter(); }, next };
}

// launch `client`'s CLI under the holder in a Workspace session, its events collected in order
// (`env` reaches the holder and the CLI)
async function launched(client: ContractClient, toolCall?: NonNullable<Parameters<typeof stubProvider>[1]>['toolCall'], env: Record<string, string> = {}): Promise<{ connection: StructuredConnection; events: StructuredEvent[]; home: string; next: Next; started: StructuredProcess; processes: StructuredProcesses; socketPath: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-contract-')));
  const socketPath = join(root, 'tmux');
  const state = join(root, 'state');
  await mkdir(state);
  const provider = await stubProvider(undefined, { toolCall });
  cleanups.push(async () => { await provider.close(); await run(tmux, ['-S', socketPath, 'kill-server']); await rm(root, { recursive: true, force: true }); });
  const place = adhocScratchPlace(root);
  expect((await run(tmux, ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d', '-s', 'work', '-c', root, 'cat'])).code).toBe(0);
  expect((await run(tmux, ['-S', socketPath, 'set-option', '-t', 'work', '@rac_place', place.id])).code).toBe(0);
  const socket: SocketRef = { fingerprint: 'work', path: socketPath, device: 0, inode: 0 };
  const launch = new LaunchService(testConfig(), socketFinder([socket]), new TmuxAdapter(), undefined, undefined, () => [], () => new Set(), async () => ({ socket, session: 'work' }), join(root, 'private'));
  const stub = await client.stub(provider.baseUrl, state);
  const processes = holderProcesses(launch, { [client.adapter.kind]: { program: process.execPath, args: stub.args, env: { ...stub.env, ...env }, launchable: true } });
  let started: StructuredProcess | undefined;
  const { events, emit, next } = collector(async () => started === undefined ? undefined : await processes.stderr(started.holder));
  started = await processes.start({ id: 'contract', kind: client.adapter.kind, place }, emit);
  expect(started).toBeDefined();
  cleanups.push(async () => { started!.connection.close(); await processes.stop(started!.holder, { kind: client.adapter.kind, home: root }); });
  return { connection: started!.connection, events, home: root, next, started: started!, processes, socketPath };
}

// reconnect to a launched process as a console that restarted would, from the lines read through its last idle point
async function reattached(launch: Awaited<ReturnType<typeof launched>>, client: ContractClient, read: number) {
  const { events, emit, next } = collector(async () => await launch.processes.stderr(launch.started.holder));
  const attached = await launch.processes.attach({ ...launch.started.holder, read }, client.adapter.kind, emit);
  expect(attached).toBeDefined();
  return { connection: attached!.connection, events, next, dropped: attached!.dropped };
}
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(!tmuxSocketsWork || loginShell === undefined).each(clients)('the $name protocol client', client => {
  beforeEach(() => { vi.stubEnv('RAC_TMUX_BIN', tmux); vi.stubEnv('RAC_INTERACTIVE_SHELL', loginShell!); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it('reports in once launched, unsandboxed, on its pinned version', async () => {
    const { next } = await launched(client);
    const report = await next('report');
    expect(report).toMatchObject({ type: 'report', report: { loaded: true, sandbox: { engaged: false } } });
    expect((report as Extract<StructuredEvent, { type: 'report' }>).report.version).toBe(client.pinned);
    expect(await next('conversation')).toMatchObject({ id: expect.any(String) });
  }, 60_000);

  it('runs one Turn: started, the prompt, the answer, then settled with the answer', async () => {
    const { connection, events, next } = await launched(client);
    await next('report');
    expect(await connection.deliver('Say hello')).toBe('started');
    await next('turn', event => event.type === 'turn' && event.turn.type !== 'started');

    const turn = events.filter(event => event.type === 'turn' || event.type === 'transcript');
    expect(turn).toEqual([
      { type: 'turn', turn: { type: 'started' } },
      { type: 'transcript', item: { id: expect.any(String), kind: 'message', role: 'user', text: 'Say hello' } },
      { type: 'transcript', item: { id: expect.any(String), kind: 'message', role: 'assistant', text: 'Hello from the stub provider' } },
      { type: 'transcript', item: { id: expect.any(String), kind: 'settled', outcome: 'done', cost: expect.any(Number), toolCalls: 0 } },
      { type: 'turn', turn: { type: 'settled', message: 'Hello from the stub provider' } }
    ]);
    // the Turn's cost, from the stub model's price, is the Conversation's so far
    const ended = turn.find(event => event.type === 'transcript' && event.item.kind === 'settled') as Extract<StructuredEvent, { type: 'transcript' }>;
    const cost = ended.item.kind === 'settled' ? ended.item.cost : undefined;
    expect(cost).toBeGreaterThan(0);
    expect(await next('usage', event => event.type === 'usage' && event.usage.cost > 0)).toMatchObject({ usage: { cost: expect.closeTo(cost!, 9) } });
  }, 60_000);

  it('shows a tool call as one line, running and then with its result', async () => {
    const { connection, events, next } = await launched(client, { name: 'bash', arguments: { command: 'printf "one\\ntwo\\n"' } });
    await next('report');
    expect(await connection.deliver('Run it')).toBe('started');
    await next('turn', event => event.type === 'turn' && event.turn.type !== 'started');

    const lines = events.flatMap(event => event.type === 'transcript' && event.item.kind === 'tool' ? [event.item] : []);
    expect(lines[0]).toEqual({ id: 'call_stub', kind: 'tool', name: 'Run', summary: 'printf "one\\ntwo\\n"', state: 'running' });
    expect(lines.at(-1)).toEqual({ id: 'call_stub', kind: 'tool', name: 'Run', summary: 'printf "one\\ntwo\\n"', state: 'done', output: 'one\ntwo\n', durationMs: expect.any(Number) });
  }, 60_000);

  it('switches model and Effort between Turns, among the models it can reach', async () => {
    const { connection, next } = await launched(client);
    await next('report');
    expect(await next('model')).toMatchObject({ current: { model: client.models.start } });
    const reasoning = (await connection.models()).find(model => model.id === client.models.reasoning);
    expect(reasoning?.efforts).toContain('high');

    expect(await connection.setModel({ model: client.models.reasoning, effort: 'high' })).toBe(true);
    expect(await next('model')).toEqual({ type: 'model', current: { model: client.models.reasoning, effort: 'high' } });
    expect(await connection.setModel({ model: 'nowhere/nothing' })).toBe(false);
  }, 60_000);

  it('names, starts and switches Conversations in place, each keeping its own model', async () => {
    const { connection, next, home } = await launched(client);
    await next('report');
    const first = (await next('conversation') as Extract<StructuredEvent, { type: 'conversation' }>).id;
    expect(await connection.setModel({ model: client.models.reasoning, effort: 'high' })).toBe(true);
    expect(await connection.deliver('Say hello')).toBe('started');
    await next('turn', event => event.type === 'turn' && event.turn.type === 'settled');
    expect(await connection.renameConversation('First')).toBe(true);
    await next('conversation', event => event.type === 'conversation' && event.id === first && event.name === 'First');

    // a new Conversation keeps the current model and Effort
    expect(await connection.newConversation()).toBe(true);
    const second = (await next('conversation', event => event.type === 'conversation' && event.id !== first) as Extract<StructuredEvent, { type: 'conversation' }>).id;
    expect(await next('model')).toEqual({ type: 'model', current: { model: client.models.reasoning, effort: 'high' } });
    expect(await connection.setModel({ model: client.models.start, effort: 'off' })).toBe(true);

    // switching back restores the first Conversation's own model and name, and its store lists it
    const reference = await client.adapter.conversations.locate(first, home);
    expect(reference).toBeDefined();
    expect(await connection.switchConversation(reference!)).toBe(true);
    await next('conversation', event => event.type === 'conversation' && event.id === first && event.name === 'First');
    expect(await next('model')).toEqual({ type: 'model', current: { model: client.models.reasoning, effort: 'high' } });
    expect((await client.adapter.conversations.list([home])).map(row => row.id)).toEqual([first]);
    expect(second).not.toBe(first);
  }, 60_000);

  it('answers busy to a second prompt while a Turn runs', async () => {
    const { connection, next } = await launched(client);
    await next('report');
    expect(await connection.deliver('Reply slowly')).toBe('started');
    await next('turn', event => event.type === 'turn' && event.turn.type === 'started');
    expect(await connection.deliver('Second')).toBe('busy');
    expect(await next('turn')).toEqual({ type: 'turn', turn: { type: 'settled', message: 'Hello from the stub provider' } });
  }, 60_000);

  it('steers a working Agent: the steer is pending, then taken within the same Turn', async () => {
    const { connection, events, next } = await launched(client);
    await next('report');
    expect(await connection.deliver('Reply slowly')).toBe('started');
    await next('turn', event => event.type === 'turn' && event.turn.type === 'started');
    expect(await connection.steer('Also say goodbye')).toBe(true);
    expect(await next('steers')).toEqual({ type: 'steers', pending: ['Also say goodbye'] });
    expect(await next('steers')).toEqual({ type: 'steers', pending: [] });
    await next('turn');

    expect(events.filter(event => event.type === 'turn')).toEqual([{ type: 'turn', turn: { type: 'started' } }, { type: 'turn', turn: { type: 'settled', message: 'Hello from the stub provider' } }]);
    expect(events.filter(event => event.type === 'transcript' && event.item.kind === 'message' && event.item.role === 'user').map(event => (event as { item: { text: string } }).item.text)).toEqual(['Reply slowly', 'Also say goodbye']);
  }, 60_000);

  it('cancels a working Agent: its pending steers come back and the Turn ends aborted', async () => {
    const { connection, events, next } = await launched(client);
    await next('report');
    expect(await connection.deliver('Reply slowly')).toBe('started');
    await next('turn', event => event.type === 'turn' && event.turn.type === 'started');
    expect(await connection.steer('Never mind')).toBe(true);
    await next('steers');

    expect(await connection.cancel()).toEqual(['Never mind']);
    expect(await next('turn')).toEqual({ type: 'turn', turn: { type: 'aborted' } });
    expect(events.filter(event => event.type === 'transcript' && event.item.kind === 'message').map(event => (event as { item: { text: string } }).item.text)).toEqual(['Reply slowly']);
  }, 60_000);

  it('round-trips a dialog: the Agent asks the operator, naming its tool call, and the answer reaches it', async () => {
    const { connection, events, next } = await launched(client);
    await next('report');
    expect(await connection.deliver('Please ask me a question')).toBe('started');
    const asked = await next('question') as Extract<StructuredEvent, { type: 'question' }>;
    expect(asked.question).toMatchObject({ text: 'Which colour?', field: { kind: 'choice', choices: ['red', 'blue'] } });
    // the dialog named its tool call: that call's line waits on the answer
    const toolCallId = (events.find(event => event.type === 'transcript' && event.item.kind === 'tool' && event.item.name === 'Ask') as { item: { id: string } }).item.id;
    // the question shows once, in the question box: the tool line never carries it as arguments
    expect(events).toContainEqual({ type: 'transcript', item: expect.objectContaining({ id: toolCallId, kind: 'tool', name: 'Ask', summary: 'waiting for your answer below', state: 'running' }) });
    expect(JSON.stringify(events.filter(event => event.type === 'transcript'))).not.toContain('Which colour?');

    expect(await connection.answer(asked.question.id, 1)).toBe(true);
    expect(await next('question-closed')).toEqual({ type: 'question-closed', id: asked.question.id });
    expect(await next('turn')).toEqual({ type: 'turn', turn: { type: 'settled', message: 'You answered: blue' } });
    expect(events).toContainEqual({ type: 'transcript', item: expect.objectContaining({ id: toolCallId, kind: 'tool', name: 'Ask', summary: '', state: 'done', result: 'blue' }) });
    expect(await connection.answer(asked.question.id, 0)).toBe(false);
  }, 60_000);

  it('reconnects after the console\'s connection drops: the holder replays the Turn in flight, which completes', async () => {
    const launch = await launched(client);
    await launch.next('report');
    const idle = launch.started.cursor!();
    expect(await launch.connection.deliver('Reply slowly')).toBe('started');
    await launch.next('turn', event => event.type === 'turn' && event.turn.type === 'started');
    launch.connection.close();

    const again = await reattached(launch, client, idle);
    expect(again.events.some(event => event.type === 'report')).toBe(false);
    expect(await again.next('turn')).toEqual({ type: 'turn', turn: { type: 'started' } });
    expect(await again.next('turn')).toEqual({ type: 'turn', turn: { type: 'settled', message: 'Hello from the stub provider' } });
    // it read the Conversation afresh, as it never heard the launch
    expect(again.events).toContainEqual({ type: 'conversation', id: expect.any(String) });
    // the reconnected client drives the Agent on
    expect(await again.connection.deliver('Say hello')).toBe('started');
    expect(await again.next('turn', event => event.type === 'turn' && event.turn.type === 'settled')).toBeDefined();
  }, 60_000);

  it('after a replay that overflowed, resyncs: Pi\'s state says it works, and the Turn settles', async () => {
    // a replay buffer of one line: a reconnect from the launch report has lost lines
    const launch = await launched(client, undefined, { RAC_HOLDER_REPLAY_BYTES: '1' });
    await launch.next('report');
    expect(await launch.connection.deliver('Reply slowly')).toBe('started');
    await launch.next('turn', event => event.type === 'turn' && event.turn.type === 'started');
    launch.connection.close();

    const again = await reattached(launch, client, 0);
    expect(again.dropped).toBeGreaterThan(0);
    expect(await again.next('turn')).toEqual({ type: 'turn', turn: { type: 'started' } });
    expect(await again.next('turn')).toEqual({ type: 'turn', turn: { type: 'settled', message: 'Hello from the stub provider' } });
  }, 60_000);

  it('reports its process exiting, killed or its window closed by hand, and Close stops the process and removes the window', async () => {
    const killed = await launched(client);
    await killed.next('report');
    process.kill(killed.started.holder.pid!, 'SIGKILL');
    expect(await killed.next('exited')).toEqual({ type: 'exited' });
    expect(await killed.processes.stderr(killed.started.holder)).toContain('exited on SIGKILL');

    const byHand = await launched(client);
    await byHand.next('report');
    expect((await run(tmux, ['-S', byHand.socketPath, 'kill-window', '-t', byHand.started.holder.pane])).code).toBe(0);
    expect(await byHand.next('exited')).toEqual({ type: 'exited' });

    const closed = await launched(client);
    await closed.next('report');
    const pid = closed.started.holder.pid!;
    await closed.processes.stop(closed.started.holder, { kind: client.adapter.kind, home: closed.home });
    expect(running(pid)).toBe(false);
    expect(await closed.processes.stderr(closed.started.holder)).toBeUndefined();
    expect(await closed.next('exited')).toEqual({ type: 'exited' });
  }, 90_000);
});
