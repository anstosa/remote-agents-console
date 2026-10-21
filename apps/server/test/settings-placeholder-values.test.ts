import { describe, expect, it } from 'vitest';
import { readPlaceholderRuntime, resolvedEnvironmentFallback, type EnvironmentFallbackContext } from '../src/settings/fallbacks.js';

// isolate saved sources and fixed runtime facts from the machine running tests
const context: EnvironmentFallbackContext = {
  application: { publicOrigin: 'https://console.example.org', listen: { host: '::1', port: 8899 }, adapters: { codex: { program: '/host/bin/codex' } }, projects: [{ path: '/console', hostPath: '/srv/console' }] },
  environment: { RAC_CONFIG: '/console/config.json', RAC_HOST_PROC: '/host-proc', RAC_HOST_UID: '1200' },
  running: {},
  checkout: '/console',
  home: '/home/console',
  cwd: '/app',
  runtime: { hostNode: '/host/bin/node', hostPath: '/host/bin:/usr/bin', timeZone: 'America/Los_Angeles' }
};

describe('resolved settings placeholders', () => {
  // a Docker installation without the host bridge cannot prove the host's Node
  it('does not mislabel container PATH or Node as host runtime defaults', async () => {
    const runtime = await readPlaceholderRuntime({ PATH: process.env.PATH, RAC_HOST_PATH: '/configured/host/bin' }, true);
    expect(runtime.hostNode).toBeUndefined();
    expect(runtime.hostPath).toBeUndefined();
  });

  // put concrete omission values before their owning sources
  it.each([
    ['RAC_HOST_NODE_BIN', '/host/bin/node (from host PATH)'],
    ['RAC_HOST_PATH', '/host/bin:/usr/bin (from host tmux PATH)'],
    ['RAC_TEMP_PREVIEW_ORIGIN', 'https://console.example.org (from Application Public Origin)'],
    ['RAC_CONFIG_WRITE_PATH', '/console/config.json (from RAC_CONFIG)'],
    ['RAC_LISTEN_HOST', '::1 (from Application Listen Host)'],
    ['RAC_LISTEN_PORT', '8899 (from Application Listen Port)'],
    ['RAC_CODEX_BIN', '/host/bin/codex (from Application Codex Program)'],
    ['RAC_HOST_CODEX_BIN', '/host/bin/codex (from Application Codex Program)'],
    ['RAC_HOST_TMUX_SOURCE', '/tmp/tmux-1200 (from RAC_HOST_UID)'],
    ['RAC_HOST_UNIX_SOCKETS', '/host-proc/net/unix (from RAC_HOST_PROC)'],
    ['RAC_CLAUDE_CONFIG_DIR', '/home/console/.claude (from HOME)'],
    ['TZ', 'America/Los_Angeles (from host time zone)'],
    ['RAC_TMUX_BIN', '/usr/bin/tmux (from built-in default)']
  ])('resolves %s without writing a configured value', (key, expected) => {
    expect(resolvedEnvironmentFallback(key, context)?.value).toBe(expected);
  });

  // dependency edits update guidance without falling back to the applied source
  it('resolves the current application and environment source values', () => {
    const next = { ...context, application: { publicOrigin: 'https://next.example.org' }, environment: { RAC_HOST_PROC: '/next-proc' } };
    expect(resolvedEnvironmentFallback('RAC_TEMP_PREVIEW_ORIGIN', next)?.value).toBe('https://next.example.org (from Application Public Origin)');
    expect(resolvedEnvironmentFallback('RAC_HOST_UNIX_SOCKETS', next)?.value).toBe('/next-proc/net/unix (from RAC_HOST_PROC)');
  });

  // pending Claude directory edits take precedence over the applied dependency
  it('follows the saved Claude config directory rather than stale process state', () => {
    const next = { ...context, environment: { CLAUDE_CONFIG_DIR: '/saved/claude' }, running: { CLAUDE_CONFIG_DIR: '/running/claude' } };
    expect(resolvedEnvironmentFallback('RAC_CLAUDE_CONFIG_DIR', next)?.value).toBe('/saved/claude (from CLAUDE_CONFIG_DIR)');
  });

  // Projects outside HOME do not prove the host account's Compose interpolation
  it('uses independently observed host socket paths and does not guess HOME from Projects', () => {
    const unknown = { ...context, hostHome: '/srv', application: { projects: [{ path: '/console', hostPath: '/srv/project' }] } };
    expect(resolvedEnvironmentFallback('HOST_TMUX_DIR', unknown)?.value).toBe('Unavailable (from host HOME)');
    const observed = { ...unknown, running: { RAC_HOST_TMUX_SOURCE: '/home/host/.local/state/tmux/tmux-1200' } };
    expect(resolvedEnvironmentFallback('HOST_TMUX_DIR', observed)?.value).toBe('/home/host/.local/state/tmux/tmux-1200 (from running host socket source)');
  });

  // never substitute container node or invent application values after lookup failure
  it('keeps unresolved defaults honest', () => {
    const unavailable = { ...context, application: {}, runtime: {} };
    expect(resolvedEnvironmentFallback('RAC_HOST_NODE_BIN', unavailable)?.value).toBe('Unavailable (from host PATH)');
    expect(resolvedEnvironmentFallback('RAC_TEMP_PREVIEW_ORIGIN', unavailable)?.value).toBe('Unavailable (from Application Public Origin)');
    expect(resolvedEnvironmentFallback('RAC_CLAUDE_BIN', unavailable)?.value).toBe('Not configured (from Application Claude Program)');
  });

  // credential lineage remains symbolic rather than revealing inherited bytes
  it('keeps protected values and custom variables out of concrete defaults', () => {
    expect(resolvedEnvironmentFallback('RAC_INSTANCE_STATUS_SECRET', context)?.value).toBe('Hidden (from RAC_SESSION_SECRET)');
    expect(resolvedEnvironmentFallback('RAC_SESSION_SECRET', context)?.value).toBe('Required; no default');
    expect(resolvedEnvironmentFallback('CUSTOM_VARIABLE', context)).toBeUndefined();
  });
});
