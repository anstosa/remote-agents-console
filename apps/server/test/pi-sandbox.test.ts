import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandEnv, fileOperations, pathRefusal, sessionPolicy, type SandboxPolicy } from '../src/adapters/pi-sandbox.js';

// The Pi-free sandbox policy the RAC Pi extension applies (ADR 0004): what a session's policy
// holds, which file-tool paths it refuses, and the environment a sandboxed command gets.

let root = '';
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'rac-pi-sandbox-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const rendered = (overrides: Partial<SandboxPolicy['filesystem']> = {}): SandboxPolicy => ({ network: { allowedDomains: ['registry.npmjs.org'], deniedDomains: [] }, filesystem: { denyRead: ['/srv/private'], allowWrite: [], denyWrite: [], ...overrides }, env: ['GH_TOKEN'], repositories: [] });

describe('a Sandboxed Pi session\'s policy', () => {
  it('makes the Worktree, its git directory and the temp directory writable, and protects Pi\'s state, .pi, what configures or redirects git, and the tmux socket', async () => {
    const app = join(root, 'app');
    const git = join(app, '.git');
    await mkdir(git, { recursive: true });
    const policy = sessionPolicy(rendered(), { cwd: app, stateDir: '/h/.pi/agent', git: { dir: git, commonDir: git }, tempDir: '/tmp/rac-pi-1', tmuxSocket: '/tmp/tmux-1000/default' });
    expect(policy.network).toEqual({ allowedDomains: ['registry.npmjs.org'], deniedDomains: [] });
    expect(policy.filesystem.allowWrite).toEqual([app, git, '/tmp/rac-pi-1']);
    expect(policy.filesystem.denyWrite).toEqual(expect.arrayContaining(['/h/.pi/agent', join(app, '.pi'), '/tmp/tmux-1000/default', ...['config', 'config.worktree', 'hooks', 'info', 'modules', 'commondir', 'worktrees', 'remotes', 'branches'].map(name => join(git, name))]));
    // a commit's own files stay writable
    expect(policy.filesystem.denyWrite).not.toContain(git);
    expect(policy.filesystem.denyRead).toEqual(expect.arrayContaining(['/srv/private', '/h/.pi/agent/auth.json', '/h/.pi/agent/mcp-auth.json', '/tmp/tmux-1000/default']));
    expect(policy.env).toEqual(['GH_TOKEN']);
  });

  it('lets a linked Worktree commit, through git\'s objects, refs, logs and its own admin directory, but nothing that redirects or configures git', async () => {
    const app = join(root, 'app');
    await mkdir(app);
    await writeFile(join(app, '.git'), 'gitdir: /w/main/.git/worktrees/app\n');
    const policy = sessionPolicy(rendered(), { cwd: app, stateDir: '/h/.pi/agent', git: { dir: '/w/main/.git/worktrees/app', commonDir: '/w/main/.git' }, tempDir: '/tmp/rac-pi-1' });
    expect(policy.filesystem.allowWrite).toEqual([app, '/w/main/.git/objects', '/w/main/.git/refs', '/w/main/.git/logs', '/w/main/.git/worktrees/app', '/tmp/rac-pi-1']);
    expect(policy.filesystem.denyWrite).toEqual(expect.arrayContaining([join(app, '.git'), ...['commondir', 'gitdir', 'config.worktree', 'modules'].map(name => join('/w/main/.git/worktrees/app', name))]));
  });

  it('writes nothing in the home directory itself, or above it, and keeps well-known credentials unreadable', () => {
    for (const cwd of [homedir(), dirname(homedir())]) {
      const policy = sessionPolicy(rendered(), { cwd, stateDir: '/h/.pi/agent', tempDir: '/tmp/rac-pi-1' });
      expect(policy.filesystem.allowWrite).toEqual(['/tmp/rac-pi-1']);
      expect(pathRefusal('write', { path: join(homedir(), '.config', 'git', 'config'), content: 'x' }, cwd, policy)).toMatch(/outside/);
    }
    const policy = sessionPolicy(rendered(), { cwd: join(root, 'app'), stateDir: '/h/.pi/agent', tempDir: '/tmp/rac-pi-1' });
    expect(policy.filesystem.denyRead).toEqual(expect.arrayContaining([join(homedir(), '.ssh'), join(homedir(), '.git-credentials'), join(homedir(), '.netrc'), join(homedir(), '.npmrc'), join(homedir(), '.docker', 'config.json'), join(homedir(), '.config', 'gcloud'), join(homedir(), '.claude', '.credentials.json'), join(homedir(), '.codex', 'auth.json')]));
    expect(policy.filesystem.denyWrite).toEqual(expect.arrayContaining([join(root, 'app', '.claude', 'settings.json'), join(root, 'app', '.claude', 'settings.local.json')]));
  });

  it('writes nothing in a folder holding the console\'s repositories, but writes in a repository\'s own checkout', () => {
    const holding = { ...rendered(), repositories: [join(root, 'code', 'app'), join(root, 'code', 'remoteagents')] };
    expect(sessionPolicy(holding, { cwd: join(root, 'code'), stateDir: '/h/.pi/agent', tempDir: '/tmp/rac-pi-1' }).filesystem.allowWrite).toEqual(['/tmp/rac-pi-1']);
    expect(sessionPolicy(holding, { cwd: join(root, 'code', 'app'), stateDir: '/h/.pi/agent', tempDir: '/tmp/rac-pi-1' }).filesystem.allowWrite).toEqual([join(root, 'code', 'app'), '/tmp/rac-pi-1']);
  });

  it('makes no repository where there is none, since the console would run git in it', () => {
    const policy = sessionPolicy(rendered(), { cwd: join(root, 'plain'), stateDir: '/h/.pi/agent', tempDir: '/tmp/rac-pi-1' });
    expect(policy.filesystem.denyWrite).toContain(join(root, 'plain', '.git'));
  });
});

