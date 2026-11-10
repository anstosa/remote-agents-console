import { execFile, execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { CodexProtocolClient } from '../src/accounts/protocol.js';
import type { AdapterConfigs, AdapterLaunchConfig } from '../src/adapters/types.js';
import { probeOmxCatalog, type OmxCatalogProbe } from '../src/launch/omx-catalog.js';
import { LaunchOptionsService, type LaunchOptionsContext } from '../src/launch/options.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig, testProject, testWorktree } from './helpers/config.js';

const directories: string[] = [];
const executeFile = promisify(execFile);
// the tmux on PATH (mise, Homebrew, a distro package); its watchdog test is skipped without one
const tmux = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim();

// reproduce POSIX single-quote framing for transport assertions
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// report whether one exact fixture process still exists
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// restore process seams and remove isolated transport roots
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // remove every temporary checkout fixture
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// create one native model record
function nativeModel(id: string, efforts: string[], defaultEffort: string, isDefault = false) {
  return { model: id, displayName: `Model ${id}`, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })), defaultReasoningEffort: defaultEffort, isDefault };
}

// create one complete fixed-helper response
function validProbe(overrides: Partial<OmxCatalogProbe> = {}): OmxCatalogProbe {
  return {
    version: 1,
    config: { config: { model: 'openai/default', model_reasoning_effort: 'high' } },
    pages: [{ data: [nativeModel('openai/default', ['low', 'high'], 'high', true)], nextCursor: null }],
    args: ['--profile', 'work'],
    capabilities: { model: true, effort: true },
    identity: 'omx-fixture',
    ...overrides
  };
}

// create the configured OMX adapter without borrowing Codex state
function omxConfig(overrides: Partial<AdapterLaunchConfig> = {}): AdapterLaunchConfig {
  return {
    program: '/opt/omx/bin/omx',
    args: ['--profile', 'work'],
    env: { HOME: '/accounts/omx', OMX_PRIVATE_TOKEN: 'omx-secret' },
    launchable: true,
    allowedModels: [{ model: 'openai/default' }, { model: 'openai/next' }],
    ...overrides
  };
}

// return the OMX manifest from a mixed response
function omxManifest(response: Awaited<ReturnType<LaunchOptionsService['list']>>) {
  const manifest = response.kinds.find(kind => kind.kind === 'omx');
  if (manifest === undefined) throw new Error('missing OMX fixture manifest');
  return manifest;
}

