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
  windowId: '@7',
  cleanupActivity: 'p47',
  socket,
  ...overrides
});
const host = (pid: number, parentPid: number, cmdline: string, startTime = String(pid)): HostProcess => ({ pid, parentPid, cmdline, startTime, comm: 'MainThread' });

const dayMs = 24 * 60 * 60 * 1_000;

// allow runtime fixtures to age a complete visibility snapshot
function idleClock(visible: string[] = []) {
  let now = 0;
  const discovery = {
    // publish the test's visible agents on a known socket
    refresh: async () => visible.map(id => ({ id }) as never),
    tmuxDiscoverySockets: new Set([socket.fingerprint])
  };
  return {
    discovery,
    // expose the observed clock to the cleanup service
    now: () => now,
    // collect the initial observation before reading the overdue rows
    afterThreshold: async (service: CleanupService) => {
      await service.scan();
      now += dayMs + 1;
      return await service.scan();
    }
  };
}

// model a hidden worker with a proven lifetime and independent terminal activity
function idleWorkerFixture(overrides: Partial<Pane> = {}) {
  let now = 0;
  let worker = pane('%3', '$team', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2', ...overrides });
  const state = {
    visible: false, complete: true, leader: false, linked: false, hud: false, leaderHud: false, recognized: true,
    kind: 'codex' as 'codex' | 'omx' | 'claude', childOffset: 0, startTime: '300', capture: 'Finished.\n›',
    // leave the process alone unless a test changes it
    onCapture: () => {}
  };
  const closeIdlePane = vi.fn().mockResolvedValue(true);
  const close = vi.fn().mockResolvedValue(true);
  const service = new CleanupService(
    {
      // expose visibility changes and degraded dashboard inventories
      refresh: async () => state.visible ? [{ id: 'socket-a:%3' } as never] : [],
      get tmuxDiscoverySockets() { return state.complete ? new Set([socket.fingerprint]) : undefined; }
    },
    { find: async () => [socket] },
    {
      // keep a worker's live leader in the same tmux session
      listPanes: async () => [
        worker,
        ...(state.leader ? [pane('%4', '$team', 400)] : []),
        ...(state.linked ? [{ ...worker, sessionId: '$linked' }] : [])
      ],
      // allow a process change during the final terminal read
      capture: async () => { state.onCapture(); return state.capture; },
      closeIdlePane, close, terminateHostProcess: async () => true
    },
    {
      // bind the scan to the process start time, not just the PID
      recognizeAgent: async pid => !state.recognized ? undefined : { kind: state.kind, pid: pid + state.childOffset, wrapped: false, startTime: state.startTime },
      // place the HUD helper under either the selected pane or the team leader
      listProcesses: async () => state.hud || state.leaderHud
        ? [host(999, state.leaderHud ? 400 : 300, 'node\0/home/ubuntu/bin/omx\0hud\0--watch\0')]
        : []
    },
    undefined, () => now
  );
  return {
    service, state, closeIdlePane, close,
    // advance without real delays
    advance: (ms: number) => { now += ms; },
    // mutate the next scan without changing earlier observations
    update: (properties: Partial<Pane>) => { worker = { ...worker, ...properties }; }
  };
}

describe('idle-agent cleanup suggestions', () => {
  // only a manual selection may close a pane, regardless of how long it has been idle
  it('lists a hidden agent after more than 24 hours and only closes it on selection', async () => {
    const { service, advance, closeIdlePane, close } = idleWorkerFixture();
    await expect(service.scan()).resolves.toEqual([]);
    advance(dayMs);
    await expect(service.scan()).resolves.toEqual([]);
    advance(1);
    const [target] = await service.scan();
    expect(target).toMatchObject({ kind: 'orphan-worker', detail: expect.stringContaining('Idle for more than 24 hours') });
    expect(service.pending()).toEqual([target]);
    await expect(service.cleanup([])).resolves.toEqual([target]);
    expect(closeIdlePane).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    await expect(service.cleanup([target!.id])).resolves.toEqual([]);
    expect(closeIdlePane).toHaveBeenCalledOnce();
    expect(closeIdlePane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%3', pid: 300, cleanupActivity: 'p47' }));
  });

  // keep panes out of the list when evidence is missing or they are in use
  it.each([
    { cleanupActivity: undefined }, { title: '⠋ Working' },
    { title: 'Action required' }, { reportedAttention: 'question' }, { reportedAttention: 'working' },
    { paneMode: 'tree-mode' }, { role: 'holder' }, { reviewRun: 'review' }, { spawnedBy: 'conductor' }
  ])('does not list an agent with %j', async overrides => {
    const { service, advance } = idleWorkerFixture(overrides);
    await expect(service.scan()).resolves.toEqual([]);
    advance(dayMs + 1);
    await expect(service.scan()).resolves.toEqual([]);
  });

  // output or a replacement process starts a fresh observation window
  it.each(['output', 'lifetime'] as const)('resets the idle clock after a change in %s', async change => {
    const { service, state, advance, update } = idleWorkerFixture();
    await service.scan();
    advance(dayMs + 1);
    const [original] = await service.scan();
    // change one witness while keeping the pane and PID intact
    if (change === 'output') update({ cleanupActivity: 'p48' });
    else state.startTime = '301';
    await expect(service.scan()).resolves.toEqual([]);
    advance(dayMs + 1);
    const [replacement] = await service.scan();
    expect(replacement!.id).not.toBe(original!.id);
  });

  // an old selection does not authorize cleanup after a change in eligibility
  it.each(['visible', 'leader', 'linked', 'outage'] as const)('rechecks %s on explicit cleanup and removes stale suggestions on scan', async change => {
    const { service, state, advance, closeIdlePane } = idleWorkerFixture();
    await service.scan();
    advance(dayMs + 1);
    const [target] = await service.scan();
    // change the pane's eligibility before the browser submits its old selection
    if (change === 'outage') state.complete = false;
    else state[change] = true;
    await service.cleanup([target!.id]);
    expect(closeIdlePane).not.toHaveBeenCalled();
    await expect(service.scan()).resolves.toEqual([]);
  });

  // the terminal can still surface a question without a title marker
  it('preserves an unanswered question in the terminal when cleanup is requested', async () => {
    const { service, state, advance, closeIdlePane } = idleWorkerFixture();
    state.capture = 'Would you like to continue?\n\n1. Yes\n2. No\n\n›';
    await service.scan();
    advance(dayMs + 1);
    const [target] = await service.scan();

    await expect(service.cleanup([target!.id])).resolves.toEqual([target]);
    expect(closeIdlePane).not.toHaveBeenCalled();
  });

  // birth time still matters after reading the terminal for pending questions
  it('does not close a replacement process that appeared during the terminal read', async () => {
    const { service, state, advance, closeIdlePane } = idleWorkerFixture();
    state.childOffset = 5;
    await service.scan();
    advance(dayMs + 1);
    const [target] = await service.scan();
    state.onCapture = () => { state.startTime = '301'; };

    await expect(service.cleanup([target!.id])).resolves.toEqual([target]);
    expect(closeIdlePane).not.toHaveBeenCalled();
  });

  // the legacy window timestamp cannot distinguish output in the observation second
  it('waits an extra second for a legacy activity witness', async () => {
    const { service, advance } = idleWorkerFixture({ cleanupActivity: 'w1700000000' });
    await service.scan();
    advance(dayMs + 999);
    await expect(service.scan()).resolves.toEqual([]);
    advance(2);
    await expect(service.scan()).resolves.toHaveLength(1);
  });

  // agents with HUD descendants are eligible only through the guarded route
  it('keeps visible mixed panes out of the list and guards the same pane when overdue', async () => {
    const { service, state, advance, closeIdlePane, close } = idleWorkerFixture({ path: '/worktrees/mixed' });
    state.hud = true;
    state.visible = true;
    // dashboard visibility still wins if the fresh process read can't find the agent
    state.recognized = false;
    await expect(service.scan()).resolves.toEqual([]);
    state.recognized = true;
    await expect(service.scan()).resolves.toEqual([]);
    state.visible = false;
    await expect(service.scan()).resolves.toEqual([]);
    advance(dayMs + 1);
    const [target] = await service.scan();
    expect(target).toMatchObject({ kind: 'stale-agent' });
    await expect(service.cleanup([target!.id])).resolves.toEqual([]);
    expect(closeIdlePane).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  // a leader still owns its team even when it also runs a HUD helper
  it('does not mark an idle worker orphaned under a leader with a HUD descendant', async () => {
    const { service, state, advance } = idleWorkerFixture();
    state.leader = true;
    state.leaderHud = true;
    await service.scan();
    advance(dayMs + 1);
    expect(await service.scan()).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'orphan-worker' })]));
  });

  // a stale debris selection cannot authorize closing a live agent that has since started
  it('revalidates an ordinary HUD selection before closing the pane', async () => {
    const { service, state, close } = idleWorkerFixture({ path: '/worktrees/mixed' });
    state.hud = true;
    state.recognized = false;
    const [target] = await service.scan();
    expect(target).toMatchObject({ kind: 'hud-pane' });
    state.recognized = true;
    state.visible = true;
    await service.cleanup([target!.id]);
    expect(close).not.toHaveBeenCalled();
  });

  // each adapter must affirm an empty composer before a selected agent can close
  it.each([['codex', '›', 0], ['omx', '›', 5], ['claude', '❯', 5]] as const)('preserves a %s draft and can close its empty composer', async (kind, caret, offset) => {
    const { service, state, advance, closeIdlePane } = idleWorkerFixture({ path: '/worktrees/hidden', reportedAttention: 'finished' });
    state.kind = kind;
    state.childOffset = offset;
    await service.scan();
    advance(dayMs + 1);
    const [target] = await service.scan();

    state.capture = `${caret} unsent draft`;
    await expect(service.cleanup([target!.id])).resolves.toEqual([target]);
    expect(closeIdlePane).not.toHaveBeenCalled();
    state.capture = caret;
    await expect(service.cleanup([target!.id])).resolves.toEqual([]);
    expect(closeIdlePane).toHaveBeenCalledOnce();
  });
});

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
    const clock = idleClock(['socket-a:%1']);
    const service = new CleanupService(
      clock.discovery,
      { find: async () => [socket] },
      { listPanes: async () => panes, close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async pid => codex.has(pid) ? { kind: 'codex' as const, pid, wrapped: false, startTime: String(pid) } : undefined, listProcesses: async () => processes },
      undefined, clock.now
    );

    const targets = await clock.afterThreshold(service);

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
    const clock = idleClock();
    // build an independently observed cleanup list for each role
    const build = (panes: Pane[]) => new CleanupService(
      clock.discovery,
      { find: async () => [socket] },
      { listPanes: async () => panes, close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async pid => pid === 900 ? { kind: 'codex' as const, pid, wrapped: false, startTime: String(pid) } : undefined, listProcesses: async () => [] },
      undefined, clock.now
    );

    // the same pane, unmarked, is proposed — so the marker is what excludes it
    expect((await clock.afterThreshold(build(unmarked))).map(target => target.kind)).toEqual(['stale-agent']);
    expect(await clock.afterThreshold(build(marked))).toEqual([]);
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
    const clock = idleClock(['socket-a:%1']);
    const service = new CleanupService(
      clock.discovery,
      { find: async () => [socket] },
      { listPanes: async () => panes, close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async pid => kinds[pid] === undefined ? undefined : { kind: kinds[pid]!, pid, wrapped: false, startTime: String(pid) }, listProcesses: async () => [] },
      undefined, clock.now
    );

    const targets = await clock.afterThreshold(service);

    expect(targets.map(target => [target.kind, target.label]).sort()).toEqual([['orphan-worker', 'Orphan OMX worker'], ['stale-agent', 'Stale OMX agent']]);
    expect(targets.find(target => target.kind === 'orphan-worker')?.detail).toContain('%3');
    expect(targets.find(target => target.kind === 'stale-agent')?.detail).toContain('old omx');
  });

  it('cleans only selected targets while unchecked targets and failures stay pending', async () => {
    let panes = [pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }), pane('%5', '$hud', 500, { startCommand: 'omx hud --watch' })];
    const closed: string[] = [];
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      {
        listPanes: async () => panes,
        close: async (_socket, paneId) => { closed.push(paneId); return paneId !== '%3'; },
        terminateHostProcess: async () => true
      },
      { recognizeAgent: async () => undefined, listProcesses: async () => [] }
    );
    const initial = await service.scan();
    const orphan = initial.find(target => target.kind === 'orphan-worker')!;
    const hud = initial.find(target => target.kind === 'hud-pane')!;

    await expect(service.cleanup([orphan.id])).resolves.toEqual([orphan, hud]);
    expect(closed).toEqual(['%3']);

    await expect(service.cleanup([hud.id])).resolves.toEqual([orphan]);
    expect(closed).toEqual(['%3', '%5']);

    panes = [];
    await expect(service.scan()).resolves.toEqual([]);
    panes = [pane('%3', '$orphan', 300, { path: '/repo/.omx/team/demo/worktrees/worker-2' }), pane('%5', '$hud', 500, { startCommand: 'omx hud --watch' })];
    await expect(service.scan()).resolves.toEqual(expect.arrayContaining([orphan, hud]));
  });

  it('versions completed scans and successful actions without advancing cached reads, unchecked targets, or failures', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234);
    let succeeds = false;
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      { listPanes: async () => [pane('%5', '$hud', 500, { startCommand: 'omx hud --watch' })], close: async () => succeeds, terminateHostProcess: async () => true },
      { recognizeAgent: async () => undefined, listProcesses: async () => [] }
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
    const tmux = { listPanes: async () => [pane('%5', '$hud', 500, { startCommand: 'omx hud --watch' })], close: async () => true, terminateHostProcess: async () => true, runShell: async (_socket: SocketRef, command: string) => { shell.push(command); return true; } };
    const service = new CleanupService(
      { refresh: async () => [] },
      { find: async () => [socket] },
      tmux,
      { recognizeAgent: async () => undefined, listProcesses: async () => [] }
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
      { listPanes: async () => [pane('%5', '$hud', 500, { startCommand: 'omx hud --watch' })], close: async () => true, terminateHostProcess: async () => true },
      { recognizeAgent: async () => undefined, listProcesses: async () => [] }
    );
    const [target] = await service.scan();
    await expect(service.cleanup([target!.id, target!.id])).resolves.toBeUndefined();
    await expect(service.cleanup(['cleanup-unknown'])).resolves.toBeUndefined();
    await expect(service.cleanup('all')).resolves.toBeUndefined();
  });
});
