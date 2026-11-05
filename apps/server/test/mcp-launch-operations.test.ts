import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/domain/models.js';
import type { LaunchKindManifest, LaunchSelectionTarget, PreparedLaunchChoice } from '../src/launch/options-types.js';
import type { IntegrationPrincipal } from '../src/integrations/auth/index.js';
import { createLaunchOperations, type DeveloperLaunchDependencies, type DeveloperManualLaunch } from '../src/integrations/mcp/launch-operations.js';

const davo = (lease = 'lease-a'): IntegrationPrincipal => ({ authentication: 'realtime', subjectId: 'voice-a', stableOwnerKey: 'owner-a', leaseKey: lease, audience: 'realtime', scopes: ['agents:control'] });
const other: IntegrationPrincipal = { authentication: 'realtime', subjectId: 'voice-b', stableOwnerKey: 'owner-b', leaseKey: 'lease-b', audience: 'realtime', scopes: ['agents:control'] };
const conductor: IntegrationPrincipal = { authentication: 'conductor', subjectId: 'conductor-1', audience: 'local', scopes: ['agents:control'] };

const target: LaunchSelectionTarget = { type: 'worktree', id: 'worktree-1' };
const context = { targetId: 'worktree-1', cwd: '/repo/worktree-1' };

// create one bounded launch manifest with semantic native controls
function manifest(overrides: Partial<LaunchKindManifest> = {}): LaunchKindManifest {
  return {
    kind: 'codex',
    optionsRevision: 'revision-1',
    modelPolicy: {
      state: 'explicit',
      allowed: [{ model: 'gpt-test', effort: 'high' }],
      defaultSelection: { mode: 'model', id: 'gpt-test' },
      catalog: [{ id: 'gpt-test', name: 'GPT Test', efforts: ['high'], defaultEffort: 'high' }],
      catalogStatus: 'ready'
    },
    security: {
      controls: [
        { id: 'approval', label: 'Approval', icon: 'hand', options: [{ id: 'ask', label: 'Ask', risk: 'normal', detail: '' }, { id: 'never', label: 'Never', risk: 'warning', detail: '' }] },
        { id: 'sandbox', label: 'Sandbox', icon: 'shield', options: [{ id: 'workspace', label: 'Workspace', risk: 'normal', detail: '' }] }
      ],
      defaults: { approval: 'ask', sandbox: 'workspace' },
      constraints: [],
      status: 'ready'
    },
    ...overrides
  };
}

type LaunchFixtureOptions = {
  kinds?: LaunchKindManifest[];
  now?: { value: number };
  resolve?: DeveloperLaunchDependencies['resolve'];
  list?: DeveloperLaunchDependencies['options']['list'];
  launch?: DeveloperLaunchDependencies['launch'];
};

// build real launch operations around deterministic target and effect ports
function fixture(options: LaunchFixtureOptions = {}) {
  const clock = options.now ?? { value: Date.parse('2026-11-04T00:00:00.000Z') };
  const kinds = options.kinds ?? [manifest()];
  const resolve = vi.fn(options.resolve ?? (async () => ({ target, context })));
  const list = vi.fn(options.list ?? (async () => ({ kinds })));
  const prepare = vi.fn(async (resolvedTarget: LaunchSelectionTarget, raw: Record<string, unknown>): Promise<DeveloperManualLaunch> => ({
    target: resolvedTarget,
    context,
    choice: {
      kind: raw.kind as PreparedLaunchChoice['kind'],
      ...(typeof raw.model === 'string' ? { model: { model: raw.model, ...(typeof raw.effort === 'string' ? { effort: raw.effort } : {}) } } : {}),
      security: raw.security as Record<string, string>,
      optionsRevision: raw.optionsRevision as string
    }
  }));
  const launch = vi.fn(options.launch ?? (async (prepared: DeveloperManualLaunch) => ({
    id: `actual-${prepared.target.type === 'worktree' ? prepared.target.id : 'agent'}`,
    kind: prepared.choice.kind,
    transport: 'structured',
    home: '/repo',
    title: '',
    attention: 'finished',
    structured: { lifecycle: 'live', revision: 1, switchable: true, ...(prepared.choice.model === undefined ? {} : { model: { id: prepared.choice.model.model, ...(prepared.choice.model.effort === undefined ? {} : { effort: prepared.choice.model.effort }) } }) }
  } as Agent)));
  const deps: DeveloperLaunchDependencies = { options: { list }, resolve, prepare, launch, conductorKinds: ['pi'], now: () => clock.value };
  return { ports: createLaunchOperations(deps), clock, resolve, list, prepare, launch };
}

// request one option and return its identifier
async function option(fx: ReturnType<typeof fixture>, principal: IntegrationPrincipal = davo(), input: Record<string, unknown> = { destination_kind: 'worktree', worktree_id: 'worktree-1' }): Promise<string> {
  const result = await fx.ports.get_launch_options!(input, principal);
  if (!result.ok) throw new Error(result.error.code);
  return (result.value as { option_id: string }).option_id;
}

