import { describe, expect, it } from 'vitest';
import { conversationEnvironment } from '../src/adapters/conversation-environment.js';
import { codexHome } from '../src/adapters/codex-conversations.js';
import { claudeConfigDir } from '../src/adapters/claude-conversations.js';

const observer = { HOME: '/server', CODEX_HOME: '/observed/codex', RAC_CLAUDE_CONFIG_DIR: '/observed/claude', PI_CODING_AGENT_DIR: '/observed/pi', OPENAI_API_KEY: 'server-only-secret' };

describe('current conversation store environment', () => {
  // a native launch uses its declared profile without inheriting unrelated server selectors or secrets
  it('reads the current native Codex store without copying observer selectors or secrets', () => {
    const env = conversationEnvironment('codex', {}, '/server', '/server', observer);
    expect(codexHome(env)).toBe('/server/.codex');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  // a configured account HOME must not inherit another profile's server selectors
  it('isolates a configured HOME from the observer store', () => {
    const env = conversationEnvironment('codex', { HOME: '/current', KEEP: 'value' }, '/server', '/server', observer);
    expect(env).toEqual({ HOME: '/current', KEEP: 'value' });
    expect(codexHome(env)).toBe('/current/.codex');
  });

  // explicit roots remain authoritative even when their path resembles a default
  it('keeps an explicit Codex state directory', () => {
    const env = conversationEnvironment('codex', { CODEX_HOME: '/server/.codex' }, '/server', '/server', observer);
    expect(codexHome(env)).toBe('/server/.codex');
  });

  // native launches under another default HOME are not container aliases
  it('does not substitute observer roots for another native launch home', () => {
    const env = conversationEnvironment('codex', {}, '/current', '/current', observer);
    expect(codexHome(env)).toBe('/current/.codex');
  });

  // the bridged default may be mounted at a different container path
  it('maps only the known bridged default profile to its readable store', () => {
    const bridge = { ...observer, RAC_HOST_TMUX_DIR: '/host-tmux' };
    expect(codexHome(conversationEnvironment('omx', {}, '/host', '/host', bridge))).toBe('/observed/codex');
    expect(codexHome(conversationEnvironment('omx', { HOME: '/other' }, '/host', '/host', bridge))).toBe('/other/.codex');
  });

  // server-only Claude mounts must not override an explicitly selected runtime directory
  it('honors the configured Claude selector over the observer seam', () => {
    const env = conversationEnvironment('claude', { CLAUDE_CONFIG_DIR: '/current/claude' }, '/server', '/server', observer);
    expect(claudeConfigDir(env)).toBe('/current/claude');
    expect(env.RAC_CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  // managed host Pi launches always receive the runtime-owned same-path selector
  it('matches the host Pi runtime state override', () => {
    const env = conversationEnvironment('pi', { HOME: '/host', PI_CODING_AGENT_DIR: '/ignored' }, '/host', '/host', { ...observer, RAC_HOST_TMUX_DIR: '/host-tmux' });
    expect(env).toEqual({ HOME: '/host', PI_CODING_AGENT_DIR: '/observed/pi' });
  });
});
