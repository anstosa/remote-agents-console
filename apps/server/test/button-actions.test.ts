import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { ConfiguredButtonCatalog } from '../src/button-actions/catalog.js';
import { ButtonActionError, ButtonActionService, buttonActionDraftInputSchema, buttonActionInputSchema, type ButtonActionDraftInput, type ButtonActionInput } from '../src/button-actions/service.js';
import { defaultButtons, type ButtonSlot, type ButtonSlots, type ConfiguredButton } from '../src/config/buttons.js';
import type { Agent } from '../src/domain/models.js';
import type { Place } from '../src/places/places.js';
import type { PromptRequestStatus } from '../src/prompts/service.js';

// run guarded drafts in an isolated real Bash child
const execFileAsync = promisify(execFile);

const prompt = (text: string, agentPrompt: string): ConfiguredButton => ({ text, color: 'mauve', style: 'solid', action: { agentPrompt } });
const shell = (text: string, shellCommand: string): ConfiguredButton => ({ text, color: 'green', style: 'outline', action: { shellCommand } });
const place: Place = { id: 'project:/workspace', kind: 'worktree', projectId: 'project', label: 'Workspace', home: '/workspace', hostPath: '/host/workspace' };

// build one deterministic application catalog
function catalog(projectButtons?: { leftNav?: ConfiguredButton[]; splits?: { files?: ConfiguredButton[] } }, key = Buffer.alloc(32, 7)): ConfiguredButtonCatalog {
  const buttons: ButtonSlots = structuredClone(defaultButtons);
  buttons.leftNav = [prompt('Ask', 'ask exactly'), prompt('Other', 'other exactly'), shell('Build', 'pnpm build')];
  buttons.splits.files = [shell('Files', 'pwd')];
  return new ConfiguredButtonCatalog({ buttons, projects: [{ id: 'project', buttons: projectButtons }] } as never, key);
}

// select one public locator by text
function actionId(buttons: ConfiguredButtonCatalog, slot: ButtonSlot, text: string): string {
  const found = buttons.value.projects.project![slot].find(button => button.text === text);
  if (found === undefined) throw new Error(`missing ${text}`);
  return found.id;
}

// build one strict action request
function input(buttons: ConfiguredButtonCatalog, text = 'Ask', slot: ButtonSlot = 'leftNav', overrides: Partial<ButtonActionInput> = {}): ButtonActionInput {
  return { requestId: 'request_123456', actionId: actionId(buttons, slot, text), configRevision: buttons.value.revision, placeId: place.id, slot, ...overrides };
}

// build one strict draft request without an execution retry identity
function draftInput(buttons: ConfiguredButtonCatalog, text = 'Ask', slot: ButtonSlot = 'leftNav', overrides: Partial<ButtonActionDraftInput> = {}): ButtonActionDraftInput {
  return { actionId: actionId(buttons, slot, text), configRevision: buttons.value.revision, placeId: place.id, slot, ...overrides };
}

// build one Agent in the requested Place
function agent(kind: Agent['kind'] = 'codex', id = 'agent-1', owner = place.id): Agent {
  return { id, kind, placeId: owner, worktreeId: owner, title: 'Ready', attention: 'finished' } as Agent;
}

// flush detached service execution
async function flush(): Promise<void> {
  // allow nested promise continuations to settle
  for (let index = 0; index < 5; index += 1) await setImmediate();
}

// create a service with inspectable engine fakes
function serviceFixture(options: { catalog?: ConfiguredButtonCatalog; agents?: Agent[]; request?: PromptRequestStatus; now?: () => number; launchAgent?: () => Promise<Agent | undefined> } = {}) {
  const buttons = options.catalog ?? catalog();
  const request = options.request ?? { id: 'prompt-request', agentId: 'agent-1', state: 'queued', submitted: false };
  const submitTracked = vi.fn(async () => ({ requestId: request.id }));
  const requestStatus = vi.fn(() => request);
  const observePrompt = vi.fn(async () => undefined);
  const warn = vi.fn();
  const launchAgent = vi.fn(options.launchAgent ?? (async () => undefined));
  const execute = vi.fn(async () => ({ state: 'complete' as const, exitCode: 0 }));
  const directoryLease = vi.fn(async () => ({ canonicalHostPath: '/host/workspace/subfolder', backendGeneration: 'generation', expiresAt: Date.now() + 60_000, identity: { dev: '1', ino: '2', kind: 'directory' as const }, current: () => true }));
  const dependencies = {
    resolvePlace: async (id: string) => id === place.id ? place : undefined,
    agents: async () => options.agents ?? [agent()],
    launchAgent,
    prompts: { submitTracked, requestStatus },
    observePrompt,
    warn,
    directoryLease,
    shell: { execute },
    ...(options.now === undefined ? {} : { now: options.now })
  };
  return { buttons, service: new ButtonActionService(buttons, dependencies), request, submitTracked, requestStatus, observePrompt, warn, launchAgent, execute, directoryLease, dependencies };
}

