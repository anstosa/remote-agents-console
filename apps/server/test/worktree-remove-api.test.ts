import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { ReviewTourStore } from '../src/review-tour/store.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';
import { stated } from './helpers/agent.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true } as never;
const host = 'agents.example.com';
const mutationHeaders = { host, origin: `https://${host}`, cookie: '__Host-rac=x', 'x-csrf-token': 'csrf' };
const readHeaders = { host, cookie: '__Host-rac=x' };
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

const linked = testWorktree({ id: 'proj:/repo/wts/feat', projectId: 'proj', label: 'Proj · feat', path: '/repo/wts/feat', identity: '/repo/wts/feat', main: false, pinned: false, branch: 'feat' });
const cleanFacts = { main: false, detached: false, locked: false, branch: 'feat', dirtyCount: 0, pushed: true, merged: true, ahead: 0, behind: 0 };

async function stores() {
  const root = await mkdtemp(join(tmpdir(), 'rac-remove-api-')); dirs.push(root);
  return {
    worktreeStore: new WorktreeLaunchStore({ file: join(root, 'worktrees.json') }),
    queuedPrompts: new QueuedPromptService(join(root, 'queued.json')),
    promptHistory: new PromptHistoryService(join(root, 'history.json')),
    reviewStore: new ReviewTourStore(join(root, 'reviews.json'))
  };
}

// a discovery stub reporting the linked worktree, with a controllable running-agent set
function discoveryStub(agents: Array<{ worktreeId?: string }> = [], worktrees = [linked]) {
  return {
    invalidateWorktrees: () => {},
    worktreesNow: () => worktrees,
    worktrees: async () => worktrees,
    place: async () => undefined,
    dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents, projects: [] })
  } as never;
}

async function app(deps: Record<string, unknown>) {
  return await buildApp(testConfig({ publicOrigin: new URL(`https://${host}`), projects: [testProject({ id: 'proj' })] }), { auth, control, dashboardUpdates, ...deps } as never);
}

describe('GET /api/worktrees/:id/removal', () => {
  it('returns the fresh facts and the runtime blockers', async () => {
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }) } as never;
    const agent = stated({ id: 'agent-x', paneId: '%1', sessionId: 's:$1', socketFingerprint: 's', home: linked.identity, worktreeId: linked.id, title: 'Ready' });
    const server = await app({ discovery: discoveryStub([agent]), worktreeManagement, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(linked.id)}/removal`, headers: readHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ...cleanFacts, blockers: ['a running agent'], stopsProcesses: [] });
    } finally { await server.close(); }
  });

  it('still blocks on a Review run\'s Agent, named as a Review run', async () => {
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }) } as never;
    const reviewer = stated({ id: 'agent-r', paneId: '%2', sessionId: 's:$1', socketFingerprint: 's', home: linked.identity, worktreeId: linked.id, title: 'Ready', reviewRun: 'run_abcdefgh1234' });
    const server = await app({ discovery: discoveryStub([reviewer]), worktreeManagement, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(linked.id)}/removal`, headers: readHeaders });
      expect(response.json()).toEqual({ ...cleanFacts, blockers: ['a Review run'], stopsProcesses: [] });
    } finally { await server.close(); }
  });

  // a running Stack process is no blocker: Remove stops it, and the dialog says so
  it('names the running Stack process Remove will stop, never as a blocker', async () => {
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }) } as never;
    const worktreeCommands = { sessionRunning: async () => false, runningProcesses: async () => ['dev'] } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, worktreeCommands, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(linked.id)}/removal`, headers: readHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ...cleanFacts, blockers: [], stopsProcesses: ['dev'] });
    } finally { await server.close(); }
  });

  it('404s an unknown worktree and propagates a service refusal', async () => {
    const worktreeManagement = { removal: async () => ({ ok: false, status: 409, error: 'blocked' }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, ...(await stores()) });
    try {
      expect((await server.inject({ method: 'GET', url: '/api/worktrees/proj%3A%2Fnope/removal', headers: readHeaders })).statusCode).toBe(404);
      const refused = await server.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(linked.id)}/removal`, headers: readHeaders });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'blocked' });
    } finally { await server.close(); }
  });
});

