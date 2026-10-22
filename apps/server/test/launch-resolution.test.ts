import { describe, expect, it, vi } from 'vitest';

// register a second launchable kind so the multi-kind resolution branch (which reads
// the launch-profile store) is exercised; only Codex is registered in production today.
// `adapterCapabilities` mirrors the real derivation for the two mocked kinds so
// `launchResolutions` can read a skipped kind's `unavailableReason`.
// the launch lookups are faked; the Review run kinds config validation reads stay real
vi.mock('../src/adapters/registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/adapters/registry.js')>(),
  adapterFor: (kind: string) => (kind === 'codex' || kind === 'claude' ? { kind } : undefined),
  adapterCapabilities: (configs?: Record<string, { launchable?: boolean; unavailableReason?: string }>) =>
    Object.fromEntries(['codex', 'claude'].map(kind => [kind, {
      launchable: configs?.[kind]?.launchable ?? false,
      ...(configs?.[kind]?.unavailableReason === undefined ? {} : { unavailableReason: configs[kind]!.unavailableReason }),
      stateSource: 'title', turnCapture: false, conversations: false, naming: false, inlineQuestions: false, commands: false, sandbox: false,
    }])),
}));

const { LaunchService } = await import('../src/launch/service.js');

const twoKinds = (claudeLaunchable = true, defaultAgent?: 'codex' | 'claude') => ({
  ...(defaultAgent === undefined ? {} : { defaultAgent }),
  adapters: {
    codex: { program: '/bin/codex', args: [], env: {}, launchable: true },
    claude: { program: '/bin/claude', args: [], env: {}, launchable: claudeLaunchable, ...(claudeLaunchable ? {} : { unavailableReason: '/bin/claude is not executable' }) }
  },
  projects: []
}) as never;
// keys are worktree wire ids `<projectId>:<realpath>`; the store is read in bulk
const cora = 'proj:/repo/cora';
const store = (profile?: string) => ({ launchProfiles: async () => (profile === undefined ? {} : { [cora]: profile }), rememberLaunchProfile: async () => {} }) as never;

describe('resolveLaunchKind with more than one launchable kind', () => {
  it('honors the remembered launch profile when it is still launchable', async () => {
    const service = new LaunchService(twoKinds(), undefined, undefined, undefined, store('claude'));
    expect(await service.resolveLaunchKind(cora)).toBe('claude');
  });

  it('skips a remembered kind that is no longer launchable and takes the first launchable in registry order', async () => {
    const service = new LaunchService(twoKinds(false), undefined, undefined, undefined, store('claude'));
    expect(await service.resolveLaunchKind(cora)).toBe('codex');
  });

  it('takes the first launchable kind when nothing is remembered', async () => {
    const service = new LaunchService(twoKinds(), undefined, undefined, undefined, store(undefined));
    expect(await service.resolveLaunchKind(cora)).toBe('codex');
  });

  it('takes the configured default kind when nothing is remembered', async () => {
    const service = new LaunchService(twoKinds(true, 'claude'), undefined, undefined, undefined, store(undefined));
    expect(await service.resolveLaunchKind(cora)).toBe('claude');
  });

  it('keeps remembered kinds ahead of the configured default', async () => {
    const service = new LaunchService(twoKinds(true, 'claude'), undefined, undefined, undefined, store('codex'));
    expect(await service.resolveLaunchKind(cora)).toBe('codex');
  });

  it('falls back when the configured default is unavailable', async () => {
    const service = new LaunchService(twoKinds(false, 'claude'), undefined, undefined, undefined, store(undefined));
    expect(await service.resolveLaunchKind(cora)).toBe('codex');
  });

  it('refuses a requested kind that is not launchable', async () => {
    const service = new LaunchService(twoKinds(false), undefined, undefined, undefined, store());
    expect(await service.resolveLaunchKind(cora, 'claude')).toBeUndefined();
    expect(await service.resolveLaunchKind(cora, 'pi' as never)).toBeUndefined();
  });
});

const { resolveLaunchProfile } = await import('../src/launch/resolution.js');
const caps = { codex: { launchable: true }, claude: { launchable: false, unavailableReason: '/bin/claude is not executable' } } as never;

