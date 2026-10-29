import { describe, expect, it } from 'vitest';
import { NewTaskService } from '../src/new-task/service.js';
import { testConfig, testWorktree } from './helpers/config.js';

const worktree = testWorktree({ id: 'proj:/worktrees/cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', hostPath: '/home/ubuntu/cora', pinned: false, newTask: 'detach && new {taskId}' });
const config = testConfig();
const agent = { id: 'agent-1', pane: { paneId: '%1', sessionId: '$1', socketFingerprint: 'socket' }, home: worktree.identity, title: 'Ready' };
const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
const discoveryStub = () => ({ target: async () => ({ agent, socket }), worktreesNow: () => [worktree] });

const cleanCommand = async (_binary: string, args: string[]) => ({ code: 0, stdout: args.includes('status') ? '' : args.includes('rev-list') ? '0\t0\n' : 'origin/main\n' });

describe('new task', () => {
  it('closes the agent and starts the configured task in a new tmux session', async () => {
    const discovery = discoveryStub();
    const calls: string[] = [];
    const tmux = { closeSession: async () => { calls.push('close-session'); return true; }, markSessionPlace: async (_socket: unknown, pane: string, placeId: string) => { calls.push(`mark ${pane} ${placeId}`); return true; } };
    const command = async (binary: string, args: string[]) => {
      calls.push(`${binary} ${args.join(' ')}`);
      // return the requested stable session field
      if (args.includes('display-message')) return { code: 0, stdout: args.at(-1) === '#{session_id}' ? '$1\n' : 'cora\n' };
      if (args.includes('new-session')) return { code: 0, stdout: '%7\n' };
      return cleanCommand(binary, args);
    };
    const service = new NewTaskService(config, discovery as never, tmux as never, command);

    await expect(service.available(agent.id)).resolves.toEqual({ enabled: true });
    await expect(service.start(agent.id)).resolves.toBe(true);
    expect(calls).toContain('close-session');
    expect(calls.some(call => /rename-session .* rac-replacing-/u.test(call))).toBe(true);
    const launch = calls.find(call => call.includes('new-session'));
    expect(launch).toContain('new-session -d -s cora -P -F #{pane_id} -c /home/ubuntu/cora');
    // the new session replaces the Agent's as the Worktree's Workspace, marked through its pane
    expect(calls).toContain(`mark %7 ${worktree.id}`);
    expect(launch).toContain('RAC_AGENT_COMMAND=');
    expect(launch).toMatch(/cd -- '\\''\/home\/ubuntu\/cora'\\'' && eval '\\''detach && new [A-Za-z0-9_-]{8}'\\''/);
    expect(calls.findIndex(call => call.includes('new-session'))).toBeLessThan(calls.indexOf('close-session'));
  });

  it('does not suspend an agent while the worktree has uncommitted work', async () => {
    const discovery = discoveryStub();
    const tmux = { closeSession: async () => true, markSessionPlace: async () => true };
    const dirtyCommand = async (_binary: string, args: string[]) => ({ code: 0, stdout: args.includes('status') ? ' M README.md\n' : 'origin/main\n' });
    const service = new NewTaskService(config, discovery as never, tmux as never, dirtyCommand);

    await expect(service.available(agent.id)).resolves.toEqual({ enabled: false, reason: 'The working copy must be clean, and any checked-out branch must be pushed before starting a new task.' });
    await expect(service.start(agent.id)).resolves.toBe(false);
  });

  it('allows a clean detached checkout to start a new task', async () => {
    const discovery = discoveryStub();
    const tmux = { closeSession: async () => true, markSessionPlace: async () => true };
    const detachedCommand = async (_binary: string, args: string[]) => ({ code: args.includes('rev-parse') || args.includes('symbolic-ref') ? 1 : 0, stdout: '' });
    const service = new NewTaskService(config, discovery as never, tmux as never, detachedCommand);

    await expect(service.available(agent.id)).resolves.toEqual({ enabled: true });
    await expect(service.start(agent.id)).resolves.toBe(true);
  });

  it('allows a clean branch whose configured upstream is gone to start a new task', async () => {
    const discovery = discoveryStub();
    const tmux = { closeSession: async () => true, markSessionPlace: async () => true };
    const goneUpstreamCommand = async (_binary: string, args: string[]) => {
      if (args.includes('status')) return { code: 0, stdout: '' };
      if (args.includes('symbolic-ref')) return { code: 0, stdout: 'refs/heads/feature/merged\n' };
      if (args.includes('--contains=HEAD')) return { code: 0, stdout: '' };
      if (args.includes('--format=%(upstream:track)')) return { code: 0, stdout: '[gone]\n' };
      return { code: 0, stdout: '' };
    };
    const service = new NewTaskService(config, discovery as never, tmux as never, goneUpstreamCommand);

    await expect(service.available(agent.id)).resolves.toEqual({ enabled: true });
    await expect(service.start(agent.id)).resolves.toBe(true);
  });
});
