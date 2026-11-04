import { afterEach, describe, expect, it, vi } from 'vitest';
import * as piRuntime from '../src/adapters/pi-runtime.js';
import { validateConfig } from '../src/config/schema.js';

const savedEnvironment = new Map<string, string | undefined>();
const scratch = { publicOrigin: 'https://agents.example.com', projects: [] as unknown[] };

// change one process variable while retaining its original value
function setEnvironment(name: string, value: string | undefined): void {
  if (!savedEnvironment.has(name)) savedEnvironment.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// restore host state and module spies after each configuration case
afterEach(() => {
  vi.restoreAllMocks();
  // restore every changed process variable
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvironment.clear();
});

// install one verified host Pi runtime seam
function verifiedPiRuntime() {
  const runtime = vi.spyOn(piRuntime, 'hostPiRuntime').mockReturnValue({
    node: '/host/bin/node',
    cli: '/host/pi.js',
    extension: '/host/pi-extension.js',
    holder: '/host/holder.js',
    command: '/host/sandboxed-command.js',
    fingerprint: 'a'.repeat(64)
  });
  const verify = vi.spyOn(piRuntime, 'verifyHostPiNode').mockResolvedValue('a'.repeat(64));
  return { runtime, verify };
}

describe('validated launch HOME', () => {
  // resolve once, keep runtime HOME unrelated to repository ancestry, and avoid source mutation
  it('stores one injected launch HOME while normalizing non-Pi blank values', async () => {
    const source = {
      publicOrigin: 'https://agents.example.com',
      projects: [{ path: '/srv/repositories/project' }],
      adapters: {
        codex: { program: '/host/bin/codex', env: { HOME: '   ', KEEP: 'codex' } },
        omx: { program: '/host/bin/omx', env: { KEEP: 'omx' } },
        opencode: { program: '/host/bin/opencode', env: { HOME: '/configured/opencode' } }
      }
    };
    const before = structuredClone(source);
    const resolveLaunchHome = vi.fn(async () => '/accounts/ansel');

    const config = await validateConfig(source, { checkExecutables: false, resolveLaunchHome });

    expect(resolveLaunchHome).toHaveBeenCalledOnce();
    expect(config.launchHome).toBe('/accounts/ansel');
    expect(config.launchHome).not.toBe('/srv/repositories');
    expect(config.adapters.codex?.env).toEqual({ KEEP: 'codex' });
    expect(config.adapters.omx?.env).toEqual({ KEEP: 'omx' });
    expect(config.adapters.opencode?.env).toEqual({ HOME: '/configured/opencode' });
    expect(source).toEqual(before);
  });

  // keep explicit adapter HOME values ahead of the resolved runtime fallback
  it('preserves explicit Pi and non-Pi HOME overrides', async () => {
    setEnvironment('RAC_HOST_TMUX_DIR', '/run/host-tmux');
    const { verify } = verifiedPiRuntime();
    const resolveLaunchHome = vi.fn(async () => '/host/accounts/default');

    const config = await validateConfig({
      ...scratch,
      adapters: {
        pi: { env: { HOME: '/host/accounts/pi', KEEP: 'pi' } },
        codex: { program: '/host/bin/codex', env: { HOME: '/host/accounts/codex' } }
      }
    }, { checkExecutables: false, resolveLaunchHome });

    expect(config.launchHome).toBe('/host/accounts/default');
    expect(config.adapters.pi?.env).toEqual({ HOME: '/host/accounts/pi', KEEP: 'pi' });
    expect(config.adapters.codex?.env).toEqual({ HOME: '/host/accounts/codex' });
    expect(verify).toHaveBeenCalledWith('/host/bin/node', expect.objectContaining({ HOME: '/host/accounts/pi' }), undefined, []);
  });

  // materialize the resolved host account for both missing and blank Pi HOME
  it.each([
    ['missing', { KEEP: 'pi' }],
    ['empty', { HOME: '', KEEP: 'pi' }],
    ['blank', { HOME: '  ', KEEP: 'pi' }]
  ])('inherits host HOME for Pi when its value is %s', async (_name, environment) => {
    setEnvironment('RAC_HOST_TMUX_DIR', '/run/host-tmux');
    const { verify } = verifiedPiRuntime();
    const source = { ...scratch, adapters: { pi: { env: environment } } };
    const before = structuredClone(source);

    const config = await validateConfig(source, { checkExecutables: false, resolveLaunchHome: async () => '/host/accounts/ansel' });

    expect(config.adapters.pi).toMatchObject({ launchable: true, env: { KEEP: 'pi', HOME: '/host/accounts/ansel' } });
    expect(verify).toHaveBeenCalledWith('/host/bin/node', expect.objectContaining({ HOME: '/host/accounts/ansel' }), undefined, []);
    expect(source).toEqual(before);
  });

  // leave host Pi unavailable when the launch account cannot be proven
  it('does not launch bridged Pi when host HOME is unknown', async () => {
    setEnvironment('RAC_HOST_TMUX_DIR', '/run/host-tmux');
    const { verify } = verifiedPiRuntime();

    const config = await validateConfig({
      ...scratch,
      adapters: {
        pi: { env: { HOME: '  ' } },
        codex: { program: '/host/bin/codex', env: { HOME: '' } }
      }
    }, { checkExecutables: false, resolveLaunchHome: async () => undefined });

    expect(config.launchHome).toBeNull();
    expect(config.adapters.pi).toMatchObject({ launchable: false });
    expect(config.adapters.pi?.unavailableReason).toMatch(/HOME|home/u);
    expect(config.adapters.codex?.env).toEqual({});
    expect(verify).not.toHaveBeenCalled();
  });
});
