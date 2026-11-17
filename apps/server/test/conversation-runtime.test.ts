import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from '../src/discovery/service.js';
import { adhocScratchPlace } from '../src/places/places.js';
import { holderProcesses, type HolderWindows } from '../src/transports/structured-agents.js';
import type { AgentKind } from '../src/adapters/types.js';

const roots: string[] = [];
const id = '11111111-2222-4333-8444-555555555555';

// keep the tests independent of real profiles and stored credentials
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// model actual provider files rather than making transcript lookup succeed through a double
async function history(kind: AgentKind, store: string, cwd: string, conversationId = id): Promise<void> {
  // Claude keys each transcript by its project directory
  if (kind === 'claude') {
    const directory = join(store, 'projects', cwd.replace(/[^a-zA-Z0-9]/gu, '-'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${conversationId}.jsonl`), [
      { type: 'custom-title', customTitle: 'Configured history' },
      { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { content: 'hello' }, timestamp: '2026-11-17T10:00:00Z' },
    ].map(record => JSON.stringify(record)).join('\n'));
    return;
  }
  // Pi returns a session-file reference, while credentials remain under the current profile
  const directory = join(store, 'sessions', `--${resolve(cwd).replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `2026-11-17_${conversationId}.jsonl`), [
    { type: 'session', id: conversationId, timestamp: '2026-11-17T09:00:00Z' },
    { type: 'session_info', name: 'Configured history', timestamp: '2026-11-17T10:00:00Z' },
  ].map(record => JSON.stringify(record)).join('\n'));
}

// point the server default at an unrelated profile to catch implicit process-env lookups
async function fixture(kind: 'claude' | 'pi', selector: 'home' | 'directory') {
  const root = await mkdtemp(join(tmpdir(), 'rac-conversation-runtime-'));
  roots.push(root);
  const cwd = join(root, 'checkout');
  const sourceHome = join(root, 'source-home');
  const currentHome = join(root, 'current-home');
  const suffix = kind === 'claude' ? ['.claude'] : ['.pi', 'agent'];
  const source = join(sourceHome, ...suffix);
  const current = join(currentHome, ...suffix);
  await mkdir(cwd);
  vi.stubEnv('HOME', sourceHome);
  vi.stubEnv('RAC_HOST_TMUX_DIR', undefined);
  vi.stubEnv('RAC_CLAUDE_CONFIG_DIR', join(sourceHome, '.claude'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(sourceHome, '.claude'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(sourceHome, '.pi', 'agent'));
  const env: Record<string, string> = {};
  // explicit state roots and account HOME are separate supported selectors
  if (selector === 'home') env.HOME = currentHome;
  else env[kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'PI_CODING_AGENT_DIR'] = current;
  const configured = { program: '/bin/false', args: [], env, launchable: true };
  // stop at the external process boundary after real store lookup has completed
  const open = vi.fn<HolderWindows['openHolderWindow']>(async () => undefined);
  const windows: HolderWindows = { openHolderWindow: open, captureHolder: async () => undefined, holderRunning: async () => false, closeHolder: async () => undefined };
  const processes = holderProcesses(windows, { [kind]: configured }, undefined, sourceHome);
  return { cwd, source, current, configured, processes, open };
}

describe.each(['claude', 'pi'] as const)('%s configured conversation lookup', kind => {
  // configured HOME and explicit state-directory overrides must select the same store as launch
  it.each(['home', 'directory'] as const)('resumes from the configured %s profile', async selector => {
    const test = await fixture(kind, selector);
    await history(kind, test.current, test.cwd);
    const discovery = new DiscoveryService(undefined, undefined, undefined, undefined, { [kind]: test.configured });
    expect((await discovery.conversations([test.cwd])).map(row => row.id)).toEqual([id]);

    await test.processes.start({ id: 'agent', kind, place: adhocScratchPlace(test.cwd), resume: id, sandboxed: false, nonce: 'nonce' }, () => {});

    expect(test.open).toHaveBeenCalledTimes(1);
    expect(test.open.mock.calls[0]?.[2].args).toContain(kind === 'claude' ? id : join(test.current, 'sessions', `--${test.cwd.slice(1).replaceAll('/', '-')}--`, `2026-11-17_${id}.jsonl`));
  });

  // a server-default transcript is not available to a CLI launched under another configured store
  it('refuses process-default-only history before creating a holder', async () => {
    const test = await fixture(kind, 'directory');
    await history(kind, test.source, test.cwd);

    await test.processes.start({ id: 'agent', kind, place: adhocScratchPlace(test.cwd), resume: id, sandboxed: false, nonce: 'nonce' }, () => {});

    expect(test.open).not.toHaveBeenCalled();
  });
});

describe('configured latest conversation', () => {
  // continue must select the configured profile's history rather than the server's unrelated history
  it('uses the configured Claude store when resolving latest', async () => {
    const test = await fixture('claude', 'directory');
    const sourceId = '22222222-3333-4333-8444-555555555555';
    await history('claude', test.source, test.cwd, sourceId);
    await history('claude', test.current, test.cwd);

    await test.processes.start({ id: 'agent', kind: 'claude', place: adhocScratchPlace(test.cwd), continue: true, sandboxed: false, nonce: 'nonce' }, () => {});

    expect(test.open).toHaveBeenCalledTimes(1);
    expect(test.open.mock.calls[0]?.[2].args).toContain(id);
    expect(test.open.mock.calls[0]?.[2].args).not.toContain(sourceId);
  });
});