// assert one bounded public service failure
async function expectActionError(operation: Promise<unknown>, code: string, statusCode?: number): Promise<void> {
  const error = await operation.then(() => undefined, value => value as ButtonActionError);
  expect(error).toBeInstanceOf(ButtonActionError);
  expect(error?.code).toBe(code);
  if (statusCode !== undefined) expect(error?.statusCode).toBe(statusCode);
}

describe('configured button catalog', () => {
  // project names cannot collide with the application source namespace
  it('isolates an application-named project override from inherited actions', () => {
    const buttons = structuredClone(defaultButtons);
    buttons.leftNav = [prompt('Ask', 'application prompt')];
    const catalog = new ConfiguredButtonCatalog({ buttons, projects: [{ id: 'application', buttons: { leftNav: [prompt('Ask', 'project prompt')] } }, { id: 'other' }] } as never);
    const inherited = catalog.value.application.leftNav[0]!;
    const override = catalog.value.projects.application!.leftNav[0]!;

    expect(inherited.id).not.toBe(override.id);
    expect(catalog.resolve('scratch', 'leftNav', inherited.id, catalog.value.revision)?.action).toEqual({ agentPrompt: 'application prompt' });
    expect(catalog.resolve('other', 'leftNav', inherited.id, catalog.value.revision)?.action).toEqual({ agentPrompt: 'application prompt' });
    expect(catalog.resolve('application', 'leftNav', override.id, catalog.value.revision)?.action).toEqual({ agentPrompt: 'project prompt' });
    expect(catalog.resolve('other', 'leftNav', override.id, catalog.value.revision)).toBeUndefined();
  });

  // retain inherited identity while replacing exact project text in place
  it('projects source ownership into opaque, boot-scoped presentations', () => {
    const first = catalog({ leftNav: [prompt('Ask', 'project ask'), prompt('Added', 'added prompt')] });
    const second = catalog({ leftNav: [prompt('Ask', 'project ask'), prompt('Added', 'added prompt')] }, Buffer.alloc(32, 8));
    const application = first.value.application.leftNav;
    const projectList = first.value.projects.project!.leftNav;

    expect(projectList.map(button => button.text)).toEqual(['Ask', 'Other', 'Build', 'Added']);
    expect(projectList[1]!.id).toBe(application[1]!.id);
    expect(projectList[0]!.id).not.toBe(application[0]!.id);
    expect(projectList[0]!.id).not.toBe(second.value.projects.project!.leftNav[0]!.id);
    expect(JSON.stringify(first.value)).not.toContain('project ask');
    expect(JSON.stringify(first.value)).not.toContain('pnpm build');
    expect(first.resolve('project', 'leftNav', projectList[0]!.id, first.value.revision)).toMatchObject({ action: { agentPrompt: 'project ask' } });
    expect(first.resolve('project', 'rightNav', projectList[0]!.id, first.value.revision)).toBeUndefined();
    expect(first.resolve('project', 'leftNav', projectList[0]!.id, second.value.revision)).toBeUndefined();
  });
});

