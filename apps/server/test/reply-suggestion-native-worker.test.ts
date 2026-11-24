import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeArguments, codexCachedCatalog, codexConfig, nativeConversation, supportsClaudeReplyVersion, supportsCodexReplyVersion } from '../src/reply-suggestions/native-policy.js';
import type { NativeReplySuggestionSource, NativeReplyScope } from '../src/reply-suggestions/types.js';
import { claudeSessionPersistence, claudeSessionPostflight, CodexAudit, codexGenerationPolicy, codexMetadataStderr, codexStartupStderr, parseClaudeStream } from '../src/reply-suggestions/native-worker.js';
import { tmpdir } from 'node:os';

const roots: string[] = [];

// remove isolated history fixtures
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const scope: NativeReplyScope = {
  kind: 'claude', program: '/native/claude', home: '/home/test', configDir: '/home/test/.claude',
  process: { pid: 301, startTime: '7001' }, fingerprint: 'scope-claude-1'
};

const claude: NativeReplySuggestionSource = {
  kind: 'claude', transport: 'tmux', agentId: 'claude-1', identity: 'turn-1', sourceGeneration: 1, processGeneration: 1,
  runtimeGeneration: 'runtime-1', conversationId: '11111111-1111-4111-8111-111111111111',
  model: { model: 'claude-native', effort: 'high' }, nativeModel: { provider: 'anthropic', id: 'claude-native' }, nativeScope: scope,
  messages: [{ id: 'a1', role: 'assistant', text: 'Use staging or production?' }]
};

const answer = '{"suggestions":[{"label":"Use staging","text":"Use staging first."}]}';

// build one exact Codex native source
function codexSource(): NativeReplySuggestionSource {
  return {
    ...claude, kind: 'codex', model: { model: 'gpt-native', effort: 'xhigh' },
    nativeModel: { provider: 'openai', id: 'gpt-native' }, nativeScope: { ...scope, kind: 'codex' }
  };
}

// build a local feature inventory of the requested size
function codexFeatureOutput(count = 215): string {
  return `${Array.from({ length: count }, (_, index) => `feature_${index} stable false`).join('\n')}\n`;
}

const cachedCodexModel = {
  slug: 'gpt-native', display_name: 'GPT Native', description: 'metadata', supported_reasoning_levels: [{ effort: 'xhigh' }],
  shell_type: 'local', apply_patch_tool_type: 'function', experimental_supported_tools: ['shell'], supports_search_tool: true
};

// encode one native stream record list
function stream(...events: object[]): Buffer {
  return Buffer.from(`${events.map(event => JSON.stringify(event)).join('\n')}\n`);
}

// build the exact successful no-tool Claude stream
function validStream(overrides: { model?: string; result?: string; assistantContent?: object[]; rateStatus?: string } = {}): Buffer {
  const model = overrides.model ?? 'claude-native';
  const result = overrides.result ?? answer;
  return stream(
    { type: 'system', subtype: 'ui_invalidate' },
    { type: 'system', subtype: 'init', model, cwd: '/empty', tools: [], mcp_servers: [], skills: [], slash_commands: [], permissionMode: 'dontAsk' },
    { type: 'assistant', message: { model, content: overrides.assistantContent ?? [{ type: 'thinking', thinking: 'discard me' }, { type: 'text', text: result }], usage: { server_tool_use: {} } } },
    { type: 'rate_limit_event', rate_limit_info: { status: overrides.rateStatus ?? 'allowed' } },
    { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result, modelUsage: { [model]: { inputTokens: 1 } }, model_usage_since_last_result: { [model]: { inputTokens: 1 } }, permission_denials: [], safety_stops: [], errors: [] }
  );
}

