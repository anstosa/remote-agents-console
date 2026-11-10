import { describe, expect, it, vi } from 'vitest';
import { DavoLive } from '../src/davo/live.js';
import { createDavoTools, type DavoToolPorts } from '../src/integrations/mcp/davo-tools.js';
import { developerSuccess } from '../src/integrations/mcp/developer-tool.js';
import { validateToolSchema } from '../src/integrations/mcp/legacy-output.js';
import type { IntegrationPrincipal } from '../src/integrations/auth/types.js';

// bind a real admitted turn around inert domain ports
function fixture() {
  const live = new DavoLive({ generation: () => 1, authorize: key => key === 'lease', now: () => 1000 });
  live.open({ voiceSessionId: 'voice', leaseKey: 'lease', ownerHash: 'a'.repeat(64), generation: 1, hardCutoffAt: 3000 });
  const turn = live.admit({ voiceSessionId: 'voice', generation: 1, messageId: 'message', providerItemId: 'item' });
  live.bind('voice', 1, turn.id, 'response-1');
  const delegate = vi.fn<DavoToolPorts['delegate']>(async () => developerSuccess({ accepted: true }));
  const relay = vi.fn(async () => developerSuccess({ accepted: true }));
  const answerChoice = vi.fn(async () => developerSuccess({ accepted: true }));
  const target = { instanceId: 'local', projectId: 'project', placeId: 'place', worktreeId: 'worktree', agentId: 'agent', processGeneration: 1, targetActivityEpoch: 'epoch', expectedPromptChainHead: 'prompt' };
  const tools = createDavoTools({ live, resolveTarget: async () => target, delegate, relay, answerChoice });
  const principal: IntegrationPrincipal = { authentication: 'realtime', subjectId: 'owner', audience: 'https://rac.example/mcp', scopes: ['status:read', 'prompts:write'], leaseKey: 'lease' };
  return { live, turn, tools, principal, delegate, relay, answerChoice };
}

describe('Davo internal operation identities', () => {
  // user-facing delegation must not depend on a caller-created tracking key
  it('does not require a request id in any advertised Davo tool', () => {
    const { tools } = fixture();
    // every operation already has an authenticated admitted-turn capability
    for (const tool of tools) expect(tool.inputSchema.required).not.toContain('request_id');
    const bind = tools.find(tool => tool.name === 'bind_davo_target')!;
    const args = { turn_capability: 'a'.repeat(43), agent_id: 'agent', worktree_id: 'worktree' };
    // keep advertised and executable contracts paired for omitted and legacy keys
    for (const [input, valid] of [[args, true], [{ ...args, request_id: 'legacy-caller-key' }, true], [{ ...args, request_id: 'short' }, false], [{ ...args, unexpected: true }, false]] as const) {
      expect(bind.schema.safeParse(input).success).toBe(valid);
      expect(validateToolSchema(bind.inputSchema, input)).toBe(valid);
    }
  });

  // retries remain one logical action even after a provider response capability rotates
  it('generates stable internal ids and rejects changed action bytes', async () => {
    const { live, turn, tools, principal, delegate, relay } = fixture();
    const bind = tools.find(tool => tool.name === 'bind_davo_target')!;
    const bound = await bind.execute(bind.schema.parse({ turn_capability: turn.capability, agent_id: 'agent', worktree_id: 'worktree' }), principal);
    expect(bound.ok).toBe(true);
    const targetCapability = (bound as { value: { target_capability: string } }).value.target_capability;
    const tool = tools.find(tool => tool.name === 'delegate_request')!;
    const args = { turn_capability: turn.capability, target_capability: targetCapability, criteria: ['The requested work is complete'], required_checks: ['tests'] };
    expect((await tool.execute(tool.schema.parse(args), principal)).ok).toBe(true);
    const firstId = delegate.mock.calls[0]![0].operationId;
    expect(firstId).toMatch(/^davo-[a-f0-9]{64}$/u);
    const advanced = live.advance('voice', 1, turn.id, 'response-1');
    live.bind('voice', 1, turn.id, 'response-2');
    const retried = { ...args, turn_capability: advanced.capability, request_id: 'legacy-caller-key' };
    expect((await tool.execute(tool.schema.parse(retried), principal)).ok).toBe(true);
    expect(delegate.mock.calls[1]![0].operationId).toBe(firstId);
    expect((await tool.execute(tool.schema.parse({ ...retried, criteria: ['A different task'] }), principal)).ok).toBe(false);
    const relayTool = tools.find(candidate => candidate.name === 'relay_agent_question_answer')!;
    expect((await relayTool.execute(relayTool.schema.parse({ turn_capability: advanced.capability, target_capability: targetCapability, question_id: 'question', answer: { index: 0 } }), principal)).ok).toBe(false);
    expect(delegate).toHaveBeenCalledTimes(2);
    expect(relay).not.toHaveBeenCalled();
  });
});
