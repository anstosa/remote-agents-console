import { describe, expect, it, vi } from 'vitest';
import type { IntegrationPrincipal } from '../src/integrations/auth/index.js';
import { createWorkerTools, type DeveloperWorkerDependencies } from '../src/integrations/mcp/worker-tools.js';

const ownerA = (lease = 'lease-a'): IntegrationPrincipal => ({ authentication: 'realtime', subjectId: 'voice-a', stableOwnerKey: 'owner-a', leaseKey: lease, audience: 'realtime', scopes: ['agents:spawn'] });
const ownerB: IntegrationPrincipal = { authentication: 'realtime', subjectId: 'voice-b', stableOwnerKey: 'owner-b', leaseKey: 'lease-b', audience: 'realtime', scopes: ['agents:spawn'] };
const worktree = { id: 'worktree-1', kind: 'worktree', projectId: 'project-1', home: '/repo/worktree', identity: '/repo/worktree', available: true };

type WorkerFixtureOptions = {
  allowed?: Partial<Record<'pi' | 'claude' | 'codex', Array<{ model: string }> | undefined>>;
  maxWorkers?: number;
  claudeTransport?: 'tmux' | 'structured';
  launch?: DeveloperWorkerDependencies['structured']['launch'];
};

// build real worker tools around deterministic domain ports
function fixture(options: WorkerFixtureOptions = {}) {
  const owners = new Map<string, string>();
  const workers: Array<{ id: string; owner: string; structured: { lifecycle: 'live' } }> = [];
  let sequence = 0;
  const launch = vi.fn(options.launch ?? (async (_place, kind, input) => {
    const id = `worker-${sequence += 1}`;
    const owner = input.workerOwner?.id;
    if (owner === undefined) return undefined;
    owners.set(id, owner);
    workers.push({ id, owner, structured: { lifecycle: 'live' } });
    return id;
  }));
  const close = vi.fn(async (id: string) => owners.delete(id));
  const createWorktree = vi.fn(async () => ({ ok: true as const, worktreeId: 'created-worktree' }));
  const allowed = options.allowed ?? { pi: [{ model: 'pi-model' }], claude: [{ model: 'claude-model' }], codex: [{ model: 'codex-model' }] };
  const deps: DeveloperWorkerDependencies = {
    config: {
      conductor: { spawnKinds: ['pi', 'claude', 'codex'], maxWorkers: options.maxWorkers ?? 4 },
      adapters: {
        pi: { allowedModels: allowed.pi },
        claude: { allowedModels: allowed.claude, transport: options.claudeTransport ?? 'structured' },
        codex: { allowedModels: allowed.codex }
      },
      projects: [{ id: 'project-1', mode: 'repository' }]
    } as never,
    structured: {
      launch,
      agent: async id => workers.find(worker => worker.id === id) as never,
      workerOwner: async id => owners.get(id),
      ownedWorkers: async owner => workers.filter(worker => worker.owner === owner) as never
    },
    resolvePlace: async id => id === worktree.id ? worktree as never : undefined,
    close,
    createWorktree
  };
  const tools = new Map(createWorkerTools(deps).map(tool => [tool.name, tool]));
  return { tools, launch, close, createWorktree, workers, owners };
}

// execute one named worker tool
async function call(fx: ReturnType<typeof fixture>, name: 'spawn_agent' | 'close_agent' | 'create_worktree', input: Record<string, unknown>, principal: IntegrationPrincipal = ownerA()) {
  return await fx.tools.get(name)!.execute(input, principal);
}

