import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDavoBridge, readDavoCompletion } from '../src/davo/bridge.js';
import { DavoRuntime } from '../src/davo/runtime.js';
import { DavoStore } from '../src/davo/store.js';
import { PromptOperationLedger } from '../src/prompts/operations.js';
import { PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { IntegrationControlService } from '../src/integrations/control/service.js';
import { RealtimeService } from '../src/integrations/realtime/service.js';
import type { Agent } from '../src/domain/models.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

// integrate real prompt persistence with a deterministic native turn sink
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'davo-bridge-'));
  directories.push(directory);
  const store = new DavoStore({ file: join(directory, 'davo.json') });
  const history = new PromptHistoryService(join(directory, 'history.json'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const operations = new PromptOperationLedger(join(directory, 'operations.json'));
  const agent = { id: 'agent', kind: 'codex', home: directory, attention: 'finished', title: 'Ready', transport: 'tmux', panel: 'terminal' } as Agent;
  let event: unknown;
  const delivered: string[] = [];
  const transport = { target: async () => ({ agent }), gate: async () => 'none', held: () => false, mark: async () => ({}), deliver: async (_id: string, text: string, _attachments: unknown, _options: unknown, rendering: (text: string) => void) => { rendering(text); delivered.push(text); return { status: 'submitted', prompt: text }; }, observe: async () => event, externalReset: async () => false, recoverAnswer: async () => 'settled', clearDraft: async () => true, answer: async () => true, interrupt: async () => 'not-working', close: async () => true, latestAnswer: async () => undefined, recentLines: async () => [] };
  const prompts = new PromptService({} as never, {} as never, history, queue, undefined, undefined, undefined, undefined, undefined, transport as never);
  const control = new IntegrationControlService(() => 'owner');
  const realtime = new RealtimeService({ apiKey: 'test', fetch: async () => new Response(JSON.stringify({ value: 'ek_test_ephemeral_key' })) });
  const runtime = new DavoRuntime({ store, control, realtime, apiKey: 'test', fetch: async url => String(url).endsWith('/hangup') ? new Response(null) : new Response('v=0\r\nanswer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_bridge_test' } }), mcpUrl: 'https://rac.example/mcp', instanceId: 'https://rac.example', scopes: ['status:read', 'prompts:write'], allowedTools: () => ['list_agents', 'delegate_request'] });
  const evaluator = { evaluate: vi.fn(async () => ({ ok: true, generation: store.currentGeneration!, value: { recommendation: 'candidate_done', unmetCriterionIds: [], contradictions: [], safeSummary: 'Finished and verified.' } })), complete: vi.fn(async () => ({ ok: false, code: 'davo_provider_unavailable' })) };
  // rebuild the bridge to model loss of in-process lifecycle observers
  const bridge = () => createDavoBridge({ runtime, prompts, operations, history, instanceId: 'https://rac.example', target: async () => ({ agentId: 'agent', worktreeId: 'worktree', projectId: 'project', placeId: 'worktree', processGeneration: 1, conversationId: 'conversation', modelId: 'model' }), question: async () => undefined, answerQuestion: async () => true, audit: { record: async () => undefined }, evaluator: evaluator as never });
  return { store, runtime, control, agent, prompts, operations, delivered, bridge, evaluator, setEvent: (next: unknown) => { event = next; } };
}