describe('the file-tool path policy', () => {
  let policy: SandboxPolicy;
  let cwd = '';
  beforeEach(async () => {
    cwd = join(root, 'work');
    await mkdir(join(cwd, '.git', 'hooks'), { recursive: true });
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(join(root, 'state', 'auth.json'), '{}');
    await writeFile(join(cwd, 'README.md'), 'hi');
    policy = sessionPolicy(rendered({ denyRead: [] }), { cwd, stateDir: join(root, 'state'), git: { dir: join(cwd, '.git'), commonDir: join(cwd, '.git') }, tempDir: join(root, 'tmp') });
  });

  it('lets read, write and edit work inside the Worktree', () => {
    expect(pathRefusal('read', { path: 'README.md' }, cwd, policy)).toBeUndefined();
    expect(pathRefusal('write', { path: 'src/new.ts' }, cwd, policy)).toBeUndefined();
    expect(pathRefusal('edit', { path: join(cwd, 'README.md') }, cwd, policy)).toBeUndefined();
    expect(pathRefusal('ls', {}, cwd, policy)).toBeUndefined();
    expect(pathRefusal('grep', { pattern: 'x', path: 'src' }, cwd, policy)).toBeUndefined();
  });

  it('refuses writes outside every writable root, into protected paths, and through a symlink out', async () => {
    expect(pathRefusal('write', { path: join(root, 'outside.txt') }, cwd, policy)).toMatch(/outside/);
    expect(pathRefusal('write', { path: '../outside.txt' }, cwd, policy)).toMatch(/outside/);
    expect(pathRefusal('edit', { path: '.git/hooks/pre-commit' }, cwd, policy)).toMatch(/protected/);
    expect(pathRefusal('write', { path: '.git/config.worktree' }, cwd, policy)).toMatch(/protected/);
    expect(pathRefusal('write', { path: '.git/commondir' }, cwd, policy)).toMatch(/protected/);
    expect(pathRefusal('write', { path: '.git' }, cwd, policy)).toMatch(/protected/);
    expect(pathRefusal('write', { path: '.pi/extensions/evil.ts' }, cwd, policy)).toMatch(/protected/);
    await symlink(root, join(cwd, 'escape'));
    expect(pathRefusal('write', { path: 'escape/outside.txt' }, cwd, policy)).toMatch(/outside/);
    // a link to a file that does not exist yet: writing it would create the target
    await symlink(join(root, 'not-yet', 'config'), join(cwd, 'dangling'));
    expect(pathRefusal('write', { path: 'dangling' }, cwd, policy)).toMatch(/outside/);
  });

  it('refuses writes to the files and folders other tools run code from, anywhere in the Worktree', () => {
    for (const path of ['.bashrc', 'sub/.gitconfig', '.gitmodules', '.mcp.json', '.vscode/tasks.json', '.idea/workspace.xml', '.claude/commands/x.md', '.claude/agents/x.md', 'vendor/lib/.git/config', 'vendor/lib/.git/hooks/pre-commit']) {
      expect(pathRefusal('write', { path }, cwd, policy), path).toMatch(/protected/);
    }
    expect(pathRefusal('write', { path: 'src/claude.md' }, cwd, policy)).toBeUndefined();
  });

  it('refuses rewriting a linked Worktree\'s .git file or anything in git\'s directories that configures or redirects git', async () => {
    const common = join(root, 'main', '.git');
    const admin = join(common, 'worktrees', 'work');
    await mkdir(join(common, 'objects'), { recursive: true });
    await mkdir(admin, { recursive: true });
    await writeFile(join(admin, 'commondir'), '../..');
    const linked = sessionPolicy(rendered({ denyRead: [] }), { cwd, stateDir: join(root, 'state'), git: { dir: admin, commonDir: common }, tempDir: join(root, 'tmp') });
    expect(pathRefusal('write', { path: '.git' }, cwd, linked)).toMatch(/protected/);
    expect(pathRefusal('write', { path: join(common, 'config.worktree') }, cwd, linked)).toMatch(/outside/);
    expect(pathRefusal('write', { path: join(common, 'config') }, cwd, linked)).toMatch(/outside/);
    expect(pathRefusal('write', { path: join(common, 'worktrees', 'other', 'gitdir') }, cwd, linked)).toMatch(/outside/);
    expect(pathRefusal('write', { path: join(admin, 'config.worktree') }, cwd, linked)).toMatch(/protected/);
    expect(pathRefusal('write', { path: join(admin, 'commondir') }, cwd, linked)).toMatch(/protected/);
    expect(pathRefusal('write', { path: join(admin, 'index') }, cwd, linked)).toBeUndefined();
    expect(pathRefusal('write', { path: join(common, 'objects', 'ab', 'cdef') }, cwd, linked)).toBeUndefined();
  });

  it('refuses reading Pi\'s secrets however the path is spelled', () => {
    const secret = join(root, 'state', 'auth.json');
    expect(pathRefusal('read', { path: secret }, cwd, policy)).toMatch(/not readable/);
    expect(pathRefusal('read', { path: `@${secret}` }, cwd, policy)).toMatch(/not readable/);
    expect(pathRefusal('read', { path: `file://${secret}` }, cwd, policy)).toMatch(/not readable/);
    expect(pathRefusal('read', { path: '../state/./auth.json' }, cwd, policy)).toMatch(/not readable/);
    expect(pathRefusal('read', { path: join(root, 'state', 'sessions', 'x.jsonl') }, cwd, policy)).toMatch(/not readable/);
  });

  it('refuses reading a secret through a symlink in the Worktree', async () => {
    await symlink(join(root, 'state', 'auth.json'), join(cwd, 'leak'));
    expect(pathRefusal('read', { path: 'leak' }, cwd, policy)).toMatch(/not readable/);
  });

  it('refuses Pi\'s own /proc, which shows its environment and every other process\'s', () => {
    expect(pathRefusal('read', { path: '/proc/self/environ' }, cwd, policy)).toMatch(/not readable/);
    expect(pathRefusal('read', { path: `/proc/${process.pid}/environ` }, cwd, policy)).toMatch(/not readable/);
    expect(pathRefusal('ls', { path: '/proc' }, cwd, policy)).toMatch(/not readable/);
    expect(pathRefusal('grep', { pattern: 'KEY', path: '/' }, cwd, policy)).toMatch(/not readable/);
  });

  it('refuses a search or listing rooted at or above a path it may not read', () => {
    expect(pathRefusal('ls', { path: join(root, 'state') }, cwd, policy)).toMatch(/not readable/);
    expect(pathRefusal('find', { pattern: '*.json', path: root }, cwd, policy)).toMatch(/not readable/);
    expect(pathRefusal('grep', { pattern: 'token', path: '~' }, cwd, sessionPolicy(rendered({ denyRead: [join(homedir(), '.ssh')] }), { cwd, stateDir: join(root, 'state'), tempDir: join(root, 'tmp') }))).toMatch(/not readable/);
  });

  it('leaves other tools alone and refuses a file tool without a usable path', () => {
    expect(pathRefusal('bash', { command: 'cat /etc/passwd' }, cwd, policy)).toBeUndefined();
    expect(pathRefusal('read', {}, cwd, policy)).toMatch(/path/);
  });
});