describe('button action input', () => {
  // reject browser-supplied execution fields and malformed identities
  it('accepts only the strict public request contract', () => {
    const buttons = catalog();
    const valid = input(buttons);
    expect(buttonActionInputSchema.safeParse(valid).success).toBe(true);
    expect(buttonActionInputSchema.safeParse({ ...valid, cwd: '/tmp' }).success).toBe(false);
    expect(buttonActionInputSchema.safeParse({ ...valid, requestId: 'short' }).success).toBe(false);
    expect(buttonActionInputSchema.safeParse({ ...valid, slot: 'split:unknown' }).success).toBe(false);
    expect(buttonActionInputSchema.safeParse({ ...valid, filesDirectoryToken: '' }).success).toBe(false);
  });

  // omit execution retry identity and reject every browser-supplied action value
  it('accepts only the strict draft locator contract', () => {
    const buttons = catalog();
    const valid = draftInput(buttons);
    expect(buttonActionDraftInputSchema.safeParse(valid).success).toBe(true);
    expect(buttonActionDraftInputSchema.safeParse({ ...valid, requestId: 'request_123456' }).success).toBe(false);
    expect(buttonActionDraftInputSchema.safeParse({ ...valid, agentPrompt: 'injected' }).success).toBe(false);
    expect(buttonActionDraftInputSchema.safeParse({ ...valid, shellCommand: 'injected' }).success).toBe(false);
    expect(buttonActionDraftInputSchema.safeParse({ ...valid, cwd: '/tmp' }).success).toBe(false);
  });
});

