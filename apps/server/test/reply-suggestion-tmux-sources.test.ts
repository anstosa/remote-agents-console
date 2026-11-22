import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TmuxReplySuggestionTarget } from '../src/discovery/service.js';
import { ClaudeReplySourcePolicyTracker, claudeReplyObserverStatePath, type ClaudeReplyObserverState } from '../src/reply-suggestions/claude-observer.js';
import { TmuxReplySuggestionSources } from '../src/reply-suggestions/tmux-sources.js';
import { ReplySuggestionService } from '../src/reply-suggestions/service.js';
import type { NativeReplyScope } from '../src/reply-suggestions/types.js';
import { codexHome, fakeProc, tempDir } from './helpers/codex-fixtures.js';
import { readStableJsonlTail } from '../src/adapters/reply-conversation.js';

const roots: string[] = [];
const trackers: ClaudeReplySourcePolicyTracker[] = [];
const approved = `${JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'shift+up': null, 'shift+down': null } }] }, null, 2)}\n`;

afterEach(async () => {
  // release profile watchers before fixture cleanup
  for (const tracker of trackers.splice(0)) tracker.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  processEnvironment.claudeConfigDir = '/home/operator/.claude';
});

// provide one atomic fake discovery target
function discovery(target: () => TmuxReplySuggestionTarget) {
  return {
    replySuggestionTarget: (id: string) => target().id === id ? structuredClone(target()) : undefined,
    validateReplySuggestionTarget: async (expected: TmuxReplySuggestionTarget) => JSON.stringify(expected) === JSON.stringify(target())
  };
}

// provide one nonsecret native route fixture
async function scope(kind: 'codex' | 'omx' | 'claude', process: { pid: number; startTime: string }, _environment?: NodeJS.ProcessEnv, _conversationId?: string): Promise<NativeReplyScope> {
  const nativeKind = kind === 'claude' ? 'claude' : 'codex';
  const configDir = kind === 'claude' ? processEnvironment.claudeConfigDir : processEnvironment.codexConfigDir;
  return {
    kind: nativeKind,
    program: `/usr/local/bin/${nativeKind}`,
    home: '/home/operator',
    configDir,
    process: { ...process },
    fingerprint: `${nativeKind}:${process.pid}:${process.startTime}:${configDir}`
  };
}

const processEnvironment = { codexConfigDir: '/home/operator/.codex', claudeConfigDir: '/home/operator/.claude' };

// write one exact Codex rollout generation
async function codexRollout(home: string, id: string, cwd: string): Promise<string> {
  const directory = join(home, 'sessions', '2026', '11', '15');
  await mkdir(directory, { recursive: true });
  const records = [
    { ordinal: 0, type: 'session_meta', payload: { id, cwd, originator: 'codex-tui' } },
    { ordinal: 1, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: id, thread_settings: { model: 'gpt-6.1-sol', model_provider_id: 'openai', reasoning_effort: 'high' } } },
    { ordinal: 2, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>hidden</environment_context>' }] } },
    { ordinal: 3, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'excluded' }, { type: 'input_text', text: 'Please propose a safe release plan.' }] } },
    { ordinal: 4, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Should I deploy to staging or production?' }] } }
  ];
  const file = join(directory, `rollout-2026-11-15T00-00-00-${id}.jsonl`);
  await writeFile(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

// atomically write one private observer state
async function observerState(directory: string, sessionId: string, state: ClaudeReplyObserverState): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = claudeReplyObserverStatePath(directory, sessionId);
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

// reproduce one content-free native terminal chain with interleaved bookkeeping
function claudeTerminalRecords(sessionId: string, assistantUuid: string, suffix: string, lastPrompt: 'before' | 'after' = 'before', leaf: 'terminal' | 'attachment' = 'terminal'): object[] {
  const attachmentUuid = `attachment-${suffix}`;
  const stopUuid = `stop-${suffix}`;
  const terminalUuid = `terminal-${suffix}`;
  const attachment = { type: 'attachment', uuid: attachmentUuid, parentUuid: assistantUuid, sessionId, session_id: sessionId, isSidechain: false, timestamp: '2026-11-15T12:00:00.200Z', attachment: { type: 'hook_success' } };
  const marker = { type: 'last-prompt', lastPrompt: 'omitted', leafUuid: leaf === 'terminal' ? terminalUuid : attachmentUuid, sessionId };
  const terminalRecords = [
    attachment,
    { type: 'ai-title', aiTitle: 'omitted', sessionId },
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'permission-mode', permissionMode: 'default', sessionId },
    { type: 'atis-latch', atis: 'omitted', sessionId },
    {
      type: 'system', subtype: 'stop_hook_summary', uuid: stopUuid, parentUuid: attachmentUuid,
      sessionId, session_id: sessionId, isSidechain: false, preventedContinuation: false,
      hasOutput: false, hookCount: 0, hookErrors: [], hookInfos: [], hookAdditionalContext: [], timestamp: '2026-11-15T12:00:00.300Z'
    },
    {
      type: 'system', subtype: 'turn_duration', uuid: terminalUuid, parentUuid: stopUuid,
      sessionId, isMeta: false, isSidechain: false, durationMs: 100, messageCount: 3,
      timestamp: '2026-11-15T12:00:00.400Z'
    }
  ];
  // native persistence can place the corroborating marker on either side of the terminal
  if (lastPrompt === 'before') terminalRecords.splice(1, 0, marker);
  else terminalRecords.push(marker);
  return terminalRecords;
}

