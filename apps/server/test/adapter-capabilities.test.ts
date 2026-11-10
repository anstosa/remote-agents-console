import { describe, expect, it } from 'vitest';
import { adapterCapabilities, launchTransport } from '../src/adapters/registry.js';

describe('adapterCapabilities', () => {
  it('publishes intrinsic Codex capabilities unlaunchable in an observe-only configuration', () => {
    const codex = adapterCapabilities({}).codex;
    expect(codex).toMatchObject({ launchable: false, stateSource: 'title', conversations: true });
    expect(codex?.program).toBeUndefined();
    expect(codex?.unavailableReason).toBeUndefined();
  });

  it('derives the two conversation capabilities: naming and listing on every kind', () => {
    // `naming` is the conversations facet's rename, `conversations` its list;
    // every registered kind names and lists (Codex and OMX share one rollout reader, ADR 0005)
    for (const kind of ['codex', 'omx', 'claude'] as const) {
      expect(adapterCapabilities({})[kind], kind).toMatchObject({ naming: true, conversations: true });
    }
  });

  it('publishes the configured program and gates launchability on it', () => {
    const configured = adapterCapabilities({ codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true } }).codex;
    expect(configured).toMatchObject({ launchable: true, program: '/usr/local/bin/codex' });

    const unavailable = adapterCapabilities({ codex: { program: '/nope', args: [], env: {}, launchable: false, unavailableReason: '/nope is not an executable file' } }).codex;
    expect(unavailable).toMatchObject({ launchable: false, program: '/nope', unavailableReason: '/nope is not an executable file' });
  });

  it('keeps native defaults distinct from an explicit deny-all model policy', () => {
    const nativeDefault = adapterCapabilities({ codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true } }).codex;
    const denyAll = adapterCapabilities({ codex: { program: '/usr/local/bin/codex', args: [], env: {}, launchable: true, allowedModels: [] } }).codex;

    expect(nativeDefault).toMatchObject({ launchable: true });
    expect(nativeDefault).not.toHaveProperty('allowedModels');
    expect(denyAll).toMatchObject({ launchable: false, allowedModels: [], unavailableReason: 'No models are allowed for this Agent.' });
  });

  it('marks a registered kind unlaunchable when an adapters block omits it', () => {
    // an observe-only console: the adapters block exists but configures nothing
    expect(adapterCapabilities({}).codex).toMatchObject({ launchable: false });
    expect(adapterCapabilities({}).codex?.program).toBeUndefined();
  });

  it('derives Claude capabilities: reported state, naming, listing, commands and inline questions, no turns', () => {
    const claude = adapterCapabilities({ claude: { program: '/usr/local/bin/claude', args: [], env: {}, launchable: true } }).claude;
    expect(claude).toMatchObject({ launchable: true, program: '/usr/local/bin/claude', stateSource: 'reported', naming: true, conversations: true, commands: true, turnCapture: false, inlineQuestions: true, sandbox: false });
  });

  it('offers a Sandboxed launch for Pi, whose extension confines its tool calls', () => {
    expect(adapterCapabilities({ pi: { program: process.execPath, args: [], env: {}, launchable: true } }).pi).toMatchObject({ launchable: true, sandbox: true });
  });

  it('publishes each kind over every Transport it launches on, flattened over its default one', () => {
    const published = adapterCapabilities({});
    expect(Object.keys(published)).toEqual(['codex', 'omx', 'claude', 'pi']);
    for (const [kind, capability] of Object.entries(published)) {
      const { transport, transports, ...flat } = capability!;
      expect(flat, kind).toEqual(transports[transport]);
    }
    expect(published.claude).toMatchObject({ transport: 'tmux', transports: { tmux: { inlineQuestions: true, steer: false }, structured: { stateSource: 'reported', inlineQuestions: true, steer: true, sandbox: false } } });
    expect(published.pi).toMatchObject({ transport: 'structured', transports: { structured: { stateSource: 'reported', turnCapture: true, sandbox: true } } });
    expect(published.pi?.transports.tmux).toBeUndefined();
  });
});

describe('launchTransport', () => {
  it('launches a single-Transport kind over its only Transport, and an unregistered kind over none', () => {
    expect(launchTransport('codex', {})).toBe('tmux');
    expect(launchTransport('omx', {})).toBe('tmux');
    expect(launchTransport('claude', {})).toBe('tmux');
    expect(launchTransport('pi', {})).toBe('structured');
    expect(launchTransport('opencode', {})).toBeUndefined();
  });

  it('launches Claude, which has both, over the Transport its config names, tmux by default', () => {
    const claude = { program: process.execPath, args: [], env: {}, launchable: true };
    expect(launchTransport('claude', { claude })).toBe('tmux');
    expect(launchTransport('claude', { claude: { ...claude, transport: 'structured' } })).toBe('structured');
    expect(launchTransport('claude', { claude: { ...claude, transport: 'tmux' } })).toBe('tmux');
  });

  it('publishes Claude flat over its configured Transport, keeping both entries for its Agents', () => {
    const claude = { program: process.execPath, args: [], env: {}, launchable: true, transport: 'structured' as const };
    const published = adapterCapabilities({ claude }).claude!;
    const { transport, transports, ...flat } = published;
    expect(transport).toBe('structured');
    expect(flat).toEqual(transports.structured);
    expect(transports.tmux).toMatchObject({ launchable: true, steer: false });
    expect(flat).toMatchObject({ launchable: true, steer: true, turnCapture: true, naming: true, sandbox: false });
  });
});
