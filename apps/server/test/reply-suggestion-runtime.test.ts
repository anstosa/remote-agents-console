import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiReplySuggestionRuntime, piReplyRuntimeGeneration } from '../src/reply-suggestions/pi-runtime.js';
import type { PiReplySuggestionSource, ReplySuggestionSource } from '../src/reply-suggestions/types.js';
import { parseReplySuggestions } from '../src/reply-suggestions/validation.js';
import { claudeClient } from '../src/transports/claude.js';
import { StructuredAgents, type StructuredProcesses } from '../src/transports/structured-agents.js';
import type { LineChannel, StructuredConnection, StructuredEvent } from '../src/transports/structured.js';
import * as nativeScope from '../src/reply-suggestions/native-scope.js';

const directories: string[] = [];
const structuredAgents: StructuredAgents[] = [];

// mirror one nonsecret native launch and credential-file generation
const runtimeGeneration = (authorityFingerprint: string): string => {
  const state = '/private';
  const launch = createHash('sha256').update(JSON.stringify([process.execPath, process.execPath, state])).digest('base64url');
  return createHash('sha256').update(JSON.stringify([launch, authorityFingerprint])).digest('base64url');
};

// remove every isolated structured store
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(structuredAgents.splice(0).map(agents => agents.saved()));
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// create one controllable structured claude process
async function structuredClaudeFixture(withStartTime = true) {
  const directory = await mkdtemp(join(tmpdir(), 'rac-claude-reply-source-'));
  directories.push(directory);
  let emit: (event: StructuredEvent) => void = () => undefined;
  const connection: StructuredConnection = {
    deliver: vi.fn(async () => 'started'), newConversation: vi.fn(async () => true), switchConversation: vi.fn(async () => true), renameConversation: vi.fn(async () => true),
    compact: vi.fn(async () => undefined), models: vi.fn(async () => [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', efforts: ['high'] }]),
    setModel: vi.fn(async () => true), steer: vi.fn(async () => true), cancel: vi.fn(async () => []), answer: vi.fn(async () => true), close: vi.fn()
  };
  const processes: StructuredProcesses = {
    start: async (launch, events) => {
      emit = events;
      queueMicrotask(() => events({ type: 'report', report: { loaded: true, nonce: launch.nonce, sandbox: { engaged: false, reason: 'not sandboxed' }, version: 'test' } }));
      return { holder: { agentId: launch.id, socket: join(directory, 'holder.sock'), pane: '%2', pid: 4321, ...(withStartTime ? { startTime: '100' } : {}) }, connection };
    },
    attach: async () => undefined, stderr: async () => undefined, stop: async () => undefined
  };
  const agents = new StructuredAgents(processes, { file: join(directory, 'agents.json'), allowedModels: kind => kind === 'claude' ? [{ model: 'sonnet', effort: 'high' }] : undefined });
  structuredAgents.push(agents);
  const id = await agents.launch({ id: 'scratch:test', kind: 'scratch', projectId: 'scratch', label: 'Scratch', home: directory } as never, 'claude', { model: { model: 'sonnet', effort: 'high' } });
  expect(id).toBeDefined();
  await vi.waitFor(async () => expect((await agents.agent(id!))?.structured.lifecycle).toBe('live'));
  return { agents, id: id!, connection, emit: (event: StructuredEvent) => emit(event) };
}

// create one structured process driven by the real claude protocol client
async function nativeClaudeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rac-claude-native-reply-source-'));
  directories.push(directory);
  vi.stubEnv('RAC_CLAUDE_CONFIG_DIR', directory);
  const sent: Array<Record<string, any>> = [];
  let receive: (line: string) => void = () => undefined;
  let connection: StructuredConnection | undefined;
  const sessionId = '5473282c-2da5-4785-8dd4-9a885abe8453';
  const processes: StructuredProcesses = {
    start: async (launch, events) => {
      const channel: LineChannel = {
        send: line => sent.push(JSON.parse(line) as Record<string, any>),
        onLine: listener => { receive = listener; },
        onClose: () => undefined,
        close: () => undefined
      };
      connection = claudeClient(channel, events, { cwd: '/work/project', model: launch.model });
      queueMicrotask(() => {
        receive(JSON.stringify({ type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', stdout: `${JSON.stringify({ rac: launch.nonce })}\n`, session_id: sessionId }));
        const initialize = sent.find(record => record.type === 'control_request' && record.request?.subtype === 'initialize');
        // the client always sends initialize before the process is returned
        if (initialize === undefined) return;
        receive(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: initialize.request_id, response: {
          claude_code_version: '2.1.319', session_state: 'idle', models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['medium', 'high'] }]
        } } }));
      });
      return { holder: { agentId: launch.id, socket: join(directory, 'holder.sock'), pane: '%2', pid: 4321, startTime: '100' }, connection };
    },
    attach: async () => undefined, stderr: async () => undefined, stop: async () => undefined
  };
  const agents = new StructuredAgents(processes, { file: join(directory, 'agents.json'), allowedModels: kind => kind === 'claude' ? [{ model: 'sonnet', effort: 'medium' }] : undefined });
  structuredAgents.push(agents);
  const id = await agents.launch({ id: 'scratch:test', kind: 'scratch', projectId: 'scratch', label: 'Scratch', home: directory } as never, 'claude', { model: { model: 'sonnet', effort: 'high' } });
  expect(id).toBeDefined();
  await vi.waitFor(async () => expect((await agents.agent(id!))?.structured.lifecycle).toBe('live'));
  return { agents, id: id!, sent, receive: (event: Record<string, unknown>) => receive(JSON.stringify(event)), connection: connection! };
}

