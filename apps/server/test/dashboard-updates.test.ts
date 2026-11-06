import { describe, expect, it } from 'vitest';
import { dashboardFingerprint, DashboardUpdates, type DashboardPayload } from '../src/dashboard/updates.js';

describe('dashboard updates', () => {
  it('publishes changed snapshots, replays the current value, and coalesces concurrent refreshes', async () => {
    let value = { generation: 1, agents: [{ id: 'agent-1', title: 'Working' }], worktrees: [] };
    let loads = 0;
    let release: (() => void) | undefined;
    const updates = new DashboardUpdates<typeof value>(dashboard => JSON.stringify([dashboard.agents, dashboard.worktrees]));
    updates.setLoader(async () => {
      loads += 1;
      if (loads === 1) await new Promise<void>(resolve => { release = resolve; });
      return value;
    });
    const seen: typeof value[] = [];
    const unsubscribe = updates.subscribe(snapshot => seen.push(snapshot));

    const first = updates.refresh();
    const duplicate = updates.refresh();
    expect(loads).toBe(1);
    release?.();
    await Promise.all([first, duplicate]);
    expect(seen).toEqual([value]);

    await updates.refresh();
    expect(seen).toHaveLength(1);
    value = { ...value, generation: 2, agents: [{ id: 'agent-1', title: 'Ready' }] };
    await updates.refresh();
    expect(seen).toHaveLength(2);

    const replayed: typeof value[] = [];
    const stopReplay = updates.subscribe(snapshot => replayed.push(snapshot));
    expect(replayed).toEqual([value]);
    unsubscribe();
    stopReplay();
    updates.close();
  });

  it('isolates failed listeners and does not retain a failed replay subscription', async () => {
    let value = { agents: [{ id: 'agent-1' }], worktrees: [] as never[] };
    const updates = new DashboardUpdates<typeof value>();
    updates.setLoader(async () => value);
    const seen: typeof value[] = [];
    updates.subscribe(() => { throw new Error('closed socket'); });
    updates.subscribe(snapshot => seen.push(snapshot));

    await expect(updates.refresh()).resolves.toEqual(value);
    expect(seen).toEqual([value]);
    expect(() => updates.subscribe(() => { throw new Error('failed replay'); })).toThrow('failed replay');
    value = { agents: [{ id: 'agent-2' }], worktrees: [] };
    await expect(updates.refresh()).resolves.toEqual(value);
    expect(seen).toEqual([{ agents: [{ id: 'agent-1' }], worktrees: [] }, value]);
  });

  it('publishes a queued-note revision without an agent status change', async () => {
    const base = { generation: 1, places: [], adapters: {}, agents: [], projects: [], cleanupPending: 0, reviewTour: { available: false, reason: 'generator_unavailable' }, reviews: [] } satisfies DashboardPayload;
    let value: DashboardPayload = { ...base, notesRevision: 0 };
    const updates = new DashboardUpdates<DashboardPayload>(dashboardFingerprint);
    updates.setLoader(async () => value);
    const seen: DashboardPayload[] = [];
    updates.subscribe(snapshot => seen.push(snapshot));

    await updates.refresh();
    value = { ...value, notesRevision: 1 };
    await updates.refresh();

    expect(seen.map(snapshot => snapshot.notesRevision)).toEqual([0, 1]);
  });

  // observe target-only and version-only publications as separate transitions
  it('publishes same-count cleanup target replacements and version-only changes', async () => {
    // build one stable cleanup target
    const target = (id: string) => ({ id, kind: 'stale-agent' as const, label: id, detail: 'old' });
    let value = { generation: 1, places: [], adapters: {}, agents: [], projects: [], cleanupPending: 1, cleanupTargets: [target('cleanup-one')], cleanupVersion: { epoch: 1, revision: 1 }, reviewTour: { available: false, reason: 'generator_unavailable' }, reviews: [] } as DashboardPayload;
    const updates = new DashboardUpdates<DashboardPayload>(dashboardFingerprint);
    updates.setLoader(async () => value);
    const seen: DashboardPayload[] = [];
    updates.subscribe(snapshot => seen.push(snapshot));

    await updates.refresh();
    value = { ...value, cleanupTargets: [target('cleanup-two')] };
    await updates.refresh();
    value = { ...value, cleanupVersion: { epoch: 1, revision: 2 } };
    await updates.refresh();

    expect(seen.map(snapshot => [snapshot.cleanupTargets?.[0]?.id, snapshot.cleanupVersion?.revision])).toEqual([
      ['cleanup-one', 1], ['cleanup-two', 1], ['cleanup-two', 2]
    ]);
  });
});
