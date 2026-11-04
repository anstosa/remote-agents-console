import { userInfo } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inheritedHomeEnvironment, resolveLaunchUserHome } from '../src/places/launch-home.js';

// restore process environment stubs after every resolution case
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('launch HOME inheritance', () => {
  // materialize a known runtime fallback without mutating authored settings
  it.each([
    ['omitted', { KEEP: 'value' }],
    ['empty', { HOME: '', KEEP: 'value' }],
    ['blank', { HOME: '   ', KEEP: 'value' }]
  ])('inherits a fallback when HOME is %s', (_name, source) => {
    const before = { ...source };

    const resolved = inheritedHomeEnvironment(source, '/accounts/launch-user');

    expect(resolved).toEqual({ KEEP: 'value', HOME: '/accounts/launch-user' });
    expect(source).toEqual(before);
    expect(resolved).not.toBe(source);
  });

  // remove blank HOME when no trustworthy runtime fallback exists
  it.each([
    ['omitted', { KEEP: 'value' }],
    ['empty', { HOME: '', KEEP: 'value' }],
    ['blank', { HOME: '\t ', KEEP: 'value' }]
  ])('omits %s HOME without a fallback', (_name, source) => {
    expect(inheritedHomeEnvironment(source)).toEqual({ KEEP: 'value' });
  });

  // preserve explicit bytes rather than trimming or replacing operator intent
  it('keeps a nonblank explicit HOME unchanged', () => {
    const source = { HOME: ' /configured/account ', KEEP: 'value' };

    expect(inheritedHomeEnvironment(source, '/accounts/launch-user')).toEqual(source);
  });
});

describe('launch user HOME resolution', () => {
  // query only the host tmux global environment under the bridge
  it('returns one absolute host HOME with the bounded tmux command', async () => {
    const command = vi.fn(async () => ({ code: 0, stdout: 'HOME=/host/accounts/ansel\n', stderr: '' }));
    const environment = {
      RAC_HOST_TMUX_DIR: '/run/host-tmux',
      RAC_TMUX_BIN: '/host/bin/tmux',
      HOME: '/container/root'
    };

    await expect(resolveLaunchUserHome(environment, command as never)).resolves.toBe('/host/accounts/ansel');

    expect(command).toHaveBeenCalledWith('/host/bin/tmux', ['-S', '/run/host-tmux/default', 'show-environment', '-g', 'HOME'], undefined, 1_500);
  });

  // never substitute the container account for malformed or unavailable host identity
  it.each([
    ['relative HOME', { code: 0, stdout: 'HOME=relative/account\n', stderr: '' }],
    ['control character', { code: 0, stdout: 'HOME=/host/account\u0007\n', stderr: '' }],
    ['missing record', { code: 0, stdout: '-HOME\n', stderr: '' }],
    ['failed query', { code: 1, stdout: '', stderr: 'missing' }],
    ['timeout', { code: 0, stdout: 'HOME=/late/account\n', stderr: '', timedOut: true }],
    ['truncation', { code: 0, stdout: 'HOME=/partial/account', stderr: '', stdoutTruncated: true }]
  ])('refuses host %s instead of using container HOME', async (_name, result) => {
    const command = vi.fn(async () => result);

    await expect(resolveLaunchUserHome({ RAC_HOST_TMUX_DIR: '/run/host-tmux', HOME: '/container/root' }, command as never)).resolves.toBeUndefined();
  });

  // fail closed when the host query itself cannot start
  it('returns no host HOME when tmux throws', async () => {
    const command = vi.fn(async () => { throw new Error('socket unavailable'); });

    await expect(resolveLaunchUserHome({ RAC_HOST_TMUX_DIR: '/run/host-tmux', HOME: '/container/root' }, command as never)).resolves.toBeUndefined();
  });

  // use the native process account before consulting operating-system fallback metadata
  it('returns an absolute native process HOME', async () => {
    await expect(resolveLaunchUserHome({ HOME: '/native/account' })).resolves.toBe('/native/account');
  });

  // reject an invalid native HOME and use the actual operating-system account
  it('uses the native user account when process HOME is blank or relative', async () => {
    await expect(resolveLaunchUserHome({ HOME: 'relative/account' })).resolves.toBe(userInfo().homedir);
    await expect(resolveLaunchUserHome({ HOME: '   ' })).resolves.toBe(userInfo().homedir);
  });
});