const claudeScope = { kind: 'claude' as const, program: '/usr/bin/claude', home: '/home/test', configDir: '/home/test/.claude', process: { pid: 4321, startTime: '100' }, fingerprint: 'claude-scope-1' };

const source: PiReplySuggestionSource = {
  kind: 'pi', transport: 'structured',
  agentId: 'agent-1', identity: 'source-1', sourceGeneration: 1, processGeneration: 1, runtimeGeneration: runtimeGeneration('account-generation-1'), conversationId: 'conversation-1',
  model: { model: 'openai/gpt-test', effort: 'high' },
  nativeModel: { provider: 'openai', id: 'gpt-test', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  messages: [{ id: 'u1', role: 'user', text: 'I need a safe rollout.' }, { id: 'a1', role: 'assistant', text: 'Should I use staging or production?' }]
};
const nativeModel = { id: 'openai/gpt-test', name: 'GPT test', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', efforts: ['high'] };

// build one real private pi credential scope
async function piCredentialFixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'rac-pi-reply-account-'));
  directories.push(stateDir);
  const authPath = join(stateDir, 'auth.json');
  await writeFile(authPath, '{"key":"account-a"}\n');
  await chmod(stateDir, 0o700);
  await chmod(authPath, 0o600);
  const adapter = { program: process.execPath, args: [], env: { PI_CODING_AGENT_DIR: stateDir }, launchable: true as const };
  const generation = await piReplyRuntimeGeneration(adapter);
  expect(generation).toBeDefined();
  return { adapter, authPath, source: { ...source, runtimeGeneration: generation! } };
}

// replace credential bytes without changing the legacy fingerprint fields
async function rewritePiCredential(authPath: string) {
  const [before, legacyBefore] = await Promise.all([lstat(authPath, { bigint: true }), lstat(authPath)]);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(authPath, '{"key":"account-b"}\n');
  await chmod(authPath, 0o600);
  await utimes(authPath, legacyBefore.atimeMs / 1e3, legacyBefore.mtimeMs / 1e3);
  const [after, legacyAfter] = await Promise.all([lstat(authPath, { bigint: true }), lstat(authPath)]);
  expect(legacyAfter.mtimeMs).toBe(legacyBefore.mtimeMs);
  expect(after.size).toBe(before.size);
  expect(after.ctimeNs).not.toBe(before.ctimeNs);
}

