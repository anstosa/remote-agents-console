import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDavoBridge } from '../src/davo/bridge.js';
import { DavoRuntime } from '../src/davo/runtime.js';
import { DavoStore } from '../src/davo/store.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { PromptOperationLedger } from '../src/prompts/operations.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptService } from '../src/prompts/service.js';
import { IntegrationControlService } from '../src/integrations/control/service.js';
import { RealtimeService } from '../src/integrations/realtime/service.js';
import type { Agent } from '../src/domain/models.js';

const directories: string[] = [];

// remove every isolated durable fixture
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

// build one real davo store over deterministic prompt delivery
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-terminal-lifecycle-'));
  directories.push(directory);
  const store = new DavoStore({ file: join(directory, 'davo.json') });
  const history = new PromptHistoryService(join(directory, 'history.json'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const operations = new PromptOperationLedger(join(directory, 'operations.json'));
  const agent = { id: 'agent', kind: 'codex', home: directory, attention: 'finished', title: 'Ready', transport: 'tmux', panel: 'terminal' } as Agent;
  const delivered: string[] = [];
  let event: unknown;
  const transport = {
    target: async () => ({ agent }),
    gate: async () => 'none',
    held: () => false,
    mark: async () => ({}),
    deliver: async (_id: string, text: string, _attachments: unknown, _options: unknown, rendering: (value: string) => void) => { rendering(text); delivered.push(text); return { status: 'submitted', prompt: text }; },
    observe: async () => event,
    externalReset: async () => false,
    recoverAnswer: async () => 'settled',
    clearDraft: async () => true,
    answer: async () => true,
    interrupt: async () => 'not-working',
    close: async () => true,
    latestAnswer: async () => undefined,
    recentLines: async () => []
  };
  const prompts = new PromptService({} as never, {} as never, history, queue, undefined, undefined, undefined, undefined, undefined, transport as never);
  const control = new IntegrationControlService(() => 'owner');
  const realtime = new RealtimeService({ apiKey: 'test', fetch: async () => new Response(JSON.stringify({ value: 'ek_test_ephemeral_key' })) });
  const runtime = new DavoRuntime({ store, control, realtime, apiKey: 'test', fetch: async url => String(url).endsWith('/hangup') ? new Response(null) : new Response('v=0\r\nanswer', { status: 201, headers: { location: '/v1/realtime/calls/rtc_terminal_test' } }), mcpUrl: 'https://rac.example/mcp', instanceId: 'https://rac.example', scopes: ['status:read', 'prompts:write'], allowedTools: () => ['list_agents', 'delegate_request'] });
  const evaluator = { evaluate: vi.fn(async () => ({ ok: true, generation: store.currentGeneration!, value: { recommendation: 'candidate_done', unmetCriterionIds: [], contradictions: [], safeSummary: 'Finished and verified.' } })), complete: vi.fn(async () => ({ ok: false, code: 'davo_provider_unavailable' })) };
  const bridge = createDavoBridge({ runtime, prompts, operations, history, instanceId: 'https://rac.example', target: async () => ({ agentId: 'agent', worktreeId: 'worktree', projectId: 'project', placeId: 'worktree', processGeneration: 1, conversationId: 'conversation', modelId: 'model' }), question: async () => undefined, answerQuestion: async () => true, audit: { record: async () => undefined }, evaluator: evaluator as never, canWrite: name => name === undefined || name === 'delegate_request' });
  return { agent, bridge, control, delivered, evaluator, operations, prompts, runtime, store, setEvent: (next: unknown) => { event = next; } };
}

describe('prompt terminal lifecycle recovery', () => {
  // recover one exact awaiting request after every immediate terminal path fails
  it('advances the same davo request once from the durable terminal operation', async () => {
    const context = await fixture();
    const snapshot = await context.runtime.conversation();
    const voice = { voiceSessionId: 'voice_terminal_1234567890123456', generation: snapshot.generation };
    const opened = await context.runtime.open('owner', voice);
    const negotiated = await context.runtime.negotiate('owner', { ...voice, negotiationId: opened.negotiationId, sdp: 'v=0\r\noffer' });
    context.runtime.acknowledgeReady('owner', { ...voice, readinessId: negotiated.readinessId, responseId: 'readiness-response', importedTools: ['list_agents', 'delegate_request'] });
    const admitted = await context.runtime.admit('owner', { ...voice, providerSessionId: 'session', providerItemId: 'item', text: 'Implement and test the change.' });
    context.runtime.bind('owner', { ...voice, turnId: admitted.turnId, responseId: 'response' });
    const bearer = (admitted.response.tools[0] as Record<string, unknown>).authorization as string;
    const principal = context.control.authenticateRealtimeBearer(bearer)!;
    const capability = /Turn capability: ([A-Za-z0-9_-]{43})/u.exec(admitted.response.instructions)![1];
    const bound = await context.bridge.tools.find(tool => tool.name === 'bind_davo_target')!.execute({ turn_capability: capability, agent_id: 'agent', worktree_id: 'worktree' }, principal);
    const targetCapability = (bound as { value: { target_capability: string } }).value.target_capability;
    await expect(context.bridge.tools.find(tool => tool.name === 'delegate_request')!.execute({ turn_capability: capability, target_capability: targetCapability, criteria: ['The requested change works'], required_checks: ['unit tests'] }, principal)).resolves.toMatchObject({ ok: true });
    const request = (await context.store.read()).requests[0]!;
    expect(request.state).toBe('awaiting-agent');
    expect(context.delivered).toHaveLength(1);

    vi.spyOn(context.operations, 'lookupByPrompt').mockRejectedValueOnce(new Error('lookup unavailable'));
    let rejectTerminal!: () => void;
    const rejectedTerminal = new Promise<void>(resolve => { rejectTerminal = resolve; });
    vi.spyOn(context.operations, 'recordLifecycle').mockImplementationOnce(async () => { rejectTerminal(); throw new Error('lifecycle unavailable'); });
    context.agent.attention = 'working';
    context.setEvent({ type: 'started', mark: {} });
    await context.prompts.observe(context.agent);
    context.agent.attention = 'finished';
    const promptId = request.dispatch.state === 'published' ? request.dispatch.promptId : '';
    const envelope = { requestId: request.id, promptId, outcome: 'complete', criteria: [{ id: 'criterion-1', status: 'satisfied', evidence: 'implemented' }], checks: [{ name: 'unit tests', status: 'passed', evidence: 'passed' }], remaining: [] };
    context.setEvent({ type: 'settled', message: `<davo-completion-v1>${JSON.stringify(envelope)}</davo-completion-v1>` });
    await context.prompts.observe(context.agent);
    await rejectedTerminal;
    await expect(context.operations.lookup(request.dispatch.operationId)).resolves.toMatchObject({ lifecycle: { state: 'delivered' } });

    const storeFailure = vi.spyOn(context.store, 'transact').mockRejectedValueOnce(new Error('davo store unavailable'));
    await expect(context.bridge.tick()).rejects.toThrow('davo store unavailable');
    await expect(context.operations.lookup(request.dispatch.operationId)).resolves.toMatchObject({ lifecycle: { state: 'ended', outcome: 'completed' } });
    expect((await context.store.read()).requests[0]).toMatchObject({ id: request.id, state: 'awaiting-agent' });
    expect(context.evaluator.evaluate).not.toHaveBeenCalled();

    await context.bridge.tick();
    const completed = await context.store.read();
    expect(completed.requests[0]).toMatchObject({ id: request.id, state: 'done' });
    expect(completed.notificationOutbox).toHaveLength(1);
    expect(context.evaluator.evaluate).toHaveBeenCalledOnce();
    expect(storeFailure).toHaveBeenCalled();
    await expect(context.operations.lookup(request.dispatch.operationId)).resolves.toMatchObject({ lifecycle: { state: 'ended', outcome: 'completed' } });
    expect(context.delivered).toHaveLength(1);

    await context.bridge.tick();
    expect(context.evaluator.evaluate).toHaveBeenCalledOnce();
    expect((await context.store.read()).notificationOutbox).toHaveLength(1);
    expect(context.delivered).toHaveLength(1);
    context.bridge.close();
    await context.runtime.stop('owner', voice);
  });
});
