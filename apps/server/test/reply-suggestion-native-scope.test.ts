import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nativeReplyScope } from '../src/reply-suggestions/native-scope.js';

const roots: string[] = [];
const conversation = '11111111-1111-4111-8111-111111111111';

// remove every fake native process tree
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// build one parseable linux proc stat record
function procStat(pid: number, startTime: string): string {
  return `${pid} (native cli) ${['S', '1', ...Array.from({ length: 17 }, () => '0'), startTime].join(' ')}\n`;
}

// create one fake executable and process identity
async function fakeProcess(root: string, input: { pid: number; startTime: string; name: 'codex' | 'omx' | 'claude'; argv?: string[]; environment: Record<string, string>; children?: number[]; conversationId?: string; cwd?: string }) {
  const processRoot = join(root, 'proc', String(input.pid));
  const program = join(root, 'bin', `${input.name}-${input.pid}`, input.name);
  await mkdir(join(program, '..'), { recursive: true, mode: 0o700 });
  await writeFile(program, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(program, 0o700);
  await mkdir(join(processRoot, 'task', String(input.pid)), { recursive: true, mode: 0o700 });
  await mkdir(join(processRoot, 'fd'), { mode: 0o700 });
  await writeFile(join(processRoot, 'stat'), procStat(input.pid, input.startTime));
  await writeFile(join(processRoot, 'comm'), `${input.name}\n`);
  await writeFile(join(processRoot, 'cmdline'), `${(input.argv ?? [program]).join('\0')}\0`);
  await writeFile(join(processRoot, 'environ'), `${Object.entries(input.environment).map(([key, value]) => `${key}=${value}`).join('\0')}\0`);
  await writeFile(join(processRoot, 'task', String(input.pid), 'children'), `${(input.children ?? []).join(' ')}\n`);
  await symlink(program, join(processRoot, 'exe'));
  await symlink(input.cwd ?? input.environment.HOME ?? root, join(processRoot, 'cwd'));
  await symlink('/', join(processRoot, 'root'));
  // expose one exact open rollout identity
  if (input.conversationId !== undefined) await symlink(`/account/sessions/2026/rollout-test-${input.conversationId}.jsonl`, join(processRoot, 'fd', '77'));
  return program;
}

// create one fake home and native config directory
async function fakeHome(root: string, kind: 'codex' | 'claude') {
  const home = join(root, 'home');
  const config = join(home, kind === 'codex' ? '.codex' : '.claude');
  await mkdir(config, { recursive: true, mode: 0o700 });
  await writeFile(join(config, kind === 'codex' ? 'auth.json' : '.credentials.json'), '{}\n', { mode: 0o600 });
  return { home, config };
}

// allocate one isolated fake proc filesystem
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rac-native-scope-'));
  roots.push(root);
  await mkdir(join(root, 'proc'), { mode: 0o700 });
  return { root, environment: { RAC_HOST_PROC: join(root, 'proc') } as NodeJS.ProcessEnv };
}