describe('native worker policies', () => {
  // admit the minimum release and newer native versions without requiring an exact pin
  it.each(['0.169.0', '0.171.0', '0.171.0+build.1', '0.172.0-beta.1', '1.0.0'])('supports Codex %s', version => {
    expect(supportsCodexReplyVersion(`codex-cli ${version}`)).toBe(true);
  });

  // require a valid native version at or above the floor
  it.each(['codex-cli 0.168.99', 'codex-cli 0.169.0-beta.1', 'codex-cli 0.171', 'codex-cli 0.171.0 extra', 'other-cli 0.171.0', ''])('rejects unsupported banner %j', banner => {
    expect(supportsCodexReplyVersion(banner)).toBe(false);
  });

  // admit newer claude releases without relaxing the native banner check
  it.each(['2.1.311', '2.1.319', '2.1.319+build.1', '2.2.0-beta.1', '3.0.0'])('supports Claude Code %s', version => {
    expect(supportsClaudeReplyVersion(`${version} (Claude Code)`)).toBe(true);
  });

  // reject older releases and banners without an exact claude identity
  it.each(['2.1.310 (Claude Code)', '2.1.311-beta.1 (Claude Code)', '2.1 (Claude Code)', '2.1.319', '2.1.319 (Other Code)', '2.1.319 (Claude Code) extra', ''])('rejects unsupported Claude banner %j', banner => {
    expect(supportsClaudeReplyVersion(banner)).toBe(false);
  });

  // generation derives its policy from local metadata as the inventory grows
  it.each([215, 224, 230])('prepares a local-only Codex policy from %i discovered features', count => {
    const output = codexFeatureOutput(count).replace('feature_0 stable false', 'guardianv2.thread_context  under development  true');
    const policy = codexGenerationPolicy(codexSource(), cachedCodexModel, output, Buffer.alloc(0), '/tmp/helper');
    expect(policy?.features).toHaveLength(count);
    expect(policy?.features).toContain('guardianv2.thread_context');
    expect(policy?.catalog).toMatchObject({ models: [{ slug: 'gpt-native', shell_type: 'disabled', experimental_supported_tools: [], supports_search_tool: false }] });
  });

  // no remote fallback repairs an invalid local feature or catalog gate
  it('rejects incomplete Codex generation metadata locally', () => {
    expect(codexGenerationPolicy(codexSource(), cachedCodexModel, codexFeatureOutput(214), Buffer.alloc(0), '/tmp/helper')).toBeUndefined();
    expect(codexGenerationPolicy(codexSource(), cachedCodexModel, '', Buffer.alloc(0), '/tmp/helper')).toBeUndefined();
    expect(codexGenerationPolicy(codexSource(), cachedCodexModel, `${codexFeatureOutput()}feature_0 stable true\n`, Buffer.alloc(0), '/tmp/helper')).toBeUndefined();
    expect(codexGenerationPolicy(codexSource(), cachedCodexModel, `${codexFeatureOutput()}new_feature stable\n`, Buffer.alloc(0), '/tmp/helper')).toBeUndefined();
    expect(codexGenerationPolicy(codexSource(), { ...cachedCodexModel, slug: 'fallback' }, codexFeatureOutput(), Buffer.alloc(0), '/tmp/helper')).toBeUndefined();
    expect(codexGenerationPolicy(codexSource(), cachedCodexModel, codexFeatureOutput(), Buffer.from('unexpected stderr'), '/tmp/helper')).toBeUndefined();
  });

  // disabling every feature emits this exact inert native diagnostic in the pinned version
  it('allows only the exact disabled multiagent deprecation diagnostic', () => {
    const line = '\u001b[2m2026-11-15T16:11:11.546028Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_app_server\u001b[0m\u001b[2m:\u001b[0m `[features].multi_agent` is deprecated. It still controls the V1 fallback. `[agents].enabled = false` disables subagent tools even when the model selects a subagent version, unless `[features].multi_agent_v2` is enabled.';
    expect(codexStartupStderr(Buffer.from(line), '/tmp/helper')).toBe(true);
    expect(codexMetadataStderr(Buffer.from(line), '/tmp/helper')).toBe(false);
    expect(codexStartupStderr(Buffer.from(`${line} other failure`), '/tmp/helper')).toBe(false);
    expect(codexStartupStderr(Buffer.from('ERROR codex_app_server: different failure'), '/tmp/helper')).toBe(false);
  });

  // valid json syntax cannot disguise invalid encoded model text
  it('rejects invalid utf8 in native Claude output', () => {
    expect(() => parseClaudeStream(Buffer.concat([validStream(), Buffer.from([0xc3, 0x28])]), claude, '/empty')).toThrow();
  });

  // only the exact known no-alias warning is harmless in a temporary native home
  it('accepts the pinned Codex temporary alias warning but no other stderr', () => {
    const root = `${tmpdir()}/rac-native-codex-test`;
    const warning = `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir ${JSON.stringify(tmpdir())} (codex_home: AbsolutePathBuf(${JSON.stringify(root)}))\n`;
    expect(codexMetadataStderr(Buffer.from(warning), root)).toBe(true);
    expect(codexMetadataStderr(Buffer.alloc(0), root)).toBe(true);
    expect(codexMetadataStderr(Buffer.from(`${warning}other warning`), root)).toBe(false);
    expect(codexMetadataStderr(Buffer.from(warning), `${root}-other`)).toBe(false);
  });

  // only the pinned inert protocol can publish a native final answer
  it('accepts supported inert Codex notifications and exactly one final answer', () => {
    const audit = new CodexAudit();
    // metadata notifications never become prompt or reply text
    for (const method of ['account/rateLimits/updated', 'account/updated', 'configWarning', 'deprecationNotice', 'remoteControl/status/changed', 'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated', 'turn/started', 'turn/moderationMetadata', 'warning', 'item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryPartAdded']) audit.consume({ method, params: {} });
    audit.consume({ method: 'item/started', params: { item: { type: 'reasoning' } } });
    audit.consume({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text: answer } } });
    audit.consume({ method: 'turn/completed', params: { turn: { status: 'completed', error: null } } });
    expect(audit.result()).toMatchObject({ terminalStatus: 'completed', finalText: answer, finalAnswerCount: 1, toolEvents: 0, errorEvents: 0 });
    expect(() => audit.consume({ method: 'turn/completed', params: { turn: { status: 'completed' } } })).toThrow('codex_duplicate_terminal');
  });

  // unknown notifications and native callbacks fail before any effect handler
  it.each([
    { method: 'totally/new-effect', params: {} },
    { method: 'item/new-capability', params: {} },
    { method: 'item/started', params: { item: { type: 'commandExecution' } } },
    { method: 'permission/request', id: 10, params: {} },
    { method: 'turn/completed', params: { turn: { status: 'failed', error: {} } } }
  ])('rejects unproved Codex event $method', event => {
    expect(() => new CodexAudit().consume(event)).toThrow();
  });

  it('accepts one exact Claude final result while discarding private thinking', () => {
    expect(parseClaudeStream(validStream(), claude, '/empty')).toEqual({
      finalText: answer, finalAnswerCount: 1, toolEvents: 0, rerouteEvents: 0, serverRequests: 0, errorEvents: 0
    });
  });

  it.each([
    ['tool block', { assistantContent: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: answer }] }],
    ['model reroute', { model: 'claude-fallback' }],
    ['quota denial', { rateStatus: 'rejected' }],
    ['schema mismatch', { result: '{"suggestions":[],"extra":true}' }]
  ])('rejects Claude %s', (_label, override) => {
    expect(() => parseClaudeStream(validStream(override), claude, '/empty')).toThrow();
  });

  it('uses text JSON rather than the unsupported Claude json-schema flag', () => {
    const selectedAlias = { ...claude, model: { model: 'default', effort: 'high' } };
    const args = claudeArguments(selectedAlias, '/private/empty-mcp.json', '11111111-1111-4111-8111-111111111111');
    expect(args).toEqual(expect.arrayContaining(['--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--model', 'claude-native', '--effort', 'high']));
    expect(args).not.toContain('--json-schema');
    expect(args).not.toContain('Use staging or production?');
  });

  // force every discovered feature off without pinning the inventory size
  it.each([215, 224, 230])('builds a %i-feature false Codex policy with no provider override', count => {
    const codex = codexSource();
    const features = ['guardianv2.thread_context', ...Array.from({ length: count - 1 }, (_, index) => `feature_${index}`)];
    const config = codexConfig(codex, '/private/catalog.json', features);
    expect(config).toContain('model_provider = "openai"');
    expect(config).toContain('[agents]\nenabled = false');
    expect(config).not.toContain('base_url');
    expect(config).not.toContain('env_key');
    const featureSection = config?.split('[features]\n')[1]?.split('\n\n[tools.')[0]?.split('\n').filter(Boolean);
    expect(featureSection).toHaveLength(count);
    // require every discovered feature to be disabled
    for (const feature of features) expect(featureSection).toContain(`"${feature}" = false`);
  });

  // a short inventory cannot generate a supposedly capability-neutral config
  it('rejects a well-formed feature inventory below the baseline', () => {
    const features = Array.from({ length: 214 }, (_, index) => `feature_${index}`);
    expect(codexConfig(codexSource(), '/private/catalog.json', features)).toBeUndefined();
  });

  // meet the size floor so each invalid key exercises its own validation
  it.each(['feature_0', 'not a name', 'guardianv2..thread_context'])('rejects invalid feature key %s in a full inventory', key => {
    const features = [...Array.from({ length: 215 }, (_, index) => `feature_${index}`), key];
    expect(codexConfig(codexSource(), '/private/catalog.json', features)).toBeUndefined();
  });

  it('sanitizes every Codex model capability while preserving metadata', () => {
    const codex = codexSource();
    const catalog = codexCachedCatalog(codex, {
      slug: 'gpt-native', display_name: 'GPT Native', description: 'metadata', supported_reasoning_levels: [{ effort: 'xhigh' }],
      shell_type: 'local', apply_patch_tool_type: 'function', experimental_supported_tools: ['shell'], supports_search_tool: true,
      web_search_tool_type: 'web', multi_agent_version: 'v2'
    }) as { models: Array<Record<string, unknown>> };
    expect(catalog.models[0]).toMatchObject({ display_name: 'GPT Native', description: 'metadata', shell_type: 'disabled', apply_patch_tool_type: null, experimental_supported_tools: [], supports_search_tool: false, node_repl_disabled: true });
    expect(catalog.models[0]).not.toHaveProperty('web_search_tool_type');
    expect(catalog.models[0]).not.toHaveProperty('multi_agent_version');
  });

  it('copies only bounded conversation messages into inert json data', () => {
    const prompt = nativeConversation(claude.messages);
    expect(prompt).toContain('<conversation_json>');
    expect(prompt).toContain('Use staging or production?');
    expect(nativeConversation([{ id: 'too-large', role: 'user', text: 'x'.repeat(70 * 1024) }])).toBeUndefined();
  });
});

