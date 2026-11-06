import { describe, expect, it, vi } from 'vitest';
import { CleanupService } from '../src/cleanup/service.js';
import type { HostProcess } from '../src/discovery/processes.js';
import type { Pane, SocketRef } from '../src/domain/models.js';

const socket: SocketRef = { fingerprint: 'socket-a', path: '/tmp/tmux-a', device: 1, inode: 2 };
const pane = (paneId: string, sessionId: string, pid: number, overrides: Partial<Pane> = {}): Pane => ({
  paneId,
  sessionId,
  sessionName: sessionId.slice(1),
  pid,
  path: '/worktrees/repo',
  title: paneId,
  command: 'bash',
  socket,
  ...overrides
});
const host = (pid: number, parentPid: number, cmdline: string, startTime = String(pid)): HostProcess => ({ pid, parentPid, cmdline, startTime, comm: 'MainThread' });

describe('runtime cleanup', () => {
  it('classifies orphan workers, unrepresented Codex panes, HUD panes, and detached HUD watchers without duplicates', async () => {
    const panes = [
      pane('%1', '$team', 100, { title: 'leader' }),
      pane('%2', '$team', 200, { path: '/repo/.omx/team/demo/worktrees/worker-1' }),
      pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }),
      pane('%4', '$hud', 400, { title: 'HUD' }),
      pane('%5', '$stale', 500, { title: 'old agent' })
    ];
    const processes = [
      host(401, 400, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0'),
      host(600, 1, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0', 'start-600')
    ];
    const codex = new Set([100, 200, 300, 500]);
    const service = new CleanupService(
      { refresh: async () => [{ id: 'socket-a:%1' } as never] },
      { find: async () => [socket] },
      { listPanes: async () => panes, close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async pid => codex.has(pid) ? { kind: 'codex' as const, pid, wrapped: false } : undefined, listProcesses: async () => processes }
    );

    const targets = await service.scan();

    expect(targets.map(target => target.kind).sort()).toEqual(['hud-pane', 'hud-process', 'orphan-worker', 'stale-agent']);
    expect(targets).not.toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('%2') })]));
    expect(targets.find(target => target.kind === 'hud-pane')?.detail).toContain('HUD');
    expect(targets.find(target => target.kind === 'hud-process')?.detail).toContain('600');
    expect(new Set(targets.map(target => target.id)).size).toBe(targets.length);
    expect(targets.every(target => /^cleanup-[A-Za-z0-9_-]{24}$/u.test(target.id))).toBe(true);
  });

  it.each(['shell', 'process'])('never proposes a pane with the %s role, even one an adapter rule would otherwise match', async role => {
    // a recognized-but-inactive Codex pane classifies as a stale agent — unless it carries a
    // console role (a Console shell, the operator's own pane, or a Stack process), which cleanup
    // skips outright (spec, Console shells)
    const marked = [pane('%9', '$shell', 900, { role, command: 'zsh' })];
    const unmarked = [pane('%9', '$shell', 900, { command: 'zsh' })];
    const build = (panes: Pane[]) => new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      { listPanes: async () => panes, close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async pid => pid === 900 ? { kind: 'codex' as const, pid, wrapped: false } : undefined, listProcesses: async () => [] }
    );

    // the same pane, unmarked, is proposed — so the marker is what excludes it
    expect((await build(unmarked).scan()).map(target => target.kind)).toEqual(['stale-agent']);
    expect(await build(marked).scan()).toEqual([]);
  });

  it('keeps workers under an OMX leader, flags a stale OMX pane as OMX, and never calls an excluded Codex worker stale', async () => {
    const panes = [
      pane('%1', '$team', 100, { title: 'leader' }),
      pane('%2', '$team', 200, { path: '/repo/.omx/team/demo/worktrees/worker-1' }),
      pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }),
      pane('%6', '$stale', 600, { title: 'old omx' })
    ];
    // the leader and the stale pane are OMX; the team workers run plain Codex
    const kinds: Record<number, 'codex' | 'omx'> = { 100: 'omx', 200: 'codex', 300: 'codex', 600: 'omx' };
    const service = new CleanupService(
      { refresh: async () => [{ id: 'socket-a:%1' } as never] },
      { find: async () => [socket] },
      { listPanes: async () => panes, close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async pid => kinds[pid] === undefined ? undefined : { kind: kinds[pid]!, pid, wrapped: false }, listProcesses: async () => [] }
    );

    const targets = await service.scan();

    expect(targets.map(target => [target.kind, target.label]).sort()).toEqual([['orphan-worker', 'Orphan OMX worker'], ['stale-agent', 'Stale OMX agent']]);
    expect(targets.find(target => target.kind === 'orphan-worker')?.detail).toContain('%3');
    expect(targets.find(target => target.kind === 'stale-agent')?.detail).toContain('old omx');
  });

  it('cleans only selected targets while unchecked targets and failures stay pending', async () => {
    let panes = [pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }), pane('%5', '$stale', 500)];
    const closed: string[] = [];
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      {
        listPanes: async () => panes,
        close: async (_socket, paneId) => { closed.push(paneId); return paneId !== '%3'; },
        terminateHostProcess: async () => true
      },
      { recognizeAgent: async pid => (pid === 300 || pid === 500) ? { kind: 'codex' as const, pid, wrapped: false } : undefined, listProcesses: async () => [] }
    );
    const initial = await service.scan();
    const orphan = initial.find(target => target.kind === 'orphan-worker')!;
    const stale = initial.find(target => target.kind === 'stale-agent')!;

    await expect(service.cleanup([orphan.id])).resolves.toEqual([orphan, stale]);
    expect(closed).toEqual(['%3']);

    await expect(service.cleanup([stale.id])).resolves.toEqual([orphan]);
    expect(closed).toEqual(['%3', '%5']);

    panes = [];
    await expect(service.scan()).resolves.toEqual([]);
    panes = [pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }), pane('%5', '$stale', 500)];
    await expect(service.scan()).resolves.toEqual(expect.arrayContaining([orphan, stale]));
  });

  it('versions completed scans and successful actions without advancing cached reads, unchecked targets, or failures', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234);
    let succeeds = false;
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      { listPanes: async () => [pane('%5', '$stale', 500)], close: async () => succeeds, terminateHostProcess: async () => true },
      { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }), listProcesses: async () => [] }
    );

    try {
      const constructed = service.version;
      expect(constructed).toEqual({ epoch: 1_234, revision: 0 });
      expect(service.version).not.toBe(constructed);

      const [target] = await service.scan();
      expect(service.version).toEqual({ epoch: 1_234, revision: 1 });
      service.pending();
      expect(service.version).toEqual({ epoch: 1_234, revision: 1 });

      await expect(service.cleanup([])).resolves.toEqual([target]);
      expect(service.version).toEqual({ epoch: 1_234, revision: 1 });
      await expect(service.cleanup([target!.id])).resolves.toEqual([target]);
      expect(service.version).toEqual({ epoch: 1_234, revision: 1 });

      succeeds = true;
      await expect(service.cleanup([target!.id])).resolves.toEqual([]);
      expect(service.version).toEqual({ epoch: 1_234, revision: 2 });
      await service.scan();
      expect(service.version).toEqual({ epoch: 1_234, revision: 3 });
    } finally {
      now.mockRestore();
    }
  });

  it('issues no adapter teardown when killing panes: cleanup only closes them', async () => {
    // cleanup kills worker/HUD/stale panes, where a leader's teardown would be wrong
    const shell: string[] = [];
    const tmux = { listPanes: async () => [pane('%5', '$stale', 500)], close: async () => true, terminateHostProcess: async () => true, runShell: async (_socket: SocketRef, command: string) => { shell.push(command); return true; } };
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      tmux,
      { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }), listProcesses: async () => [] }
    );
    const [target] = await service.scan();
    await expect(service.cleanup([target!.id])).resolves.toEqual([]);
    expect(shell).toEqual([]);
  });

  // preserve distinct labels and consent for each branch cleanup reason
  it.each(['merged', 'closed'] as const)('lists %s branches and revalidates the selected reason through the branch cleaner', async reason => {
    let branches = [{ projectId: 'proj', projectLabel: 'Project', branch: 'feature/done', reason }];
    const deleted: string[] = [];
    const branchCleanup = {
      // return current cleanup branches
      cleanupBranches: async () => branches,
      // record and remove one revalidated branch
      deleteCleanupBranch: async (projectId: string, branch: string, selectedReason: 'merged' | 'closed') => {
        deleted.push(`${projectId}:${branch}:${selectedReason}`);
        branches = [];
        return true;
      }
    };
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [] },
      { listPanes: async () => [], close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async () => undefined, listProcesses: async () => [] },
      branchCleanup
    );

    const targets = await service.scan();

    expect(targets).toEqual([expect.objectContaining({ kind: reason === 'closed' ? 'closed-pr-branch' : 'merged-branch', label: 'feature/done', detail: reason === 'closed' ? 'Closed PR (not merged) in Project; deleting this branch discards unmerged work' : 'Merged branch in Project' })]);
    await expect(service.cleanup([targets[0]!.id])).resolves.toEqual([]);
    expect(deleted).toEqual([`proj:feature/done:${reason}`]);
  });

  // reclassification invalidates old consent and dismissal never deletes a branch
  it('rejects stale merged selections after a branch becomes a closed PR target', async () => {
    let reason: 'merged' | 'closed' = 'merged';
    let deletes = 0;
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [] },
      { listPanes: async () => [], close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async () => undefined, listProcesses: async () => [] },
      {
        // expose changing eligibility under the same branch name
        cleanupBranches: async () => [{ projectId: 'proj', projectLabel: 'Project', branch: 'feature/done', reason }],
        // observe any unauthorized deletion attempt
        deleteCleanupBranch: async () => { deletes += 1; return true; }
      }
    );
    const [merged] = await service.scan();
    reason = 'closed';
    const [closed] = await service.scan();

    expect(closed!.id).not.toBe(merged!.id);
    expect(closed!.kind).toBe('closed-pr-branch');
    await expect(service.cleanup([merged!.id])).resolves.toBeUndefined();
    await expect(service.cleanup([])).resolves.toEqual([closed]);
    expect(deletes).toBe(0);
  });

  it('rejects duplicate, unknown, and malformed target selections', async () => {
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      { listPanes: async () => [pane('%5', '$stale', 500)], close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async (pid: number) => ({ kind: 'codex' as const, pid, wrapped: false }), listProcesses: async () => [] }
    );
    const [target] = await service.scan();
    await expect(service.cleanup([target!.id, target!.id])).resolves.toBeUndefined();
    await expect(service.cleanup(['cleanup-unknown'])).resolves.toBeUndefined();
    await expect(service.cleanup('all')).resolves.toBeUndefined();
  });
});
