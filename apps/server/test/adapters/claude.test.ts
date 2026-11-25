import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter, claudeStructuredAdapter } from '../../src/adapters/claude.js';
import { claudeStructuredSettings } from '../../src/adapters/claude-hooks.js';
import { responseUrlEnvironment } from '../../src/adapters/response-urls.js';
import { structuredAdapterFor } from '../../src/adapters/registry.js';
import { claudeClient } from '../../src/transports/claude.js';
import { holderProcesses, type HolderLaunch, type HolderWindows, type StructuredLaunch } from '../../src/transports/structured-agents.js';
import type { AdapterLaunchConfig, SandboxSettings } from '../../src/adapters/types.js';
import type { Place } from '../../src/places/places.js';

const hooks = '/data/adapters/claude/hooks.json';
const files = { 'hooks.json': hooks };
const id = '0199a4e1-c0b7-4a90-bf22-abcdef012345';
const responseOrigin = 'https://agents.example.com:4173';

describe('claude adapter launch', () => {
  it('injects --settings after the mode flag in every mode', () => {
    expect(claudeAdapter.launch({ mode: 'fresh', cwd: '/w', sandboxed: false, files }).args).toEqual(['--settings', hooks]);
    expect(claudeAdapter.launch({ mode: 'continue', cwd: '/w', sandboxed: false, files }).args).toEqual(['--continue', '--settings', hooks]);
    expect(claudeAdapter.launch({ mode: 'resume', conversationId: id, cwd: '/w', sandboxed: false, files }).args).toEqual(['--resume', id, '--settings', hooks]);
  });

  it('omits --settings when no hooks file was rendered', () => {
    expect(claudeAdapter.launch({ mode: 'fresh', cwd: '/w', sandboxed: false }).args).toEqual([]);
    expect(claudeAdapter.launch({ mode: 'continue', cwd: '/w', sandboxed: false }).args).toEqual(['--continue']);
  });

  it('falls back to a fresh launch when a resume carries no conversation id', () => {
    expect(claudeAdapter.launch({ mode: 'resume', cwd: '/w', sandboxed: false, files }).args).toEqual(['--settings', hooks]);
  });

  it('sets persistent response URL context for fresh and resumed sessions, clearing inherited context without an origin', () => {
    expect(claudeAdapter.launch({ mode: 'fresh', cwd: '/w', sandboxed: false, responseOrigin }).env).toEqual(responseUrlEnvironment(responseOrigin));
    expect(claudeAdapter.launch({ mode: 'resume', conversationId: id, cwd: '/w', sandboxed: false, responseOrigin }).env).toEqual(responseUrlEnvironment(responseOrigin));
    expect(claudeAdapter.launch({ mode: 'continue', cwd: '/w', sandboxed: false }).env).toEqual(responseUrlEnvironment());
  });
});

