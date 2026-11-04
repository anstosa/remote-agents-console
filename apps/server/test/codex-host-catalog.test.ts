import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexProtocolClient } from '../src/accounts/protocol.js';
import type { AdapterLaunchConfig } from '../src/adapters/types.js';
import { probeCodexCatalog, type OmxCatalogProbe } from '../src/launch/omx-catalog.js';
import { LaunchOptionsService } from '../src/launch/options.js';

const directories: string[] = [];

// restore host seams and remove isolated descriptor roots
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // remove every temporary transport checkout
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// create one native Codex model record
function nativeModel(id: string, efforts = ['low', 'high'], defaultEffort = 'high', isDefault = false) {
  return { model: id, displayName: `Model ${id}`, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: defaultEffort, isDefault };
}

// create one complete host probe result
function hostProbe(overrides: Partial<OmxCatalogProbe> = {}): OmxCatalogProbe {
  return {
    version: 1,
    config: { config: { model: 'openai/gpt-4', model_reasoning_effort: 'high' } },
    pages: [{ data: [nativeModel('openai/gpt-4', ['low', 'high'], 'high', true)], nextCursor: null }],
    args: ['--profile', 'team'],
    capabilities: { model: true, effort: true },
    identity: 'codex-host-fixture',
    ...overrides
  };
}

// create the exact bridged Codex launch configuration
function codexConfig(overrides: Partial<AdapterLaunchConfig> = {}): AdapterLaunchConfig {
  return {
    program: '/host/tools/codex',
    args: ['--profile', 'team'],
    env: { CODEX_HOME: '/host/accounts/team/.codex', CODEX_PRIVATE_TOKEN: 'codex-secret' },
    launchable: true,
    ...overrides
  };
}

// find one kind without relying on response ordering
function manifest(response: Awaited<ReturnType<LaunchOptionsService['list']>>, kind: 'codex' | 'omx') {
  const found = response.kinds.find(candidate => candidate.kind === kind);
  if (found === undefined) throw new Error(`missing ${kind} fixture manifest`);
  return found;
}