describe('guarded branch deletion API', () => {
  it('returns fresh branch facts from the worktree repository', async () => {
    const facts = { branch: 'feature/done', checkedOut: false, dirtyCount: 0, pushed: true, merged: true, defaultBranch: false };
    const worktreeManagement = { branchRemoval: async () => ({ ok: true, facts }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(linked.id)}/branch-removal?branch=${encodeURIComponent(facts.branch)}`, headers: readHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(facts);
    } finally { await server.close(); }
  });

  it('passes explicit loss acknowledgement and refreshes cleanup after deletion', async () => {
    const deletions: Array<{ projectId: string; branch: string; discardUnpushed: boolean }> = [];
    let scans = 0;
    let refreshes = 0;
    const worktreeManagement = {
      // record the guarded delete contract
      deleteBranchGuarded: async (projectId: string, branch: string, discardUnpushed: boolean) => {
        deletions.push({ projectId, branch, discardUnpushed });
        return { ok: true };
      }
    } as never;
    const cleanup = { pending: () => [], scan: async () => { scans += 1; return []; }, cleanup: async () => [] } as never;
    const updates = { setLoader: () => {}, refresh: async () => { refreshes += 1; }, close: () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, cleanup, dashboardUpdates: updates, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}/branch`, headers: mutationHeaders, payload: { branch: 'feature/risky', discardUnpushed: true } });
      expect(response.statusCode).toBe(204);
      expect(deletions).toEqual([{ projectId: 'proj', branch: 'feature/risky', discardUnpushed: true }]);
      expect(scans).toBe(1);
      expect(refreshes).toBe(1);
    } finally { await server.close(); }
  });

  it('rejects malformed input and preserves service guard failures', async () => {
    const worktreeManagement = { deleteBranchGuarded: async () => ({ ok: false, status: 409, error: 'the branch is checked out; remove its worktree first' }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, ...(await stores()) });
    try {
      const malformed = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}/branch`, headers: mutationHeaders, payload: { branch: 'feature', discardUnpushed: 'yes' } });
      expect(malformed.statusCode).toBe(400);
      const refused = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}/branch`, headers: mutationHeaders, payload: { branch: 'feature' } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'the branch is checked out; remove its worktree first' });
    } finally { await server.close(); }
  });
});