describe('Davo worker tools', () => {
  it('binds workers to the stable owner across lease replacement without forging Conductor origin', async () => {
    const fx = fixture();
    const spawned = await call(fx, 'spawn_agent', { worktree_id: worktree.id, kind: 'pi', request_id: 'request-0001' });
    expect(spawned).toMatchObject({ ok: true, value: { agent_id: 'worker-1' } });
    expect(fx.launch).toHaveBeenCalledWith(worktree, 'pi', expect.objectContaining({ sandboxed: true, workerOwner: { kind: 'davo', id: 'owner-a' } }));
    expect(fx.launch.mock.calls[0]?.[2]).not.toHaveProperty('spawnedBy');
    await expect(call(fx, 'close_agent', { agent_id: 'worker-1', request_id: 'request-0002' }, ownerB)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(fx.close).not.toHaveBeenCalled();
    await expect(call(fx, 'close_agent', { agent_id: 'worker-1', request_id: 'request-0003' }, ownerA('replacement-lease'))).resolves.toMatchObject({ ok: true, value: { closed: true } });
    expect(fx.close).toHaveBeenCalledWith('worker-1');
  });

  it('sandboxes only Pi, launches a structured Claude unsandboxed, and refuses a kind its config launches in a pane', async () => {
    const fx = fixture();
    await call(fx, 'spawn_agent', { worktree_id: worktree.id, kind: 'pi', model: 'pi-model', request_id: 'request-1001' });
    await call(fx, 'spawn_agent', { worktree_id: worktree.id, kind: 'claude', model: 'claude-model', request_id: 'request-1002' });
    await expect(call(fx, 'spawn_agent', { worktree_id: worktree.id, kind: 'codex', model: 'codex-model', request_id: 'request-1003' })).resolves.toMatchObject({ ok: false, error: { code: 'capability_not_supported' } });
    expect(fx.launch.mock.calls.map(call => [call[1], call[2]?.sandboxed, call[2]?.model])).toEqual([
      ['pi', true, { model: 'pi-model' }],
      ['claude', false, { model: 'claude-model' }]
    ]);
    const tmux = fixture({ claudeTransport: 'tmux' });
    await expect(call(tmux, 'spawn_agent', { worktree_id: worktree.id, kind: 'claude', request_id: 'request-1004' })).resolves.toMatchObject({ ok: false, error: { code: 'capability_not_supported' } });
    expect(tmux.launch).not.toHaveBeenCalled();
  });

  it('distinguishes native-default omission, explicit model policy, and an explicit empty policy', async () => {
    const native = fixture({ allowed: { pi: undefined, claude: [{ model: 'claude-model' }], codex: [{ model: 'codex-model' }] } });
    await expect(call(native, 'spawn_agent', { worktree_id: worktree.id, kind: 'pi', request_id: 'request-2001' })).resolves.toMatchObject({ ok: true });
    expect(native.launch.mock.calls[0]?.[2]).not.toHaveProperty('model');
    await expect(call(native, 'spawn_agent', { worktree_id: worktree.id, kind: 'pi', model: 'unapproved', request_id: 'request-2002' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(native.launch).toHaveBeenCalledTimes(1);

    const empty = fixture({ allowed: { pi: [], claude: [{ model: 'claude-model' }], codex: [{ model: 'codex-model' }] } });
    await expect(call(empty, 'spawn_agent', { worktree_id: worktree.id, kind: 'pi', request_id: 'request-2003' })).resolves.toMatchObject({ ok: false, error: { code: 'capability_not_supported' } });
    expect(empty.launch).not.toHaveBeenCalled();
  });

  it('serializes concurrent spawns and refuses the fifth live worker at the configured cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const owners = new Map<string, string>();
    const workers: Array<{ id: string; owner: string; structured: { lifecycle: 'live' } }> = [];
    let sequence = 0;
    const fx = fixture({ maxWorkers: 4 });
    fx.workers.splice(0);
    fx.launch.mockImplementation(async (_place, _kind, input) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      const id = `parallel-${sequence += 1}`;
      const owner = input.workerOwner!.id;
      owners.set(id, owner);
      workers.push({ id, owner, structured: { lifecycle: 'live' } });
      fx.workers.push({ id, owner, structured: { lifecycle: 'live' } });
      fx.owners.set(id, owner);
      inFlight -= 1;
      return id;
    });
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => call(fx, 'spawn_agent', { worktree_id: worktree.id, kind: 'pi', request_id: `request-30${index}0` })));
    expect(peak).toBe(1);
    expect(fx.launch).toHaveBeenCalledTimes(4);
    expect(results.filter(result => result.ok)).toHaveLength(4);
    expect(results[4]).toMatchObject({ ok: false, error: { code: 'capacity' } });
  });

  it('validates create-worktree modes before the existing Add flow', async () => {
    const fx = fixture();
    await expect(call(fx, 'create_worktree', { worktree_id: worktree.id, mode: 'new', branch: 'feature', base: 'main', issue: 7, request_id: 'request-4001' })).resolves.toMatchObject({ ok: true, value: { worktree_id: 'created-worktree' } });
    expect(fx.createWorktree).toHaveBeenLastCalledWith('project-1', { mode: 'new', branch: 'feature', base: 'main' }, 'empty', 7);
    await expect(call(fx, 'create_worktree', { worktree_id: worktree.id, mode: 'pull-request', number: 12, request_id: 'request-4002' })).resolves.toMatchObject({ ok: true });
    expect(fx.createWorktree).toHaveBeenLastCalledWith('project-1', { mode: 'pull-request', number: 12 }, 'empty', undefined);

    for (const input of [
      { mode: 'new' },
      { mode: 'existing', branch: 'feature', base: 'main' },
      { mode: 'pull-request', number: 12, branch: 'feature' },
      { mode: 'pull-request', number: 12, issue: 7 },
      { mode: 'unknown', branch: 'feature' }
    ]) {
      await expect(call(fx, 'create_worktree', { worktree_id: worktree.id, ...input, request_id: 'request-4999' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
    expect(fx.createWorktree).toHaveBeenCalledTimes(2);
  });
});
