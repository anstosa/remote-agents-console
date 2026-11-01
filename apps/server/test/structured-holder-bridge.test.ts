import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredAgents, holderProcesses, type HolderRef, type HolderWindows } from '../src/transports/structured-agents.js';

const hostTmuxDirectory = process.env.RAC_HOST_TMUX_DIR;
const roots: string[] = [];
// restore the process-wide bridge marker after path-boundary tests
afterEach(async () => {
  if (hostTmuxDirectory === undefined) delete process.env.RAC_HOST_TMUX_DIR; else process.env.RAC_HOST_TMUX_DIR = hostTmuxDirectory;
  // remove only persistence fixtures this suite made
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// bridged child pids belong to the host namespace and must never be signalled from the container
describe('a bridged structured holder', () => {
  it('exposes the current holder policy generation through the process boundary', async () => {
    const generation = 'a'.repeat(64);
    const holderGeneration = vi.fn(async () => generation);
    const windows: HolderWindows = {
      openHolderWindow: async () => undefined,
      captureHolder: async () => undefined,
      holderRunning: async () => false,
      closeHolder: async () => {},
      holderGeneration
    };

    await expect(holderProcesses(windows, {}).sandboxGeneration?.('pi')).resolves.toBe(generation);
    expect(holderGeneration).toHaveBeenCalledExactlyOnceWith('pi');
  });

  it('stops by closing its exact tagged window without probing or signalling its host pid', async () => {
    const holder: HolderRef = { agentId: 'agent-1', socket: '/shared/agent-1.sock', pane: '%9', tmuxSocket: '/host-tmux/default', host: true, pid: 4242 };
    const holderRunning = vi.fn(async () => true);
    const closeHolder = vi.fn(async () => {});
    const windows: HolderWindows = {
      openHolderWindow: async () => undefined,
      captureHolder: async () => undefined,
      holderRunning,
      closeHolder
    };
    const kill = vi.spyOn(process, 'kill');

    await holderProcesses(windows, { pi: { program: '/host/node', args: [], env: {}, launchable: true } }).stop(holder, { kind: 'pi', home: '/host/conductor' });

    expect(holderRunning).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(closeHolder).toHaveBeenCalledExactlyOnceWith(holder);
    kill.mockRestore();
  });

  it('treats a missing persisted host marker as bridged while the bridge is live', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    const holder: HolderRef = { agentId: 'agent-old', socket: '/shared/agent-old.sock', pane: '%8', tmuxSocket: '/host-tmux/default', pid: 4343 };
    const holderRunning = vi.fn(async () => true);
    const closeHolder = vi.fn(async () => {});
    const kill = vi.spyOn(process, 'kill');

    await holderProcesses({ openHolderWindow: async () => undefined, captureHolder: async () => undefined, holderRunning, closeHolder }, { pi: { program: '/host/node', args: [], env: {}, launchable: true } }).stop(holder, { kind: 'pi', home: '/host/conductor' });

    expect(holderRunning).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(closeHolder).toHaveBeenCalledExactlyOnceWith(holder);
    kill.mockRestore();
  });

  it.each([
    { host: false, tmuxSocket: '/host-tmux/default' },
    { host: true },
    { host: true, tmuxSocket: 'relative/default' },
    { host: true, tmuxSocket: '' },
    { host: true, tmuxSocket: '/host-tmux/default', sandboxGeneration: 'not-a-sha256' },
    { host: true, tmuxSocket: '/host-tmux/default', sandboxGeneration: [] }
  ])('sets aside malformed persisted holder bridge metadata %#', async metadata => {
    const root = await mkdtemp(join(tmpdir(), 'rac-holder-record-'));
    roots.push(root);
    const file = join(root, 'structured-agents.json');
    await writeFile(file, JSON.stringify([{ id: 'agent-1', kind: 'pi', placeId: 'proj:/host', home: '/host', sandboxed: true, lifecycle: 'live', origin: 'operator', launchedAt: 1, holder: { agentId: 'agent-1', socket: '/shared/agent-1.sock', pane: '%1', pid: 42, ...metadata } }]));
    const processes = { start: async () => undefined, attach: async () => undefined, stderr: async () => undefined, stop: async () => {} };

    expect(await new StructuredAgents(processes as never, { file }).agents()).toEqual([]);
  });

  it('refuses an aliased Place before resolving a Conversation or opening a window', async () => {
    process.env.RAC_HOST_TMUX_DIR = '/host-tmux';
    const openHolderWindow = vi.fn(async () => undefined);
    const windows: HolderWindows = {
      openHolderWindow,
      captureHolder: async () => undefined,
      holderRunning: async () => false,
      closeHolder: async () => {}
    };
    const place = { id: 'proj:/container/conductor', kind: 'directory' as const, projectId: 'proj', label: 'Conductor', home: '/container/conductor', hostPath: '/host/conductor' };

    const started = await holderProcesses(windows, { pi: { program: '/host/node', args: [], env: {}, launchable: true } }).start({ id: 'agent-2', kind: 'pi', place, sandboxed: true, nonce: 'nonce' }, () => {});

    expect(started).toBeUndefined();
    expect(openHolderWindow).not.toHaveBeenCalled();
  });
});