describe('DELETE /api/worktrees/:id', () => {
  it('refuses main, locked, a running agent, and a dirty tree without discard — with no side effects', async () => {
    const killed: string[] = [];
    let removeCalls = 0;
    const worktreeManagement = { removal: async () => ({ ok: true, facts: { ...cleanFacts, dirtyCount: 3 } }), removeCheckout: async () => { removeCalls += 1; return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async (w: { id: string }) => { killed.push(w.id); } } as never;
    const main = testWorktree({ id: 'proj:/repo', projectId: 'proj', path: '/repo', identity: '/repo', main: true });
    const locked = testWorktree({ ...linked, locked: true });
    const withMain = await app({ discovery: discoveryStub([], [main]), worktreeManagement, launch, ...(await stores()) });
    try {
      expect((await withMain.inject({ method: 'DELETE', url: '/api/worktrees/proj%3A%2Frepo', headers: mutationHeaders })).statusCode).toBe(409);
    } finally { await withMain.close(); }
    const withLocked = await app({ discovery: discoveryStub([], [locked]), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await withLocked.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'Locked worktrees cannot be removed' });
    } finally { await withLocked.close(); }
    const agent = stated({ id: 'agent-x', paneId: '%1', sessionId: 's:$1', socketFingerprint: 's', home: linked.identity, worktreeId: linked.id, title: 'Ready' });
    const withAgent = await app({ discovery: discoveryStub([agent]), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await withAgent.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('a running agent');
    } finally { await withAgent.close(); }
    // a dirty tree without discard is refused, and its records survive untouched
    const dirtyStores = await stores();
    await dirtyStores.worktreeStore.setPinned(linked.id, true);
    const dirty = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...dirtyStores });
    try {
      const response = await dirty.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('Discard uncommitted changes');
      expect(await dirtyStores.worktreeStore.pins()).toEqual({ [linked.id]: true });
    } finally { await dirty.close(); }
    // no refusal ever killed a shell or ran git remove
    expect(killed).toEqual([]);
    expect(removeCalls).toBe(0);
  });

  it('refuses removal while a running stack command holds the worktree, stopping no Stack process', async () => {
    let stops = 0;
    let removeCalls = 0;
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => { removeCalls += 1; return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => {} } as never;
    // no running agent, but the stack service reports an active operation beside a Stack process
    const worktreeCommands = { sessionRunning: async () => true, stopForRemoval: async (_w: unknown, remove: () => Promise<unknown>) => { stops += 1; return await remove(); } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeCommands, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('a running stack command');
      expect(stops).toBe(0);
      expect(removeCalls).toBe(0);
    } finally { await server.close(); }
  });

  // the Stack process is stopped (gracefully, then killed, inside the service) and only then do
  // the idle shells and the checkout go; a refused Remove leaves it running
  it('stops the Stack process before the shells and the checkout, and not on a refusal', async () => {
    const order: string[] = [];
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => { order.push('remove'); return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => { order.push('kill'); } } as never;
    // the Stop resolves on a later tick, so a dropped `await` would let git run first
    const worktreeCommands = { sessionRunning: async () => false, stopForRemoval: async (_w: unknown, remove: () => Promise<unknown>) => { await new Promise(resolve => setTimeout(resolve, 5)); order.push('stop'); const removed = await remove(); order.push('released'); return removed; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeCommands, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(200);
      expect(order).toEqual(['stop', 'kill', 'remove', 'released']);
    } finally { await server.close(); }
    const dirtyManagement = { removal: async () => ({ ok: true, facts: { ...cleanFacts, dirtyCount: 1 } }), removeCheckout: async () => ({ ok: true }) } as never;
    order.length = 0;
    const dirty = await app({ discovery: discoveryStub(), worktreeManagement: dirtyManagement, launch, worktreeCommands, ...(await stores()) });
    try {
      expect((await dirty.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders })).statusCode).toBe(409);
      expect(order).toEqual([]);
    } finally { await dirty.close(); }
  });

  // the Stop can take seconds; an Agent that starts meanwhile still refuses the removal
  it('checks the blockers again once the Stack process has stopped', async () => {
    let removeCalls = 0;
    const agents: unknown[] = [];
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => { removeCalls += 1; return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => {} } as never;
    const agent = stated({ id: 'agent-x', paneId: '%1', sessionId: 's:$1', socketFingerprint: 's', home: linked.identity, worktreeId: linked.id, title: 'Ready' });
    const worktreeCommands = { sessionRunning: async () => false, stopForRemoval: async (_w: unknown, remove: () => Promise<unknown>) => { agents.push(agent); return await remove(); } } as never;
    const server = await app({ discovery: discoveryStub(agents as never), worktreeManagement, launch, worktreeCommands, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain('a running agent');
      expect(removeCalls).toBe(0);
    } finally { await server.close(); }
  });

  it('keeps the checkout when the Stack process could not be stopped or is mid-action', async () => {
    let removeCalls = 0;
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => { removeCalls += 1; return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => {} } as never;
    for (const [outcome, status, error] of [[false, 500, 'could not stop the stack process'], ['busy', 409, 'stack operation already running']] as const) {
      const worktreeCommands = { sessionRunning: async () => false, stopForRemoval: async () => outcome } as never;
      const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeCommands, ...(await stores()) });
      try {
        const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toEqual({ error });
      } finally { await server.close(); }
    }
    expect(removeCalls).toBe(0);
  });

  it('kills the idle shells before git, deletes every wire-id record after, and returns removed', async () => {
    const order: string[] = [];
    const invalidated: string[] = [];
    // killWorktreeShells resolves on a later tick; if the route dropped its `await`,
    // removeCheckout would push 'remove' first — so this proves completion order, not call order
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => { order.push('remove'); return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push('kill'); } } as never;
    const { worktreeStore, queuedPrompts, promptHistory } = await stores();
    const reviewStore = { summaries: async () => [], current: async () => undefined, invalidate: async (id: string) => { invalidated.push(id); return 1; }, save: async () => undefined } as never;
    await worktreeStore.setPinned(linked.id, true);
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore, queuedPrompts, promptHistory, reviewStore });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ removed: true });
      // the idle shell is killed before git removes the checkout
      expect(order).toEqual(['kill', 'remove']);
      // every wire-id-keyed record for the worktree is gone; the review tour is invalidated
      expect(await worktreeStore.pins()).toEqual({});
      expect(invalidated).toEqual([linked.id]);
    } finally { await server.close(); }
  });

  it('removes a clean tree without --force', async () => {
    let forced: boolean | undefined;
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async (_w: unknown, o: { force: boolean }) => { forced = o.force; return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(200);
      // a clean removal never forces
      expect(forced).toBe(false);
    } finally { await server.close(); }
  });

  it('force-removes a dirty tree when discardChanges is set', async () => {
    let forced: boolean | undefined;
    const worktreeManagement = { removal: async () => ({ ok: true, facts: { ...cleanFacts, dirtyCount: 2 } }), removeCheckout: async (_w: unknown, o: { force: boolean }) => { forced = o.force; return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders, payload: { discardChanges: true } });
      expect(response.statusCode).toBe(200);
      expect(forced).toBe(true);
    } finally { await server.close(); }
  });

  it('preserves the worktree records when git removal fails', async () => {
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => ({ ok: false, status: 409, error: 'fatal: could not remove' }) } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => {} } as never;
    const { worktreeStore, queuedPrompts, promptHistory, reviewStore } = await stores();
    await worktreeStore.setPinned(linked.id, true);
    await queuedPrompts.enqueue(linked.id, 'keep me');
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, worktreeStore, queuedPrompts, promptHistory, reviewStore });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'fatal: could not remove' });
      // records are deleted only after a successful removal
      expect(await worktreeStore.pins()).toEqual({ [linked.id]: true });
      expect(await queuedPrompts.list(linked.id)).toHaveLength(1);
    } finally { await server.close(); }
  });

  it('deletes the branch when asked, reporting its failure without undoing the removal', async () => {
    const deleted: string[] = [];
    const worktreeManagement = { removal: async () => ({ ok: true, facts: cleanFacts }), removeCheckout: async () => ({ ok: true }), deleteBranch: async (_w: unknown, b: string) => { deleted.push(b); return { ok: false, error: 'error: unmerged' }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders, payload: { deleteBranch: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ removed: true, branchDeleteError: 'error: unmerged' });
      expect(deleted).toEqual(['feat']);
    } finally { await server.close(); }
  });

  // the dialog warns before offering it, so an unpushed, unmerged branch is still the
  // operator's call to lose
  it('deletes an unpushed, unmerged branch when it is explicitly requested', async () => {
    const deleted: string[] = [];
    const worktreeManagement = { removal: async () => ({ ok: true, facts: { ...cleanFacts, pushed: false, merged: false } }), removeCheckout: async () => ({ ok: true }), deleteBranch: async (_w: unknown, b: string) => { deleted.push(b); return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders, payload: { deleteBranch: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ removed: true, branchDeleted: true });
      expect(deleted).toEqual(['feat']);
    } finally { await server.close(); }
  });

  it('leaves the branch alone when it was not requested', async () => {
    const deleted: string[] = [];
    const worktreeManagement = { removal: async () => ({ ok: true, facts: { ...cleanFacts, pushed: false, merged: false } }), removeCheckout: async () => ({ ok: true }), deleteBranch: async (_w: unknown, b: string) => { deleted.push(b); return { ok: true }; } } as never;
    const launch = { placeConsoleShells: async () => [], killWorktreeShells: async () => {} } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, launch, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(linked.id)}`, headers: mutationHeaders, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ removed: true });
      expect(deleted).toEqual([]);
    } finally { await server.close(); }
  });
});

describe('POST /api/projects/:id/worktrees/prune', () => {
  it('prunes, deletes orphaned records, and returns 204', async () => {
    const worktreeManagement = { prune: async () => ({ ok: true }) } as never;
    const { worktreeStore, queuedPrompts, promptHistory } = await stores();
    // one record git still lists (kept) and one it lists nowhere (orphan, deleted)
    await worktreeStore.setPinned(linked.id, true);
    await worktreeStore.setPinned('proj:/repo/wts/gone', true);
    const server = await app({ discovery: discoveryStub(), worktreeManagement, worktreeStore, queuedPrompts, promptHistory });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees/prune', headers: mutationHeaders });
      expect(response.statusCode).toBe(204);
      expect(await worktreeStore.pins()).toEqual({ [linked.id]: true });
    } finally { await server.close(); }
  });

  it('propagates a service refusal', async () => {
    const worktreeManagement = { prune: async () => ({ ok: false, status: 409, error: 'blocked' }) } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'POST', url: '/api/projects/proj/worktrees/prune', headers: mutationHeaders });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'blocked' });
    } finally { await server.close(); }
  });
});

describe('GET /api/worktrees/closed-pull-requests', () => {
  it('lists the discovered worktrees whose pull request merged or closed', async () => {
    let asked: unknown;
    const worktreeManagement = { closedPullRequestWorktrees: async (worktrees: unknown) => { asked = worktrees; return [{ worktreeId: linked.id, reason: 'merged' }]; } } as never;
    const server = await app({ discovery: discoveryStub(), worktreeManagement, ...(await stores()) });
    try {
      const response = await server.inject({ method: 'GET', url: '/api/worktrees/closed-pull-requests', headers: readHeaders });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ worktrees: [{ worktreeId: linked.id, reason: 'merged' }] });
      expect(asked).toEqual([linked]);
    } finally { await server.close(); }
  });
});
