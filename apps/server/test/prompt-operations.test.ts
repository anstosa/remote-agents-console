import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { PromptOperationLedger, type PromptOperationIdentity } from '../src/prompts/operations.js';
import { QueuedPromptService, promptScope } from '../src/prompts/queue.js';
import { PromptService, type PromptPublicationInput } from '../src/prompts/service.js';

const directories: string[] = [];
const agentId = 'socket:%1';
const promptId = 'StablePromptId_123456';

// remove every isolated durable fixture
afterEach(async () => {
  // clear all test-owned directories
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// create one valid immutable operation identity
const operationIdentity = (overrides: Partial<PromptOperationIdentity> = {}): PromptOperationIdentity => ({
  operationKey: 'operation-1',
  promptId,
  agentId,
  canonicalDestination: 'instance-a/project-a/worktree-a/socket:%1',
  payloadDigest: createHash('sha256').update('do the work').digest('base64url'),
  targetDigest: createHash('sha256').update('target').digest('base64url'),
  generation: 7,
  davoRequestId: 'davo-request-1',
  expiresAt: '2030-01-04T11:00:00.000Z',
  expectedActivityEpoch: 0,
  ...overrides
});

// create a PromptService with one deterministic submitted transport
const promptFixture = async (clock: () => Date = () => new Date('2030-01-01T12:00:00.000Z')) => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-operation-'));
  directories.push(directory);
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const history = new PromptHistoryService(join(directory, 'history.json'));
  const ledger = new PromptOperationLedger(join(directory, 'operations.json'), { clock });
  const agent = { id: agentId, kind: 'codex', home: directory, attention: 'finished', title: 'Ready' };
  const delivered: string[] = [];
  let nativeMark: Record<string, unknown> = {};
  let turnEvent: unknown;
  let recoverAnswer: () => Promise<'settled'> = async () => 'settled';
  let answer: () => Promise<boolean> = async () => false;
  let interrupt: () => Promise<'ok' | 'not-working' | 'unavailable'> = async () => 'not-working';
  let close: () => Promise<boolean> = async () => true;
  const transport = {
    target: async () => ({ agent }),
    gate: async () => 'none',
    held: () => false,
    mark: async () => nativeMark,
    deliver: async (_target: string, text: string, _attachments: unknown[], _options: unknown, rendering: (value: string) => void) => {
      rendering(text);
      delivered.push(text);
      return { status: 'submitted', prompt: text };
    },
    observe: async () => turnEvent,
    externalReset: async () => false,
    forget: async () => undefined,
    recoverAnswer: async () => await recoverAnswer(),
    clearDraft: async () => true,
    answer: async () => await answer(),
    interrupt: async () => await interrupt(),
    close: async () => await close(),
    latestAnswer: async () => undefined,
    recentLines: async () => []
  };
  const service = new PromptService({} as never, {} as never, history, queue, undefined, undefined, undefined, undefined, undefined, transport as never);
  service.useOperations(ledger);
  return { agent, directory, queue, history, ledger, service, delivered, transport, setAnswer: (next: typeof answer) => { answer = next; }, setClose: (next: typeof close) => { close = next; }, setInterrupt: (next: typeof interrupt) => { interrupt = next; }, setNativeMark: (next: Record<string, unknown>) => { nativeMark = next; }, setRecoverAnswer: (next: typeof recoverAnswer) => { recoverAnswer = next; }, setTurnEvent: (next: unknown) => { turnEvent = next; } };
};

describe('PromptOperationLedger', () => {
  // correct stale temporary permissions before replacing the private ledger
  it('privatizes an existing permissive next inode', async () => {
    const fixture = await promptFixture();
    const file = join(fixture.directory, 'operations.json');
    await writeFile(`${file}.next`, 'stale');
    await chmod(`${file}.next`, 0o666);
    await fixture.ledger.watchActivity(agentId, operationIdentity().expiresAt);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  // fail before publishing when private permissions cannot be established
  it('does not promote a next inode after chmod failure', async () => {
    const fixture = await promptFixture();
    const file = join(fixture.directory, 'operations.json');
    const probe = await open(`${file}.probe`, 'w');
    const prototype = Object.getPrototypeOf(probe) as { chmod: (mode: number) => Promise<void> };
    await probe.close();
    const failure = vi.spyOn(prototype, 'chmod').mockRejectedValueOnce(new Error('permission failure'));
    try {
      await expect(fixture.ledger.watchActivity(agentId, operationIdentity().expiresAt)).rejects.toThrow('permission failure');
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { failure.mockRestore(); }
  });

  // preserve durable tracking before any coordinator restart recovery
  it.each(['operator', 'pane', 'native'] as const)('stamps %s activity immediately after restart without rewatching', async source => {
    const fixture = await promptFixture();
    await fixture.service.watchActivity(agentId, operationIdentity().expiresAt);
    const restarted = new PromptService({} as never, {} as never, fixture.history, fixture.queue, undefined, undefined, undefined, undefined, undefined, fixture.transport as never);
    restarted.useOperations(new PromptOperationLedger(join(fixture.directory, 'operations.json'), { clock: () => new Date('2030-01-01T12:00:00.000Z') }));
    // exercise every pre-coordinator input boundary
    if (source === 'operator') await restarted.submit(agentId, 'intervening operator work');
    else if (source === 'pane') await restarted.withExternalActivity(agentId, async () => {
      expect(await restarted.activitySnapshot(agentId)).toMatchObject({ epoch: 1, pending: true });
      return true;
    });
    else await restarted.observeExternalTurn(agentId, 'new-native-turn');
    expect(await restarted.activitySnapshot(agentId)).toMatchObject({ epoch: 1, pending: source === 'pane' });
    await expect(restarted.publishOperation({ ...operationIdentity(), text: 'old request' }, () => true)).resolves.toMatchObject({ kind: 'rejected' });
  });

  // reading ordinary targets must not create or retain tracking state
  it('keeps an unwatched agent ledger-free across every input boundary', async () => {
    const fixture = await promptFixture();
    await fixture.service.submit(agentId, 'ordinary work');
    await fixture.service.withExternalActivity(agentId, async () => true);
    await fixture.service.observeExternalTurn(agentId, 'ordinary-native');
    expect(await fixture.service.activitySnapshot(agentId)).toBeUndefined();
    const stored = JSON.parse(await readFile(join(fixture.directory, 'operations.json'), 'utf8'));
    expect(stored).toMatchObject({ operations: [], frontiers: [] });
  });

  it('keeps immutable idempotency metadata content-free and never evicts active operations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-operation-ledger-'));
    directories.push(directory);
    let now = new Date('2030-01-01T12:00:00.000Z');
    const file = join(directory, 'operations.json');
    const ledger = new PromptOperationLedger(file, { clock: () => now, maxOperations: 1 });
    const identity = operationIdentity();

    await expect(ledger.prepare({ ...identity, text: 'must never persist' } as PromptOperationIdentity)).resolves.toMatchObject({ kind: 'prepared', operation: { promptId } });
    await expect(ledger.prepare(identity)).resolves.toMatchObject({ kind: 'existing', operation: { promptId } });
    await expect(ledger.prepare({ ...identity, payloadDigest: 'different' })).resolves.toEqual({ kind: 'conflict' });
    await expect(ledger.prepare(operationIdentity({ operationKey: 'operation-2', promptId: 'StablePromptId_654321' }))).resolves.toEqual({ kind: 'capacity' });

    const serialized = await readFile(file, 'utf8');
    expect(serialized).not.toContain('must never persist');
    expect(serialized).not.toContain('do the work');

    now = new Date('2030-01-05T12:00:00.000Z');
    await expect(ledger.prepare(operationIdentity({ operationKey: 'operation-2', promptId: 'StablePromptId_654321', expiresAt: '2030-01-06T12:00:00.000Z' }))).resolves.toMatchObject({ kind: 'prepared' });
    await expect(ledger.lookup('operation-1')).resolves.toBeUndefined();
  });

  it('persists pending activity before effects and deduplicates observed turns without an event log', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-operation-frontier-'));
    directories.push(directory);
    const file = join(directory, 'operations.json');
    const ledger = new PromptOperationLedger(file, { clock: () => new Date('2030-01-01T12:00:00.000Z') });

    await expect(ledger.activitySnapshot(agentId)).resolves.toBeUndefined();
    await expect(ledger.watchActivity(agentId, '2030-01-04T11:00:00.000Z')).resolves.toMatchObject({ epoch: 0, pending: false });
    await expect(ledger.beginExternalActivity(agentId)).resolves.toMatchObject({ epoch: 1, pending: true });
    await expect(new PromptOperationLedger(file, { clock: () => new Date('2030-01-01T12:00:00.000Z') }).activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: true });
    await expect(ledger.observeExternalTurn(agentId, 'turn-1')).resolves.toMatchObject({ epoch: 1, pending: false });
    await expect(ledger.observeExternalTurn(agentId, 'turn-1')).resolves.toMatchObject({ epoch: 1, pending: false });
    await expect(ledger.observeExternalTurn(agentId, 'turn-2')).resolves.toMatchObject({ epoch: 2, pending: false });

    const stored = JSON.parse(await readFile(file, 'utf8')) as { frontiers: unknown[] };
    expect(stored.frontiers).toHaveLength(1);
  });
});

