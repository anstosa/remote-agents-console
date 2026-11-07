import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { PromptOperationLedger } from '../src/prompts/operations.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptService, type PromptPublicationInput } from '../src/prompts/service.js';
import { StructuredAgents, structuredTurnMarkPrefix, type StructuredProcesses } from '../src/transports/structured-agents.js';
import type { StructuredConnection, StructuredEvent } from '../src/transports/structured.js';

const directories: string[] = [];

// remove every isolated structured store
afterEach(async () => {
  // clear all test-owned directories
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// create one protocol process with directly controlled native events
const nativeFixture = async (options: { file?: string; dropped?: number } = {}) => {
  const directory = options.file === undefined ? await mkdtemp(join(tmpdir(), 'rac-structured-frontier-')) : undefined;
  // retain only directories created by this fixture
  if (directory !== undefined) directories.push(directory);
  const file = options.file ?? join(directory!, 'structured-agents.json');
  let emit: (event: StructuredEvent) => void = () => undefined;
  const connection: StructuredConnection = {
    deliver: async () => 'started',
    newConversation: async () => true,
    switchConversation: async () => true,
    renameConversation: async () => true,
    compact: async () => undefined,
    models: async () => [],
    setModel: async () => true,
    steer: async () => true,
    cancel: async () => [],
    answer: async () => true,
    close: () => undefined
  };
  const processes: StructuredProcesses = {
    start: async (launch, events) => {
      emit = events;
      queueMicrotask(() => events({ type: 'report', report: { loaded: true, nonce: launch.nonce, sandbox: { engaged: false, reason: 'not sandboxed' }, version: 'test' } }));
      return { holder: { agentId: launch.id, socket: '/tmp/structured-frontier.sock', pane: '%1' }, connection, cursor: () => 0 };
    },
    attach: async (holder, _kind, events) => {
      emit = events;
      return { holder, connection, cursor: () => 0, dropped: options.dropped ?? 0 };
    },
    stderr: async () => '',
    stop: async () => undefined
  };
  const agents = new StructuredAgents(processes, { file });
  return { agents, directory: directory ?? file.slice(0, file.lastIndexOf('/')), emit: (event: StructuredEvent) => emit(event), file };
};

// decode one content-free structured native frontier
const frontier = async (agents: StructuredAgents, agentId: string) => {
  const mark = await agents.turns.mark({ id: agentId } as never);
  expect(mark.baselineCompletion?.startsWith(structuredTurnMarkPrefix)).toBe(true);
  return JSON.parse(mark.baselineCompletion!.slice(structuredTurnMarkPrefix.length)) as { processGeneration: number; turnRevision: number; turnEventRevision: number; state: string; uncertain: boolean };
};

// launch one live structured agent
const launch = async (fixture: Awaited<ReturnType<typeof nativeFixture>>): Promise<string> => {
  const id = await fixture.agents.launch({ id: 'scratch:test', kind: 'scratch', projectId: 'scratch', label: 'Scratch', home: fixture.directory } as never, 'pi');
  expect(id).toBeDefined();
  return id!;
};

describe('structured native turn frontier', () => {
  it('persists every turn transition and rejects stale same-conversation history after restart', async () => {
    const first = await nativeFixture();
    const id = await launch(first);
    expect(await frontier(first.agents, id)).toMatchObject({ turnRevision: 0, turnEventRevision: 0, state: 'idle', uncertain: false });

    first.emit({ type: 'turn', turn: { type: 'started' } });
    first.emit({ type: 'transcript', item: { id: 'native-user-1', kind: 'message', role: 'user', text: 'private first prompt' } });
    const afterUser = await frontier(first.agents, id);
    first.emit({ type: 'transcript', item: { id: 'assistant-delta', kind: 'message', role: 'assistant', text: 'stream one' } });
    expect(afterUser).toMatchObject({ turnRevision: 1, turnEventRevision: 1, state: 'working' });
    expect(await frontier(first.agents, id)).toEqual(afterUser);
    first.emit({ type: 'turn', turn: { type: 'settled', message: 'done' } });
    first.emit({ type: 'turn', turn: { type: 'started' } });
    first.emit({ type: 'transcript', item: { id: 'native-user-2', kind: 'message', role: 'user', text: 'private second prompt' } });
    const beforeRestart = await frontier(first.agents, id);
    expect(beforeRestart).toMatchObject({ turnRevision: 2, turnEventRevision: 3, state: 'working' });
    await first.agents.saved();

    const second = await nativeFixture({ file: first.file });
    await second.agents.reattach();
    second.emit({ type: 'history', items: [{ id: 'native-user-1', kind: 'message', role: 'user', text: 'stale private prompt' }, { id: 'settled-1', kind: 'settled', outcome: 'done' }] });
    second.emit({ type: 'turn', turn: { type: 'started' } });
    expect(await frontier(second.agents, id)).toEqual(beforeRestart);

    second.emit({ type: 'turn', turn: { type: 'settled', message: 'second done' } });
    second.emit({ type: 'turn', turn: { type: 'started' } });
    second.emit({ type: 'transcript', item: { id: 'native-user-3', kind: 'message', role: 'user', text: 'private third prompt' } });
    second.emit({ type: 'turn', turn: { type: 'settled', message: 'third done' } });
    second.emit({ type: 'turn', turn: { type: 'started' } });
    second.emit({ type: 'transcript', item: { id: 'native-user-4', kind: 'message', role: 'user', text: 'private fourth prompt' } });
    expect(await frontier(second.agents, id)).toMatchObject({ turnRevision: 4, turnEventRevision: 7, state: 'working', uncertain: false });
    await second.agents.saved();
    const stored = await readFile(first.file, 'utf8');
    expect(stored).not.toContain('private first prompt');
    expect(stored).not.toContain('private fourth prompt');
  });

  it('keeps a dropped replay pending until an explicit new prompt establishes a frontier', async () => {
    const first = await nativeFixture();
    const id = await launch(first);
    const ledgerFile = join(first.directory, 'operations.json');
    const expiresAt = '2030-01-04T11:00:00.000Z';
    const firstService = new PromptService({} as never, {} as never, new PromptHistoryService(join(first.directory, 'history.json')), new QueuedPromptService(join(first.directory, 'queue.json')), undefined, undefined, undefined, undefined, undefined, undefined, first.agents.turns);
    firstService.useOperations(new PromptOperationLedger(ledgerFile, { clock: () => new Date('2030-01-01T12:00:00.000Z') }));
    await firstService.watchActivity(id, expiresAt);
    await first.agents.saved();

    const second = await nativeFixture({ file: first.file, dropped: 5 });
    await second.agents.reattach();
    const secondService = new PromptService({} as never, {} as never, new PromptHistoryService(join(first.directory, 'history.json')), new QueuedPromptService(join(first.directory, 'queue.json')), undefined, undefined, undefined, undefined, undefined, undefined, second.agents.turns);
    secondService.useOperations(new PromptOperationLedger(ledgerFile, { clock: () => new Date('2030-01-01T12:00:00.000Z') }));
    // recover eligibility before any coordinator can rewatch this target
    const agent = await second.agents.agent(id);
    await secondService.observe(agent as never);
    await expect(secondService.activitySnapshot(id)).resolves.toMatchObject({ epoch: 1, pending: true });

    await expect(secondService.submit(id, 'explicit new user request')).resolves.toBe(true);
    await expect(secondService.activitySnapshot(id)).resolves.toMatchObject({ epoch: 2, pending: false });
    await second.agents.saved();
  });

  it('baselines its own published structured turn without advancing again', async () => {
    const fixture = await nativeFixture();
    const id = await launch(fixture);
    const ledgerFile = join(fixture.directory, 'operations.json');
    const historyFile = join(fixture.directory, 'history.json');
    const queueFile = join(fixture.directory, 'queue.json');
    const ledger = new PromptOperationLedger(ledgerFile, { clock: () => new Date('2030-01-01T12:00:00.000Z') });
    const service = new PromptService({} as never, {} as never, new PromptHistoryService(historyFile), new QueuedPromptService(queueFile), undefined, undefined, undefined, undefined, undefined, undefined, fixture.agents.turns);
    service.useOperations(ledger);
    const input: PromptPublicationInput = {
      operationKey: 'structured-operation-1',
      promptId: 'StructuredPromptId_123',
      agentId: id,
      canonicalDestination: `instance/place/${id}`,
      payloadDigest: createHash('sha256').update('owned prompt').digest('base64url'),
      targetDigest: createHash('sha256').update(id).digest('base64url'),
      generation: 1,
      davoRequestId: 'structured-request-1',
      expiresAt: '2030-01-04T11:00:00.000Z',
      expectedActivityEpoch: 0,
      text: 'owned prompt'
    };
    await service.watchActivity(id, input.expiresAt);
    await expect(service.publishOperation(input, async () => true)).resolves.toMatchObject({ kind: 'published' });
    fixture.emit({ type: 'turn', turn: { type: 'started' } });
    fixture.emit({ type: 'transcript', item: { id: 'owned-native-user', kind: 'message', role: 'user', text: input.text } });
    await service.observe(await fixture.agents.agent(id) as never);
    await fixture.agents.saved();

    const restartedFixture = await nativeFixture({ file: fixture.file });
    await restartedFixture.agents.reattach();
    const restarted = new PromptService({} as never, {} as never, new PromptHistoryService(historyFile), new QueuedPromptService(queueFile), undefined, undefined, undefined, undefined, undefined, undefined, restartedFixture.agents.turns);
    restarted.useOperations(new PromptOperationLedger(ledgerFile, { clock: () => new Date('2030-01-01T12:00:00.000Z') }));
    // native events must stay protected without a fresh watch admission
    await restarted.observe(await restartedFixture.agents.agent(id) as never);
    await expect(restarted.activitySnapshot(id)).resolves.toMatchObject({ epoch: 1, pending: false });
    expect(restarted.davoOwned(id)).toBe(true);
    restartedFixture.emit({ type: 'turn', turn: { type: 'started' } });
    restartedFixture.emit({ type: 'transcript', item: { id: 'owned-native-user', kind: 'message', role: 'user', text: input.text } });
    await restarted.observe(await restartedFixture.agents.agent(id) as never);
    await expect(restarted.activitySnapshot(id)).resolves.toMatchObject({ epoch: 1, pending: false });
    expect(restarted.davoOwned(id)).toBe(true);
    restartedFixture.emit({ type: 'turn', turn: { type: 'settled', message: 'owned answer' } });
    await restarted.observe(await restartedFixture.agents.agent(id) as never);
    await expect(restarted.activitySnapshot(id)).resolves.toMatchObject({ epoch: 1, pending: false });
    await restartedFixture.agents.saved();
  });
});
