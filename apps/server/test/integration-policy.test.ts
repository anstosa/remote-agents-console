import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntegrationAuditService } from '../src/integrations/audit/service.js';
import { digest, IntegrationPolicyService } from '../src/integrations/policy/service.js';

describe('IntegrationPolicyService', () => {
  it('replays completed outcomes and rejects changed arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const service = new IntegrationPolicyService(join(root, 'policy.json'));
    const claimed = await service.claim('principal', 'queue_prompt', 'request-1', digest('first'));
    expect(claimed.kind).toBe('claimed');
    if (claimed.kind !== 'claimed') throw new Error('claim unavailable');
    await service.finish(claimed.recordId, 'completed', { queued: true });
    await expect(service.claim('principal', 'queue_prompt', 'request-1', digest('first'))).resolves.toMatchObject({ kind: 'replay', state: 'completed', result: { queued: true } });
    await expect(service.claim('principal', 'queue_prompt', 'request-1', digest('second'))).resolves.toEqual({ kind: 'conflict' });
  });

  it('recovers interrupted claims as unknown outcomes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const file = join(root, 'policy.json');
    const service = new IntegrationPolicyService(file);
    await service.claim('principal', 'run_stack_action', 'request-2', digest('restart'));
    await service.recoverUnknownOutcomes();
    await expect(new IntegrationPolicyService(file).claim('principal', 'run_stack_action', 'request-2', digest('restart'))).resolves.toMatchObject({ kind: 'replay', state: 'unknown_outcome' });
  });

  it('refuses capacity without evicting an unexpired claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const file = join(root, 'policy.json');
    const service = new IntegrationPolicyService(file, 2);
    const first = await service.claim('principal', 'queue_prompt', 'request-1', digest('one'));
    await service.claim('principal', 'queue_prompt', 'request-2', digest('two'));
    await expect(service.claim('principal', 'queue_prompt', 'request-3', digest('three'))).resolves.toEqual({ kind: 'capacity' });
    const stored = JSON.parse(await readFile(file, 'utf8')) as { idempotency: Array<{ id: string }> };
    expect(stored.idempotency).toHaveLength(2);
    expect(stored.idempotency.map(record => record.id)).toContain(first.kind === 'claimed' ? first.recordId : 'missing');
  });

  it('expires before capacity admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    let now = 1_800_000_000_000;
    const service = new IntegrationPolicyService(join(root, 'policy.json'), 1, () => now);
    await expect(service.claim('principal', 'queue_prompt', 'request-1', digest('one'))).resolves.toMatchObject({ kind: 'claimed' });
    now += 24 * 60 * 60_000 + 1;
    await expect(service.claim('principal', 'queue_prompt', 'request-2', digest('two'))).resolves.toMatchObject({ kind: 'claimed' });
  });

  it('atomically stores and generation-fences lifecycle commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const service = new IntegrationPolicyService(join(root, 'policy.json'));
    const claim = await service.claimLifecycleCommand('owner', 'restart_agent', 'request-3', digest('restart'), { targetAgentId: 'agent-1', operation: 'restart', expectedGeneration: 4 });
    expect(claim).toMatchObject({ kind: 'claimed', command: { state: 'pending', expectedGeneration: 4 } });
    if (claim.command === undefined) throw new Error('command unavailable');
    await expect(service.beginLifecycleCommand(claim.command.id, 4)).resolves.toMatchObject({ state: 'running' });
    await expect(service.beginLifecycleCommand(claim.command.id, 4)).resolves.toBeUndefined();
    await expect(service.finishLifecycleCommand(claim.command.id, 'unknown')).resolves.toBe(true);
    await expect(service.lifecycleCommand('owner', claim.command.id)).resolves.toMatchObject({ state: 'unknown' });
    await expect(service.lifecycleCommand('other-owner', claim.command.id)).resolves.toBeUndefined();
    await expect(service.claimLifecycleCommand('owner', 'restart_agent', 'request-3', digest('restart'), { targetAgentId: 'agent-1', operation: 'restart', expectedGeneration: 4 })).resolves.toMatchObject({ kind: 'replay', state: 'unknown_outcome', command: { id: claim.command.id, state: 'unknown' } });
  });

  it('reconciles a running unchanged generation as unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const service = new IntegrationPolicyService(join(root, 'policy.json'));
    const claim = await service.claimLifecycleCommand('owner', 'restart_agent', 'request-4', digest('restart'), { targetAgentId: 'agent-1', operation: 'restart', expectedGeneration: 7 });
    if (claim.command === undefined) throw new Error('command unavailable');
    await service.beginLifecycleCommand(claim.command.id, 7);
    await service.reconcileLifecycleCommands(() => 7);
    await expect(service.lifecycleCommand('owner', claim.command.id)).resolves.toMatchObject({ state: 'unknown' });
    await expect(service.claimLifecycleCommand('owner', 'restart_agent', 'request-4', digest('restart'), { targetAgentId: 'agent-1', operation: 'restart', expectedGeneration: 7 })).resolves.toMatchObject({ kind: 'replay', state: 'unknown_outcome' });
  });

  it('defers lifecycle claims to generation reconciliation after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const file = join(root, 'policy.json');
    const service = new IntegrationPolicyService(file);
    const claim = await service.claimLifecycleCommand('owner', 'restart_agent', 'request-5', digest('restart'), { targetAgentId: 'agent-1', operation: 'restart', expectedGeneration: 9 });
    if (claim.command === undefined) throw new Error('command unavailable');
    await service.beginLifecycleCommand(claim.command.id, 9);
    const restarted = new IntegrationPolicyService(file);
    await restarted.recoverUnknownOutcomes();
    await restarted.reconcileLifecycleCommands(() => 10);
    await expect(restarted.lifecycleCommand('owner', claim.command.id)).resolves.toMatchObject({ state: 'succeeded', currentGeneration: 10 });
    await expect(restarted.claimLifecycleCommand('owner', 'restart_agent', 'request-5', digest('restart'), { targetAgentId: 'agent-1', operation: 'restart', expectedGeneration: 9 })).resolves.toMatchObject({ kind: 'replay', state: 'completed' });
  });

  it('uses the durable command marker and returns only safe pending recovery work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const service = new IntegrationPolicyService(join(root, 'policy.json'));
    const completed = await service.claimLifecycleCommand('owner', 'restart_agent', 'request-6', digest('restart-a'), { targetAgentId: 'agent-1', operation: 'restart', expectedGeneration: 3 });
    const pending = await service.claimLifecycleCommand('owner', 'restart_agent', 'request-7', digest('restart-b'), { targetAgentId: 'agent-2', operation: 'restart', expectedGeneration: 8 });
    if (completed.command === undefined || pending.command === undefined) throw new Error('command unavailable');
    await service.beginLifecycleCommand(completed.command.id, 3);
    await service.reconcileLifecycleCommands(async id => id === 'agent-1' ? 4 : 8, async id => id === 'agent-1' ? { commandId: completed.command!.id, expectedGeneration: 3, effectGeneration: 4 } : undefined);
    await expect(service.lifecycleCommand('owner', completed.command.id)).resolves.toMatchObject({ state: 'succeeded', currentGeneration: 4 });
    await expect(service.pendingLifecycleCommands()).resolves.toEqual([expect.objectContaining({ id: pending.command.id, state: 'pending' })]);
  });

  it('migrates legacy confirmation state without retaining it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-policy-'));
    const file = join(root, 'policy.json');
    await writeFile(file, JSON.stringify({ version: 1, confirmations: [{ tokenHash: 'unsafe' }], idempotency: [] }));
    const service = new IntegrationPolicyService(file);
    await service.recoverUnknownOutcomes();
    const stored = JSON.parse(await readFile(file, 'utf8')) as { version: number; confirmations?: unknown[]; lifecycleCommands: unknown[] };
    expect(stored).toMatchObject({ version: 4, lifecycleCommands: [] });
    expect(stored.confirmations).toBeUndefined();
  });
});