describe('TmuxReplySuggestionSources', () => {
  // both native readers share strict byte decoding rather than replacement text
  it('rejects invalid utf8 records and skips a partial leading multibyte record', async () => {
    const root = await tempDir('rac-reply-utf8-');
    const file = join(root, 'transcript.jsonl');
    await writeFile(file, Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]));
    expect(await readStableJsonlTail(file, 1024)).toBeUndefined();
    const tail = '{"text":"complete"}\n';
    await writeFile(file, `{"text":"éééééééé"}\n${tail}`);
    expect((await readStableJsonlTail(file, Buffer.byteLength(tail) + 8))?.lines).toEqual([tail.trim()]);
  });

  it('reads exact Codex settings and bounded authored context with ABA-safe file generations', async () => {
    const home = await codexHome();
    const cwd = await tempDir('rac-reply-cwd-');
    const id = '11111111-2222-4333-8444-555555555555';
    const file = await codexRollout(home, id, cwd);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [file]);
    let target: TmuxReplySuggestionTarget = {
      id: 'socket:%1', kind: 'codex', attention: 'finished', panePid: 123, cwd,
      process: { pid: 123, startTime: '10' }, generation: 1
    };
    const sources = new TmuxReplySuggestionSources(discovery(() => target), { inspectNativeScope: scope });
    const first = await sources.source(target.id);
    expect(first).toMatchObject({
      kind: 'codex', transport: 'tmux', conversationId: id,
      model: { model: 'gpt-6.1-sol', effort: 'high' },
      nativeModel: { provider: 'openai', id: 'gpt-6.1-sol' }
    });
    expect(first!.messages).toEqual([
      { id: '3:user', role: 'user', text: 'Please propose a safe release plan.' },
      { id: '4:assistant', role: 'assistant', text: 'Should I deploy to staging or production?' }
    ]);
    await expect(sources.validate(first!, new AbortController().signal)).resolves.toBe(true);

    await appendFile(file, `${JSON.stringify({ ordinal: 5, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: id, thread_settings: { model: 'gpt-6-sol', model_provider_id: 'openai', reasoning_effort: 'low' } } })}\n`);
    await appendFile(file, `${JSON.stringify({ ordinal: 6, type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: id, thread_settings: { model: 'gpt-6.1-sol', model_provider_id: 'openai', reasoning_effort: 'high' } } })}\n`);
    const aba = await sources.source(target.id);
    expect(aba!.model).toEqual(first!.model);
    expect(aba!.sourceGeneration).toBeGreaterThan(first!.sourceGeneration);
    expect(aba!.identity).not.toBe(first!.identity);

    target = { ...target, process: { pid: 123, startTime: '11' }, generation: 2 };
    const replaced = await sources.source(target.id);
    expect(replaced!.processGeneration).toBeGreaterThan(aba!.processGeneration);
    await expect(sources.validate(aba!, new AbortController().signal)).resolves.toBe(false);
  });

  it('requires the controlled Claude policy and a new stable heartbeat for each validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-reply-claude-'));
    roots.push(root);
    const configDir = join(root, '.claude');
    const observerDir = join(root, 'observer');
    const cwd = '/workspace';
    const encoded = '-workspace';
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await mkdir(join(configDir, 'projects', encoded), { recursive: true, mode: 0o700 });
    await writeFile(join(configDir, 'keybindings.json'), approved, { mode: 0o600 });
    await chmod(join(configDir, 'keybindings.json'), 0o600);
    const transcript = join(configDir, 'projects', encoded, `${sessionId}.jsonl`);
    const userRecord = { type: 'user', uuid: 'u1', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'image', source: 'excluded' }, { type: 'text', text: 'I prefer the safer option.' }] } };
    const localRecord = { type: 'assistant', local_command_source: '<local-command-stdout>Effort set to high</local-command-stdout>', local_command_run: { command: 'effort' }, message: { id: 'local-1', role: 'assistant', content: [{ type: 'text', text: 'Effort set to high' }] } };
    const assistantRecord = {
      type: 'assistant', uuid: 'assistant-1', parentUuid: 'u1', sessionId, session_id: sessionId,
      isSidechain: false, timestamp: '2026-11-15T12:00:00.100Z',
      message: { id: 'a1', role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Should I use the reversible migration?' }] }
    };
    const initialRecords = [
      userRecord,
      localRecord,
      assistantRecord,
      { type: 'ai-title', aiTitle: 'omitted', sessionId },
      { type: 'mode', mode: 'normal', sessionId }
    ];
    await writeFile(transcript, `${initialRecords.map(record => JSON.stringify(record)).join('\n')}\n`);
    const tracker = new ClaudeReplySourcePolicyTracker({ configDir, sourceConfigDir: configDir, observerDir });
    trackers.push(tracker);
    await expect(tracker.initialize()).resolves.toBe(true);
    processEnvironment.claudeConfigDir = configDir;
    const policy = tracker.snapshot()!;
    let state: ClaudeReplyObserverState = {
      version: 1, sessionId, policyNonce: policy.policyNonce, bootNonce: 'boot-1', heartbeatSeq: 1,
      processPid: 333, processStartTime: '20',
      sourceEpoch: 1, hookSeq: 1, statusHookSeq: 1, transcriptSignalSeq: 0,
      pendingModelSwitch: false, model: 'claude-opus-5-5', effort: 'high'
    };
    await observerState(observerDir, sessionId, state);
    const target: TmuxReplySuggestionTarget = {
      id: 'socket:%2', kind: 'claude', attention: 'finished', panePid: 222, cwd, conversationId: sessionId,
      process: { pid: 333, startTime: '20' }, generation: 1
    };
    const sources = new TmuxReplySuggestionSources(discovery(() => target), {
      environment: { RAC_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
      claudePolicy: tracker,
      inspectNativeScope: scope,
      validationTimeoutMs: 300,
      validationPollMs: 5
    });
    await expect(sources.source(target.id)).resolves.toBeUndefined();

    const oldAssistant = { ...assistantRecord, uuid: 'assistant-old', message: { ...assistantRecord.message, id: 'a0' } };
    const priorTurn = [userRecord, oldAssistant, ...claudeTerminalRecords(sessionId, 'assistant-old', 'old'), localRecord, assistantRecord];
    const unrelated = [...initialRecords, ...claudeTerminalRecords(sessionId, 'other-assistant', 'unrelated')];
    const wrongSession = [...initialRecords, ...claudeTerminalRecords('ffffffff-1111-4222-8333-444444444444', 'assistant-1', 'wrong-session')];
    const leafMismatch = [...claudeTerminalRecords(sessionId, 'assistant-1', 'leaf-mismatch')];
    (leafMismatch[1] as { leafUuid: string }).leafUuid = 'not-the-terminal';
    const forwardSpoof = claudeTerminalRecords(sessionId, 'assistant-1', 'forward');
    forwardSpoof.splice(6, 2, forwardSpoof[7]!, forwardSpoof[6]!);
    const duplicate = [...claudeTerminalRecords(sessionId, 'assistant-1', 'duplicate'), { type: 'future-record', uuid: 'terminal-duplicate', sessionId }];
    const latestLeafMismatch = [...claudeTerminalRecords(sessionId, 'assistant-1', 'latest-leaf'), { type: 'last-prompt', lastPrompt: 'omitted', leafUuid: 'not-the-terminal', sessionId }];
    const malformedLatestLeaf = [...claudeTerminalRecords(sessionId, 'assistant-1', 'malformed-leaf'), { type: 'last-prompt', lastPrompt: 'omitted', sessionId }];
    const siblingLeaf = [
      { type: 'attachment', uuid: 'attachment-sibling', parentUuid: 'assistant-1', sessionId, session_id: sessionId, isSidechain: false },
      ...claudeTerminalRecords(sessionId, 'assistant-1', 'sibling'),
      { type: 'last-prompt', lastPrompt: 'omitted', leafUuid: 'attachment-sibling', sessionId }
    ];
    const oldAttachmentLeaf = [
      userRecord,
      oldAssistant,
      ...claudeTerminalRecords(sessionId, 'assistant-old', 'old-leaf'),
      localRecord,
      assistantRecord,
      ...claudeTerminalRecords(sessionId, 'assistant-1', 'current-leaf'),
      { type: 'last-prompt', lastPrompt: 'omitted', leafUuid: 'attachment-old-leaf', sessionId }
    ];
    const emptyAssistant = {
      ...assistantRecord, uuid: 'assistant-empty', parentUuid: 'terminal-valid',
      timestamp: '2026-11-15T12:00:01.100Z',
      message: { id: 'empty', role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'tool_use', name: 'none' }] }
    };
    const staleVisibleReply = [...initialRecords, ...claudeTerminalRecords(sessionId, 'assistant-1', 'valid'), emptyAssistant, ...claudeTerminalRecords(sessionId, 'assistant-empty', 'empty')];
    const invalidTerminals = [priorTurn, unrelated, wrongSession, [...initialRecords, ...leafMismatch], [...initialRecords, ...forwardSpoof], [...initialRecords, ...duplicate], [...initialRecords, ...latestLeafMismatch], [...initialRecords, ...malformedLatestLeaf], [...initialRecords, ...siblingLeaf], oldAttachmentLeaf, staleVisibleReply];
    // every incomplete, unrelated or spoofed terminal remains unavailable
    for (const records of invalidTerminals) {
      await writeFile(transcript, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
      await expect(sources.source(target.id)).resolves.toBeUndefined();
    }

    const finalAssistantFragment = {
      ...assistantRecord, uuid: 'assistant-1-final', parentUuid: 'assistant-1',
      timestamp: '2026-11-15T12:00:00.150Z',
      message: { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', name: 'none' }] }
    };
    await writeFile(transcript, `${[...initialRecords, finalAssistantFragment, ...claudeTerminalRecords(sessionId, 'assistant-1-final', 'attachment-leaf', 'before', 'attachment')].map(record => JSON.stringify(record)).join('\n')}\n`);
    const attachmentLeafSource = await sources.source(target.id);
    expect(attachmentLeafSource).toBeDefined();
    await writeFile(transcript, `${[...initialRecords, finalAssistantFragment, ...claudeTerminalRecords(sessionId, 'assistant-1-final', 'preterminal')].map(record => JSON.stringify(record)).join('\n')}\n`);
    const preterminalSource = await sources.source(target.id);
    expect(preterminalSource).toBeDefined();
    expect(preterminalSource!.identity).not.toBe(attachmentLeafSource!.identity);
    const postterminal = claudeTerminalRecords(sessionId, 'assistant-1-final', 'valid', 'after');
    postterminal.push({ type: 'last-prompt', lastPrompt: 'omitted', leafUuid: 'ignored-wrong-session', sessionId: 'ffffffff-1111-4222-8333-444444444444' });
    await writeFile(transcript, `${[...initialRecords, finalAssistantFragment, ...postterminal].map(record => JSON.stringify(record)).join('\n')}\n`);
    const source = await sources.source(target.id);
    expect(source!.identity).not.toBe(preterminalSource!.identity);
    expect(source).toMatchObject({ kind: 'claude', model: { model: 'claude-opus-5-5', effort: 'high' } });
    expect(source!.messages).toEqual([
      { id: 'user:u1', role: 'user', text: 'I prefer the safer option.' },
      { id: 'assistant:a1', role: 'assistant', text: 'Should I use the reversible migration?' }
    ]);

    const generated = vi.fn(async () => [{ label: 'Use reversible', text: 'Use the reversible migration.' }]);
    const service = new ReplySuggestionService({
      source: async id => await sources.source(id),
      routeFingerprint: async () => 'claude-route',
      generate: generated
    });
    const sourceKey = await service.observe(target.id);
    expect(sourceKey).toBeTypeOf('string');
    const costState = {
      type: 'cost-state', sessionId, totalCostUSD: 0.01, totalAPIDuration: 100,
      totalAPIDurationWithoutRetries: 100, totalToolDuration: 0, totalLinesAdded: 0,
      totalLinesRemoved: 0, totalDuration: 120, startTime: 1,
      modelUsage: {
        'claude-opus-5-5': {
          inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.01
        }
      },
      hasUnknownModelCost: false
    };
    await appendFile(transcript, `${JSON.stringify(costState)}\n`);
    const costOnly = await sources.source(target.id);
    expect(costOnly!.identity).toBe(source!.identity);
    expect(await service.observe(target.id)).toBe(sourceKey);
    const expected = { status: 'ready', sourceKey: sourceKey!, suggestions: [{ label: 'Use reversible', text: 'Use the reversible migration.' }] };
    expect(await service.request(target.id, sourceKey!, () => true)).toEqual(expected);
    expect(await service.request(target.id, sourceKey!, () => true)).toEqual(expected);
    expect(generated).toHaveBeenCalledTimes(1);
    service.stop();

    setTimeout(() => {
      state = { ...state, heartbeatSeq: 2 };
      void observerState(observerDir, sessionId, state);
    }, 20);
    await expect(sources.validate(source!, new AbortController().signal)).resolves.toBe(true);

    await appendFile(transcript, `${JSON.stringify({
      type: 'assistant', uuid: 'assistant-2', parentUuid: 'terminal-valid', sessionId, session_id: sessionId,
      isSidechain: false, timestamp: '2026-11-15T12:00:01.100Z',
      message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'Would you like the rollback steps too?' }] }
    })}\n`);
    await expect(sources.source(target.id)).resolves.toBeUndefined();
    await appendFile(transcript, `${claudeTerminalRecords(sessionId, 'assistant-2', 'second').map(record => JSON.stringify(record)).join('\n')}\n`);
    const authored = await sources.source(target.id);
    expect(authored!.identity).not.toBe(costOnly!.identity);
    expect(authored!.messages.at(-1)?.text).toBe('Would you like the rollback steps too?');

    await appendFile(transcript, `${JSON.stringify({
      type: 'assistant', local_command_source: '<local-command-stdout>Effort set to low</local-command-stdout>',
      local_command_run: { command: 'effort' }, message: { id: 'local-2', role: 'assistant', content: [{ type: 'text', text: 'Effort set to low' }] }
    })}\n${JSON.stringify({
      type: 'assistant', local_command_source: '<local-command-stdout>Effort set to high</local-command-stdout>',
      local_command_run: { command: 'effort' }, message: { id: 'local-3', role: 'assistant', content: [{ type: 'text', text: 'Effort set to high' }] }
    })}\n`);
    const localAba = await sources.source(target.id);
    expect(localAba!.identity).not.toBe(authored!.identity);
    expect(localAba!.messages).toEqual(authored!.messages);
    expect(localAba!.model).toEqual(authored!.model);

    await appendFile(transcript, `${JSON.stringify({ type: 'future-selection-record', selectedEffort: 'high' })}\n`);
    const unknown = await sources.source(target.id);
    expect(unknown!.identity).not.toBe(localAba!.identity);

    const replacement = `${transcript}.replacement`;
    await writeFile(replacement, await readFile(transcript));
    await rename(replacement, transcript);
    const replaced = await sources.source(target.id);
    expect(replaced!.identity).not.toBe(unknown!.identity);

    const aborted = new AbortController();
    aborted.abort();
    await expect(sources.validate(source!, aborted.signal)).resolves.toBe(false);

    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5', effortLevel: 'high' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    await expect(tracker.settled()).resolves.toBe(true);
    const requalified = await sources.source(target.id);
    expect(requalified!.sourceGeneration).toBeGreaterThan(source!.sourceGeneration);
    expect(requalified!.model).toEqual(source!.model);

    state = { ...state, heartbeatSeq: 3, sourceEpoch: 3, effort: 'high' };
    await observerState(observerDir, sessionId, state);
    const aba = await sources.source(target.id);
    expect(aba!.model).toEqual(requalified!.model);
    expect(aba!.sourceGeneration).toBeGreaterThan(requalified!.sourceGeneration);

    await appendFile(transcript, '{malformed complete json}\n');
    await expect(sources.source(target.id)).resolves.toBeUndefined();

    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5', hooks: { SessionStart: [] } }));
    await new Promise(resolve => setTimeout(resolve, 30));
    await expect(tracker.settled()).resolves.toBe(false);
    await expect(sources.source(target.id)).resolves.toBeUndefined();
  });
});