describe('OMX launch catalog projection', () => {
  // keep the wrapper account isolated and project only bounded public metadata
  it('uses the exact OMX config and resolves native profile defaults without returning raw configuration', async () => {
    const codex = { program: '/opt/codex', args: ['--profile', 'other'], env: { CODEX_ONLY: 'codex-secret' }, launchable: true };
    const omx = omxConfig({ allowedModels: undefined });
    const probe = vi.fn(async () => validProbe({
      config: { config: { model: 'openai/default', model_reasoning_effort: 'low', private_api_key: 'native-config-secret' } },
      pages: [
        { data: [nativeModel('openai/default', ['low', 'high'], 'high', true)], nextCursor: 'page-2' },
        { data: [nativeModel('openai/next', ['low', 'xhigh'], 'xhigh')], nextCursor: null }
      ],
      args: ['--profile', 'work', '--model', 'openai/next', '-cmodel_reasoning_effort=xhigh']
    }));
    const codexClient: CodexProtocolClient = {
      // return a minimal sibling catalog that must not affect OMX
      request: vi.fn(async method => method === 'config/read' ? { config: {} } : method === 'model/list' ? { data: [], nextCursor: null } : {}),
      notify: vi.fn(),
      onNotification: vi.fn(() => () => undefined),
      close: vi.fn(async () => undefined)
    };
    const service = new LaunchOptionsService({ codex, omx }, {
      omxProbe: probe,
      createCodexClient: vi.fn(async () => codexClient),
      capabilities: vi.fn(async () => ({}))
    });
    const context = { cwd: '/console/repo', hostCwd: '/host/repo', home: '/accounts/host' };

    const manifest = omxManifest(await service.list(context));

    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(omx, context, 5_000);
    expect(probe.mock.calls[0]?.[0]).not.toBe(codex);
    expect(manifest.modelPolicy).toMatchObject({
      state: 'native-default',
      allowed: [{ model: 'openai/next', effort: 'xhigh', available: true }],
      defaultSelection: { mode: 'model', id: 'openai/next' },
      catalogStatus: 'ready',
      catalog: [
        { id: 'openai/default', efforts: ['low', 'high'], defaultEffort: 'high' },
        { id: 'openai/next', efforts: ['low', 'xhigh'], defaultEffort: 'xhigh' }
      ]
    });
    expect(JSON.stringify(manifest)).not.toContain('native-config-secret');
    expect(JSON.stringify(manifest)).not.toContain('omx-secret');
    expect(JSON.stringify(manifest)).not.toContain('codex-secret');
  });

  // treat model grammar proof independently from unproven native security controls
  it('prepares a model and effort from OMX capabilities while security remains unsupported', async () => {
    const probe = vi.fn(async () => validProbe({
      pages: [{ data: [
        nativeModel('openai/default', ['high'], 'high', true),
        nativeModel('openai/next', ['low', 'xhigh'], 'xhigh')
      ], nextCursor: null }]
    }));
    const service = new LaunchOptionsService({ omx: omxConfig() }, { omxProbe: probe });
    const context = { cwd: '/repo', hostCwd: '/host/repo', home: '/accounts/host' };
    const manifest = omxManifest(await service.list(context));

    const prepared = await service.prepare('omx', {
      kind: 'omx',
      model: { mode: 'model', id: 'openai/next' },
      effort: { mode: 'effort', id: 'xhigh' },
      optionsRevision: manifest.optionsRevision
    }, context);

    expect(manifest.security).toMatchObject({ status: 'unsupported', controls: [], defaults: {} });
    expect(prepared).toEqual({
      kind: 'omx',
      model: { model: 'openai/next', effort: 'xhigh' },
      security: {},
      optionsRevision: manifest.optionsRevision
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  // preserve the configured model and saved effort for an untouched launch choice
  it('prepares and revalidates the default OMX model with its configured effort', async () => {
    // expose grammar and metadata from the same successful wrapper probe
    const probe = vi.fn(async () => validProbe({
      pages: [{ data: [
        nativeModel('openai/default', ['high', 'xhigh'], 'high', true),
        nativeModel('openai/next', ['high'], 'high')
      ], nextCursor: null }]
    }));
    const service = new LaunchOptionsService({ omx: omxConfig({
      args: ['--madmax', '-c', 'check_for_update_on_startup=false'],
      allowedModels: [{ model: 'openai/default', effort: 'xhigh' }, { model: 'openai/next', effort: 'high' }]
    }) }, { omxProbe: probe });
    const context = { cwd: '/repo', hostCwd: '/host/repo', home: '/accounts/host' };
    const manifest = omxManifest(await service.list(context));
    const prepared = await service.prepare('omx', {
      kind: 'omx', model: manifest.modelPolicy.defaultSelection, optionsRevision: manifest.optionsRevision
    }, context);

    expect(manifest.modelPolicy.catalogStatus).toBe('ready');
    expect(prepared.model).toEqual({ model: 'openai/default', effort: 'xhigh' });
    expect(prepared.security).toEqual({});
    await expect(service.revalidate(prepared, context)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledOnce();
  });

  // fail closed on incomplete, duplicate, or malformed native pagination
  it.each([
    ['duplicate models', validProbe({ pages: [
      { data: [nativeModel('openai/default', ['high'], 'high', true)], nextCursor: 'again' },
      { data: [nativeModel('openai/default', ['high'], 'high')], nextCursor: null }
    ] })],
    ['unclosed final page', validProbe({ pages: [{ data: [nativeModel('openai/default', ['high'], 'high', true)], nextCursor: 'more' }] })],
    ['early pagination end', validProbe({ pages: [
      { data: [nativeModel('openai/default', ['high'], 'high', true)], nextCursor: null },
      { data: [nativeModel('openai/next', ['high'], 'high')], nextCursor: null }
    ] })],
    ['too many pages', validProbe({ pages: Array.from({ length: 11 }, (_value, index) => ({
      data: [nativeModel(`openai/page-${index}`, ['high'], 'high', index === 0)],
      nextCursor: index === 10 ? null : `page-${index + 1}`
    })) })],
    ['malformed effective config', validProbe({ config: { private_api_key: 'do-not-leak' } })]
  ])('publishes no partial catalog for %s', async (_name, result) => {
    const probe = vi.fn(async () => result);
    const service = new LaunchOptionsService({ omx: omxConfig() }, { omxProbe: probe });

    const manifest = omxManifest(await service.list({ cwd: '/repo', hostCwd: '/host/repo', home: '/accounts/host' }));

    expect(manifest.modelPolicy.catalogStatus).toBe('unavailable');
    expect(manifest.modelPolicy.catalog).toEqual([]);
    expect(JSON.stringify(manifest)).not.toContain('do-not-leak');
  });
});

describe('OMX catalog cache boundaries', () => {
  // share one in-flight request and bind successful reuse to every relevant context input
  it('deduplicates discovery and segregates cwd, host cwd, home, args, env, and Codex account invalidation', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const probe = vi.fn(async () => { await gate; return validProbe(); });
    const config = omxConfig();
    const configs: AdapterConfigs = { omx: config };
    const service = new LaunchOptionsService(configs, { omxProbe: probe });
    const base = { cwd: '/console/a', hostCwd: '/host/a', home: '/accounts/a' };
    const first = service.list(base);
    const duplicate = service.list(base);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    release?.();
    await Promise.all([first, duplicate]);

    await service.list(base);
    expect(probe).toHaveBeenCalledTimes(1);
    await service.list({ ...base, hostCwd: '/host/b' });
    await service.list({ ...base, cwd: '/console/b' });
    await service.list({ ...base, home: '/accounts/b' });
    config.args.push('--xhigh');
    await service.list(base);
    config.env.OMX_PRIVATE_TOKEN = 'rotated-secret';
    await service.list(base);
    service.invalidate('codex');
    await service.list(base);

    expect(probe).toHaveBeenCalledTimes(7);
  });

  // do not retain a transient bridge failure as the context's discovery result
  it('retries discovery after a failed snapshot', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('private bridge diagnostic'))
      .mockResolvedValueOnce(validProbe());
    const service = new LaunchOptionsService({ omx: omxConfig() }, { omxProbe: probe });
    const context = { cwd: '/repo', hostCwd: '/host/repo', home: '/accounts/host' };

    const unavailable = omxManifest(await service.list(context));
    const recovered = omxManifest(await service.list(context));

    expect(unavailable.modelPolicy).toMatchObject({ catalogStatus: 'unavailable', catalog: [] });
    expect(JSON.stringify(unavailable)).not.toContain('private bridge diagnostic');
    expect(recovered.modelPolicy.catalogStatus).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('OMX fixed-helper transport', () => {
  // pass only an expiring private descriptor while preserving host namespace quoting
  it.each([undefined, '', '   '])('inherits HOME=%s privately and removes the descriptor after success', async home => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-omx-bridge-'));
    directories.push(checkout);
    vi.stubEnv('RAC_HOST_INTERACTIVE_SHELL', '/bin/bash');
    const secret = "token-'#-private";
    let descriptor = '';
    let request: Record<string, unknown> | undefined;
    const command = vi.fn(async (_program: string, args: string[]) => {
      const temporary = (await readdir(join(checkout, '.data')))[0]!;
      descriptor = join(checkout, '.data', temporary, 'request.json');
      request = JSON.parse(await readFile(descriptor, 'utf8')) as Record<string, unknown>;
      expect((await stat(descriptor)).mode & 0o777).toBe(0o600);
      return { code: 0, stdout: JSON.stringify(validProbe()), stderr: '' };
    });
    const config = omxConfig({ env: { OMX_PRIVATE_TOKEN: secret, ...(home === undefined ? {} : { HOME: home }) } });
    const environment = {
      RAC_HOST_TMUX_DIR: '/run/user/1000/tmux dir',
      RAC_HOST_NODE_BIN: '/opt/node bin/node',
      RAC_HOST_REPOSITORY: checkout,
      RAC_HOST_PATH: '/custom/bin:/usr/bin',
      RAC_TMUX_BIN: '/usr/bin/tmux'
    };

    const result = await probeOmxCatalog(config, {
      cwd: '/console/not-used',
      hostCwd: "/host/worktree/Ansel's #repo",
      home: "/home/Ansel's account"
    }, 750, { command: command as never, environment, checkout });

    expect(result).toEqual(validProbe());
    expect(command).toHaveBeenCalledOnce();
    const [program, args, input, timeout] = command.mock.calls[0]!;
    expect(program).toBe('/usr/bin/tmux');
    expect(input).toBeUndefined();
    expect(timeout).toBe(2_750);
    expect(JSON.stringify([program, args])).not.toContain(secret);
    expect(args).toEqual(expect.arrayContaining(['-S', '/run/user/1000/tmux dir/default', 'run-shell']));
    const script = args.at(-1)!;
    const quotedCwdPrefix = shellQuote(`cd -- ${shellQuote("/host/worktree/Ansel's #repo")}`).slice(0, -1).replaceAll('#', '##');
    expect(script.startsWith('exec /usr/bin/timeout --signal=TERM --kill-after=0.25s 0.75s /bin/sh -c ')).toBe(true);
    expect(script).toContain(quotedCwdPrefix);
    expect(script).toContain('/home/Ansel');
    expect(script).toContain('s account');
    expect(script).toContain('/custom/bin:/usr/bin');
    expect(request).toMatchObject({
      version: 1,
      program: config.program,
      args: config.args,
      cwd: "/host/worktree/Ansel's #repo",
      home: "/home/Ansel's account",
      env: { OMX_PRIVATE_TOKEN: secret, HOME: "/home/Ansel's account" },
      timeoutMs: 750,
      expiresAt: expect.any(Number)
    });
    expect(Number(request?.expiresAt)).toBeGreaterThan(Date.now() - 2_000);
    await expect(access(descriptor)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(checkout, '.data'))).toEqual([]);
  });

  // reject timeout, truncation, excess output, and malformed helper framing without retaining requests
  it.each([
    ['timeout', { code: 0, stdout: JSON.stringify(validProbe()), stderr: '', timedOut: true }],
    ['truncation', { code: 0, stdout: JSON.stringify(validProbe()), stderr: '', stdoutTruncated: true }],
    ['oversize output', { code: 0, stdout: 'x'.repeat(900 * 1024 + 1), stderr: '' }],
    ['malformed framing', { code: 0, stdout: JSON.stringify({ version: 1, pages: [], args: [], capabilities: {} }), stderr: '' }]
  ])('rejects %s and cleans its private descriptor', async (_name, result) => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-omx-reject-'));
    directories.push(checkout);
    vi.stubEnv('RAC_HOST_INTERACTIVE_SHELL', '/bin/bash');
    const command = vi.fn(async () => result);
    const environment = {
      RAC_HOST_TMUX_DIR: '/run/tmux',
      RAC_HOST_NODE_BIN: '/usr/bin/node',
      RAC_HOST_REPOSITORY: checkout,
      RAC_TMUX_BIN: '/usr/bin/tmux'
    };

    await expect(probeOmxCatalog(omxConfig(), { cwd: '/console/repo', hostCwd: '/host/repo', home: '/home/ansel' }, 500, {
      command: command as never,
      environment,
      checkout
    })).rejects.toThrow();

    expect(command).toHaveBeenCalledOnce();
    expect(await readdir(join(checkout, '.data'))).toEqual([]);
  });

  // refuse incomplete bridge authority before creating a descriptor or spawning a helper
  it.each([
    ['host cwd', { context: { cwd: '/console/repo', home: '/home/ansel' }, environment: { RAC_HOST_NODE_BIN: '/usr/bin/node', RAC_HOST_REPOSITORY: 'CHECKOUT' } }],
    ['home', { context: { cwd: '/console/repo', hostCwd: '/host/repo' }, environment: { RAC_HOST_NODE_BIN: '/usr/bin/node', RAC_HOST_REPOSITORY: 'CHECKOUT' } }],
    ['host node', { context: { cwd: '/console/repo', hostCwd: '/host/repo', home: '/home/ansel' }, environment: { RAC_HOST_REPOSITORY: 'CHECKOUT' } }],
    ['host repository', { context: { cwd: '/console/repo', hostCwd: '/host/repo', home: '/home/ansel' }, environment: { RAC_HOST_NODE_BIN: '/usr/bin/node' } }]
  ])('fails a bridge missing %s before filesystem or command side effects', async (_name, fixture) => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-omx-context-'));
    directories.push(checkout);
    const command = vi.fn();
    const environment = Object.fromEntries(Object.entries(fixture.environment).map(([key, value]) => [key, value === 'CHECKOUT' ? checkout : value]));
    environment.RAC_HOST_TMUX_DIR = '/run/tmux';

    await expect(probeOmxCatalog(omxConfig({ env: {} }), fixture.context, 500, {
      command: command as never,
      environment,
      checkout
    })).rejects.toThrow('omx_context_unavailable');

    expect(command).not.toHaveBeenCalled();
    await expect(access(join(checkout, '.data'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // prove the host watchdog kills the whole discovery job while its isolated tmux server remains reusable
  it.skipIf(tmux === '')('kills an over-deadline host job and allows a later probe on the same isolated tmux server', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-omx-watchdog-'));
    directories.push(checkout);
    const scripts = join(checkout, 'scripts');
    const socketDirectory = join(checkout, 'tmux');
    const socket = join(socketDirectory, 'default');
    const fakeBash = join(checkout, 'bash');
    const slow = join(checkout, 'slow-once');
    const sentinel = join(checkout, 'late-sentinel');
    const pidFile = join(checkout, 'slow.pid');
    await mkdir(scripts, { recursive: true });
    await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
    await writeFile(slow, 'slow once\n');
    await writeFile(fakeBash, [
      '#!/bin/sh',
      `if [ -f ${shellQuote(slow)} ]; then`,
      `  rm -f ${shellQuote(slow)}`,
      `  printf '%s\\n' "$$" > ${shellQuote(pidFile)}`,
      '  sleep 1',
      `  printf 'escaped watchdog\\n' > ${shellQuote(sentinel)}`,
      'fi',
      'exec /bin/bash "$@"',
      ''
    ].join('\n'));
    await chmod(fakeBash, 0o700);
    const helperResult = validProbe({
      config: { config: { model: 'fixture/model', model_reasoning_effort: 'high' } },
      pages: [{ data: [nativeModel('fixture/model', ['high'], 'high', true)], nextCursor: null }],
      args: ['--profile', 'fixture'],
      identity: 'watchdog-fixture'
    });
    await writeFile(join(scripts, 'discover-omx-models.mjs'), [
      "import { readFile, unlink } from 'node:fs/promises';",
      "const index = process.argv.indexOf('--request');",
      "if (index < 0 || process.argv[index + 1] === undefined) process.exit(2);",
      'const request = process.argv[index + 1];',
      "const payload = JSON.parse(await readFile(request, 'utf8'));",
      'await unlink(request);',
      "if (payload.version !== 1) process.exit(3);",
      `process.stdout.write(${JSON.stringify(JSON.stringify(helperResult))});`,
      ''
    ].join('\n'));
    vi.stubEnv('RAC_HOST_INTERACTIVE_SHELL', fakeBash);
    const environment = {
      RAC_HOST_TMUX_DIR: socketDirectory,
      RAC_HOST_NODE_BIN: process.execPath,
      RAC_HOST_REPOSITORY: checkout,
      RAC_HOST_PATH: '/usr/local/bin:/usr/bin:/bin',
      RAC_TMUX_BIN: tmux
    };
    const config = omxConfig({ program: '/fixture/omx', args: ['--profile', 'fixture'], env: {} });
    const context = { cwd: '/console/not-used', hostCwd: checkout, home: checkout };

    await executeFile(tmux, ['-S', socket, 'new-session', '-d', '-s', 'watchdog-fixture', '/bin/sleep', '60']);
    try {
      await expect(probeOmxCatalog(config, context, 250, { environment, checkout })).rejects.toThrow('omx_discovery_unavailable');
      const slowPid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(Number.isSafeInteger(slowPid)).toBe(true);
      // wait beyond the fake shell's delayed write
      await new Promise(resolve => setTimeout(resolve, 1_100));
      await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(processExists(slowPid)).toBe(false);

      await expect(probeOmxCatalog(config, context, 2_000, { environment, checkout })).resolves.toEqual(helperResult);
      expect(await readdir(join(checkout, '.data'))).toEqual([]);
    } finally {
      // terminate only the exact socket created by this test
      await executeFile(tmux, ['-S', socket, 'kill-server']).catch(() => undefined);
    }
  });

  // let native discovery use a fully mocked runner rather than executing the helper
  it('supports native discovery through the injected command seam', async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'rac-omx-native-'));
    directories.push(checkout);
    vi.stubEnv('RAC_INTERACTIVE_SHELL', '/bin/bash');
    const command = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(validProbe()), stderr: '' }));

    await expect(probeOmxCatalog(omxConfig(), { cwd: '/native/repo', home: '/native/home' }, 500, {
      command: command as never,
      environment: { HOME: '/native/home' },
      checkout
    })).resolves.toEqual(validProbe());

    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[0]).toBe('/bin/sh');
    const args = command.mock.calls[0]?.[1] as string[];
    const quotedCwdPrefix = shellQuote(`cd -- ${shellQuote('/native/repo')}`).slice(0, -1);
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain(quotedCwdPrefix);
  });
});