describe('IntegrationAuditService', () => {
  it('writes bounded redacted audit events without tool payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-audit-'));
    const file = join(root, 'audit.jsonl');
    const service = new IntegrationAuditService(file);
    await service.record({ phase: 'outcome', timestamp: new Date().toISOString(), durationMs: 25, correlationId: 'correlation', requestId: 'request', principalHash: 'principal-hash', clientId: 'chatgpt', tool: 'queue_prompt', scopes: ['prompts:write'], risk: 'write', argumentsDigest: digest('secret prompt'), targetSummary: 'agent-1', result: 'success' });
    const stored = JSON.parse((await readFile(file, 'utf8')).trim());
    expect(stored).toMatchObject({ correlationId: 'correlation', tool: 'queue_prompt', result: 'success' });
    expect(JSON.stringify(stored)).not.toContain('secret prompt');
  });
});

// a different operation's next generation is not evidence this command executed
it('refuses an unrelated generation change between lifecycle claim and begin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rac-policy-generation-'));
  try {
    const service = new IntegrationPolicyService(join(root, 'policy.json'));
    const claim = await service.claimLifecycleCommand('owner', 'restart_agent', 'request-independent-restart', digest('restart'), { targetAgentId: 'agent', operation: 'restart', expectedGeneration: 3 });
    expect(claim.command).toBeDefined();
    expect(await service.beginLifecycleCommand(claim.command!.id, 4)).toMatchObject({ state: 'failed', error: { code: 'target_changed' } });
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
});