describe('resolveLaunchProfile (pure)', () => {
  it('resolves the remembered kind with its origin when it is launchable', () => {
    expect(resolveLaunchProfile(['codex', 'claude'], [{ origin: 'worktree', kind: 'claude' }], caps)).toEqual({ kind: 'claude', origin: 'worktree' });
  });

  it('falls back to the first launchable kind as the default when nothing is remembered', () => {
    expect(resolveLaunchProfile(['codex', 'claude'], [{ origin: 'worktree', kind: undefined }], caps)).toEqual({ kind: 'codex', origin: 'default' });
  });

  it('uses a configured launchable default when nothing is remembered', () => {
    expect(resolveLaunchProfile(['codex', 'claude'], [{ origin: 'worktree', kind: undefined }], caps, 'claude')).toEqual({ kind: 'claude', origin: 'default' });
  });

  it('skips a remembered-but-unlaunchable kind, surfaces its reason, and falls back', () => {
    expect(resolveLaunchProfile(['codex'], [{ origin: 'worktree', kind: 'claude' }], caps)).toEqual({
      kind: 'codex', origin: 'default', skipped: { kind: 'claude', origin: 'worktree', reason: '/bin/claude is not executable' }
    });
  });

  it('reports "no longer configured" when a skipped kind has no capability reason', () => {
    expect(resolveLaunchProfile(['codex'], [{ origin: 'scratch', kind: 'pi' }], caps).skipped).toEqual({ kind: 'pi', origin: 'scratch', reason: 'no longer configured' });
  });

  it('tries remembered candidates in order and keeps the first skip when both miss', () => {
    const resolution = resolveLaunchProfile(['codex'], [{ origin: 'worktree', kind: 'claude' }, { origin: 'project', kind: 'pi' }], caps);
    expect(resolution.kind).toBe('codex');
    expect(resolution.skipped).toEqual({ kind: 'claude', origin: 'worktree', reason: '/bin/claude is not executable' });
  });

  it('resolves nothing (no kind, no origin) when no kind is launchable', () => {
    expect(resolveLaunchProfile([], [{ origin: 'scratch', kind: undefined }], caps)).toEqual({});
  });
});

describe('launchResolutions', () => {
  it('resolves worktree scopes and the scratch scope from one store read', async () => {
    const profiles: Record<string, string> = { [cora]: 'claude', scratch: 'codex' };
    const service = new LaunchService(twoKinds(), undefined, undefined, undefined, { launchProfiles: async () => profiles } as never);
    const resolutions = await service.launchResolutions([cora, 'proj:/repo/dana', 'scratch']);
    expect(resolutions.get(cora)).toEqual({ kind: 'claude', origin: 'worktree' });
    expect(resolutions.get('proj:/repo/dana')).toEqual({ kind: 'codex', origin: 'default' });
    expect(resolutions.get('scratch')).toEqual({ kind: 'codex', origin: 'scratch' });
  });

  it('falls back to the Project last-used kind when the Worktree has none', async () => {
    const service = new LaunchService(twoKinds(), undefined, undefined, undefined, { launchProfiles: async () => ({ proj: 'claude' }) } as never);
    const resolution = await service.launchResolutions([cora]);
    expect(resolution.get(cora)).toEqual({ kind: 'claude', origin: 'project' });
  });

  it('resolves a Scratch Place in the scratch scope, from its own last-used kind then the Scratch group', async () => {
    const service = new LaunchService(twoKinds(), undefined, undefined, undefined, { launchProfiles: async () => ({ scratch: 'claude', 'scratch:/srv/tools': 'codex' }) } as never);
    const resolutions = await service.launchResolutions(['scratch:/srv/tools', 'scratch:/srv/other']);
    expect(resolutions.get('scratch:/srv/tools')).toEqual({ kind: 'codex', origin: 'scratch' });
    // never the `scratch` group record read as if it were a Project's
    expect(resolutions.get('scratch:/srv/other')).toEqual({ kind: 'claude', origin: 'scratch' });
  });

  it('surfaces a skipped remembered kind that is no longer launchable', async () => {
    const service = new LaunchService(twoKinds(false), undefined, undefined, undefined, { launchProfiles: async () => ({ [cora]: 'claude' }) } as never);
    const resolution = await service.launchResolutions([cora]);
    expect(resolution.get(cora)).toEqual({ kind: 'codex', origin: 'default', skipped: { kind: 'claude', origin: 'worktree', reason: expect.stringContaining('not executable') } });
  });
});