describe('bridged Codex catalog projection', () => {
  // isolate Codex from its OMX sibling while projecting all native metadata and defaults
  it('uses the exact Codex host context and publishes the eight-model native catalog', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/run/host-tmux');
    const codex = codexConfig();
    const omx = { program: '/host/tools/omx', args: ['--profile', 'omx-team'], env: { OMX_ONLY: 'omx-secret' }, launchable: true };
    const models = Array.from({ length: 8 }, (_value, index) => nativeModel(`openai/gpt-${index + 1}`, index === 7 ? ['low', 'high', 'xhigh'] : ['low', 'high'], index === 7 ? 'xhigh' : 'high', index === 3));
    const codexProbe = vi.fn(async () => hostProbe({
      config: { config: { model: 'openai/gpt-4', model_reasoning_effort: 'high', private_key: 'native-secret' } },
      pages: [
        { data: models.slice(0, 4), nextCursor: 'page-2' },
        { data: models.slice(4), nextCursor: null }
      ]
    }));
    const omxProbe = vi.fn(async () => hostProbe({ identity: 'omx-sibling' }));
    const createCodexClient = vi.fn();
    const context = { cwd: '/console/worktree', hostCwd: '/host/worktree', home: '/host/accounts/team' };
    const service = new LaunchOptionsService({ codex, omx }, { codexHostProbe: codexProbe, omxProbe, createCodexClient });

    const response = await service.list(context);
    const codexManifest = manifest(response, 'codex');

    expect(codexProbe).toHaveBeenCalledOnce();
    expect(codexProbe).toHaveBeenCalledWith(codex, context, 5_000);
    expect(codexProbe.mock.calls[0]?.[0]).not.toBe(omx);
    expect(omxProbe).toHaveBeenCalledWith(omx, context, 5_000);
    expect(createCodexClient).not.toHaveBeenCalled();
    expect(codexManifest.modelPolicy).toMatchObject({
      state: 'native-default',
      defaultSelection: { mode: 'model', id: 'openai/gpt-4' },
      allowed: [{ model: 'openai/gpt-4', effort: 'high', available: true }],
      catalogStatus: 'ready'
    });
    expect(codexManifest.modelPolicy.catalog).toHaveLength(8);
    expect(codexManifest.modelPolicy.catalog[7]).toEqual({ id: 'openai/gpt-8', name: 'Model openai/gpt-8', efforts: ['low', 'high', 'xhigh'], defaultEffort: 'xhigh' });
    expect(JSON.stringify(response)).not.toContain('native-secret');
    expect(JSON.stringify(response)).not.toContain('codex-secret');
    expect(JSON.stringify(response)).not.toContain('omx-secret');
  });

  // accept proven model grammar without claiming unproven filesystem or approval controls
  it('prepares a host model and effort while keeping security unsupported', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/run/host-tmux');
    const config = codexConfig({ allowedModels: [{ model: 'openai/gpt-4' }, { model: 'openai/gpt-8' }] });
    const probe = vi.fn(async () => hostProbe({ pages: [{ data: [
      nativeModel('openai/gpt-4', ['low', 'high'], 'high', true),
      nativeModel('openai/gpt-8', ['low', 'high', 'xhigh'], 'xhigh')
    ], nextCursor: null }] }));
    const service = new LaunchOptionsService({ codex: config }, { codexHostProbe: probe });
    const context = { cwd: '/console/worktree', hostCwd: '/host/worktree', home: '/host/accounts/team' };
    const codexManifest = manifest(await service.list(context), 'codex');

    const prepared = await service.prepare('codex', {
      kind: 'codex',
      model: { mode: 'model', id: 'openai/gpt-8' },
      effort: { mode: 'effort', id: 'xhigh' },
      optionsRevision: codexManifest.optionsRevision
    }, context);

    expect(codexManifest.security).toMatchObject({ status: 'unsupported', controls: [], defaults: {} });
    expect(prepared).toEqual({
      kind: 'codex',
      model: { model: 'openai/gpt-8', effort: 'xhigh' },
      security: {},
      optionsRevision: codexManifest.optionsRevision
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  // retry the host account after failure without silently querying the container Codex
  it('retries a failed host probe and never falls back to the container client', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/run/host-tmux');
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('host account unavailable'))
      .mockResolvedValueOnce(hostProbe());
    const createCodexClient = vi.fn();
    const capabilities = vi.fn();
    const service = new LaunchOptionsService({ codex: codexConfig() }, { codexHostProbe: probe, createCodexClient, capabilities });
    const context = { cwd: '/console/worktree', hostCwd: '/host/worktree', home: '/host/accounts/team' };

    const failed = manifest(await service.list(context), 'codex');
    const recovered = manifest(await service.list(context), 'codex');

    expect(failed.modelPolicy).toMatchObject({ catalogStatus: 'unavailable', catalog: [] });
    expect(failed.modelPolicy.message).toContain('configured Codex context');
    expect(recovered.modelPolicy.catalogStatus).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(2);
    expect(createCodexClient).not.toHaveBeenCalled();
    expect(capabilities).not.toHaveBeenCalled();
  });
});