describe('the file tools\' own operations', () => {
  let policy: SandboxPolicy;
  let cwd = '';
  let ops: ReturnType<typeof fileOperations>;
  beforeEach(async () => {
    cwd = join(root, 'work');
    await mkdir(join(cwd, 'sub'), { recursive: true });
    await mkdir(join(root, 'state'), { recursive: true });
    await mkdir(join(root, 'outside'), { recursive: true });
    await writeFile(join(root, 'state', 'auth.json'), 'secret');
    await writeFile(join(root, 'outside', 'rc'), 'keep');
    await writeFile(join(cwd, 'README.md'), 'hi');
    policy = sessionPolicy(rendered({ denyRead: [] }), { cwd, stateDir: join(root, 'state'), tempDir: join(root, 'tmp') });
    ops = fileOperations(() => ({ policy, cwd }));
  });
  // what a command running beside the tool does between the path check and the tool's use
  const swap = async (path: string, target: string) => { await rm(path, { recursive: true, force: true }); await symlink(target, path); };

  it('read, write and make folders inside the Worktree, through links that stay inside', async () => {
    expect((await ops.readFile(join(cwd, 'README.md'))).toString()).toBe('hi');
    await ops.mkdir(join(cwd, 'src', 'deep'));
    await ops.writeFile(join(cwd, 'src', 'deep', 'new.ts'), 'one');
    await symlink(join(cwd, 'README.md'), join(cwd, 'readme-link'));
    await ops.writeFile(join(cwd, 'readme-link'), 'two');
    expect(await readFile(join(cwd, 'src', 'deep', 'new.ts'), 'utf8')).toBe('one');
    expect(await readFile(join(cwd, 'README.md'), 'utf8')).toBe('two');
  });

  it('refuse reading a file swapped for a link to a secret after its path was checked', async () => {
    const path = join(cwd, 'notes.txt');
    await writeFile(path, 'plain');
    expect(pathRefusal('read', { path }, cwd, policy)).toBeUndefined();
    await swap(path, join(root, 'state', 'auth.json'));
    await expect(ops.readFile(path)).rejects.toThrow(/not readable/);
    await expect(ops.read(path, async opened => (await readFile(opened)).toString())).rejects.toThrow(/not readable/);
  });

  it('refuse writing through a file or folder swapped for a link out, leaving what is outside untouched', async () => {
    const file = join(cwd, 'notes.txt');
    await writeFile(file, 'plain');
    expect(pathRefusal('write', { path: file }, cwd, policy)).toBeUndefined();
    await swap(file, join(root, 'outside', 'rc'));
    await expect(ops.writeFile(file, 'evil')).rejects.toThrow(/outside/);
    expect(await readFile(join(root, 'outside', 'rc'), 'utf8')).toBe('keep');

    expect(pathRefusal('write', { path: join(cwd, 'sub', 'new') }, cwd, policy)).toBeUndefined();
    await swap(join(cwd, 'sub'), join(root, 'outside'));
    await expect(ops.writeFile(join(cwd, 'sub', 'new'), 'evil')).rejects.toThrow(/outside/);
    await expect(ops.mkdir(join(cwd, 'sub', 'made', 'deeper'))).rejects.toThrow(/outside/);
    expect(await readdir(join(root, 'outside'))).toEqual(['rc']);
  });

  it('refuse writing what the policy protects, and anything before the policy is loaded', async () => {
    await expect(ops.mkdir(join(cwd, '.vscode'))).rejects.toThrow(/protected/);
    await expect(ops.writeFile(join(cwd, '.bashrc'), 'x')).rejects.toThrow(/protected/);
    await expect(fileOperations(() => undefined).readFile(join(cwd, 'README.md'))).rejects.toThrow(/policy/);
  });
});

describe('a sandboxed command\'s environment', () => {
  it('keeps only the base names, LC_*, and the names the policy adds', () => {
    const env = commandEnv({ PATH: '/bin', HOME: '/h', USER: 'u', SHELL: '/bin/bash', LANG: 'C', LC_ALL: 'C', TERM: 'xterm', TMPDIR: '/tmp', GH_TOKEN: 'gh', OPENROUTER_API_KEY: 'sk', RAC_LAUNCH_NONCE: 'n', RAC_SANDBOX_POLICY: '/p', TMUX: '/tmp/tmux-1000/default,1,0', PI_SESSION_ID: 's' }, ['GH_TOKEN']);
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', USER: 'u', SHELL: '/bin/bash', LANG: 'C', LC_ALL: 'C', TERM: 'xterm', TMPDIR: '/tmp', GH_TOKEN: 'gh' });
  });
});
