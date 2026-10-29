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
import { cleanWorkingTree } from '../src/git/worktree-state.js';
import { interactiveShellName } from '../src/tmux/interactive-shell.js';
import { holderProcesses, type StructuredProcess, type StructuredProcesses } from '../src/transports/structured-agents.js';
import type { StructuredConnection, StructuredEvent } from '../src/transports/structured.js';
import type { SocketRef } from '../src/domain/models.js';
import { testConfig } from './helpers/config.js';
import { socketFinder } from './helpers/discovery-stubs.js';
import { stubModels, stubProvider, type StubReply } from './helpers/stub-provider.js';
import { stubMcp } from './helpers/stub-mcp.js';

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

// How a case launches: Sandboxed or not, the provider's scripted replies (or the one tool call it
// makes first), environment the CLI and its holder get beyond the stub's (the operator's
// `adapters.<kind>.env`), the policy's extra names, and whether the place is a repository's main
// checkout or a linked Worktree of one.
type LaunchOptions = { sandboxed?: boolean; replies?: StubReply[]; toolCall?: { name: string; arguments: object }; env?: Record<string, string>; sandboxEnv?: string[]; git?: 'main' | 'linked'; role?: 'conductor' };
const nonce = 'contract-nonce-0123456789abcdef';

// launch `client`'s CLI under the holder in a Workspace session, its events collected in order;
// the place is `<root>/place` (a repository, or a linked Worktree of `<root>/repo`, when asked),
// the console's private directory `<root>/private`
async function launched(client: ContractClient, { sandboxed = false, replies, toolCall, env = {}, sandboxEnv = [], git: checkout, role }: LaunchOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-contract-')));
  const socketPath = join(root, 'tmux');
  const state = join(root, 'state');
  const home = join(root, 'place');
  await mkdir(state);
  const git = (...args: string[]) => run('git', ['-c', 'user.name=Contract', '-c', 'user.email=contract@example.com', ...args]);
  const repository = checkout === 'linked' ? join(root, 'repo') : home;
  if (checkout === undefined) await mkdir(home);
  else {
    expect((await git('init', '-q', repository)).code).toBe(0);
    expect((await git('-C', repository, 'commit', '-q', '--allow-empty', '-m', 'init')).code).toBe(0);
    if (checkout === 'linked') expect((await git('-C', repository, 'worktree', 'add', '-q', home)).code).toBe(0);
  }
  const provider = await stubProvider(undefined, { ...(toolCall === undefined ? {} : { toolCall }), ...(replies === undefined ? {} : { replies }) });
  vi.stubEnv('RAC_ADAPTER_FILES_DIR', join(root, 'files'));
  cleanups.push(async () => { await provider.close(); await run(tmux, ['-S', socketPath, 'kill-server']); await rm(root, { recursive: true, force: true }); });
  const place = adhocScratchPlace(home);
  expect((await run(tmux, ['-f', '/dev/null', '-S', socketPath, 'new-session', '-d', '-s', 'work', '-c', home, 'cat'])).code).toBe(0);
  expect((await run(tmux, ['-S', socketPath, 'set-option', '-t', 'work', '@rac_place', place.id])).code).toBe(0);
  const socket: SocketRef = { fingerprint: 'work', path: socketPath, device: 0, inode: 0 };
  const stub = await client.stub(provider.baseUrl, state);
  const configured = { program: process.execPath, args: stub.args, env: { ...stub.env, ...env }, launchable: true, sandbox: { allowedDomains: [], deniedDomains: [], allowWrite: [], denyWrite: [], denyRead: [], env: sandboxEnv } };
  const launch = new LaunchService(testConfig({ adapters: { [client.adapter.kind]: configured } }), socketFinder([socket]), new TmuxAdapter(), undefined, undefined, () => [], () => new Set(), async () => ({ socket, session: 'work' }), join(root, 'private'));
  const processes = holderProcesses(launch, { [client.adapter.kind]: configured }, kind => launch.adapterFiles(kind));
  let started: StructuredProcess | undefined;
  const { events, emit, next } = collector(async () => started === undefined ? undefined : await processes.stderr(started.holder));
  started = await processes.start({ id: 'contract', kind: client.adapter.kind, place, sandboxed, nonce, ...(role === undefined ? {} : { role }) }, emit);
  expect(started).toBeDefined();
  cleanups.push(async () => { started!.connection.close(); await processes.stop(started!.holder, { kind: client.adapter.kind, home }); });
  // what the CLI told the provider a tool call returned, for the `n`th completion's request (from 0)
  const toolResult = (n: number): string => JSON.stringify((JSON.parse(provider.bodies[n] ?? '{}') as { messages?: Array<{ role: string; content: unknown }> }).messages?.filter(message => message.role === 'tool').at(-1)?.content ?? '');
  return { connection: started!.connection, events, next, toolResult, bodies: provider.bodies, root, home, started: started!, processes, socketPath };
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
  it('reports in once launched, unsandboxed, on its pinned version, with its launch\'s nonce', async () => {
    const { next, events } = await launched(client);
    const report = await next('report');
    expect(report).toMatchObject({ type: 'report', report: { loaded: true, sandbox: { engaged: false }, nonce } });
    expect(events).toContainEqual({ type: 'status', key: 'rac-sandbox', text: 'not sandboxed' });
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
    const { connection, events, next } = await launched(client, { replies: [{ tool: 'bash', args: { command: 'printf "one\\ntwo\\n"' } }, 'Hello from the stub provider'] });
    await next('report');
    expect(await connection.deliver('Run it')).toBe('started');
    await next('turn', event => event.type === 'turn' && event.turn.type !== 'started');

    const lines = events.flatMap(event => event.type === 'transcript' && event.item.kind === 'tool' ? [event.item] : []);
    expect(lines[0]).toEqual({ id: 'call_1', kind: 'tool', name: 'Run', summary: 'printf "one\\ntwo\\n"', state: 'running' });
    expect(lines.at(-1)).toEqual({ id: 'call_1', kind: 'tool', name: 'Run', summary: 'printf "one\\ntwo\\n"', state: 'done', output: 'one\ntwo\n', durationMs: expect.any(Number) });
  }, 60_000);

  // a Turn that makes the scripted tool calls, then answers; resolves once it settles
  const turn = async (agent: Awaited<ReturnType<typeof launched>>) => {
    expect(await agent.connection.deliver('Use the tools')).toBe('started');
    await agent.next('turn', event => event.type === 'turn' && event.turn.type !== 'started');
  };

  it('reports its sandbox engaged when launched Sandboxed', async () => {
    const { next, events } = await launched(client, { sandboxed: true });
    expect(await next('report')).toMatchObject({ report: { sandbox: { engaged: true }, nonce } });
    expect(events).toContainEqual({ type: 'status', key: 'rac-sandbox', text: 'sandboxed' });
  }, 60_000);

  it('confines a Sandboxed Agent\'s commands and file tools to its Place', async () => {
    const agent = await launched(client, { sandboxed: true, replies: [
      { tool: 'bash', args: { command: 'touch ../outside-bash.txt; touch inside-bash.txt; ls -A ../private' } },
      { tool: 'write', args: { path: '../outside-write.txt', content: 'x' } },
      { tool: 'write', args: { path: 'inside-write.txt', content: 'x' } },
      'done'
    ] });
    expect(await agent.next('report')).toMatchObject({ report: { sandbox: { engaged: true } } });
    await turn(agent);
    expect(existsSync(join(agent.root, 'outside-bash.txt'))).toBe(false);
    expect(existsSync(join(agent.home, 'inside-bash.txt'))).toBe(true);
    // the console's private directory, where holder sockets live, is hidden from commands
    expect(agent.toolResult(1)).not.toContain('holders');
    expect(agent.toolResult(2)).toContain('outside the paths the sandbox may write');
    expect(existsSync(join(agent.root, 'outside-write.txt'))).toBe(false);
    expect(existsSync(join(agent.home, 'inside-write.txt'))).toBe(true);
  }, 60_000);

  it('gives a Sandboxed Agent\'s commands only the allowlisted environment, and no tmux', async () => {
    const agent = await launched(client, { sandboxed: true, env: { OPENROUTER_API_KEY: 'sk-contract', CONTRACT_KEPT: 'kept', LC_CONTRACT: 'locale' }, sandboxEnv: ['CONTRACT_KEPT'], replies: [
      // the Workspace's tmux socket is `<root>/tmux`, beside the place
      { tool: 'bash', args: { command: `env; ${tmux} -S ../tmux list-sessions; echo tmux=$?` } },
      'done'
    ] });
    await agent.next('report');
    await turn(agent);
    const output = agent.toolResult(1);
    expect(output).toContain('CONTRACT_KEPT=kept');
    expect(output).toContain('LC_CONTRACT=locale');
    expect(output).toContain('PATH=');
    expect(output).not.toContain('sk-contract');
    expect(output).not.toContain('RAC_LAUNCH_NONCE');
    expect(output).not.toContain('RAC_SANDBOX_POLICY');
    expect(output).not.toContain('tmux=0');
  }, 60_000);

  it('fails closed when the sandbox runtime cannot start: the report says why, commands are refused, the path policy holds', async () => {
    // no bubblewrap on this PATH, so the runtime refuses to start
    const agent = await launched(client, { sandboxed: true, env: { PATH: '/nonexistent' }, replies: [
      { tool: 'bash', args: { command: ': > inside-bash.txt' } },
      { tool: 'write', args: { path: '../outside-write.txt', content: 'x' } },
      'done'
    ] });
    const report = await agent.next('report');
    expect(report).toMatchObject({ report: { sandbox: { engaged: false, reason: expect.any(String) } } });
    await turn(agent);
    expect(agent.toolResult(1)).toContain('Sandboxed commands are refused');
    expect(existsSync(join(agent.home, 'inside-bash.txt'))).toBe(false);
    expect(agent.toolResult(2)).toContain('outside the paths the sandbox may write');
  }, 60_000);

  it('lets a Sandboxed Agent commit in a linked Worktree but not configure or repoint git', async () => {
    const agent = await launched(client, { sandboxed: true, git: 'linked', replies: [
      { tool: 'bash', args: { command: [
        'git -c user.name=Agent -c user.email=agent@example.com commit -q --allow-empty -m sandboxed; echo commit=$?',
        'echo "[core] fsmonitor = touch ../pwned" > ../repo/.git/config.worktree',
        'echo "[core] fsmonitor = touch ../pwned" > ../repo/.git/worktrees/place/config.worktree',
        'echo "gitdir: ../evil" > .git',
        'mv .git .git.bak 2>/dev/null && echo "gitdir: ../evil" > .git && echo replaced:gitfile',
        'echo ../evil > ../repo/.git/worktrees/place/commondir',
        'mkdir -p ../repo/.git/worktrees/place/modules/x && echo "[core] fsmonitor = touch ../pwned" > ../repo/.git/worktrees/place/modules/x/config',
        'true'
      ].join('; ') } },
      { tool: 'write', args: { path: '../repo/.git/config.worktree', content: '[core]\n\tfsmonitor = touch ../pwned\n' } },
      { tool: 'write', args: { path: '.git', content: 'gitdir: ../evil\n' } },
      'done'
    ] });
    const before = { gitfile: readFileSync(join(agent.home, '.git'), 'utf8'), commondir: readFileSync(join(agent.root, 'repo/.git/worktrees/place/commondir'), 'utf8') };
    expect(await agent.next('report')).toMatchObject({ report: { sandbox: { engaged: true } } });
    await turn(agent);
    expect(agent.toolResult(1)).toContain('commit=0');
    expect(agent.toolResult(1)).not.toContain('replaced:');
    expect(existsSync(join(agent.home, '.git.bak'))).toBe(false);
    expect((await run('git', ['-C', agent.home, 'log', '-1', '--format=%s'])).stdout.trim()).toBe('sandboxed');
    expect(existsSync(join(agent.root, 'repo/.git/config.worktree')) ? readFileSync(join(agent.root, 'repo/.git/config.worktree'), 'utf8') : '').toBe('');
    expect(existsSync(join(agent.root, 'repo/.git/worktrees/place/config.worktree')) ? readFileSync(join(agent.root, 'repo/.git/worktrees/place/config.worktree'), 'utf8') : '').toBe('');
    expect(readFileSync(join(agent.home, '.git'), 'utf8')).toBe(before.gitfile);
    expect(readFileSync(join(agent.root, 'repo/.git/worktrees/place/commondir'), 'utf8')).toBe(before.commondir);
    expect(existsSync(join(agent.root, 'repo/.git/worktrees/place/modules/x'))).toBe(false);
    expect(agent.toolResult(2)).toContain('outside the paths the sandbox may write');
    expect(agent.toolResult(3)).toContain('protected in the sandbox');
  }, 60_000);

  it('lets a Sandboxed Agent commit in a repository\'s main checkout but write nothing that configures or redirects git', async () => {
    // each a file, or a folder a file goes in, that git reads its configuration, code or whereabouts from
    const protectedPaths = ['config', 'config.worktree', 'commondir', 'hooks/pre-commit', 'info/attributes', 'modules/x/config', 'worktrees/x/gitdir', 'remotes/origin', 'branches/origin'];
    const attempts = protectedPaths.map(path => `mkdir -p "$(dirname .git/${path})" 2>/dev/null; printf '[core]\\n\\tfsmonitor = touch ../pwned\\n' > .git/${path} 2>/dev/null && echo wrote:${path}`);
    const agent = await launched(client, { sandboxed: true, git: 'main', replies: [
      { tool: 'bash', args: { command: ['git -c user.name=Agent -c user.email=agent@example.com commit -q --allow-empty -m sandboxed; echo commit=$?', ...attempts, 'git config core.fsmonitor "touch ../pwned"; echo config=$?',
        // the entry itself is immovable: no moving `.git` aside to make a fresh one
        'mv .git .git.bak 2>/dev/null && git init -q && printf \'[core]\\n\\tfsmonitor = touch ../pwned\\n\' > .git/config && echo replaced:git'].join('; ') } },
      { tool: 'write', args: { path: '.git/config', content: '[core]\n\tfsmonitor = touch ../pwned\n' } },
      'done'
    ] });
    expect(await agent.next('report')).toMatchObject({ report: { sandbox: { engaged: true } } });
    // the console's extension made the repository's own `commondir`, as git reads none
    const before = { config: readFileSync(join(agent.home, '.git/config'), 'utf8'), commondir: readFileSync(join(agent.home, '.git/commondir'), 'utf8') };
    expect(before.commondir).toBe('.\n');
    await turn(agent);
    const output = agent.toolResult(1);
    expect(output).toContain('commit=0');
    expect(output).not.toContain('wrote:');
    expect(output).not.toContain('config=0');
    expect(output).not.toContain('replaced:');
    expect(existsSync(join(agent.home, '.git.bak'))).toBe(false);
    expect((await run('git', ['-C', agent.home, 'log', '-1', '--format=%s'])).stdout.trim()).toBe('sandboxed');
    expect(readFileSync(join(agent.home, '.git/config'), 'utf8')).toBe(before.config);
    expect(readFileSync(join(agent.home, '.git/commondir'), 'utf8')).toBe(before.commondir);
    for (const path of protectedPaths.filter(path => !['config', 'commondir'].includes(path))) expect(existsSync(join(agent.home, '.git', path)) ? readFileSync(join(agent.home, '.git', path), 'utf8') : '', path).toBe('');
    // the console's own git, as its dashboard runs it, finds nothing to run
    expect((await run('git', ['-C', agent.home, 'status', '--porcelain=v1'])).code).toBe(0);
    expect(existsSync(join(agent.root, 'pwned'))).toBe(false);
    expect(agent.toolResult(2)).toContain('protected in the sandbox');
  }, 60_000);

  // each script, in the Worktree where the command may write, marks `<root>/pwned-<name>` if it ever runs
  const evil = (name: string) => `printf '#!/bin/sh\\ntouch %s/pwned-${name}\\n' "$(dirname "$PWD")" > evil-${name}.sh; chmod +x evil-${name}.sh`;
  // plant what a command could leave in a main checkout (every step must land), then run the
  // console's own git over it
  const plantedThenConsoleGit = async (commands: string[], consoleGit: (home: string) => Promise<unknown>) => {
    const agent = await launched(client, { sandboxed: true, git: 'main', replies: [{ tool: 'bash', args: { command: [...commands, 'echo planted'].join(' && ') } }, 'done'] });
    expect(await agent.next('report')).toMatchObject({ report: { sandbox: { engaged: true } } });
    await turn(agent);
    expect(agent.toolResult(1)).toContain('planted');
    await consoleGit(agent.home);
    return agent;
  };

  it('runs no fsmonitor of a nested repository a command adds as a submodule', async () => {
    const agent = await plantedThenConsoleGit([
      evil('fsmonitor'),
      'mkdir sub && git -C sub init -q && git -C sub -c user.name=A -c user.email=a@b commit -q --allow-empty -m s',
      'git add sub && git -c user.name=A -c user.email=a@b commit -q -m gitlink',
      'printf "[core]\\n\\trepositoryformatversion = 0\\n\\tfsmonitor = $PWD/evil-fsmonitor.sh\\n" > sub/.git/config'
    ], async home => { await cleanWorkingTree(home); await run('/usr/bin/git', ['-C', home, 'status', '--porcelain=v1', '--untracked-files=all']); });
    expect(existsSync(join(agent.root, 'pwned-fsmonitor'))).toBe(false);
  }, 60_000);

  it('does not read a bare repository a command makes at the Worktree root after breaking .git', async () => {
    const agent = await plantedThenConsoleGit([
      evil('gpg'),
      'mv .git/HEAD .git/HEAD.bak', 'git init -q --bare fake', 'cp -r fake/HEAD fake/objects fake/refs .',
      // a signed commit, so a log asks gpg about it
      'tree=$(git --git-dir=. mktree </dev/null) && commit=$(printf "tree %s\\nauthor a <a@b> 1 +0000\\ncommitter a <a@b> 1 +0000\\ngpgsig -----BEGIN PGP SIGNATURE-----\\n x\\n -----END PGP SIGNATURE-----\\n\\nsigned\\n" "$tree" | git --git-dir=. hash-object -t commit -w --stdin) && git --git-dir=. update-ref HEAD "$commit"',
      'printf "[log]\\n\\tshowSignature = true\\n[gpg]\\n\\tprogram = $PWD/evil-gpg.sh\\n" > config'
    ], async home => { await cleanWorkingTree(home); await run('/usr/bin/git', ['--no-optional-locks', '-C', home, 'log', '-z', '--max-count=2', 'HEAD', '--']); });
    expect(existsSync(join(agent.root, 'pwned-gpg'))).toBe(false);
  }, 60_000);

  it('lets a Sandboxed Agent ask the operator with ask_user', async () => {
    const { connection, next } = await launched(client, { sandboxed: true });
    expect(await next('report')).toMatchObject({ report: { sandbox: { engaged: true } } });
    expect(await connection.deliver('Please ask me a question')).toBe('started');
    const asked = await next('question') as Extract<StructuredEvent, { type: 'question' }>;
    expect(asked.question).toMatchObject({ text: 'Which colour?', field: { kind: 'choice', choices: ['red', 'blue'] } });
    expect(await connection.answer(asked.question.id, 1)).toBe(true);
    expect(await next('turn')).toEqual({ type: 'turn', turn: { type: 'settled', message: 'You answered: blue' } });
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
    expect(await launch.connection.deliver('Say hello')).toBe('started');
    await launch.next('turn', event => event.type === 'turn' && event.turn.type === 'settled');
    // the console's last idle point: the end of the first Turn
    const idle = launch.started.cursor!();
    expect(await launch.connection.deliver('Reply slowly')).toBe('started');
    await launch.next('turn', event => event.type === 'turn' && event.turn.type === 'started');
    launch.connection.close();

    const again = await reattached(launch, client, idle);
    expect(await again.next('turn')).toEqual({ type: 'turn', turn: { type: 'started' } });
    expect(await again.next('turn')).toEqual({ type: 'turn', turn: { type: 'settled', message: 'Hello from the stub provider' } });
    // it read the Conversation afresh, as it never heard the launch, and replayed only the Turn in flight
    expect(again.events).toContainEqual({ type: 'conversation', id: expect.any(String) });
    expect(again.events.flatMap(event => event.type === 'transcript' && event.item.kind === 'message' && event.item.role === 'user' ? [event.item.text] : [])).toEqual(['Reply slowly']);
    // the reconnected client drives the Agent on
    expect(await again.connection.deliver('Say hello')).toBe('started');
    expect(await again.next('turn', event => event.type === 'turn' && event.turn.type === 'settled')).toBeDefined();
  }, 60_000);

  it('after a replay that overflowed, resyncs: Pi\'s state says it works, and the Turn settles', async () => {
    // a replay buffer of one line: a reconnect from the launch report has lost lines
    const launch = await launched(client, { env: { RAC_HOLDER_REPLAY_BYTES: '1' } });
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

  // the Conductor (ADR 0018): the console's MCP server reaches its process in-band, and its scripts call it
  const conductor = async (code: string, options: LaunchOptions = {}) => {
    const mcp = await stubMcp();
    cleanups.push(mcp.close);
    const agent = await launched(client, { role: 'conductor', replies: [{ tool: 'codemode', args: { code } }, 'done'], ...options });
    await agent.next('report');
    expect(await agent.connection.consoleAccess!({ url: mcp.url, token: 'rac-conductor.contract-token' })).toBe(true);
    // it is taken once: a second hand-over is refused
    expect(await agent.connection.consoleAccess!({ url: 'http://127.0.0.1:1/mcp', token: 'rac-conductor.other' })).toBe(false);
    return { ...agent, mcp };
  };
  // what a script printed, from the Script line's output
  const scriptOutput = (agent: Awaited<ReturnType<typeof launched>>): string => {
    const script = agent.events.flatMap(event => event.type === 'transcript' && event.item.kind === 'tool' && event.item.name === 'Script' ? [event.item] : []).at(-1);
    return script?.output ?? '';
  };

  it('gives the Conductor the console\'s MCP server in-band, which its scripts call without `models`', async () => {
    const agent = await conductor('const listed = await tools.mcp__rac__list_agents({}); return JSON.stringify({ models: typeof models, agents: listed.structuredContent.data.length });');
    await turn(agent);
    expect(agent.mcp.requests).toContainEqual({ method: 'tools/call', name: 'list_agents', authorization: 'Bearer rac-conductor.contract-token' });
    expect(scriptOutput(agent)).toContain('{"models":"undefined","agents":1}');
    // the script's call is its child line
    expect(agent.events).toContainEqual({ type: 'transcript', item: expect.objectContaining({ name: 'mcp__rac__list_agents', parentId: 'call_1', state: 'done' }) });
    // the token went to the console's server only, never to the model
    expect(agent.bodies.some(body => body.includes('contract-token'))).toBe(false);
  }, 60_000);

  it('takes the console\'s access only as the Conductor', async () => {
    const agent = await launched(client);
    await agent.next('report');
    expect(await agent.connection.consoleAccess!({ url: 'http://127.0.0.1:1/mcp', token: 'rac-conductor.contract-token' })).toBe(false);
  }, 60_000);

  it('ends a Conductor script that spins when its Turn is cancelled', async () => {
    const agent = await conductor('while (true) await tools.mcp__rac__list_agents({});');
    expect(await agent.connection.deliver('Use the console')).toBe('started');
    await agent.next('transcript', event => event.type === 'transcript' && event.item.kind === 'tool' && event.item.parentId === 'call_1');
    expect(await agent.connection.cancel()).toEqual([]);
    expect(await agent.next('turn', event => event.type === 'turn' && event.turn.type !== 'started')).toEqual({ type: 'turn', turn: { type: 'aborted' } });
    expect(scriptOutput(agent)).toContain('Script aborted');
  }, 60_000);

  it('refuses a Sandboxed Conductor script\'s out-of-policy commands and file writes', async () => {
    const agent = await conductor([
      'const results = await Promise.allSettled([',
      '  tools.bash({ command: "touch ../outside-bash.txt" }),',
      '  tools.write({ path: "../outside-write.txt", content: "x" }),',
      '  tools.read({ path: "/proc/self/environ" }),',
      '  tools.write({ path: "inside-write.txt", content: "x" })',
      ']);',
      'return JSON.stringify(results.map(result => result.status === "rejected" ? String(result.reason) : "ok"));'
    ].join('\n'), { sandboxed: true });
    await turn(agent);
    expect(existsSync(join(agent.root, 'outside-bash.txt'))).toBe(false);
    expect(existsSync(join(agent.root, 'outside-write.txt'))).toBe(false);
    expect(existsSync(join(agent.home, 'inside-write.txt'))).toBe(true);
    expect(scriptOutput(agent)).toContain('outside the paths the sandbox may write');
  }, 60_000);
});