describe('Codex catalog execution boundary', () => {
  // preserve direct app-server discovery when the server is not bridged
  it('uses the configured native Codex client outside the bridge and never calls the host probe', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', undefined);
    const client: CodexProtocolClient = {
      // answer only the native handshake, configuration, and one model page
      request: vi.fn(async method => method === 'config/read'
        ? { config: { model: 'native/model', model_reasoning_effort: 'high' } }
        : method === 'model/list'
          ? { data: [nativeModel('native/model', ['low', 'high'], 'high', true)], nextCursor: null }
          : {}),
      notify: vi.fn(),
      onNotification: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined)
    };
    const createCodexClient = vi.fn(async () => client);
    const host = vi.fn();
    const capabilities = vi.fn(async () => ({}));
    const config = codexConfig({ program: '/container/codex', env: {} });
    const service = new LaunchOptionsService({ codex: config }, { createCodexClient, codexHostProbe: host, capabilities });

    const codexManifest = manifest(await service.list({ cwd: '/container/repo', home: '/container/home' }), 'codex');

    expect(codexManifest.modelPolicy.catalogStatus).toBe('ready');
    expect(createCodexClient).toHaveBeenCalledOnce();
    expect(createCodexClient.mock.calls[0]?.[1]).toMatchObject({ command: '/container/codex', cwd: '/container/repo' });
    expect(host).not.toHaveBeenCalled();
    expect(capabilities).toHaveBeenCalledOnce();
  });

  // keep both host kinds independently deduplicated and invalidate both after a Codex account switch
  it('deduplicates Codex and OMX separately and invalidates both account-backed snapshots', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/run/host-tmux');
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const codexProbe = vi.fn(async () => { await gate; return hostProbe({ identity: 'codex' }); });
    const omxProbe = vi.fn(async () => { await gate; return hostProbe({ identity: 'omx' }); });
    const service = new LaunchOptionsService({
      codex: codexConfig(),
      omx: { program: '/host/tools/omx', args: [], env: {}, launchable: true }
    }, { codexHostProbe: codexProbe, omxProbe });
    const context = { cwd: '/console/repo', hostCwd: '/host/repo', home: '/host/home' };
    const first = service.list(context);
    const duplicate = service.list(context);
    await vi.waitFor(() => {
      expect(codexProbe).toHaveBeenCalledOnce();
      expect(omxProbe).toHaveBeenCalledOnce();
    });
    release?.();
    await Promise.all([first, duplicate]);

    await service.list(context);
    expect(codexProbe).toHaveBeenCalledTimes(1);
    expect(omxProbe).toHaveBeenCalledTimes(1);
    service.invalidate('codex');
    await service.list(context);
    expect(codexProbe).toHaveBeenCalledTimes(2);
    expect(omxProbe).toHaveBeenCalledTimes(2);
  });

  // bind successful host caches to exact configured argv and environment
  it('segregates Codex host discovery when configured args or env change', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/run/host-tmux');
    const config = codexConfig();
    const probe = vi.fn(async () => hostProbe());
    const service = new LaunchOptionsService({ codex: config }, { codexHostProbe: probe });
    const context = { cwd: '/console/repo', hostCwd: '/host/repo', home: '/host/home' };

    await service.list(context);
    await service.list(context);
    expect(probe).toHaveBeenCalledTimes(1);
    config.args.push('-cmodel_reasoning_effort=xhigh');
    await service.list(context);
    config.env.CODEX_PRIVATE_TOKEN = 'rotated-secret';
    await service.list(context);

    expect(probe).toHaveBeenCalledTimes(3);
  });
});

describe('Codex private host descriptor', () => {
  // keep Codex credentials in one expiring private request rather than tmux argv
  it.each([undefined, '', '   '])('inherits HOME=%s in kind codex mode 0600 and removes the request', async home => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-codex-host-'));
    directories.push(checkout);
    vi.stubEnv('RAC_HOST_INTERACTIVE_SHELL', '/bin/bash');
    const secret = "codex-'#-private";
    let descriptor = '';
    let request: Record<string, unknown> | undefined;
    const command = vi.fn(async (_program: string, args: string[]) => {
      const temporary = (await readdir(join(checkout, '.data')))[0]!;
      descriptor = join(checkout, '.data', temporary, 'request.json');
      request = JSON.parse(await readFile(descriptor, 'utf8')) as Record<string, unknown>;
      expect((await stat(descriptor)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(args)).not.toContain(secret);
      return { code: 0, stdout: JSON.stringify(hostProbe()), stderr: '' };
    });
    const config = codexConfig({ env: { CODEX_PRIVATE_TOKEN: secret, ...(home === undefined ? {} : { HOME: home }) } });
    const environment = {
      RAC_HOST_TMUX_DIR: '/run/host-tmux',
      RAC_HOST_NODE_BIN: '/usr/bin/node',
      RAC_HOST_REPOSITORY: checkout,
      RAC_HOST_PATH: '/host/bin:/usr/bin',
      RAC_TMUX_BIN: '/usr/bin/tmux'
    };

    await expect(probeCodexCatalog(config, { cwd: '/console/repo', hostCwd: '/host/repo', home: '/host/home' }, 600, {
      command: command as never,
      environment,
      checkout
    })).resolves.toEqual(hostProbe());

    expect(command).toHaveBeenCalledOnce();
    expect(JSON.stringify(command.mock.calls[0])).not.toContain(secret);
    expect(request).toMatchObject({
      version: 1,
      kind: 'codex',
      program: config.program,
      args: config.args,
      cwd: '/host/repo',
      home: '/host/home',
      env: { CODEX_PRIVATE_TOKEN: secret, HOME: '/host/home' },
      timeoutMs: 600,
      expiresAt: expect.any(Number)
    });
    expect(Number(request?.expiresAt)).toBeGreaterThan(Date.now() - 2_000);
    await expect(access(descriptor)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(checkout, '.data'))).toEqual([]);
  });
});
