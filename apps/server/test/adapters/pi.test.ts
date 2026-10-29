import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { piAdapter } from '../../src/adapters/pi.js';
import { adhocScratchPlace } from '../../src/places/places.js';
import { holderProcesses, type HolderLaunch } from '../../src/transports/structured-agents.js';

// What RAC's Pi is launched with (ADR 0004 amendment): only vetted things load, and a Sandboxed
// launch points the extension at the rendered policy, which the operator's env cannot replace.

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const worktree = async () => { const dir = await mkdtemp(join(tmpdir(), 'rac-pi-launch-')); dirs.push(dir); return dir; };

describe('the Pi Adapter\'s launch', () => {
  it('loads only the console\'s extension, no project settings or packages, and an explicit tool list', async () => {
    const { args } = piAdapter.launch({ cwd: await worktree(), sandboxed: false });
    expect(args).toEqual(expect.arrayContaining(['--mode', 'rpc', '-ne', '--offline', '--no-approve', '--tools', 'read,bash,edit,write,grep,find,ls,ask_user']));
    expect(args.filter(arg => arg === '-e')).toHaveLength(1);
    expect(args).not.toContain('builtin:mcp');
    expect(args).not.toContain('--skill');
  });

  it('passes the Worktree\'s own skills and prompt templates when it has them', async () => {
    const cwd = await worktree();
    await mkdir(join(cwd, '.pi', 'skills'), { recursive: true });
    await mkdir(join(cwd, '.pi', 'prompts'), { recursive: true });
    await mkdir(join(cwd, '.agents', 'skills'), { recursive: true });
    const { args } = piAdapter.launch({ cwd, sandboxed: false });
    expect(args.join(' ')).toContain(`--skill ${join(cwd, '.pi/skills')} --skill ${join(cwd, '.agents/skills')} --prompt-template ${join(cwd, '.pi/prompts')}`);
  });

  it('names the policy only when Sandboxed, failing closed without a rendered one, and always the nonce', async () => {
    const cwd = await worktree();
    expect(piAdapter.launch({ cwd, sandboxed: false, nonce: 'n1' }).env).toEqual({ RAC_LAUNCH_NONCE: 'n1' });
    expect(piAdapter.launch({ cwd, sandboxed: true, nonce: 'n1', files: { 'sandbox.json': '/files/pi/sandbox.json' } }).env).toEqual({ RAC_LAUNCH_NONCE: 'n1', RAC_SANDBOX_POLICY: '/files/pi/sandbox.json' });
    expect(piAdapter.launch({ cwd, sandboxed: true, nonce: 'n1' }).env).toEqual({ RAC_LAUNCH_NONCE: 'n1', RAC_SANDBOX_POLICY: '' });
  });
});

describe('a Pi holder launch', () => {
  it('keeps what the Adapter composes over the operator\'s env', async () => {
    const launches: HolderLaunch[] = [];
    const windows = { openHolderWindow: async (_place: unknown, _id: string, launch: HolderLaunch) => { launches.push(launch); return undefined; }, captureHolder: async () => undefined, holderRunning: async () => false, closeHolder: async () => {} };
    const processes = holderProcesses(windows, { pi: { program: process.execPath, args: [], env: { RAC_SANDBOX_POLICY: '', RAC_LAUNCH_NONCE: 'operator', KEEP: '1' }, launchable: true } }, async () => ({ 'sandbox.json': '/files/pi/sandbox.json' }));
    await processes.start({ id: 'a1', kind: 'pi', place: adhocScratchPlace(await worktree()), sandboxed: true, nonce: 'console' }, () => {});
    expect(launches[0]?.env).toEqual({ KEEP: '1', RAC_LAUNCH_NONCE: 'console', RAC_SANDBOX_POLICY: '/files/pi/sandbox.json' });
  });
});