describe('OMX launch options API host context', () => {
  // map a container worktree identity to its nonaligned host root behind authenticated control
  it('passes the bridged worktree host cwd to launch option discovery', async () => {
    vi.stubEnv('RAC_HOST_TMUX_DIR', '/run/tmux');
    const project = testProject({ id: 'proj', path: '/console/project', identity: '/console/project/.git', hostPath: '/host/project' });
    const worktree = testWorktree({ id: 'proj:main', projectId: project.id, path: '/console/project', identity: '/console/project', hostPath: '/host/project' });
    const contexts: LaunchOptionsContext[] = [];
    const launchOptions = {
      // capture the route's server-resolved namespace
      list: vi.fn(async (context: LaunchOptionsContext) => { contexts.push(context); return { kinds: [] }; })
    };
    const discovery = {
      worktreesNow: () => [worktree],
      projectsNow: () => [project],
      dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [], projects: [] })
    };
    const app = await buildApp(testConfig({ projects: [project] }), {
      auth: await testAuthService(),
      discovery: discovery as never,
      launchOptions: launchOptions as never
    });
    try {
      const headers = await authenticatedHeaders(app);
      const response = await app.inject({
        method: 'POST',
        url: '/api/launch/options',
        headers,
        payload: { type: 'worktree', id: worktree.id }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kinds: [] });
      expect(launchOptions.list).toHaveBeenCalledOnce();
      expect(contexts).toEqual([{ cwd: '/console/project', hostCwd: '/host/project', home: '/host' }]);
    } finally {
      await app.close();
    }
  });
});