describe('reply suggestion validation', () => {
  it('accepts a bounded exact result including a grounded empty result', () => {
    expect(parseReplySuggestions('{"suggestions":[]}')).toEqual([]);
    expect(parseReplySuggestions('{"suggestions":[{"label":"Use staging","text":"Use staging so we can verify the migration first."}]}')).toEqual([
      { label: 'Use staging', text: 'Use staging so we can verify the migration first.' }
    ]);
  });

  it.each([
    '{"suggestions":[],"extra":true}',
    '{"suggestions":[{"label":"This label has four","text":"Draft"}]}',
    '{"suggestions":[{"label":"Choice","text":"Same"},{"label":"Again","text":" same "}]}',
    '{"suggestions":[{"label":"Choice","text":"Draft","extra":true}]}',
    '{"suggestions":[{"label":"Choice","text":"Bad\\u0000draft"}]}',
    '{"suggestions":[{"label":"Line\\nBreak","text":"Draft"}]}',
    '{"suggestions":[{"label":"Choice","text":"Bad\\rdraft"}]}'
  ])('rejects a malformed result as a whole', value => {
    expect(parseReplySuggestions(value)).toBeUndefined();
  });
});

describe('Pi reply suggestion runtime', () => {
  // build one successful exact stored-account runtime
  const fixture = (overrides: { authSource?: string; credentialType?: string; responseModel?: string; responseProvider?: string; authorityFingerprint?: () => string; program?: string } = {}) => {
    const completeSimple = vi.fn(async () => ({
      stopReason: 'stop', provider: overrides.responseProvider ?? 'openai', model: 'gpt-test', responseModel: overrides.responseModel ?? 'gpt-test',
      content: [{ type: 'text', text: '{"suggestions":[{"label":"Use staging","text":"Use staging first, then promote after verification."}]}' }]
    }));
    const runtime = {
      refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })), getError: () => undefined,
      getProviderAuthStatus: () => ({ configured: true, source: overrides.authSource ?? 'stored' }),
      listCredentials: vi.fn(async () => [{ providerId: 'openai', type: overrides.credentialType ?? 'api_key' }]),
      getPhysicalModel: () => ({ provider: 'openai', id: 'gpt-test', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }), completeSimple
    };
    const suggestions = new PiReplySuggestionRuntime({ program: overrides.program ?? process.execPath, args: [], env: { PI_CODING_AGENT_DIR: '/private' }, launchable: true }, undefined, {
      inspectAuthority: async () => ({ authPath: '/private/auth.json', fingerprint: overrides.authorityFingerprint?.() ?? 'account-generation-1' }), runtimeFactory: async () => runtime as never
    });
    return { suggestions, runtime, completeSimple };
  };

  it('uses the exact stored Agent login with no tools or continuation', async () => {
    const { suggestions, completeSimple } = fixture();
    const route = await suggestions.routeFingerprint(source);
    expect(route).toBeDefined();
    await expect(suggestions.generate(source, new AbortController().signal, route!)).resolves.toEqual([
      { label: 'Use staging', text: 'Use staging first, then promote after verification.' }
    ]);
    expect(completeSimple).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', id: 'gpt-test' }), expect.objectContaining({ tools: [] }), expect.objectContaining({ toolChoice: 'none', disableContinuation: true, maxTokens: 4_096, timeoutMs: 20_000, reasoning: 'high' }));
  });

  // reasoning models return private blocks beside the final reply JSON
  it('discards private reasoning while validating only the final text', async () => {
    const { suggestions, completeSimple } = fixture();
    completeSimple.mockResolvedValue({ stopReason: 'stop', provider: 'openai', model: 'gpt-test', responseModel: 'gpt-test', content: [
      { type: 'thinking', text: 'private provider reasoning' },
      { type: 'text', text: '{"suggestions":[{"label":"Use staging","text":"Use staging first."}]}' }
    ] });
    const route = await suggestions.routeFingerprint(source);
    expect(await suggestions.generate(source, new AbortController().signal, route!)).toEqual([{ label: 'Use staging', text: 'Use staging first.' }]);
  });

  // unexpected tool content still rejects the complete provider result
  it('rejects tool content even beside otherwise valid final text', async () => {
    const { suggestions, completeSimple } = fixture();
    completeSimple.mockResolvedValue({ stopReason: 'stop', provider: 'openai', model: 'gpt-test', responseModel: 'gpt-test', content: [
      { type: 'toolCall', text: 'not an executable path' },
      { type: 'text', text: '{"suggestions":[{"label":"Use staging","text":"Use staging first."}]}' }
    ] });
    const route = await suggestions.routeFingerprint(source);
    expect(await suggestions.generate(source, new AbortController().signal, route!)).toEqual([]);
  });

  it.each([{ authSource: 'environment' }, { credentialType: 'oauth' }])('rejects a credential outside the stored Agent api-key login', async override => {
    const { suggestions, completeSimple } = fixture(override);
    await expect(suggestions.routeFingerprint(source)).resolves.toBeUndefined();
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it.each([{ responseModel: 'gpt-fallback' }, { responseProvider: 'other' }])('hides a substituted provider response', async override => {
    const { suggestions } = fixture(override);
    const route = await suggestions.routeFingerprint(source);
    await expect(suggestions.generate(source, new AbortController().signal, route!)).resolves.toEqual([]);
  });

  it('refuses a changed route generation before dispatch', async () => {
    let generation = 'account-generation-1';
    const { suggestions, completeSimple } = fixture({ authorityFingerprint: () => generation });
    const route = await suggestions.routeFingerprint(source);
    generation = 'account-generation-2';
    await expect(suggestions.generate(source, new AbortController().signal, route!)).resolves.toEqual([]);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  // reject a replacement hidden from the legacy fingerprint
  it('invalidates an in-place credential rewrite even when size and mtime are restored', async () => {
    const { adapter, authPath, source: managedSource } = await piCredentialFixture();
    const { runtime, completeSimple } = fixture();
    const runtimeFactory = vi.fn(async () => runtime as never);
    const suggestions = new PiReplySuggestionRuntime(adapter, undefined, { runtimeFactory });
    const route = await suggestions.routeFingerprint(managedSource);
    expect(route).toBeDefined();

    await rewritePiCredential(authPath);

    await expect(suggestions.routeFingerprint(managedSource)).resolves.toBeUndefined();
    await expect(suggestions.generate(managedSource, new AbortController().signal, route!)).resolves.toEqual([]);
    expect(completeSimple).not.toHaveBeenCalled();
    const replacementGeneration = await piReplyRuntimeGeneration(adapter);
    await expect(suggestions.routeFingerprint({ ...managedSource, runtimeGeneration: replacementGeneration! })).resolves.toBeDefined();
    expect(runtimeFactory).toHaveBeenCalledTimes(2);
  });

  // ignore unrelated files beneath the managed pi state directory
  it('preserves the account generation when unrelated pi state is added', async () => {
    const { adapter, authPath, source: managedSource } = await piCredentialFixture();
    const { runtime } = fixture();
    const suggestions = new PiReplySuggestionRuntime(adapter, undefined, { runtimeFactory: async () => runtime as never });
    const route = await suggestions.routeFingerprint(managedSource);
    const generation = managedSource.runtimeGeneration;
    expect(route).toBeDefined();

    await mkdir(join(authPath, '..', 'sessions'));
    await writeFile(join(authPath, '..', 'sessions', 'active.json'), '{}\n');

    await expect(piReplyRuntimeGeneration(adapter)).resolves.toBe(generation);
    await expect(suggestions.routeFingerprint(managedSource)).resolves.toBe(route);
  });

  // recheck credential identity after the billed request
  it('suppresses a result when credentials are rewritten during inference', async () => {
    const { adapter, authPath, source: managedSource } = await piCredentialFixture();
    const { runtime, completeSimple } = fixture();
    // replace the account while inference is active
    completeSimple.mockImplementation(async () => {
      await rewritePiCredential(authPath);
      return {
        stopReason: 'stop', provider: 'openai', model: 'gpt-test', responseModel: 'gpt-test',
        content: [{ type: 'text', text: '{"suggestions":[{"label":"Use staging","text":"Use staging first."}]}' }]
      };
    });
    const suggestions = new PiReplySuggestionRuntime(adapter, undefined, { runtimeFactory: async () => runtime as never });
    const route = await suggestions.routeFingerprint(managedSource);
    expect(route).toBeDefined();

    await expect(suggestions.generate(managedSource, new AbortController().signal, route!)).resolves.toEqual([]);
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it('rejects a custom launch wrapper and a source from another login generation', async () => {
    const wrapped = fixture({ program: '/tmp/custom-pi-wrapper' });
    await expect(wrapped.suggestions.routeFingerprint(source)).resolves.toBeUndefined();
    const current = fixture();
    await expect(current.suggestions.routeFingerprint({ ...source, runtimeGeneration: 'another-login' })).resolves.toBeUndefined();
  });
});

// create one controllable structured Pi process
async function structuredFixture(replyRuntimeGeneration: string | null = 'structured-runtime-1', savedEffort?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'rac-reply-source-'));
  directories.push(directory);
  let emit: (event: StructuredEvent) => void = () => undefined;
  const models = vi.fn(async () => [nativeModel]);
  const connection: StructuredConnection = {
    deliver: async () => 'started', newConversation: async () => true, switchConversation: async () => true, renameConversation: async () => true,
    compact: async () => undefined,
    models,
    setModel: async () => true, steer: async () => true, cancel: async () => [], answer: async () => true, close: () => undefined
  };
  const processes: StructuredProcesses = {
    start: async (launch, events) => {
      emit = events;
      queueMicrotask(() => events({ type: 'report', report: { loaded: true, nonce: launch.nonce, sandbox: { engaged: false, reason: 'not sandboxed' }, version: 'test' } }));
      return { holder: { agentId: launch.id, socket: join(directory, 'holder.sock'), pane: '%1' }, connection, ...(replyRuntimeGeneration === null ? {} : { replyRuntimeGeneration }) };
    },
    attach: async () => undefined, stderr: async () => undefined, stop: async () => undefined
  };
  const agents = new StructuredAgents(processes, { file: join(directory, 'agents.json'), allowedModels: kind => kind === 'pi' ? [{ model: 'openai/gpt-test', ...(savedEffort === undefined ? {} : { effort: savedEffort }) }] : undefined });
  structuredAgents.push(agents);
  const id = await agents.launch({ id: 'scratch:test', kind: 'scratch', projectId: 'scratch', label: 'Scratch', home: directory } as never, 'pi');
  expect(id).toBeDefined();
  await vi.waitFor(async () => expect((await agents.agent(id!))?.structured.lifecycle).toBe('live'));
  return { agents, id: id!, models, emit: (event: StructuredEvent) => emit(event) };
}

describe('structured Pi reply source', () => {
  it('treats a saved effort as a launch default while accepting a different current effort', async () => {
    const { agents, id, emit } = await structuredFixture('structured-runtime-1', 'medium');
    emit({ type: 'conversation', id: 'conversation-1' });
    emit({ type: 'model', current: { model: 'openai/gpt-test', effort: 'high' }, native: nativeModel });
    emit({ type: 'history', conversationId: 'conversation-1', items: [{ id: 'a1', kind: 'message', role: 'assistant', text: 'Proceed?' }] });

    await vi.waitFor(async () => expect(await agents.replySuggestionSource(id)).toMatchObject({ kind: 'pi', model: { model: 'openai/gpt-test', effort: 'high' } }));
  });

  it('waits for matching history and ignores a replaced Conversation history', async () => {
    const { agents, id, models, emit } = await structuredFixture();
    emit({ type: 'conversation', id: 'conversation-1' });
    emit({ type: 'model', current: { model: 'openai/gpt-test', effort: 'high' }, native: nativeModel });
    expect(await agents.replySuggestionSource(id)).toBeUndefined();
    emit({ type: 'history', conversationId: 'conversation-1', items: [{ id: 'u1', kind: 'message', role: 'user', text: 'Help me deploy.' }, { id: 'a1', kind: 'message', role: 'assistant', text: 'Should I use staging or production?' }] });
    let first: ReplySuggestionSource | undefined;
    await vi.waitFor(async () => { first = await agents.replySuggestionSource(id); expect(first).toBeDefined(); });
    expect(first).toMatchObject({ agentId: id, conversationId: 'conversation-1', model: { model: 'openai/gpt-test', effort: 'high' }, nativeModel: { provider: 'openai', id: 'gpt-test', api: 'openai-responses' } });
    expect(first?.messages).toEqual([{ id: 'u1', role: 'user', text: 'Help me deploy.' }, { id: 'a1', role: 'assistant', text: 'Should I use staging or production?' }]);
    const guardCalls = models.mock.calls.length;
    models.mockImplementation(async () => await new Promise<never>(() => undefined));
    expect(await agents.replySuggestionSource(id)).toBeDefined();
    expect(models).toHaveBeenCalledTimes(guardCalls);

    emit({ type: 'conversation', id: 'conversation-2' });
    emit({ type: 'history', conversationId: 'conversation-1', items: [{ id: 'old', kind: 'message', role: 'assistant', text: 'Old question?' }] });
    expect(await agents.replySuggestionSource(id)).toBeUndefined();
    emit({ type: 'history', conversationId: 'conversation-2', items: [{ id: 'u2', kind: 'message', role: 'user', text: 'Use the new project.' }, { id: 'a2', kind: 'message', role: 'assistant', text: 'Which environment should I use?' }] });
    const replacement = await agents.replySuggestionSource(id);
    expect(replacement?.conversationId).toBe('conversation-2');
    expect(replacement?.identity).not.toBe(first?.identity);
    emit({ type: 'model', current: { model: 'openai/gpt-test', effort: 'high' } });
    expect(await agents.replySuggestionSource(id)).toBeUndefined();
  });

  it('withholds working and native-question sources', async () => {
    const { agents, id, emit } = await structuredFixture();
    emit({ type: 'conversation', id: 'conversation-1' });
    emit({ type: 'model', current: { model: 'openai/gpt-test' }, native: nativeModel });
    emit({ type: 'history', conversationId: 'conversation-1', items: [{ id: 'a1', kind: 'message', role: 'assistant', text: 'Proceed?' }] });
    await vi.waitFor(async () => expect(await agents.replySuggestionSource(id)).toBeDefined());
    const initial = await agents.replySuggestionSource(id);
    emit({ type: 'turn', turn: { type: 'started' } });
    expect(await agents.replySuggestionSource(id)).toBeUndefined();
    emit({ type: 'turn', turn: { type: 'settled', message: 'Proceed?' } });
    const settled = await agents.replySuggestionSource(id);
    expect(settled?.identity).not.toBe(initial?.identity);
    emit({ type: 'question', question: { id: 'q1', text: 'Allow?', permission: true, field: { kind: 'choice', choices: ['Allow', 'Block'] } } });
    expect(await agents.replySuggestionSource(id)).toBeUndefined();
    emit({ type: 'question-closed', id: 'q1' });
    expect((await agents.replySuggestionSource(id))?.identity).not.toBe(settled?.identity);
    emit({ type: 'exited' });
    expect(await agents.replySuggestionSource(id)).toBeUndefined();
  });

  it('uses live prose after a fresh empty history becomes ready', async () => {
    const { agents, id, emit } = await structuredFixture();
    emit({ type: 'conversation', id: 'conversation-1' });
    emit({ type: 'model', current: { model: 'openai/gpt-test' }, native: nativeModel });
    emit({ type: 'history', conversationId: 'conversation-1', items: [] });
    emit({ type: 'turn', turn: { type: 'started' } });
    emit({ type: 'transcript', item: { id: 'u1', kind: 'message', role: 'user', text: 'Help me choose.' } });
    emit({ type: 'transcript', item: { id: 'a1', kind: 'message', role: 'assistant', text: 'Use staging or production?' } });
    emit({ type: 'turn', turn: { type: 'settled', message: 'Use staging or production?' } });
    await vi.waitFor(async () => expect(await agents.replySuggestionSource(id)).toMatchObject({ conversationId: 'conversation-1', messages: [{ id: 'u1', role: 'user', text: 'Help me choose.' }, { id: 'a1', role: 'assistant', text: 'Use staging or production?' }] }));
  });

  it('withholds a process without current-console launch provenance', async () => {
    const { agents, id, emit } = await structuredFixture(null);
    emit({ type: 'conversation', id: 'conversation-1' });
    emit({ type: 'model', current: { model: 'openai/gpt-test' }, native: nativeModel });
    emit({ type: 'history', conversationId: 'conversation-1', items: [{ id: 'a1', kind: 'message', role: 'assistant', text: 'Proceed?' }] });
    expect(await agents.replySuggestionSource(id)).toBeUndefined();
  });
});

describe('structured Claude reply source', () => {
  it('qualifies live prose after the real client proves a fresh empty history epoch', async () => {
    vi.spyOn(nativeScope, 'nativeReplyScope').mockResolvedValue(claudeScope);
    const { agents, id, sent, receive, connection } = await nativeClaudeFixture();
    await vi.waitFor(() => expect(sent.some(record => record.type === 'control_request' && record.request?.subtype === 'initialize')).toBe(true));
    expect(await connection.deliver('Help me choose.')).toBe('started');
    const prompt = sent.at(-1)!;
    receive({ type: 'system', subtype: 'init', session_id: '5473282c-2da5-4785-8dd4-9a885abe8453', model: 'claude-sonnet-5-5', claude_code_version: '2.1.319' });
    receive({ type: 'assistant', parent_tool_use_id: null, uuid: 'a1', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Use staging or production?' }] } });
    receive({ type: 'result', subtype: 'success', is_error: false, result: 'Use staging or production?', total_cost_usd: 0.01, session_id: '5473282c-2da5-4785-8dd4-9a885abe8453', uuid: 'r1' });

    await vi.waitFor(async () => expect(await agents.replySuggestionSource(id)).toMatchObject({
      kind: 'claude', conversationId: '5473282c-2da5-4785-8dd4-9a885abe8453', model: { model: 'sonnet', effort: 'high' },
      messages: [{ id: prompt.uuid, role: 'user', text: 'Help me choose.' }, { id: 'a1:0', role: 'assistant', text: 'Use staging or production?' }]
    }));

    expect(await connection.deliver('/effort low')).toBe('started');
    receive({ type: 'result', subtype: 'success', is_error: false, result: 'Effort set to low', local_command: 'effort', total_cost_usd: 0.01, session_id: '5473282c-2da5-4785-8dd4-9a885abe8453', uuid: 'r2' });
    expect(await connection.deliver('Which environment now?')).toBe('started');
    receive({ type: 'system', subtype: 'init', session_id: '5473282c-2da5-4785-8dd4-9a885abe8453', model: 'claude-sonnet-5-5', claude_code_version: '2.1.319' });
    receive({ type: 'assistant', parent_tool_use_id: null, uuid: 'a2', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Staging or production?' }] } });
    receive({ type: 'result', subtype: 'success', is_error: false, result: 'Staging or production?', total_cost_usd: 0.01, session_id: '5473282c-2da5-4785-8dd4-9a885abe8453', uuid: 'r3' });
    expect(await agents.replySuggestionSource(id)).toBeUndefined();
  });

  it('uses the resolved native model and holder scope without active client RPCs', async () => {
    vi.spyOn(nativeScope, 'nativeReplyScope').mockResolvedValue(claudeScope);
    const { agents, id, connection, emit } = await structuredClaudeFixture();
    emit({ type: 'conversation', id: 'conversation-1' });
    emit({ type: 'model', current: { model: 'sonnet', effort: 'high' }, native: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', provider: 'anthropic', efforts: ['high'] } });
    emit({ type: 'history', conversationId: 'conversation-1', items: [{ id: 'u1', kind: 'message', role: 'user', text: 'Help me choose.' }, { id: 'a1', kind: 'message', role: 'assistant', text: 'Use staging or production?' }] });
    await vi.waitFor(async () => expect(await agents.replySuggestionSource(id)).toBeDefined());
    const calls = Object.fromEntries(Object.entries(connection).filter((entry): entry is [string, ReturnType<typeof vi.fn>] => typeof entry[1] === 'function' && 'mock' in entry[1]).map(([name, method]) => [name, method.mock.calls.length]));

    const source = await agents.replySuggestionSource(id);

    expect(source).toMatchObject({ kind: 'claude', transport: 'structured', model: { model: 'sonnet', effort: 'high' }, nativeModel: { id: 'claude-sonnet-5-5', provider: 'anthropic' }, nativeScope: claudeScope, runtimeGeneration: claudeScope.fingerprint });
    for (const [name, method] of Object.entries(connection)) {
      // source observation cannot call the active protocol client
      if (typeof method === 'function' && 'mock' in method) expect(method.mock.calls.length, name).toBe(calls[name]);
    }
  });

  it('fails closed when an idle-away-idle transition races native scope resolution', async () => {
    let resolveScope: (scope: typeof claudeScope) => void = () => undefined;
    vi.spyOn(nativeScope, 'nativeReplyScope').mockImplementation(async () => await new Promise(resolve => { resolveScope = resolve; }));
    const { agents, id, connection, emit } = await structuredClaudeFixture();
    emit({ type: 'conversation', id: 'conversation-1' });
    emit({ type: 'model', current: { model: 'sonnet', effort: 'high' }, native: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', provider: 'anthropic', efforts: ['high'] } });
    emit({ type: 'history', conversationId: 'conversation-1', items: [{ id: 'a1', kind: 'message', role: 'assistant', text: 'Proceed?' }] });
    await vi.waitFor(() => expect(connection.models).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 0));

    const pending = agents.replySuggestionSource(id);
    await vi.waitFor(() => expect(nativeScope.nativeReplyScope).toHaveBeenCalledOnce());
    emit({ type: 'turn', turn: { type: 'started' } });
    emit({ type: 'turn', turn: { type: 'settled', message: 'Proceed?' } });
    resolveScope(claudeScope);

    await expect(pending).resolves.toBeUndefined();
  });

  it('withholds restored or otherwise unknown Effort and missing holder lifetime proof', async () => {
    const scope = vi.spyOn(nativeScope, 'nativeReplyScope').mockResolvedValue(claudeScope);
    const { agents, id, emit } = await structuredClaudeFixture();
    emit({ type: 'conversation', id: 'conversation-1' });
    emit({ type: 'model', current: { model: 'sonnet' }, native: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', provider: 'anthropic', efforts: ['high'] } });
    emit({ type: 'history', conversationId: 'conversation-1', items: [{ id: 'a1', kind: 'message', role: 'assistant', text: 'Proceed?' }] });

    expect(await agents.replySuggestionSource(id)).toBeUndefined();
    expect(scope).not.toHaveBeenCalled();

    const missing = await structuredClaudeFixture(false);
    missing.emit({ type: 'conversation', id: 'conversation-2' });
    missing.emit({ type: 'model', current: { model: 'sonnet', effort: 'high' }, native: { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', provider: 'anthropic', efforts: ['high'] } });
    missing.emit({ type: 'history', conversationId: 'conversation-2', items: [{ id: 'a2', kind: 'message', role: 'assistant', text: 'Proceed?' }] });
    await vi.waitFor(() => expect(missing.connection.models).toHaveBeenCalled());
    expect(await missing.agents.replySuggestionSource(missing.id)).toBeUndefined();
    expect(scope).not.toHaveBeenCalled();
  });
});
