import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { IntegrationConfig } from '../src/config/schema.js';
import type { AuditEvent } from '../src/integrations/audit/service.js';
import type { IntegrationPrincipal } from '../src/integrations/auth/index.js';
import { IntegrationControlService } from '../src/integrations/control/service.js';
import { developerSuccess, developerTool } from '../src/integrations/mcp/developer-tool.js';
import { IntegrationGateway, type IntegrationToolActivity } from '../src/integrations/mcp/gateway.js';
import { IntegrationPolicyService } from '../src/integrations/policy/service.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// assemble one gateway with a real lease and policy store
async function fixture(input: { activity?: IntegrationToolActivity; audit?: (event: AuditEvent) => Promise<void>; delegate?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-activity-'));
  directories.push(directory);
  let reads = 0;
  const config: IntegrationConfig = {
    enabled: true,
    mcp: { readEnabled: true, writeEnabled: true, dangerousEnabled: false, ...(input.delegate ? { permissions: { delegate_request: { write: true } } } : {}) },
    realtime: { enabled: true, name: 'Davo', context: '', writeToolsEnabled: true },
    multiInstance: { enabled: false }
  };
  const orchestration = { listWorktrees: async () => { reads += 1; return { ok: true as const, version: 'v1' as const, value: [] }; } };
  const control = new IntegrationControlService(() => 'owner');
  const credential = control.startVoiceLease('owner', 'voice_gateway_activity_123456789', ['status:read', 'files:write'])!;
  const delegate = developerTool({
    name: 'delegate_request', title: 'delegate_request', description: 'delegate_request', risk: 'write', audiences: ['realtime'], requiredScopes: ['files:write'], idempotency: 'domain_cursor',
    schema: z.object({}).strict(), inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: z.object({ accepted: z.literal(true) }).strict(), dataSchema: { type: 'object', properties: { accepted: { const: true } }, required: ['accepted'], additionalProperties: false },
    execute: async () => developerSuccess({ accepted: true })
  });
  const gateway = new IntegrationGateway({
    config,
    instanceId: 'https://rac.example',
    orchestration: orchestration as never,
    policy: new IntegrationPolicyService(join(directory, 'policy.json')),
    audit: { record: input.audit ?? (async () => undefined) },
    control,
    ...(input.activity === undefined ? {} : { activity: input.activity }),
    ...(input.delegate ? { developerTools: () => [delegate] } : {})
  });
  const realtime: IntegrationPrincipal = { authentication: 'realtime', subjectId: credential.stableOwnerKey, stableOwnerKey: credential.stableOwnerKey, leaseKey: credential.leaseKey, audience: 'https://rac.example/mcp', scopes: ['status:read', 'files:write'] };
  return { gateway, realtime, control, reads: () => reads };
}

describe('IntegrationGateway activity', () => {
  it('observes canonical local Realtime calls and classifies their final results', async () => {
    const events: Array<Record<string, unknown>> = [];
    const activity: IntegrationToolActivity = {
      start: vi.fn(async event => { events.push({ phase: 'start', ...event }); return `row-${event.correlationId}`; }),
      finish: vi.fn(async (handle, event) => { events.push({ phase: 'finish', handle, ...event }); })
    };
    const { gateway, realtime } = await fixture({ activity });
    await expect(gateway.call(realtime, 'list_worktrees', {})).resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(gateway.call(realtime, 'list_worktrees', { unexpected: true })).resolves.toMatchObject({ structuredContent: { error: { code: 'invalid_request' } } });
    expect(events).toMatchObject([
      { phase: 'start', tool: 'list_worktrees', leaseKey: realtime.leaseKey },
      { phase: 'finish', tool: 'list_worktrees', outcome: 'success' },
      { phase: 'start', tool: 'list_worktrees', leaseKey: realtime.leaseKey },
      { phase: 'finish', tool: 'list_worktrees', outcome: 'error' }
    ]);

    const oauth: IntegrationPrincipal = { authentication: 'oauth', subjectId: 'user', clientId: 'client', audience: realtime.audience, scopes: ['status:read'] };
    await gateway.call(oauth, 'list_worktrees', {});
    expect(activity.start).toHaveBeenCalledTimes(2);
  });

  it('fails before dispatch when running receipt capacity is unavailable', async () => {
    const activity: IntegrationToolActivity = { start: async () => { throw new Error('davo_capacity'); }, finish: async () => undefined };
    const { gateway, realtime, reads } = await fixture({ activity });
    await expect(gateway.call(realtime, 'list_worktrees', {})).resolves.toMatchObject({ structuredContent: { error: { code: 'activity_unavailable' } } });
    expect(reads()).toBe(0);
  });

  it('preserves direct read compatibility when there is no admitted turn receipt', async () => {
    const finish = vi.fn(async () => undefined);
    const activity: IntegrationToolActivity = { start: async () => undefined, finish };
    const { gateway, realtime, reads } = await fixture({ activity });
    await expect(gateway.call(realtime, 'list_worktrees', {})).resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(reads()).toBe(1);
    expect(finish).not.toHaveBeenCalled();
  });

  it('rechecks the captured lease after the awaited running receipt', async () => {
    let replaceLease = () => undefined;
    const finish = vi.fn(async () => undefined);
    const activity: IntegrationToolActivity = { start: async () => { replaceLease(); return 'row-1'; }, finish };
    const { gateway, realtime, control, reads } = await fixture({ activity });
    replaceLease = () => { control.startVoiceLease('owner', 'voice_gateway_replacement_12345', ['status:read']); return undefined; };
    await expect(gateway.call(realtime, 'list_worktrees', {})).resolves.toMatchObject({ structuredContent: { error: { code: 'voice_lease_changed' } } });
    expect(reads()).toBe(0);
    expect(finish).toHaveBeenCalledWith('row-1', expect.objectContaining({ tool: 'list_worktrees', outcome: 'error' }));
  });

  it('preserves an executed result when only its terminal receipt remains unavailable', async () => {
    const activity: IntegrationToolActivity = { start: async () => 'row-1', finish: async () => { throw new Error('disk unavailable'); } };
    const { gateway, realtime, reads } = await fixture({ activity });
    await expect(gateway.call(realtime, 'list_worktrees', {})).resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(reads()).toBe(1);
  });

  it('records unknown only after strict outcome audit rewrites the actual result', async () => {
    const finish = vi.fn(async () => undefined);
    const activity: IntegrationToolActivity = { start: async () => 'row-1', finish };
    const { gateway, realtime } = await fixture({ activity, delegate: true, audit: async event => {
      // preserve intent but make post-effect confirmation uncertain
      if (event.phase === 'outcome') throw new Error('audit unavailable');
    } });
    await expect(gateway.call(realtime, 'delegate_request', {})).resolves.toMatchObject({ structuredContent: { error: { code: 'unknown_outcome' } } });
    expect(finish).toHaveBeenCalledWith('row-1', expect.objectContaining({ tool: 'delegate_request', outcome: 'unknown' }));
  });
});
