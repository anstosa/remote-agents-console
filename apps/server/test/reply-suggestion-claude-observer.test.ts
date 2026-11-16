import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeHooksSettings } from '../src/adapters/claude-hooks.js';
import { ClaudeReplySourcePolicyTracker, claudeReplyObserverStatePath, readClaudeReplyObserverState } from '../src/reply-suggestions/claude-observer.js';

const roots: string[] = [];
const trackers: ClaudeReplySourcePolicyTracker[] = [];
const approved = `${JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'shift+up': null, 'shift+down': null } }] }, null, 2)}\n`;

afterEach(async () => {
  // stop profile watchers before deleting their roots
  for (const tracker of trackers.splice(0)) tracker.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// run one metadata-only observer invocation
async function observer(root: string, mode: 'hook' | 'status', payload: object, event?: string): Promise<void> {
  const script = join(process.cwd(), '..', '..', 'scripts', 'hooks', 'rac-reply-source');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, mode, ...(event === undefined ? [] : [event])], {
      env: { ...process.env, NODE_ENV: 'test', RAC_REPLY_TEST_PROCESS: '999:100', RAC_REPLY_SOURCE_DIR: join(root, 'observer'), RAC_REPLY_POLICY_NONCE: 'policy-1' },
      stdio: ['pipe', 'ignore', 'pipe']
    });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`observer exited ${code}: ${diagnostics}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}

// create one exact approved private profile
async function profile(settings?: object): Promise<{ root: string; configDir: string; observerDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-claude-observer-'));
  roots.push(root);
  const configDir = join(root, '.claude');
  const observerDir = join(root, 'observer');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, 'keybindings.json'), approved, { mode: 0o600 });
  await chmod(join(configDir, 'keybindings.json'), 0o600);
  // write only an explicit operator settings fixture
  if (settings !== undefined) await writeFile(join(configDir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  return { root, configDir, observerDir };
}

describe('Claude reply source observer', () => {
  // reporter edits cannot reuse a boot acknowledgement even before watch delivery
  it('permanently retires a changed reporter closure', async () => {
    const fixture = await profile();
    const reporterPath = join(fixture.root, 'reporter');
    await writeFile(reporterPath, 'trusted reporter');
    const tracker = new ClaudeReplySourcePolicyTracker({ configDir: fixture.configDir, observerDir: fixture.observerDir, reporterPath });
    trackers.push(tracker);
    expect(await tracker.initialize()).toBe(true);
    expect(tracker.snapshot()).toBeDefined();
    await writeFile(reporterPath, 'changed reporter');
    expect(tracker.snapshot()).toBeUndefined();
    await writeFile(reporterPath, 'trusted reporter');
    expect(tracker.snapshot()).toBeUndefined();
    expect(tracker.readiness().status).toBe('untrusted');
  });

  it('adds bounded hooks only after the approved watched policy and preserves monotonic ABA evidence', async () => {
    const fixture = await profile();
    const tracker = new ClaudeReplySourcePolicyTracker({ configDir: fixture.configDir, observerDir: fixture.observerDir });
    trackers.push(tracker);
    await expect(tracker.initialize()).resolves.toBe(true);
    const settings = claudeHooksSettings({ repoRoot: join(process.cwd(), '..', '..') });
    expect(settings.statusLine?.command).toContain('rac-reply-source');
    expect(settings.statusLine?.refreshInterval).toBe(1);
    expect(settings.hooks.PreModelSwitch).toHaveLength(1);
    expect(settings.hooks.PostModelSwitch).toHaveLength(1);

    const session = '11111111-2222-4333-8444-555555555555';
    await observer(fixture.root, 'hook', { session_id: session }, 'SessionStart');
    await observer(fixture.root, 'status', { session_id: session, model: { id: 'claude-opus-5-5' }, effort: { level: 'high' } });
    const first = await readClaudeReplyObserverState(fixture.observerDir, session);
    expect(first).toMatchObject({ processPid: 999, processStartTime: '100', heartbeatSeq: 1, hookSeq: 1, statusHookSeq: 1, sourceEpoch: 2, model: 'claude-opus-5-5', effort: 'high' });

    await observer(fixture.root, 'status', { session_id: session, model: { id: 'claude-opus-5-5' }, effort: { level: 'low' } });
    await observer(fixture.root, 'status', { session_id: session, model: { id: 'claude-opus-5-5' }, effort: { level: 'high' } });
    const aba = await readClaudeReplyObserverState(fixture.observerDir, session);
    expect(aba).toMatchObject({ heartbeatSeq: 3, sourceEpoch: 4, effort: 'high' });
    expect(aba!.bootNonce).toBe(first!.bootNonce);
    expect(await readFile(claudeReplyObserverStatePath(fixture.observerDir, session), 'utf8')).not.toContain('prompt');
  });

  it('leaves an existing operator status line untouched and makes the source policy unavailable', async () => {
    const fixture = await profile({ statusLine: { type: 'command', command: '/operator/status' } });
    const tracker = new ClaudeReplySourcePolicyTracker({ configDir: fixture.configDir, observerDir: fixture.observerDir });
    trackers.push(tracker);
    await expect(tracker.initialize()).resolves.toBe(false);
    expect(tracker.snapshot()).toBeUndefined();
    expect(claudeHooksSettings({ repoRoot: '/srv/remoteagents' }).statusLine).toBeUndefined();
  });

  it('retires old generations but requalifies documented model and effort settings only', async () => {
    const fixture = await profile({
      model: 'claude-opus-5-5',
      effortLevel: 'high',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
      permissions: { deny: ['Bash'] }
    });
    const tracker = new ClaudeReplySourcePolicyTracker({ configDir: fixture.configDir, observerDir: fixture.observerDir });
    trackers.push(tracker);
    await expect(tracker.initialize()).resolves.toBe(true);
    const initial = tracker.snapshot()!;
    await writeFile(join(fixture.configDir, 'settings.json'), JSON.stringify({
      model: 'claude-sonnet-5-5',
      effortLevel: 'low',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } },
      permissions: { deny: ['Bash'] }
    }));
    // allow fs.watch to publish the temporary unready generation
    await new Promise(resolve => setTimeout(resolve, 30));
    await expect(tracker.settled()).resolves.toBe(true);
    expect(tracker.snapshot()).toMatchObject({ policyNonce: initial.policyNonce });
    expect(tracker.snapshot()!.generation).toBeGreaterThan(initial.generation);
    const selectedGeneration = tracker.snapshot()!.generation;
    await writeFile(join(fixture.configDir, 'settings.json'), JSON.stringify({
      model: 'claude-sonnet-5-5',
      effortLevel: 'low',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } },
      permissions: { deny: ['Bash'] }
    }));
    await new Promise(resolve => setTimeout(resolve, 30));
    await expect(tracker.settled()).resolves.toBe(true);
    expect(tracker.snapshot()!.generation).toBeGreaterThan(selectedGeneration);

    await writeFile(join(fixture.configDir, 'settings.json'), JSON.stringify({
      model: 'claude-sonnet-5-5',
      permissions: { deny: [] }
    }));
    await new Promise(resolve => setTimeout(resolve, 30));
    await expect(tracker.settled()).resolves.toBe(false);
    expect(tracker.readiness().status).toBe('untrusted');
  });
});