describe('developer launch operations', () => {
  it('binds options to the exact Davo lease and stable owner', async () => {
    const fx = fixture();
    const first = await option(fx);
    await expect(fx.ports.launch_agent!({ option_id: first, kind: 'codex', request_id: 'request-1001' }, other)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(fx.launch).not.toHaveBeenCalled();
    await expect(fx.ports.launch_agent!({ option_id: first, kind: 'codex', request_id: 'request-1002' }, davo('replacement-lease'))).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(fx.launch).not.toHaveBeenCalled();
    await expect(fx.ports.launch_agent!({ option_id: first, kind: 'codex', request_id: 'request-1003' }, davo())).resolves.toMatchObject({ ok: true, value: { agent_id: 'actual-worktree-1' } });
    expect(fx.launch).toHaveBeenCalledOnce();
  });

  it('expires options and refuses ordinary Conductor launch authority', async () => {
    const fx = fixture({ kinds: [manifest({ kind: 'pi' }), manifest({ kind: 'codex' })] });
    const conductorResult = await fx.ports.get_launch_options!({ destination_kind: 'worktree', worktree_id: 'worktree-1' }, conductor);
    expect(conductorResult).toMatchObject({ ok: true, value: { ordinary_launch: false, kinds: [{ kind: 'pi' }] } });
    const conductorId = (conductorResult as { ok: true; value: { option_id: string } }).value.option_id;
    await expect(fx.ports.launch_agent!({ option_id: conductorId, kind: 'pi', request_id: 'request-2001' }, conductor)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });

    const expiring = await option(fx);
    fx.clock.value += 120_001;
    await expect(fx.ports.launch_agent!({ option_id: expiring, kind: 'codex', request_id: 'request-2002' }, davo())).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(fx.launch).not.toHaveBeenCalled();
  });

  it('revalidates revision and canonical target before preparation', async () => {
    let phase = 0;
    const moved: LaunchSelectionTarget = { type: 'worktree', id: 'worktree-2' };
    const fx = fixture({
      resolve: async () => ({ target: phase === 0 ? target : moved, context: phase === 0 ? context : { targetId: 'worktree-2', cwd: '/repo/worktree-2' } })
    });
    const id = await option(fx);
    phase = 1;
    await expect(fx.ports.launch_agent!({ option_id: id, kind: 'codex', request_id: 'request-3001' }, davo())).resolves.toMatchObject({ ok: false, error: { code: 'target_changed' } });
    expect(fx.prepare).not.toHaveBeenCalled();

    let revision = 'revision-1';
    const revisionFx = fixture({ list: async () => ({ kinds: [manifest({ optionsRevision: revision })] }) });
    const revisionId = await option(revisionFx);
    revision = 'revision-2';
    await expect(revisionFx.ports.launch_agent!({ option_id: revisionId, kind: 'codex', request_id: 'request-3002' }, davo())).resolves.toMatchObject({ ok: false, error: { code: 'target_changed' } });
    expect(revisionFx.prepare).not.toHaveBeenCalled();
  });

  it('consumes an option once under concurrent launch requests and returns the effect agent identity', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const fx = fixture({ launch: async prepared => { await held; return { id: 'domain-agent-id', kind: prepared.choice.kind, transport: 'structured', home: '/repo', title: '', attention: 'finished', structured: { lifecycle: 'live', revision: 1, switchable: true } } as Agent; } });
    const id = await option(fx);
    const first = fx.ports.launch_agent!({ option_id: id, kind: 'codex', model: 'gpt-test', effort: 'high', request_id: 'request-4001' }, davo());
    const second = fx.ports.launch_agent!({ option_id: id, kind: 'codex', model: 'gpt-test', effort: 'high', request_id: 'request-4002' }, davo());
    await vi.waitFor(() => expect(fx.launch).toHaveBeenCalledOnce());
    release();
    const results = await Promise.all([first, second]);
    expect(results.filter(result => result.ok)).toEqual([expect.objectContaining({ value: expect.objectContaining({ agent_id: 'domain-agent-id' }) })]);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    expect(fx.launch).toHaveBeenCalledOnce();
  });

  it('reports an unknown outcome when the effect throws after option consumption', async () => {
    const fx = fixture({ launch: async () => { throw new Error('effect lost'); } });
    const id = await option(fx);
    await expect(fx.ports.launch_agent!({ option_id: id, kind: 'codex', request_id: 'request-5001' }, davo())).resolves.toMatchObject({ ok: false, error: { code: 'unknown_outcome', retryable: true } });
    await expect(fx.ports.launch_agent!({ option_id: id, kind: 'codex', request_id: 'request-5001' }, davo())).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('rejects raw, ambiguous, and duplicate native security selections', async () => {
    const ambiguous = manifest({
      security: {
        controls: [
          { id: 'approval', label: 'Approval', icon: 'hand', options: [{ id: 'shared', label: 'Shared', risk: 'normal', detail: '' }] },
          { id: 'sandbox', label: 'Sandbox', icon: 'shield', options: [{ id: 'shared', label: 'Shared', risk: 'normal', detail: '' }] }
        ],
        defaults: { approval: 'shared', sandbox: 'shared' },
        constraints: [],
        status: 'ready'
      }
    });
    const ambiguousFx = fixture({ kinds: [ambiguous] });
    const ambiguousId = await option(ambiguousFx);
    await expect(ambiguousFx.ports.launch_agent!({ option_id: ambiguousId, kind: 'codex', native_mode: 'shared', request_id: 'request-6001' }, davo())).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(ambiguousFx.prepare).not.toHaveBeenCalled();

    const rawFx = fixture();
    const rawId = await option(rawFx);
    await expect(rawFx.ports.launch_agent!({ option_id: rawId, kind: 'codex', security_mode: '--dangerously-bypass-approvals-and-sandbox', request_id: 'request-6002' }, davo())).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(rawFx.prepare).not.toHaveBeenCalled();

    const duplicateFx = fixture();
    const duplicateId = await option(duplicateFx);
    await expect(duplicateFx.ports.launch_agent!({ option_id: duplicateId, kind: 'codex', native_mode: 'ask', security_mode: 'never', request_id: 'request-6003' }, davo())).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(duplicateFx.prepare).not.toHaveBeenCalled();
  });
});
