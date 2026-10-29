import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { piAdapter } from '../src/adapters/pi.js';
import type { StructuredAdapter } from '../src/adapters/types.js';
import { LaunchService } from '../src/launch/service.js';
import { adhocScratchPlace } from '../src/places/places.js';
import { TmuxAdapter } from '../src/tmux/adapter.js';
import { run } from '../src/tmux/command.js';
import { interactiveShellName } from '../src/tmux/interactive-shell.js';
import { holderProcesses } from '../src/transports/structured-agents.js';
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

// One protocol client under test: its Adapter, and the launch arguments and environment that point
// its CLI at the stub provider and away from the operator's own state.
type ContractClient = { name: string; adapter: StructuredAdapter; pinned: string; stub(baseUrl: string, state: string): Promise<{ args: string[]; env: Record<string, string> }> };
const clients: ContractClient[] = [{
  name: 'pi',
  adapter: piAdapter,
  pinned: (JSON.parse(readFileSync(new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8')) as { version: string }).version,
  async stub(baseUrl, state) {
    await writeFile(join(state, 'models.json'), stubModels(baseUrl));
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

// launch `client`'s CLI under the holder in a Workspace session, its events collected in order
async function launched(client: ContractClient, toolCall?: Parameters<typeof stubProvider>[1]): Promise<{ connection: StructuredConnection; events: StructuredEvent[]; next(type: StructuredEvent['type'], match?: (event: StructuredEvent) => boolean): Promise<StructuredEvent> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-contract-')));
  const socketPath = join(root, 'tmux');
  const state = join(root, 'state');
  await mkdir(state);
  const provider = await stubProvider(undefined, toolCall);
  cleanups.push(async () => { await provider.close(); await run(tmux, ['-S', socketPath, 'kill-server']); await rm(root, { recursive: true, force: true }); });
  const place = adhocScratchPlace(root);
  expect((await run(tmux, ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d', '-s', 'work', '-c', root, 'cat'])).code).toBe(0);
  expect((await run(tmux, ['-S', socketPath, 'set-option', '-t', 'work', '@rac_place', place.id])).code).toBe(0);
  const socket: SocketRef = { fingerprint: 'work', path: socketPath, device: 0, inode: 0 };
  const launch = new LaunchService(testConfig(), socketFinder([socket]), new TmuxAdapter(), undefined, undefined, () => [], () => new Set(), async () => ({ socket, session: 'work' }), join(root, 'private'));
  const stub = await client.stub(provider.baseUrl, state);
  const processes = holderProcesses(launch, { [client.adapter.kind]: { program: process.execPath, args: stub.args, env: stub.env, launchable: true } });
  const events: StructuredEvent[] = [];
  const waiters: Array<() => void> = [];
  const started = await processes.start({ id: 'contract', kind: client.adapter.kind, place }, event => { events.push(event); for (const waiter of waiters.splice(0)) waiter(); });
  expect(started).toBeDefined();
  cleanups.push(async () => { started!.connection.close(); await processes.stop(started!.holder, { kind: client.adapter.kind, home: root }); });
  let seen = 0;
  // the next event of `type` after the last one awaited, so each wait moves forward in the stream
  const next = async (type: StructuredEvent['type'], match: (event: StructuredEvent) => boolean = () => true): Promise<StructuredEvent> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const index = events.findIndex((event, at) => at >= seen && event.type === type && match(event));
      if (index !== -1) { seen = index + 1; return events[index]!; }
      await new Promise<void>(resolve => { waiters.push(resolve); setTimeout(resolve, 250); });
    }
    throw new Error(`no ${type} event within 30 s; saw ${JSON.stringify(events)}; holder pane: ${await processes.stderr(started!.holder)}`);
  };
  return { connection: started!.connection, events, next };
}

describe.skipIf(!tmuxSocketsWork || loginShell === undefined).each(clients)('the $name protocol client', client => {
  beforeAll(() => { vi.stubEnv('RAC_TMUX_BIN', tmux); vi.stubEnv('RAC_INTERACTIVE_SHELL', loginShell!); });
  afterAll(() => { vi.unstubAllEnvs(); });
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
      { type: 'transcript', item: { id: expect.any(String), kind: 'settled', outcome: 'done', cost: expect.any(Number) } },
      { type: 'turn', turn: { type: 'settled', message: 'Hello from the stub provider' } }
    ]);
    expect(await next('usage')).toMatchObject({ usage: { cost: expect.any(Number) } });
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
});