describe('Davo integration bridge', () => {
  // redact every untrusted completion string before retaining evidence
  it('redacts credentials from parsed completion evidence', () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz';
    const envelope = { requestId: 'request-1', promptId: 'prompt-1', outcome: 'complete', criteria: [{ id: 'criterion-1', status: 'satisfied', evidence: `implemented with ${secret}` }], checks: [{ name: 'tests', status: 'passed', evidence: `Bearer ${secret}` }], remaining: [] };
    const parsed = readDavoCompletion(`<davo-completion-v1>${JSON.stringify(envelope)}</davo-completion-v1>`);
    expect(parsed).toBeDefined();
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(parsed?.criteria[0]?.evidence).toContain('[REDACTED TOKEN]');
    expect(parsed?.checks[0]?.evidence).toContain('Bearer [REDACTED]');
  });

  it('recovers an exact ended lifecycle after restart and never relies on the latest answer', async () => {
    const context = await fixture();
    const secret = 'sk-proj-bridgecredential123456';
    context.evaluator.evaluate.mockResolvedValueOnce({ ok: true, generation: context.store.currentGeneration!, value: { recommendation: 'candidate_done', unmetCriterionIds: [], contradictions: [], safeSummary: `Finished with Bearer ${secret}` } });
    const first = context.bridge();
    const snapshot = await context.runtime.conversation();
    const voice = { voiceSessionId: 'voice_123456789012345678901234', generation: snapshot.generation };
    const opened = await context.runtime.open('owner', voice);
    const negotiated = await context.runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    context.runtime.acknowledgeReady('owner', { ...voice, readinessId: negotiated.readinessId, responseId: 'readiness-response', importedTools: ['list_agents', 'delegate_request'] });
    const receipt = await context.runtime.admit('owner', { ...voice, providerSessionId: 'session', providerItemId: 'item', text: 'Implement and test the change.' });
    context.runtime.bind('owner', { ...voice, turnId: receipt.turnId, responseId: 'response' });
    const bearer = (receipt.response.tools[0] as Record<string, unknown>).authorization as string;
    const principal = context.control.authenticateRealtimeBearer(bearer)!;
    const capability = /Turn capability: ([A-Za-z0-9_-]{43})/u.exec(receipt.response.instructions)![1];
    const bound = await first.tools.find(tool => tool.name === 'bind_davo_target')!.execute({ request_id: 'bind-operation', turn_capability: capability, agent_id: 'agent', worktree_id: 'worktree' }, principal);
    expect(bound.ok).toBe(true);
    const targetCapability = (bound as { value: { target_capability: string } }).value.target_capability;
    const submitted = await first.tools.find(tool => tool.name === 'delegate_request')!.execute({ request_id: 'delegate-operation', turn_capability: capability, target_capability: targetCapability, criteria: ['The requested change works'], required_checks: ['unit tests'] }, principal);
    expect(submitted.ok).toBe(true);
    expect(context.delivered).toHaveLength(1);
    const request = (await context.store.read()).requests[0];
    expect(request.state).toBe('awaiting-agent');
    first.close();
    context.agent.attention = 'working';
    context.setEvent({ type: 'started', mark: {} });
    await context.prompts.observe(context.agent);
    context.agent.attention = 'finished';
    const envelope = { requestId: request.id, promptId: request.dispatch.state === 'published' ? request.dispatch.promptId : '', outcome: 'complete', criteria: [{ id: 'criterion-1', status: 'satisfied', evidence: `implemented with ${secret}` }], checks: [{ name: 'unit tests', status: 'passed', evidence: `Bearer ${secret}` }], remaining: [] };
    context.setEvent({ type: 'settled', message: `API_KEY=${secret}\n<davo-completion-v1>${JSON.stringify(envelope)}</davo-completion-v1>` });
    await context.prompts.observe(context.agent);
    const recovered = context.bridge();
    await recovered.tick();
    const final = await context.store.read();
    expect(final.requests[0].state).toBe('done');
    expect(final.notificationOutbox).toHaveLength(1);
    expect(final.notificationOutbox[0].kind).toBe('done');
    expect(context.delivered).toHaveLength(1);
    expect(context.evaluator.evaluate).toHaveBeenCalledOnce();
    expect(context.evaluator.evaluate.mock.calls[0]?.[0].input).not.toContain(secret);
    expect(JSON.stringify(final)).not.toContain(secret);
    expect(final.messages.at(-1)?.text).toContain('Bearer [REDACTED]');
    recovered.close();
    await context.runtime.stop('owner', voice);
  });
});