describe('native reply process scope', () => {
  it('binds an exact Codex process, profile and conversation without secrets', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    const program = await fakeProcess(root, { pid: 101, startTime: '5001', name: 'codex', environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation });
    const scope = await nativeReplyScope('codex', { pid: 101, startTime: '5001' }, environment, conversation);
    expect(scope).toMatchObject({ kind: 'codex', program, home, configDir: config, process: { pid: 101, startTime: '5001' } });
    expect(scope?.fingerprint).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(JSON.stringify(scope)).not.toContain('secret');
  });

  it.each(['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'HTTPS_PROXY'])('rejects Codex environment override %s', async forbidden => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    await fakeProcess(root, { pid: 101, startTime: '5001', name: 'codex', environment: { HOME: home, CODEX_HOME: config, [forbidden]: 'secret-value' }, conversationId: conversation });
    expect(await nativeReplyScope('codex', { pid: 101, startTime: '5001' }, environment, conversation)).toBeUndefined();
  });

  it('rejects a replaced process and mismatched conversation', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    await fakeProcess(root, { pid: 101, startTime: '5002', name: 'codex', environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation });
    expect(await nativeReplyScope('codex', { pid: 101, startTime: '5001' }, environment, conversation)).toBeUndefined();
    expect(await nativeReplyScope('codex', { pid: 101, startTime: '5002' }, environment, '22222222-2222-4222-8222-222222222222')).toBeUndefined();
  });

  it('selects the unique conversation-matching Codex descendant beneath OMX', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    const wrapper = await fakeProcess(root, { pid: 201, startTime: '6001', name: 'omx', argv: ['/usr/bin/omx', '--direct'], environment: { HOME: home }, children: [202, 203] });
    const selected = await fakeProcess(root, { pid: 202, startTime: '6002', name: 'codex', environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation });
    await fakeProcess(root, { pid: 203, startTime: '6003', name: 'codex', environment: { HOME: home, CODEX_HOME: config }, conversationId: '22222222-2222-4222-8222-222222222222' });
    const scope = await nativeReplyScope('omx', { pid: 201, startTime: '6001' }, environment, conversation);
    expect(scope).toMatchObject({ kind: 'codex', program: selected, process: { pid: 202, startTime: '6002' } });
    expect(scope?.program).not.toBe(wrapper);
  });

  it('rejects ambiguous OMX descendants without a conversation fence', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    await fakeProcess(root, { pid: 201, startTime: '6001', name: 'omx', argv: ['/usr/bin/omx', '--direct'], environment: { HOME: home }, children: [202, 203] });
    await fakeProcess(root, { pid: 202, startTime: '6002', name: 'codex', environment: { HOME: home, CODEX_HOME: config } });
    await fakeProcess(root, { pid: 203, startTime: '6003', name: 'codex', environment: { HOME: home, CODEX_HOME: config } });
    expect(await nativeReplyScope('omx', { pid: 201, startTime: '6001' }, environment)).toBeUndefined();
  });

  it('rejects an OMX tree whose second matching Codex is beyond the process budget', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    await fakeProcess(root, { pid: 201, startTime: '6001', name: 'omx', argv: ['/usr/bin/omx', '--direct'], environment: { HOME: home }, children: [300, 202] });
    await fakeProcess(root, { pid: 202, startTime: '6002', name: 'codex', environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation });
    // place a second matching process after more descendants than the scanner permits
    for (let pid = 300; pid < 560; pid += 1) await fakeProcess(root, { pid, startTime: String(6_000 + pid), name: 'omx', environment: { HOME: home }, children: [pid === 559 ? 999 : pid + 1] });
    await fakeProcess(root, { pid: 999, startTime: '6999', name: 'codex', environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation });
    expect(await nativeReplyScope('omx', { pid: 201, startTime: '6001' }, environment, conversation)).toBeUndefined();
  });

  it('rejects an OMX tree with an unreadable children record', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    await fakeProcess(root, { pid: 201, startTime: '6001', name: 'omx', argv: ['/usr/bin/omx', '--direct'], environment: { HOME: home }, children: [300, 202] });
    await fakeProcess(root, { pid: 202, startTime: '6002', name: 'codex', environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation });
    await fakeProcess(root, { pid: 300, startTime: '6300', name: 'omx', environment: { HOME: home } });
    await rm(join(root, 'proc', '300', 'task', '300', 'children'));
    expect(await nativeReplyScope('omx', { pid: 201, startTime: '6001' }, environment, conversation)).toBeUndefined();
  });

  it('binds the exact Claude profile and rejects environment credentials', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'claude');
    const program = await fakeProcess(root, { pid: 301, startTime: '7001', name: 'claude', environment: { HOME: home, CLAUDE_CONFIG_DIR: config } });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toMatchObject({ kind: 'claude', program, home, configDir: config });
    await writeFile(join(root, 'proc', '301', 'environ'), `HOME=${home}\0CLAUDE_CONFIG_DIR=${config}\0ANTHROPIC_AUTH_TOKEN=secret\0`);
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeUndefined();
  });

  it.each(['--safe-mode', '-p', '--print', '--bg', '--background', '--cloud', '--teleport', '--from-pr', '--remote-control'])('rejects tmux Claude mode %s', async mode => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'claude');
    const program = join(root, 'bin', 'claude-301', 'claude');
    await fakeProcess(root, { pid: 301, startTime: '7001', name: 'claude', argv: [program, mode], environment: { HOME: home, CLAUDE_CONFIG_DIR: config } });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeUndefined();
  });

  it('accepts only the managed structured Claude stream mode', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'claude');
    const program = join(root, 'bin', 'claude-301', 'claude');
    await fakeProcess(root, {
      pid: 301, startTime: '7001', name: 'claude',
      argv: [program, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio'],
      environment: { HOME: home, CLAUDE_CONFIG_DIR: config }
    });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment, undefined, 'structured')).toMatchObject({ kind: 'claude', program });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeUndefined();
  });

  it.each(['CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_CLOUD_SESSION_ID', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS'])('rejects native Claude session environment %s', async forbidden => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'claude');
    await fakeProcess(root, { pid: 301, startTime: '7001', name: 'claude', environment: { HOME: home, CLAUDE_CONFIG_DIR: config, [forbidden]: 'present' } });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeUndefined();
  });

  it('rejects a background Claude session kind', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'claude');
    await fakeProcess(root, { pid: 301, startTime: '7001', name: 'claude', environment: { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_KIND: 'background' } });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeUndefined();
  });

  it.each([
    ['profile', ['-p', 'alternate']],
    ['compact profile', ['-palternate']],
    ['remote server', ['--remote', 'wss://example.invalid']],
    ['local provider', ['--oss', '--local-provider', 'ollama']],
    ['provider config', ['-c', 'model_provider="synthetic"']],
    ['compact provider config', ['-cmodel_provider="synthetic"']]
  ])('rejects Codex source argv %s', async (_label, args) => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    const program = join(root, 'bin', 'codex-101', 'codex');
    await fakeProcess(root, { pid: 101, startTime: '5001', name: 'codex', argv: [program, ...args], environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation });
    expect(await nativeReplyScope('codex', { pid: 101, startTime: '5001' }, environment, conversation)).toBeUndefined();
  });

  it('allows only routing-neutral Codex config overrides', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    const program = join(root, 'bin', 'codex-101', 'codex');
    await fakeProcess(root, {
      pid: 101, startTime: '5001', name: 'codex',
      argv: [program, '-c', 'model_reasoning_effort="xhigh"', '--config=check_for_update_on_startup=false', '-c', 'model_instructions_file="/safe/instructions"'],
      environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation
    });
    expect(await nativeReplyScope('codex', { pid: 101, startTime: '5001' }, environment, conversation)).toBeDefined();
  });

  it.each([
    ['provider selection', 'model_provider = "synthetic"\n'],
    ['provider table', '[model_providers.synthetic]\nbase_url = "https://example.invalid"\n'],
    ['endpoint override', 'openai_base_url = "https://example.invalid"\n'],
    ['default profile', 'profile = "alternate"\n'],
    ['credential store', 'cli_auth_credentials_store = "keyring"\n']
  ])('rejects Codex source config %s', async (_label, configText) => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    await writeFile(join(config, 'config.toml'), configText, { mode: 0o600 });
    await fakeProcess(root, { pid: 101, startTime: '5001', name: 'codex', environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation });
    expect(await nativeReplyScope('codex', { pid: 101, startTime: '5001' }, environment, conversation)).toBeUndefined();
  });

  it('binds safe Codex config and workspace routing generations', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'codex');
    const project = join(root, 'project');
    await mkdir(join(project, '.codex'), { recursive: true, mode: 0o700 });
    await writeFile(join(config, 'config.toml'), 'model = "gpt-native"\ncli_auth_credentials_store = "file"\n', { mode: 0o600 });
    await writeFile(join(project, '.codex', 'config.toml'), 'model_reasoning_effort = "high"\n', { mode: 0o600 });
    await fakeProcess(root, { pid: 101, startTime: '5001', name: 'codex', cwd: project, environment: { HOME: home, CODEX_HOME: config }, conversationId: conversation });
    const before = await nativeReplyScope('codex', { pid: 101, startTime: '5001' }, environment, conversation);
    expect(before).toBeDefined();
    await writeFile(join(project, '.codex', 'config.toml'), 'model_reasoning_effort = "xhigh"\n', { mode: 0o600 });
    const after = await nativeReplyScope('codex', { pid: 101, startTime: '5001' }, environment, conversation);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
    await writeFile(join(project, '.codex', 'config.toml'), 'model_provider = "synthetic"\n', { mode: 0o600 });
    expect(await nativeReplyScope('codex', { pid: 101, startTime: '5001' }, environment, conversation)).toBeUndefined();
  });

  it.each([
    ['api helper', { apiKeyHelper: '/secret/helper' }],
    ['endpoint env', { env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } }],
    ['cloud provider', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }],
    ['gateway login', { forceLoginGatewayUrl: 'https://example.invalid' }]
  ])('rejects Claude user setting %s', async (_label, settings) => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'claude');
    await writeFile(join(config, 'settings.json'), `${JSON.stringify(settings)}\n`, { mode: 0o600 });
    await fakeProcess(root, { pid: 301, startTime: '7001', name: 'claude', environment: { HOME: home, CLAUDE_CONFIG_DIR: config } });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeUndefined();
  });

  it('scans explicit and effective Claude workspace settings only', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'claude');
    const project = join(root, 'project');
    const explicit = join(root, 'hooks.json');
    await mkdir(join(project, '.claude'), { recursive: true, mode: 0o700 });
    await writeFile(join(config, 'settings.json'), '{"env":{"DISABLE_AUTOUPDATER":"1"}}\n', { mode: 0o600 });
    await writeFile(join(project, '.claude', 'settings.local.json'), '{"env":{"ANTHROPIC_API_KEY":"secret"}}\n', { mode: 0o600 });
    await writeFile(explicit, '{"hooks":{"SessionStart":[]}}\n', { mode: 0o600 });
    const program = join(root, 'bin', 'claude-301', 'claude');
    await fakeProcess(root, { pid: 301, startTime: '7001', name: 'claude', cwd: project, argv: [program, '--settings', explicit], environment: { HOME: home, CLAUDE_CONFIG_DIR: config } });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeUndefined();
    await writeFile(join(project, '.claude', 'settings.local.json'), '{"env":{"DISABLE_AUTOUPDATER":"1"}}\n', { mode: 0o600 });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeDefined();
    await writeFile(explicit, '{"apiKeyHelper":"/secret/helper"}\n', { mode: 0o600 });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeUndefined();
  });

  it('honors Claude setting-source exclusions and rejects inline routing', async () => {
    const { root, environment } = await fixture();
    const { home, config } = await fakeHome(root, 'claude');
    const project = join(root, 'project');
    await mkdir(join(project, '.claude'), { recursive: true, mode: 0o700 });
    await writeFile(join(config, 'settings.json'), '{"env":{"DISABLE_AUTOUPDATER":"1"}}\n', { mode: 0o600 });
    await writeFile(join(project, '.claude', 'settings.json'), '{"apiKeyHelper":"ignored-by-source-selection"}\n', { mode: 0o600 });
    const program = join(root, 'bin', 'claude-301', 'claude');
    await fakeProcess(root, { pid: 301, startTime: '7001', name: 'claude', cwd: project, argv: [program, '--setting-sources', 'user'], environment: { HOME: home, CLAUDE_CONFIG_DIR: config } });
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeDefined();
    await writeFile(join(root, 'proc', '301', 'cmdline'), `${program}\0--setting-sources\0user\0--settings\0{"env":{"ANTHROPIC_AUTH_TOKEN":"secret"}}\0`);
    expect(await nativeReplyScope('claude', { pid: 301, startTime: '7001' }, environment)).toBeUndefined();
  });
});