describe('PromptService operation publication', () => {
  it('publishes one stable prompt, survives presentation pressure, and contains observer failures', async () => {
    const { service, history, ledger, delivered } = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    await service.watchActivity(agentId, input.expiresAt);
    const observed = vi.fn();
    service.observePromptLifecycle({
      queued: () => { throw new Error('observer failure'); },
      delivered: observed,
      ended: () => { throw new Error('observer failure'); }
    });

    await expect(service.publishOperation(input, async () => true)).resolves.toMatchObject({ kind: 'published', replayed: false, operation: { promptId, state: 'published' } });
    expect(service.davoOwned(agentId)).toBe(true);
    expect(delivered).toEqual(['do the work']);
    expect(observed).toHaveBeenCalledOnce();
    await expect(history.findExact(promptScope(agentId), input.operationKey, input.promptId)).resolves.toMatchObject({ id: promptId, operationKey: input.operationKey, davoRequestId: input.davoRequestId, label: 'davo', text: 'do the work' });

    // push the stable row beyond the 50-row presentation slice
    for (let index = 0; index < 55; index += 1) await history.record(promptScope(agentId), `ordinary ${index}`);
    expect((await history.list(promptScope(agentId)))?.some(entry => entry.id === promptId)).toBe(false);
    await expect(history.findExact(promptScope(agentId), input.operationKey, input.promptId)).resolves.toMatchObject({ id: promptId });

    await expect(service.publishOperation(input, async () => true)).resolves.toMatchObject({ kind: 'published', replayed: true, operation: { promptId } });
    expect(delivered).toEqual(['do the work']);
    await expect(service.publishOperation({ ...input, payloadDigest: 'different' }, async () => true)).resolves.toEqual({ kind: 'conflict' });
    await expect(ledger.lookup(input.operationKey)).resolves.toMatchObject({ state: 'published', lifecycle: { state: 'delivered', historyEntryId: promptId } });
  });

  // retry one immutable end only after its durable receipt succeeds
  it('recovers terminal persistence after lookup and write failures without duplicate delivery', async () => {
    const fixture = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    const ended = vi.fn();
    fixture.service.observePromptLifecycle({ ended });
    await fixture.service.watchActivity(agentId, input.expiresAt);
    await expect(fixture.service.publishOperation(input, async () => true)).resolves.toMatchObject({ kind: 'published' });
    const lookupFailure = vi.spyOn(fixture.ledger, 'lookupByPrompt').mockRejectedValueOnce(new Error('lookup unavailable'));
    let rejectTerminal!: () => void;
    const rejectedTerminal = new Promise<void>(resolve => { rejectTerminal = resolve; });
    const lifecycleFailure = vi.spyOn(fixture.ledger, 'recordLifecycle').mockImplementationOnce(async () => { rejectTerminal(); throw new Error('lifecycle unavailable'); });

    fixture.agent.attention = 'working';
    fixture.setTurnEvent({ type: 'started', mark: {} });
    await fixture.service.observe(fixture.agent as never);
    fixture.agent.attention = 'finished';
    fixture.setTurnEvent({ type: 'settled', message: 'verified answer' });
    await fixture.service.observe(fixture.agent as never);
    await rejectedTerminal;

    await expect(fixture.ledger.lookup(input.operationKey)).resolves.toMatchObject({ lifecycle: { state: 'delivered' } });
    await expect(fixture.service.lookupOperation(input.operationKey)).resolves.toMatchObject({ lifecycle: { state: 'ended', outcome: 'completed' } });
    await expect(fixture.service.lookupOperation(input.operationKey)).resolves.toMatchObject({ lifecycle: { state: 'ended', outcome: 'completed' } });
    expect(fixture.delivered).toEqual(['do the work']);
    expect(ended).not.toHaveBeenCalled();
    expect(lookupFailure).toHaveBeenCalled();
    expect(lifecycleFailure).toHaveBeenCalled();
  });

  // reconstruct completion only from the exact persisted answer after restart
  it('repairs a restart between answer and lifecycle persistence from exact history', async () => {
    const fixture = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    await fixture.service.watchActivity(agentId, input.expiresAt);
    await fixture.service.publishOperation(input, async () => true);
    let rejectTerminal!: () => void;
    const rejectedTerminal = new Promise<void>(resolve => { rejectTerminal = resolve; });
    vi.spyOn(fixture.ledger, 'recordLifecycle').mockImplementationOnce(async () => { rejectTerminal(); throw new Error('lifecycle unavailable'); });
    fixture.agent.attention = 'working';
    fixture.setTurnEvent({ type: 'started', mark: {} });
    await fixture.service.observe(fixture.agent as never);
    fixture.agent.attention = 'finished';
    fixture.setTurnEvent({ type: 'settled', message: 'durable answer' });
    await fixture.service.observe(fixture.agent as never);
    await rejectedTerminal;
    await expect(fixture.history.findExact(promptScope(agentId), input.operationKey, input.promptId)).resolves.toMatchObject({ answer: 'durable answer' });

    const restartedLedger = new PromptOperationLedger(join(fixture.directory, 'operations.json'), { clock: () => new Date('2030-01-01T12:00:00.000Z') });
    const restarted = new PromptService({} as never, {} as never, fixture.history, fixture.queue, undefined, undefined, undefined, undefined, undefined, fixture.transport as never);
    restarted.useOperations(restartedLedger);
    await expect(restarted.lookupOperation(input.operationKey)).resolves.toMatchObject({ lifecycle: { state: 'ended', outcome: 'completed' } });
    expect(fixture.delivered).toEqual(['do the work']);
  });

  // preserve an explicit interruption when restart history cannot prove completion
  it('interrupts exact idle answerless history after restart instead of inventing completion', async () => {
    const fixture = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    await fixture.service.watchActivity(agentId, input.expiresAt);
    await fixture.service.publishOperation(input, async () => true);
    const unanswered = await fixture.history.findExact(promptScope(agentId), input.operationKey, input.promptId);
    expect(unanswered).toMatchObject({ id: promptId });
    expect(unanswered?.answer).toBeUndefined();

    const restartedLedger = new PromptOperationLedger(join(fixture.directory, 'operations.json'), { clock: () => new Date('2030-01-01T12:00:00.000Z') });
    const restarted = new PromptService({} as never, {} as never, fixture.history, fixture.queue, undefined, undefined, undefined, undefined, undefined, fixture.transport as never);
    restarted.useOperations(restartedLedger);
    fixture.agent.attention = 'finished';
    fixture.setTurnEvent(undefined);
    await restarted.observe(fixture.agent as never);

    await expect(restartedLedger.lookup(input.operationKey)).resolves.toMatchObject({ lifecycle: { state: 'ended', outcome: 'interrupted' } });
    expect(fixture.delivered).toEqual(['do the work']);
  });

  // a stale restart observer cannot interrupt a newly phased publication
  it('rechecks phase ownership after gated restart recovery before interrupting', async () => {
    const fixture = await promptFixture();
    const original: PromptPublicationInput = { ...operationIdentity(), text: 'old work' };
    await fixture.service.watchActivity(agentId, original.expiresAt);
    await fixture.service.publishOperation(original, async () => true);

    const restartedLedger = new PromptOperationLedger(join(fixture.directory, 'operations.json'), { clock: () => new Date('2030-01-01T12:00:00.000Z') });
    const restarted = new PromptService({} as never, {} as never, fixture.history, fixture.queue, undefined, undefined, undefined, undefined, undefined, fixture.transport as never);
    restarted.useOperations(restartedLedger);
    const ended = vi.fn();
    restarted.observePromptLifecycle({ ended });
    let enterRecovery!: () => void;
    let releaseRecovery!: () => void;
    const recoveryEntered = new Promise<void>(resolve => { enterRecovery = resolve; });
    const recoveryReleased = new Promise<void>(resolve => { releaseRecovery = resolve; });
    fixture.setRecoverAnswer(async () => { enterRecovery(); await recoveryReleased; return 'settled'; });
    fixture.agent.attention = 'finished';
    fixture.setTurnEvent(undefined);
    const staleObservation = restarted.observe(fixture.agent as never);
    await recoveryEntered;

    const activity = await restarted.activitySnapshot(agentId);
    const fresh: PromptPublicationInput = { ...operationIdentity({ operationKey: 'operation-fresh', promptId: 'StablePromptId_fresh12', davoRequestId: 'davo-request-fresh', expectedActivityEpoch: activity?.epoch ?? -1 }), text: 'fresh work' };
    await expect(restarted.publishOperation(fresh, async () => true)).resolves.toMatchObject({ kind: 'published' });
    releaseRecovery();
    await staleObservation;
    await expect(restartedLedger.lookup(fresh.operationKey)).resolves.not.toMatchObject({ lifecycle: { state: 'ended', outcome: 'interrupted' } });

    fixture.agent.attention = 'working';
    fixture.setTurnEvent({ type: 'started', mark: {} });
    await restarted.observe(fixture.agent as never);
    fixture.agent.attention = 'finished';
    fixture.setTurnEvent({ type: 'settled', message: 'fresh answer' });
    await restarted.observe(fixture.agent as never);
    await expect(restarted.lookupOperation(fresh.operationKey)).resolves.toMatchObject({ lifecycle: { state: 'ended', outcome: 'completed' } });
    expect(ended).toHaveBeenCalledOnce();
    expect(fixture.delivered).toEqual(['old work', 'fresh work']);
  });

  // stop terminal retries at the original operation expiry
  it('does not retry a terminal receipt after operation expiry', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2030-01-01T12:00:00.000Z'));
      const fixture = await promptFixture(() => new Date());
      const input: PromptPublicationInput = { ...operationIdentity({ expiresAt: '2030-01-02T12:00:00.000Z' }), text: 'do the work' };
      const ended = vi.fn();
      fixture.service.observePromptLifecycle({ ended });
      await fixture.service.watchActivity(agentId, input.expiresAt);
      await fixture.service.publishOperation(input, async () => true);
      let rejectTerminal!: () => void;
      const rejectedTerminal = new Promise<void>(resolve => { rejectTerminal = resolve; });
      vi.spyOn(fixture.ledger, 'recordLifecycle').mockImplementationOnce(async () => { rejectTerminal(); throw new Error('lifecycle unavailable'); });
      fixture.agent.attention = 'working';
      fixture.setTurnEvent({ type: 'started', mark: {} });
      await fixture.service.observe(fixture.agent as never);
      fixture.agent.attention = 'finished';
      fixture.setTurnEvent({ type: 'settled', message: 'durable answer' });
      await fixture.service.observe(fixture.agent as never);
      await rejectedTerminal;

      vi.setSystemTime(new Date('2030-01-03T12:00:00.000Z'));
      await expect(fixture.service.lookupOperation(input.operationKey)).resolves.toBeUndefined();
      expect(ended).not.toHaveBeenCalled();
      expect(fixture.delivered).toEqual(['do the work']);
    } finally { vi.useRealTimers(); }
  });

  it('keeps ledger truth after 2,000-row lookup and global history eviction', async () => {
    const { directory, service, history } = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    await service.watchActivity(agentId, input.expiresAt);
    await expect(service.publishOperation(input, async () => true)).resolves.toMatchObject({ kind: 'published' });
    const historyFile = join(directory, 'history.json');
    const stable = { id: promptId, text: input.text, createdAt: '2029-12-01T00:00:00.000Z', label: 'davo', operationKey: input.operationKey, davoRequestId: input.davoRequestId };
    const rows = Array.from({ length: 1_999 }, (_, index) => ({ id: `HistoryRow_${String(index).padStart(12, '0')}`, text: `row ${index}`, createdAt: new Date(Date.UTC(2029, 11, 2, 0, 0, index)).toISOString() }));
    await writeFile(historyFile, JSON.stringify({ [promptScope(agentId)]: [...rows, stable] }));

    await expect(history.list(promptScope(agentId))).resolves.toHaveLength(50);
    await expect(history.findExact(promptScope(agentId), input.operationKey, input.promptId)).resolves.toMatchObject({ id: promptId });

    const pressureRows = Array.from({ length: 155 }, (_, index) => ({ id: `PressureRow_${String(index).padStart(12, '0')}`, text: 'x'.repeat(64_000), createdAt: new Date(Date.UTC(2029, 11, 3, 0, 0, index)).toISOString() }));
    await writeFile(historyFile, JSON.stringify({ [promptScope(agentId)]: [stable], 'agent:pressure': pressureRows }));
    await history.record('agent:pressure', 'y'.repeat(64_000));
    await history.record('agent:pressure', 'z'.repeat(64_000));

    await expect(history.findExact(promptScope(agentId), input.operationKey, input.promptId)).resolves.toBeUndefined();
    await expect(service.lookupOperation(input.operationKey)).resolves.toMatchObject({ state: 'published', promptId });
  });

  it('serializes manual activity before effects and blocks the old expected frontier after failure', async () => {
    const { service } = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    await service.watchActivity(agentId, input.expiresAt);

    await expect(service.withExternalActivity(agentId, async () => {
      await expect(service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: true });
      throw new Error('send failed');
    })).rejects.toThrow('send failed');

    await expect(service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: true });
    await expect(service.publishOperation(input, async () => true)).resolves.toEqual({ kind: 'rejected', reason: 'activity_pending' });
    await expect(service.observeExternalTurn(agentId, 'manual-turn')).resolves.toMatchObject({ epoch: 1, pending: false });
    await expect(service.publishOperation(input, async () => true)).resolves.toEqual({ kind: 'rejected', reason: 'activity_changed' });
  });

  it('advances for newly submitted ordinary work but not work queued before the target watch', async () => {
    const { service, queue } = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    await queue.enqueue(promptScope(agentId), 'already active', [], { home: '/before-watch' });
    await expect(service.watchActivity(agentId, input.expiresAt)).resolves.toMatchObject({ epoch: 0, pending: false });
    await expect(service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 0, pending: false });

    await expect(service.submit(agentId, 'new operator chain')).resolves.toBe(true);
    await expect(service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: false });
    await expect(service.publishOperation(input, async () => true)).resolves.toEqual({ kind: 'rejected', reason: 'activity_changed' });
  });

  it('does not advance for its correlated Davo turn but advances every new uncorrelated turn', async () => {
    const { service } = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    await service.watchActivity(agentId, input.expiresAt);
    await expect(service.publishOperation(input, async () => true)).resolves.toMatchObject({ kind: 'published' });

    await expect(service.observeExternalTurn(agentId, 'owned-turn', promptId)).resolves.toMatchObject({ epoch: 1, pending: false });
    await expect(service.observeExternalTurn(agentId, 'other-turn')).resolves.toMatchObject({ epoch: 2, pending: false });
    await expect(service.observeExternalTurn(agentId, 'other-turn')).resolves.toMatchObject({ epoch: 2, pending: false });
  });

  it('advances from native marks for external turns while its managed Davo turn stays correlated', async () => {
    const fixture = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'rollout-a', ordinal: 1 } });
    await fixture.service.watchActivity(agentId, input.expiresAt);

    fixture.agent.attention = 'working';
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'rollout-b', ordinal: 1 } });
    await fixture.service.observe(fixture.agent as never);
    await expect(fixture.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: false });
    await fixture.service.observe(fixture.agent as never);
    await expect(fixture.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: false });

    fixture.setNativeMark({ rolloutBaseline: { rollout: 'rollout-c', ordinal: 1 } });
    await fixture.service.observe(fixture.agent as never);
    await expect(fixture.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 2, pending: false });

    fixture.agent.attention = 'finished';
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'rollout-c', ordinal: 2 } });
    await fixture.service.observe(fixture.agent as never);
    await expect(fixture.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 2, pending: false });

    const next: PromptPublicationInput = { ...operationIdentity({ operationKey: 'operation-own', promptId: 'StablePromptId_own123', expectedActivityEpoch: 2 }), text: 'owned work' };
    await expect(fixture.service.publishOperation(next, async () => true)).resolves.toMatchObject({ kind: 'published' });
    fixture.agent.attention = 'working';
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'rollout-own', ordinal: 1 } });
    fixture.setTurnEvent({ type: 'started', mark: { rolloutBaseline: { rollout: 'rollout-own', ordinal: 1 } } });
    await fixture.service.observe(fixture.agent as never);
    await expect(fixture.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 3, pending: false });

    fixture.agent.attention = 'finished';
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'rollout-own', ordinal: 2 } });
    fixture.setTurnEvent({ type: 'settled', message: 'owned answer' });
    await fixture.service.observe(fixture.agent as never);
    await expect(fixture.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 3, pending: false });
  });

  it('persists a preexisting-turn baseline across restart without adopting its completion as new activity', async () => {
    const fixture = await promptFixture();
    fixture.agent.attention = 'working';
    fixture.setNativeMark({ rolloutBaseline: { rollout: '/secret/native-rollout.jsonl', ordinal: 9 } });
    await expect(fixture.service.watchActivity(agentId, operationIdentity().expiresAt)).resolves.toMatchObject({ epoch: 0, pending: false });

    const restartedLedger = new PromptOperationLedger(join(fixture.directory, 'operations.json'), { clock: () => new Date('2030-01-01T12:00:00.000Z') });
    const restarted = new PromptService({} as never, {} as never, fixture.history, fixture.queue, undefined, undefined, undefined, undefined, undefined, fixture.transport as never);
    restarted.useOperations(restartedLedger);
    await restarted.watchActivity(agentId, operationIdentity().expiresAt);
    fixture.agent.attention = 'finished';
    fixture.setNativeMark({ rolloutBaseline: { rollout: '/secret/native-rollout.jsonl', ordinal: 10 } });
    await restarted.observe(fixture.agent as never);
    await expect(restarted.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 0, pending: false });

    fixture.agent.attention = 'working';
    fixture.setNativeMark({ rolloutBaseline: { rollout: '/secret/other-rollout.jsonl', ordinal: 1 } });
    await restarted.observe(fixture.agent as never);
    await expect(restarted.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: false });
    expect(await readFile(join(fixture.directory, 'operations.json'), 'utf8')).not.toContain('/secret/');
  });

  it('keeps a restarted published Davo turn correlated from stable full-history identity', async () => {
    const fixture = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    await fixture.service.watchActivity(agentId, input.expiresAt);
    await fixture.service.publishOperation(input, async () => true);
    fixture.agent.attention = 'working';
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'owned-restart', ordinal: 1 } });
    fixture.setTurnEvent({ type: 'started', mark: { rolloutBaseline: { rollout: 'owned-restart', ordinal: 1 } } });
    await fixture.service.observe(fixture.agent as never);

    const restartedLedger = new PromptOperationLedger(join(fixture.directory, 'operations.json'), { clock: () => new Date('2030-01-01T12:00:00.000Z') });
    const restarted = new PromptService({} as never, {} as never, fixture.history, fixture.queue, undefined, undefined, undefined, undefined, undefined, fixture.transport as never);
    restarted.useOperations(restartedLedger);
    await restarted.watchActivity(agentId, input.expiresAt);
    await restarted.observe(fixture.agent as never);

    await expect(restarted.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: false });
    expect(restarted.davoOwned(agentId)).toBe(true);
    fixture.agent.attention = 'finished';
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'owned-restart', ordinal: 2 } });
    fixture.setTurnEvent({ type: 'settled', message: 'owned answer' });
    await restarted.observe(fixture.agent as never);
    expect(restarted.davoOwned(agentId)).toBe(true);

    fixture.agent.attention = 'working';
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'manual-next', ordinal: 1 } });
    fixture.setTurnEvent(undefined);
    await restarted.observe(fixture.agent as never);
    expect(restarted.davoOwned(agentId)).toBe(false);
  });

  it('does not recover Davo ownership from stale history over an unrelated active native turn', async () => {
    const fixture = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    await fixture.service.watchActivity(agentId, input.expiresAt);
    await fixture.service.publishOperation(input, async () => true);
    fixture.agent.attention = 'working';
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'unrelated-manual', ordinal: 1 } });

    const restarted = new PromptService({} as never, {} as never, fixture.history, fixture.queue, undefined, undefined, undefined, undefined, undefined, fixture.transport as never);
    restarted.useOperations(new PromptOperationLedger(join(fixture.directory, 'operations.json'), { clock: () => new Date('2030-01-01T12:00:00.000Z') }));
    await restarted.watchActivity(agentId, input.expiresAt);
    await restarted.observe(fixture.agent as never);

    expect(restarted.davoOwned(agentId)).toBe(false);
    await expect(restarted.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 2, pending: false });
  });

  it('preserves ownership for an explicit Davo question relay and clears it for ordinary answers', async () => {
    const fixture = await promptFixture();
    const input: PromptPublicationInput = { ...operationIdentity(), text: 'do the work' };
    fixture.setAnswer(async () => true);
    await fixture.service.watchActivity(agentId, input.expiresAt);
    await fixture.service.publishOperation(input, async () => true);

    await expect(fixture.service.answerQuestion(agentId, 'question-1', 0, { preserveDavo: true })).resolves.toBe(true);
    expect(fixture.service.davoOwned(agentId)).toBe(true);
    await expect(fixture.service.answerQuestion(agentId, 'question-2', 0)).resolves.toBe(true);
    expect(fixture.service.davoOwned(agentId)).toBe(false);
  });

  it('stamps cancellation and close before their effects without double-stamping wrapped Ctrl+C', async () => {
    const cancelled = await promptFixture();
    await cancelled.service.watchActivity(agentId, operationIdentity().expiresAt);
    let cancelEffectSnapshot: Awaited<ReturnType<typeof cancelled.service.activitySnapshot>> | undefined;
    cancelled.setInterrupt(async () => {
      cancelEffectSnapshot = await cancelled.service.activitySnapshot(agentId);
      return 'not-working';
    });
    await expect(cancelled.service.cancel(agentId)).resolves.toBe('not-working');
    expect(cancelEffectSnapshot).toMatchObject({ epoch: 1, pending: true });
    await expect(cancelled.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: true });

    const wrapped = await promptFixture();
    await wrapped.service.watchActivity(agentId, operationIdentity().expiresAt);
    await expect(wrapped.service.withExternalActivity(agentId, async () => await wrapped.service.cancel(agentId))).resolves.toBe('not-working');
    await expect(wrapped.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: true });

    const confirmed = await promptFixture();
    await confirmed.service.watchActivity(agentId, operationIdentity().expiresAt);
    await expect(confirmed.service.withExternalActivity(agentId, async () => 'ok', result => result === 'ok')).resolves.toBe('ok');
    await expect(confirmed.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: false });

    const closed = await promptFixture();
    await closed.service.watchActivity(agentId, operationIdentity().expiresAt);
    let closeEffectSnapshot: Awaited<ReturnType<typeof closed.service.activitySnapshot>> | undefined;
    closed.setClose(async () => {
      closeEffectSnapshot = await closed.service.activitySnapshot(agentId);
      return false;
    });
    await expect(closed.service.close(agentId)).resolves.toBe(false);
    expect(closeEffectSnapshot).toMatchObject({ epoch: 1, pending: true });
    await expect(closed.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: true });
  });

  it('reuses one activity stamp for a nested handover', async () => {
    const fixture = await promptFixture();
    const replacementId = 'socket:%2';
    await fixture.service.watchActivity(agentId, operationIdentity().expiresAt);
    await fixture.queue.enqueue(promptScope(agentId), 'move me', [], { home: fixture.directory });

    await fixture.service.withExternalActivity(agentId, async () => await fixture.service.handOver(agentId, replacementId), () => true);

    await expect(fixture.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 1, pending: false });
    await expect(fixture.queue.list(promptScope(replacementId))).resolves.toMatchObject([{ text: 'move me' }]);
  });

  it('does not let an unrelated asynchronous caller bypass an active target serializer', async () => {
    const fixture = await promptFixture();
    await fixture.service.watchActivity(agentId, operationIdentity().expiresAt);
    let releaseEffect!: () => void;
    let enteredEffect!: () => void;
    const held = new Promise<void>(resolve => { releaseEffect = resolve; });
    const entered = new Promise<void>(resolve => { enteredEffect = resolve; });
    const outer = fixture.service.withExternalActivity(agentId, async () => {
      enteredEffect();
      await held;
      return true;
    });
    await entered;
    let submitSettled = false;
    const submitted = fixture.service.submit(agentId, 'unrelated caller').then(result => { submitSettled = true; return result; });
    await Promise.resolve();
    expect(submitSettled).toBe(false);
    releaseEffect();
    await expect(outer).resolves.toBe(true);
    await expect(submitted).resolves.toBe(true);
    await expect(fixture.service.activitySnapshot(agentId)).resolves.toMatchObject({ epoch: 2, pending: false });
  });

  it('does not create activity storage while ordinary unwatched agents are observed or mutated', async () => {
    const fixture = await promptFixture();
    fixture.agent.attention = 'working';
    fixture.setNativeMark({ rolloutBaseline: { rollout: 'ordinary', ordinal: 1 } });
    await fixture.service.observe(fixture.agent as never);
    await expect(fixture.service.withExternalActivity(agentId, async () => 'exact bytes')).resolves.toBe('exact bytes');
    await expect(fixture.service.close(agentId)).resolves.toBe(true);
    await expect(access(join(fixture.directory, 'operations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers publishing only from exact durable evidence and otherwise records unknown', async () => {
    const first = await promptFixture();
    const identity = operationIdentity();
    await first.ledger.watchActivity(agentId, identity.expiresAt);
    await first.ledger.prepare(identity);
    await first.ledger.transition(identity.operationKey, ['prepared'], 'publishing');

    const restartedLedger = new PromptOperationLedger(join(first.directory, 'operations.json'), { clock: () => new Date('2030-01-01T12:00:00.000Z') });
    const restarted = new PromptService({} as never, {} as never, first.history, first.queue);
    restarted.useOperations(restartedLedger);
    await expect(restarted.lookupOperation(identity.operationKey)).resolves.toMatchObject({ state: 'unknown' });

    const second = await promptFixture();
    const evidenced = operationIdentity({ operationKey: 'operation-evidenced', promptId: 'StablePromptId_999999' });
    await second.ledger.watchActivity(agentId, evidenced.expiresAt);
    await second.ledger.prepare(evidenced);
    await second.ledger.transition(evidenced.operationKey, ['prepared'], 'publishing');
    await second.queue.putIfAbsent(promptScope(agentId), 'do the work', [], { home: second.directory }, { id: evidenced.promptId, operationKey: evidenced.operationKey, davoRequestId: evidenced.davoRequestId });

    const evidencedLedger = new PromptOperationLedger(join(second.directory, 'operations.json'), { clock: () => new Date('2030-01-01T12:00:00.000Z') });
    const evidencedService = new PromptService({} as never, {} as never, second.history, second.queue);
    evidencedService.useOperations(evidencedLedger);
    await expect(evidencedService.lookupOperation(evidenced.operationKey)).resolves.toMatchObject({ state: 'published', promptId: evidenced.promptId });
  });
});