describe('structured claude launch', () => {
  const protocol = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--mcp-config', '{"mcpServers":{"rac":{"type":"sdk","name":"rac"}}}', '--settings', claudeStructuredSettings];
  const untrusted = ['--setting-sources', 'user', '--strict-mcp-config'];
  const roots: string[] = [];
  // Claude's config directory, which the launch's own environment names, and a real folder to work in
  let config = '';
  let work = '';
  let place: Place;
  // the trust record, trusting `trusted` as Claude's TUI trust dialog records it
  const trusting = async (...trusted: string[]) => await writeFile(join(config, '.claude.json'), JSON.stringify({ projects: Object.fromEntries(trusted.map(folder => [folder, { hasTrustDialogAccepted: true }])) }));
  const folder = async (...parts: string[]) => { const path = join(work, ...parts); await mkdir(path, { recursive: true }); return path; };
  beforeEach(async () => {
    config = await realpath(await mkdtemp(join(tmpdir(), 'rac-claude-config-')));
    work = await realpath(await mkdtemp(join(tmpdir(), 'rac-claude-work-')));
    roots.push(config, work);
    place = { id: 'w', kind: 'worktree', projectId: 'p', label: 'w', home: work };
    vi.stubEnv('RAC_CLAUDE_CONFIG_DIR', config);
    await trusting(work);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  // a session transcript Claude wrote for the working folder, named so it is listed
  const transcript = async (session: string, name: string, at: string) => {
    const project = join(config, 'projects', work.replace(/[^a-zA-Z0-9]/gu, '-'));
    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${session}.jsonl`), `${JSON.stringify({ type: 'custom-title', customTitle: name })}\n${JSON.stringify({ type: 'user', promptSource: 'typed', origin: { kind: 'human' }, entrypoint: 'cli', message: { content: 'hi' }, timestamp: at })}\n`);
  };

  // what a launch opens its holder window with; the window never opens, so nothing connects
  async function launched(launch: Partial<StructuredLaunch>, configured: Partial<AdapterLaunchConfig> = {}, at: Place = place, sandbox?: SandboxSettings): Promise<HolderLaunch> {
    let opened: HolderLaunch | undefined;
    const windows: HolderWindows = { openHolderWindow: async (_place, _id, holder) => { opened = holder; return undefined; }, captureHolder: async () => undefined, holderRunning: async () => false, closeHolder: async () => {} };
    const claude: AdapterLaunchConfig = { program: '/usr/local/bin/claude', args: [], env: { SOME: '1', CLAUDE_CONFIG_DIR: config, RAC_RESPONSE_URL_INSTRUCTIONS: 'stale' }, launchable: true, transport: 'structured', ...configured };
    await holderProcesses(windows, { claude }, async () => files, undefined, () => sandbox).start({ id: 'a', kind: 'claude', place: at, sandboxed: false, nonce: 'n0nce', ...launch }, () => {});
    return opened!;
  }
  const argsIn = async (home: string) => (await launched({}, {}, { ...place, home })).args;

  it('runs claude -p over stream-json with the console\'s MCP server, inline settings and nonce, never sandboxed or pinned by the console', async () => {
    expect(await launched({})).toEqual({ kind: 'claude', program: '/usr/local/bin/claude', args: protocol, env: { SOME: '1', CLAUDE_CONFIG_DIR: config, RAC_LAUNCH_NONCE: 'n0nce', ...responseUrlEnvironment() } });
    expect(claudeStructuredAdapter.sandbox).toBeUndefined();
    expect(claudeStructuredAdapter.pinned()).toBeUndefined();
    expect(structuredAdapterFor('claude')?.client).toBe(claudeClient);
  });

  it('sets persistent response URL context on structured fresh and resumed launches', () => {
    expect(claudeStructuredAdapter.launch({ cwd: work, sandboxed: false, nonce: 'fresh', responseOrigin }).env).toEqual({ RAC_LAUNCH_NONCE: 'fresh', ...responseUrlEnvironment(responseOrigin) });
    expect(claudeStructuredAdapter.launch({ cwd: work, sandboxed: false, nonce: 'resumed', resume: id, responseOrigin }).env).toEqual({ RAC_LAUNCH_NONCE: 'resumed', ...responseUrlEnvironment(responseOrigin) });
  });

  it('leaves out the project settings and every other MCP server in a folder Claude does not trust yet, last, and never records trust', async () => {
    await trusting('/elsewhere');
    const args = ['--setting-sources', 'project,local,user', '--mcp-config', './servers.json', '--add-dir', '/data'];
    expect((await launched({}, { args })).args).toEqual([...protocol, '--add-dir', '/data', ...untrusted]);
    expect(JSON.parse(await readFile(join(config, '.claude.json'), 'utf8'))).toEqual({ projects: { '/elsewhere': { hasTrustDialogAccepted: true } } });
    // an unreadable record trusts nothing
    await writeFile(join(config, '.claude.json'), '{');
    expect((await launched({})).args.slice(-3)).toEqual(untrusted);
  });

  it('reads the trust record of the launch\'s own account: its config directory, else its home', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'rac-claude-home-')));
    roots.push(home);
    await writeFile(join(home, '.claude.json'), JSON.stringify({ projects: { [work]: { hasTrustDialogAccepted: true } } }));
    expect((await launched({}, { env: { HOME: home } })).args).toEqual(protocol);
    // never the console's own config directory: this home has no record
    expect((await launched({}, { env: { HOME: work } })).args.slice(-3)).toEqual(untrusted);
  });

  it('trusts a folder by Claude\'s own key only: the main worktree\'s top level inside git, the real folder elsewhere, never a folder above', async () => {
    // a repository and a worktree linked to it beside it
    const main = await folder('main');
    await mkdir(join(main, '.git', 'worktrees', 'feature'), { recursive: true });
    await writeFile(join(main, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    const linked = await folder('feature');
    await writeFile(join(linked, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`);
    const nested = await folder('main', 'src');
    // a repository under a trusted plain folder, and a plain folder under one
    const repo = await folder('trusted', 'repo');
    await mkdir(join(repo, '.git'));
    const plain = await folder('trusted', 'plain');
    await symlink(main, join(work, 'alias'));
    await trusting(main, join(work, 'trusted'), linked, '/');
    expect(await argsIn(linked)).toEqual(protocol);
    expect(await argsIn(nested)).toEqual(protocol);
    expect(await argsIn(join(work, 'alias'))).toEqual(protocol);
    expect((await argsIn(repo)).slice(-3)).toEqual(untrusted);
    expect((await argsIn(plain)).slice(-3)).toEqual(untrusted);
    // a record on a linked worktree's own path is not Claude's key for it
    await trusting(linked);
    expect((await argsIn(linked)).slice(-3)).toEqual(untrusted);
  });

  it('resumes the newest listed Conversation to continue the latest, a new one when none, never --continue', async () => {
    expect((await launched({ continue: true })).args).toEqual(protocol);
    await transcript('11111111-2222-4333-8444-555555555555', 'older', '2026-11-01T10:00:00.000Z');
    await transcript(id, 'newer', '2026-11-02T10:00:00.000Z');
    expect((await launched({ continue: true, model: { model: 'opus', effort: 'high' } })).args).toEqual([...protocol, '--resume', id, '--model', 'opus', '--effort', 'high']);
  });

  it('resumes a located session on the launch\'s model and Effort, which a resume names too', async () => {
    // a session not under the cwd's project directory is not resumed
    expect(await launched({ resume: id })).toBeUndefined();
    await transcript(id, 'named', '2026-11-02T10:00:00.000Z');
    expect((await launched({ resume: id, model: { model: 'sonnet' } })).args).toEqual([...protocol, '--resume', id, '--model', 'sonnet']);
  });

  it('drops what the launch composes from the operator\'s arguments every time, whatever the boot dropped', async () => {
    // as a boot for tmux leaves them; `--verbose` takes no value, so the flag after it stays
    const args = ['--tools', 'Bash', 'Read', '--output-format=json', '--verbose', '--add-dir', '/data', '--replay-user-messages', '--permission-prompt-tool', 'mcp__x__allow', '--mcp-config', '/home/me/mcp.json', '--include-partial-messages', '--bg', '-w', 'feature', '--no-session-persistence', '--json-schema', '{}'];
    expect((await launched({}, { args })).args).toEqual([...protocol, '--add-dir', '/data', '--mcp-config', '/home/me/mcp.json']);
  });

  it('honours the Launch menu\'s permission mode and model over the operator\'s arguments, keeping theirs otherwise', async () => {
    const args = ['--permission-mode', 'auto', '--model', 'haiku', '--add-dir', '/data'];
    expect((await launched({}, { args })).args).toEqual([...protocol, ...args]);
    expect((await launched({ security: { permissions: 'inherit' } }, { args })).args).toEqual([...protocol, ...args]);
    expect((await launched({ security: { permissions: 'acceptEdits' }, model: { model: 'opus' } }, { args })).args).toEqual([...protocol, '--model', 'opus', '--permission-mode', 'acceptEdits', '--add-dir', '/data']);
    expect((await launched({ security: { permissions: 'bypassPermissions' } }, { args })).args).toEqual([...protocol, '--dangerously-skip-permissions', '--model', 'haiku', '--add-dir', '/data']);
  });

  it('launches the Conductor on the console\'s settings alone: no setting sources or other MCP server, its own tools, sandbox and permissions, and none of the operator\'s arguments', async () => {
    // a folder Claude does not trust, and every operator choice that would widen the Conductor
    await trusting('/elsewhere');
    const args = ['--permission-mode', 'bypassPermissions', '--add-dir', '/', '--setting-sources', 'user', '--mcp-config', './servers.json', '--settings', '/home/me/wide.json'];
    const sandbox: SandboxSettings = { allowedDomains: ['registry.npmjs.org'], deniedDomains: ['console.example.com', '172.19.0.1'], allowWrite: ['~/.cache/pnpm'], denyWrite: ['/srv/rac/.data'], denyRead: ['/srv/rac/.data'], env: ['NPM_TOKEN'], repositories: ['/srv/rac'] };
    vi.stubEnv('PI_CODING_AGENT_DIR', '/pi/agent');
    const opened = await launched({ role: 'conductor', model: { model: 'opus', effort: 'high' }, security: { permissions: 'bypassPermissions' } }, { args }, place, sandbox);
    const settings = opened.args[opened.args.indexOf('--settings') + 1]!;
    expect(opened.args).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
      '--setting-sources', '', '--strict-mcp-config', '--tools', 'Bash,Read,Edit,Write,Grep,Glob',
      '--mcp-config', '{"mcpServers":{"operator":{"type":"sdk","name":"operator"}}}', '--settings', settings,
      '--model', 'opus', '--effort', 'high'
    ]);
    const home = ['~/.ssh', '~/.gnupg', '~/.aws', '~/.config/gh', '~/.config/gcloud', '~/.docker/config.json', '~/.git-credentials', '~/.netrc', '~/.npmrc', '~/.claude/.credentials.json', '~/.codex/auth.json'];
    // the launch account's Claude secrets and Pi's, which no command of the Conductor's needs
    const secrets = [...home, `${config}/.credentials.json`, `${config}/.claude.json`, `${config}/history.jsonl`, '~/.claude.json', ...['auth.json', 'oauth.json', 'mcp-auth.json', 'models.json', 'mcp.json', 'sessions'].map(name => `/pi/agent/${name}`)];
    // Claude's file tools follow permission rules, not the sandbox's lists
    const rules = (tool: string, paths: string[]) => paths.flatMap(path => [`${tool}(${path.startsWith('~') ? path : `/${path}`})`, `${tool}(${path.startsWith('~') ? path : `/${path}`}/**)`]);
    expect(JSON.parse(settings)).toEqual({
      hooks: JSON.parse(claudeStructuredSettings).hooks,
      sandbox: {
        enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
        network: { allowedDomains: ['registry.npmjs.org'], deniedDomains: ['console.example.com', '172.19.0.1'] },
        // other Conversations' transcripts are kept from commands only: the file tools read results Claude saved there
        filesystem: { allowWrite: ['~/.cache/pnpm'], denyWrite: ['/srv/rac/.data'], denyRead: ['/srv/rac/.data', ...secrets, `${config}/projects`] }
      },
      permissions: {
        defaultMode: 'dontAsk', allow: ['mcp__rac', 'mcp__operator__ask_user', 'Edit', 'Write'],
        deny: ['AskUserQuestion', ...rules('Read', ['/srv/rac/.data', ...secrets]), ...rules('Edit', ['/srv/rac/.data'])],
        // the file tools reach what the sandbox lets commands write
        additionalDirectories: [join(homedir(), '.cache/pnpm')],
        blockFileToolReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true
      }
    });
    expect(JSON.parse(settings).permissions.deny).toContain('Read(//srv/rac/.data/**)');
    // the operator's environment still names the account
    expect(opened.env).toEqual({ SOME: '1', CLAUDE_CONFIG_DIR: config, RAC_LAUNCH_NONCE: 'n0nce', ...responseUrlEnvironment() });
    // with no sandbox settings given, it has no network and writes nowhere beyond its folder
    const bare = await launched({ role: 'conductor' }, { args });
    expect(JSON.parse(bare.args[bare.args.indexOf('--settings') + 1]!).sandbox).toMatchObject({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { allowWrite: [], denyWrite: [] } });
    expect(bare.args).not.toContain('bypassPermissions');

    // a folder holding one of the console's repositories is not the Conductor's to write, as for a Sandboxed Pi
    const above = await launched({ role: 'conductor' }, {}, place, { ...sandbox, repositories: [join(work, 'remoteagents')] });
    const confined = JSON.parse(above.args[above.args.indexOf('--settings') + 1]!);
    expect(confined.sandbox.filesystem.denyWrite).toEqual(['/srv/rac/.data', work]);
    // its file tools may still edit the sandbox's writable paths
    expect(confined.permissions.allow).toEqual(['mcp__rac', 'mcp__operator__ask_user', 'Edit(~/.cache/pnpm)', 'Edit(~/.cache/pnpm/**)']);
    expect(confined.permissions.deny).toContain(`Edit(/${work}/**)`);
  });

  it('routes structured Claude to a kind-specific generic holder under the host bridge', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/run/tmux');
    expect(await launched({})).toMatchObject({ kind: 'claude', program: '/usr/local/bin/claude' });
  });
});