describe('button action service', () => {
  // preserve trusted bytes while preparing edits without invoking either execution engine
  it('returns exact prompt and shell drafts without executing them', async () => {
    const promptBytes = '  ask exactly\nwith spacing  ';
    const shellBytes = "printf ' exact bytes \\n'";
    const buttons = catalog({ leftNav: [prompt('Ask', promptBytes), shell('Build', shellBytes)] });
    const fixture = serviceFixture({ catalog: buttons, agents: [agent('codex', 'agent-1'), agent('omx', 'agent-2')] });

    const existingDraft = await fixture.service.draft('session', draftInput(buttons));
    const promptDraft = await fixture.service.draft('session', draftInput(buttons, 'Ask', 'leftNav', { agentId: 'agent-2' }));
    const shellDraft = await fixture.service.draft('session', draftInput(buttons, 'Build'));

    expect(existingDraft).toEqual({ kind: 'prompt', text: promptBytes, placeId: place.id, agentId: 'agent-1' });
    expect(promptDraft).toEqual({ kind: 'prompt', text: promptBytes, placeId: place.id, agentId: 'agent-2' });
    expect(shellDraft).toEqual({ kind: 'shell', text: shellBytes, placeId: place.id });
    expect(fixture.launchAgent).not.toHaveBeenCalled();
    expect(fixture.submitTracked).not.toHaveBeenCalled();
    expect(fixture.observePrompt).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  // reject stale or retargeted draft locators and never fall back from an exact Agent
  it('validates draft catalog, Place, project, slot and selected Agent before launch', async () => {
    const buttons = catalog({ leftNav: [prompt('Ask', 'project ask')] });
    const fixture = serviceFixture({ catalog: buttons, agents: [agent('codex', 'eligible'), agent('codex', 'foreign', 'other:/workspace')] });
    const valid = draftInput(buttons);

    await expectActionError(fixture.service.draft('session', { ...valid, configRevision: 'stale' }), 'stale_button_configuration');
    await expectActionError(fixture.service.draft('session', { ...valid, placeId: 'missing:/place' }), 'place_unavailable', 404);
    await expectActionError(fixture.service.draft('session', { ...valid, slot: 'rightNav' }), 'button_unavailable', 404);
    fixture.dependencies.resolvePlace = async id => id === place.id ? { ...place, projectId: 'other' } : undefined;
    await expectActionError(fixture.service.draft('session', valid), 'button_unavailable', 404);
    fixture.dependencies.resolvePlace = async id => id === place.id ? place : undefined;
    await expectActionError(fixture.service.draft('session', { ...valid, agentId: 'foreign' }), 'agent_unavailable', 404);
    await expectActionError(fixture.service.draft('session', { ...valid, agentId: 'missing' }), 'agent_unavailable', 404);
    expect(fixture.launchAgent).not.toHaveBeenCalled();
    expect(fixture.submitTracked).not.toHaveBeenCalled();

    fixture.service.close();
    await expectActionError(fixture.service.draft('session', valid), 'server_stopped', 503);
  });

  // share a normal Place launch between a draft and an executing action
  it('launches only when needed and coalesces concurrent draft and action requests', async () => {
    let resolveLaunch!: (value: Agent) => void;
    const launch = new Promise<Agent>(resolve => { resolveLaunch = resolve; });
    const fixture = serviceFixture({ agents: [], launchAgent: async () => await launch });

    const draft = fixture.service.draft('session', draftInput(fixture.buttons, 'Other'));
    const operation = await fixture.service.start('session', input(fixture.buttons));
    await flush();
    expect(fixture.launchAgent).toHaveBeenCalledTimes(1);

    resolveLaunch(agent());
    await expect(draft).resolves.toEqual({ kind: 'prompt', text: 'other exactly', placeId: place.id, agentId: 'agent-1' });
    await flush();
    expect(operation.id).toBeDefined();
    expect(fixture.submitTracked).toHaveBeenCalledTimes(1);
    expect(fixture.observePrompt).toHaveBeenCalledTimes(1);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  // bound failed, mismatched and unsupported draft Agent resolution
  it('rejects unusable draft launch targets without prompt submission', async () => {
    const missing = serviceFixture({ agents: [], launchAgent: async () => undefined });
    await expectActionError(missing.service.draft('session', draftInput(missing.buttons)), 'agent_launch_failed');

    const mismatched = serviceFixture({ agents: [], launchAgent: async () => agent('codex', 'foreign', 'other:/workspace') });
    await expectActionError(mismatched.service.draft('session', draftInput(mismatched.buttons)), 'agent_launch_mismatch');

    const unsupported = serviceFixture({ agents: [agent('terminal' as Agent['kind'])] });
    await expectActionError(unsupported.service.draft('session', draftInput(unsupported.buttons)), 'agent_kind_unavailable');
    expect(missing.submitTracked).not.toHaveBeenCalled();
    expect(mismatched.submitTracked).not.toHaveBeenCalled();
    expect(unsupported.submitTracked).not.toHaveBeenCalled();
  });

  // validate Files authority only to produce a guarded manual command
  it('guards Files drafts and rejects missing, unexpected, expired or changed leases', async () => {
    const buttons = catalog({ splits: { files: [shell('Files', "echo 'quoted'")] } });
    const fixture = serviceFixture({ catalog: buttons });
    const files = draftInput(fixture.buttons, 'Files', 'split:files');

    await expectActionError(fixture.service.draft('session', files), 'files_context_required', 400);
    await expectActionError(fixture.service.draft('session', draftInput(fixture.buttons, 'Build', 'leftNav', { filesDirectoryToken: 'unexpected-token' })), 'unexpected_files_context', 400);
    fixture.directoryLease.mockResolvedValueOnce({ canonicalHostPath: "/host/workspace/a'b", backendGeneration: 'generation', expiresAt: Date.now() + 60_000, identity: { dev: '1', ino: '2', kind: 'directory' }, current: () => true });
    const guarded = await fixture.service.draft('session', { ...files, filesDirectoryToken: 'valid-token' });
    expect(guarded).toEqual({
      kind: 'shell',
      text: `(if cd -- '/host/workspace/a'\\''b' && [ "$(LC_ALL=C /usr/bin/stat -Lc '%d:%i:%F' -- .)" = '1:2:directory' ]; then BASH_ENV= /bin/bash -c 'echo '\\''quoted'\\'''; else printf '%s\\n' 'Files directory changed; command not run.' >&2; exit 125; fi)`,
      placeId: place.id
    });
    expect(await fixture.service.draft('session', draftInput(fixture.buttons, 'Build'))).toEqual({ kind: 'shell', text: 'pnpm build', placeId: place.id });

    fixture.directoryLease.mockResolvedValueOnce({ canonicalHostPath: '/host/workspace/old', backendGeneration: 'generation', expiresAt: Date.now() - 1, identity: { dev: '1', ino: '2', kind: 'directory' }, current: () => true });
    await expectActionError(fixture.service.draft('session', { ...files, filesDirectoryToken: 'expired-token' }), 'files_context_changed');
    fixture.directoryLease.mockResolvedValueOnce({ canonicalHostPath: '/host/workspace/replaced', backendGeneration: 'generation', expiresAt: Date.now() + 60_000, identity: { dev: '1', ino: '2', kind: 'directory' }, current: () => false });
    await expectActionError(fixture.service.draft('session', { ...files, filesDirectoryToken: 'changed-token' }), 'files_context_changed');
    fixture.directoryLease.mockRejectedValueOnce(new ButtonActionError('files_context_changed', 404));
    await expectActionError(fixture.service.draft('session', { ...files, filesDirectoryToken: 'wrong-token' }), 'files_context_changed', 404);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.launchAgent).not.toHaveBeenCalled();
  });

  // isolate guarded Files drafts from the parent shell and reject changed directories
  it('executes a valid guarded draft without trusting startup files or exiting its parent shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-button-draft-'));
    const directory = join(root, "quoted'directory");
    const moved = join(root, 'original-directory');
    const parentMarker = join(root, 'parent-marker');
    const cwdMarker = join(root, 'cwd-marker');
    const evil = join(root, 'evil-env');
    try {
      await mkdir(directory);
      await writeFile(evil, "printf '%s' bypass > bypass.txt\n", 'utf8');
      const identity = await stat(directory, { bigint: true });
      const buttons = catalog({ splits: { files: [shell('Files', "printf '%s' 'ran' > result.txt")] } });
      const fixture = serviceFixture({ catalog: buttons });
      fixture.directoryLease.mockResolvedValue({
        canonicalHostPath: directory,
        backendGeneration: 'generation',
        expiresAt: Date.now() + 60_000,
        identity: { dev: identity.dev.toString(), ino: identity.ino.toString(), kind: 'directory' },
        current: () => true
      });
      const draft = await fixture.service.draft('session', { ...draftInput(buttons, 'Files', 'split:files'), filesDirectoryToken: 'valid-token' });
      const script = `export BASH_ENV="$EVIL"; ${draft.text}; printf '%s' reached > "$MARKER"; printf '%s' "$PWD" > "$CWD_MARKER"`;
      const environment = { ...process.env, BASH_ENV: '', EVIL: evil, MARKER: parentMarker, CWD_MARKER: cwdMarker };

      await execFileAsync('/bin/bash', ['-c', script], { cwd: root, env: environment });
      expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('ran');
      expect(await readFile(parentMarker, 'utf8')).toBe('reached');
      expect(await readFile(cwdMarker, 'utf8')).toBe(root);
      await expect(readFile(join(directory, 'bypass.txt'), 'utf8')).rejects.toThrow();

      await rm(parentMarker);
      await rename(directory, moved);
      await mkdir(directory);
      await execFileAsync('/bin/bash', ['-c', script], { cwd: root, env: environment });
      expect(await readFile(parentMarker, 'utf8')).toBe('reached');
      await expect(readFile(join(directory, 'result.txt'), 'utf8')).rejects.toThrow();

      await rm(parentMarker);
      await rm(directory, { recursive: true });
      await execFileAsync('/bin/bash', ['-c', script], { cwd: root, env: environment });
      expect(await readFile(parentMarker, 'utf8')).toBe('reached');
      await expect(readFile(join(directory, 'result.txt'), 'utf8')).rejects.toThrow();
    } finally {
      // remove only this test's isolated directory
      await rm(root, { recursive: true, force: true });
    }
  });

  // register retry identity before effects and guard active work globally
  it('recovers lost responses without duplicate submission or foreign disclosure', async () => {
    const fixture = serviceFixture();
    const request = input(fixture.buttons);
    const first = await fixture.service.start('session-a', request);
    await flush();
    const retry = await fixture.service.start('session-a', request);
    const ownerRepeat = await fixture.service.start('session-a', { ...request, requestId: 'request_654321' });

    expect(retry.id).toBe(first.id);
    expect(ownerRepeat.id).toBe(first.id);
    expect(fixture.submitTracked).toHaveBeenCalledTimes(1);
    await expectActionError(fixture.service.start('session-a', { ...request, actionId: actionId(fixture.buttons, 'leftNav', 'Other') }), 'request_id_conflict');
    await expectActionError(fixture.service.start('session-b', { ...request, requestId: 'request_foreign' }), 'action_in_progress');
    await expectActionError(fixture.service.status('session-b', first.id), 'button_action_unavailable', 404);
  });

  // refresh engine completion before refusing a different controller
  it('releases a completed foreign guard without disclosing its operation', async () => {
    const fixture = serviceFixture();
    const first = await fixture.service.start('session-a', input(fixture.buttons));
    await flush();
    fixture.request.state = 'complete';

    const second = await fixture.service.start('session-b', input(fixture.buttons, 'Ask', 'leftNav', { requestId: 'request_second' }));
    await flush();

    expect(second.id).not.toBe(first.id);
    expect(fixture.submitTracked).toHaveBeenCalledTimes(2);
    await expectActionError(fixture.service.status('session-b', first.id), 'button_action_unavailable', 404);
  });

  // surface observer outages while retaining accepted work and its guard
  it('retains accepted prompt work across bounded observer outages', async () => {
    const fixture = serviceFixture();
    const request = input(fixture.buttons);
    const first = await fixture.service.start('session-a', request);
    await flush();
    fixture.observePrompt.mockRejectedValue(new Error('secret prompt and command detail'));

    await expectActionError(fixture.service.status('session-a', first.id), 'button_action_status_unavailable', 503);
    await expectActionError(fixture.service.status('session-a', first.id), 'button_action_status_unavailable', 503);
    expect(fixture.warn).toHaveBeenCalledTimes(1);
    expect(fixture.warn.mock.calls.flat().join(' ')).not.toContain('secret prompt');

    const retry = await fixture.service.start('session-a', request);
    const ownerRepeat = await fixture.service.start('session-a', { ...request, requestId: 'request_owner_repeat' });
    expect(retry).toMatchObject({ id: first.id, state: 'queued', phase: 'reconnecting' });
    expect(ownerRepeat).toMatchObject({ id: first.id, state: 'queued', phase: 'reconnecting' });
    await expectActionError(fixture.service.start('session-b', { ...request, requestId: 'request_foreign' }), 'action_in_progress');
    expect(fixture.submitTracked).toHaveBeenCalledTimes(1);
    expect(fixture.warn).toHaveBeenCalledTimes(1);

    fixture.observePrompt.mockResolvedValue(undefined);
    fixture.request.state = 'complete';
    const completed = await fixture.service.status('session-a', first.id);
    expect(completed).toMatchObject({ id: first.id, state: 'complete' });
    expect(completed).not.toHaveProperty('phase');

    fixture.request.state = 'queued';
    const second = await fixture.service.start('session-b', input(fixture.buttons, 'Ask', 'leftNav', { requestId: 'request_second' }));
    await flush();
    expect(second.id).not.toBe(first.id);
    expect(fixture.submitTracked).toHaveBeenCalledTimes(2);

    fixture.observePrompt.mockRejectedValue(new Error('different sensitive detail'));
    await expectActionError(fixture.service.status('session-b', second.id), 'button_action_status_unavailable', 503);
    await expectActionError(fixture.service.status('session-b', second.id), 'button_action_status_unavailable', 503);
    expect(fixture.warn).toHaveBeenCalledTimes(2);
    expect(fixture.warn.mock.calls.flat().join(' ')).not.toContain('sensitive detail');
    expect(fixture.submitTracked).toHaveBeenCalledTimes(2);
  });

  // keep one Agent's outage latch across another Agent's healthy observation
  it('deduplicates interleaved observer outages per Agent', async () => {
    const fixture = serviceFixture({ agents: [agent('codex', 'agent-a'), agent('codex', 'agent-b')] });
    fixture.observePrompt.mockImplementation(async agentId => {
      // fail only the first Agent's observer
      if (agentId === 'agent-a') throw new Error('agent-a sensitive failure');
    });

    const first = await fixture.service.start('session', input(fixture.buttons, 'Ask', 'leftNav', { agentId: 'agent-a' }));
    await flush();
    expect(fixture.warn).toHaveBeenCalledTimes(1);

    await fixture.service.start('session', input(fixture.buttons, 'Other', 'leftNav', { requestId: 'request_agent_b', agentId: 'agent-b' }));
    await flush();
    await expectActionError(fixture.service.status('session', first.id), 'button_action_status_unavailable', 503);
    expect(fixture.warn).toHaveBeenCalledTimes(1);
  });

  // absorb only the bounded observer outage during internal recovery
  it('propagates unrelated internal status failures', async () => {
    const fixture = serviceFixture();
    const request = input(fixture.buttons);
    await fixture.service.start('session', request);
    await flush();
    const failure = new Error('status engine failure');
    fixture.requestStatus.mockImplementation(() => { throw failure; });

    await expect(fixture.service.start('session', request)).rejects.toBe(failure);
    expect(fixture.submitTracked).toHaveBeenCalledTimes(1);
  });

  // reject stale catalogs, missing Places and foreign selected Agents
  it('validates catalog, Place, slot and Agent membership before side effects', async () => {
    const fixture = serviceFixture({ agents: [agent('codex', 'elsewhere', 'other:/workspace')] });
    const valid = input(fixture.buttons);

    await expectActionError(fixture.service.start('session', { ...valid, configRevision: 'stale' }), 'stale_button_configuration');
    await expectActionError(fixture.service.start('session', { ...valid, requestId: 'request_place', placeId: 'missing:/place' }), 'place_unavailable', 404);
    await expectActionError(fixture.service.start('session', { ...valid, requestId: 'request_slot', slot: 'rightNav' }), 'button_unavailable', 404);
    await expectActionError(fixture.service.start('session', { ...valid, requestId: 'request_agent', agentId: 'elsewhere' }), 'agent_unavailable', 404);
    expect(fixture.submitTracked).not.toHaveBeenCalled();
  });

  // coalesce normal launch while allowing distinct button operations
  it('shares one Place launch across concurrent distinct prompt buttons', async () => {
    let resolveLaunch!: (value: Agent) => void;
    const launch = new Promise<Agent>(resolve => { resolveLaunch = resolve; });
    const fixture = serviceFixture({ agents: [], launchAgent: async () => await launch });

    const first = await fixture.service.start('session', input(fixture.buttons, 'Ask'));
    const second = await fixture.service.start('session', input(fixture.buttons, 'Other', 'leftNav', { requestId: 'request_other' }));
    await flush();
    expect(first.id).not.toBe(second.id);
    expect(fixture.launchAgent).toHaveBeenCalledTimes(1);

    resolveLaunch(agent());
    await flush();
    expect(fixture.submitTracked).toHaveBeenCalledTimes(2);
  });

  // reject launch results that point at another Place
  it('fails a mismatched Place launch before prompt submission', async () => {
    const fixture = serviceFixture({ agents: [], launchAgent: async () => agent('codex', 'foreign-agent', 'other:/workspace') });
    const operation = await fixture.service.start('session', input(fixture.buttons));
    await flush();

    expect(await fixture.service.status('session', operation.id)).toMatchObject({ state: 'failed', error: 'agent_launch_mismatch' });
    expect(fixture.submitTracked).not.toHaveBeenCalled();
  });

  // keep Codex and OMX busy through exact request completion
  it.each(['codex', 'omx'] as const)('projects %s queue, running, completion and uncertainty without replay', async kind => {
    const fixture = serviceFixture({ agents: [agent(kind)] });
    const operation = await fixture.service.start('session', input(fixture.buttons));
    await flush();

    expect(await fixture.service.status('session', operation.id)).toMatchObject({ state: 'queued' });
    fixture.request.state = 'running';
    fixture.request.submitted = true;
    expect(await fixture.service.status('session', operation.id)).toMatchObject({ state: 'running' });
    fixture.request.state = 'complete';
    expect(await fixture.service.status('session', operation.id)).toMatchObject({ state: 'complete' });
    expect(fixture.submitTracked).toHaveBeenCalledTimes(1);

    const lost = serviceFixture({ request: undefined });
    lost.requestStatus.mockReturnValue(undefined);
    const uncertain = await lost.service.start('session', input(lost.buttons));
    await flush();
    expect(await lost.service.status('session', uncertain.id)).toMatchObject({ state: 'interrupted', error: 'prompt_status_unavailable' });
    expect(lost.submitTracked).toHaveBeenCalledTimes(1);

    const rejected = serviceFixture();
    rejected.submitTracked.mockResolvedValue(undefined);
    const failed = await rejected.service.start('session', input(rejected.buttons));
    await flush();
    expect(await rejected.service.status('session', failed.id)).toMatchObject({ state: 'failed', error: 'prompt_submission_failed' });
    expect(rejected.submitTracked).toHaveBeenCalledTimes(1);
  });

  // a launch finishing after shutdown must not deliver its configured prompt
  it('does not submit after an in-flight launch outlives shutdown', async () => {
    let resolveLaunch!: (value: Agent) => void;
    const launch = new Promise<Agent>(resolve => { resolveLaunch = resolve; });
    const fixture = serviceFixture({ agents: [], launchAgent: () => launch });
    const operation = await fixture.service.start('session', input(fixture.buttons));
    await flush();
    expect(fixture.launchAgent).toHaveBeenCalledTimes(1);

    fixture.service.close();
    resolveLaunch(agent());
    await flush();

    expect(fixture.submitTracked).not.toHaveBeenCalled();
    expect(await fixture.service.status('session', operation.id)).toMatchObject({ state: 'interrupted', error: 'server_stopped' });
  });

  // never revive a button after shutdown while submission is unresolved
  it('keeps a deferred prompt interrupted when shutdown wins the race', async () => {
    let resolveSubmission!: (value: { requestId: string }) => void;
    const submission = new Promise<{ requestId: string }>(resolve => { resolveSubmission = resolve; });
    const fixture = serviceFixture();
    fixture.submitTracked.mockImplementation(async () => await submission);
    const operation = await fixture.service.start('session', input(fixture.buttons));
    await flush();
    expect(fixture.submitTracked).toHaveBeenCalledTimes(1);

    fixture.service.close();
    resolveSubmission({ requestId: fixture.request.id });
    await flush();

    expect(await fixture.service.status('session', operation.id)).toMatchObject({ state: 'interrupted', error: 'server_stopped' });
    expect(fixture.requestStatus).not.toHaveBeenCalled();
  });

  // stop Claude loading at actual submission rather than queue acceptance or turn finish
  it('completes Claude only when its queued request becomes submitted', async () => {
    const request: PromptRequestStatus = { id: 'claude-request', agentId: 'claude-1', state: 'queued', submitted: false };
    const fixture = serviceFixture({ agents: [agent('claude', 'claude-1')], request });
    const operation = await fixture.service.start('session', input(fixture.buttons));
    await flush();

    expect(await fixture.service.status('session', operation.id)).toMatchObject({ state: 'queued' });
    request.state = 'running';
    request.submitted = true;
    expect(await fixture.service.status('session', operation.id)).toMatchObject({ state: 'complete', phase: 'submitted' });
    expect(request.state).toBe('running');
  });

  // preserve active work across TTL and evict only old terminal summaries
  it('never evicts active operations and expires terminal retry state', async () => {
    let now = 1_000;
    const fixture = serviceFixture({ now: () => now });
    const request = input(fixture.buttons);
    const operation = await fixture.service.start('session', request);
    await flush();

    now += 11 * 60_000;
    expect(await fixture.service.status('session', operation.id)).toMatchObject({ state: 'queued' });
    fixture.request.state = 'complete';
    await fixture.service.status('session', operation.id);
    now += 11 * 60_000;
    await expectActionError(fixture.service.status('session', operation.id), 'button_action_unavailable', 404);
    const replacement = await fixture.service.start('session', request);
    expect(replacement.id).not.toBe(operation.id);
  });

  // require Files capabilities only for Files shell actions
  it('uses trusted Workspace and Files directories without accepting raw cwd', async () => {
    const fixture = serviceFixture();

    await expectActionError(fixture.service.start('session', input(fixture.buttons, 'Files', 'split:files', { requestId: 'request_files' })), 'files_context_required', 400);
    await expectActionError(fixture.service.start('session', input(fixture.buttons, 'Build', 'leftNav', { requestId: 'request_extra', filesDirectoryToken: 'token-value' })), 'unexpected_files_context', 400);
    const files = await fixture.service.start('session', input(fixture.buttons, 'Files', 'split:files', { requestId: 'request_files_ok', filesDirectoryToken: 'token-value' }));
    await flush();
    expect(files.id).toBeDefined();
    expect(fixture.directoryLease).toHaveBeenCalledWith(place, 'session', 'token-value');
    expect(fixture.execute).toHaveBeenCalledWith(expect.objectContaining({ command: 'pwd', cwd: '/host/workspace/subfolder', lease: expect.any(Object) }));

    await fixture.service.start('session', input(fixture.buttons, 'Build', 'leftNav', { requestId: 'request_build' }));
    await flush();
    expect(fixture.execute).toHaveBeenCalledWith({ command: 'pnpm build', cwd: '/host/workspace' });
  });
});