describe('claude helper history postflight', () => {
  // create one isolated profile tree
  async function profile(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'rac-claude-history-'));
    roots.push(root);
    return root;
  }

  it('distinguishes a clean profile from one persisted helper session', async () => {
    const root = await profile();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    await mkdir(join(root, 'projects'), { mode: 0o700 });
    await expect(claudeSessionPersistence(root, sessionId)).resolves.toBe('clean');
    await expect(claudeSessionPostflight(root, sessionId)).resolves.toBeUndefined();
    await writeFile(join(root, 'projects', `session-${sessionId}.jsonl`), '{}\n', { mode: 0o600 });
    await expect(claudeSessionPersistence(root, sessionId)).resolves.toBe('persisted');
    await expect(claudeSessionPostflight(root, sessionId)).rejects.toThrow('claude_postflight_failed');
  });

  it.each(['root', 'subtree'] as const)('treats an unreadable history %s as indeterminate', async target => {
    const root = await profile();
    const unreadable = target === 'root' ? root : join(root, 'projects');
    // isolate root and subtree failures with the same assertion
    if (target === 'subtree') await mkdir(unreadable, { mode: 0o700 });
    await chmod(unreadable, 0o000);
    try {
      const sessionId = '11111111-1111-4111-8111-111111111111';
      await expect(claudeSessionPersistence(root, sessionId)).resolves.toBe('indeterminate');
      await expect(claudeSessionPostflight(root, sessionId)).rejects.toThrow('claude_postflight_failed');
    } finally {
      // restore cleanup access after the failure check
      await chmod(unreadable, 0o700);
    }
  });

  it('treats a session beyond the traversal budget as indeterminate', async () => {
    const root = await profile();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    // exceed the bounded directory budget with deterministic names
    for (let index = 0; index < 4_097; index += 1) await mkdir(join(root, `history-${String(index).padStart(4, '0')}`), { mode: 0o700 });
    await writeFile(join(root, 'history-0000', `session-${sessionId}.jsonl`), '{}\n', { mode: 0o600 });
    await expect(claudeSessionPersistence(root, sessionId)).resolves.toBe('indeterminate');
    await expect(claudeSessionPostflight(root, sessionId)).rejects.toThrow('claude_postflight_failed');
  });
});
