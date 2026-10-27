import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoogleCalendarLifecycle } from '../src/google-calendar/lifecycle.js';

const helper = join(process.cwd(), '../../scripts/hooks/rac-claude-lifecycle.mjs');
const sessionId = 'session-1';
const promptId = '00000000-0000-4000-8000-000000000001';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

// create a stateful tmux stub for pane-option compare-and-swap tests
async function fixture(prompt: string, expiresAt = new Date(Date.now() + 30_000).toISOString()) {
  const directory = await mkdtemp(join(tmpdir(), 'rac-claude-lifecycle-'));
  directories.push(directory);
  const file = join(directory, 'state.json');
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
  const arm = { v: 1, state: 'armed', activityId: 'activity-1', nonce: 'nonce-1', promptFingerprint: createHash('sha256').update(prompt).digest('hex'), paneId: '%7', processGeneration: 'generation-1', contract: { cliVersion: 'synthetic-test', payloadContract: 'synthetic-test-v1' }, process: { pid: process.pid, start }, armedAt: new Date().toISOString(), expiresAt };
  await writeFile(file, JSON.stringify({ arm: Buffer.from(JSON.stringify(arm)).toString('base64url') }));
  const spool = join(directory, 'lifecycle.jsonl');
  const callsFile = join(directory, 'commands.jsonl');
  const tmux = join(directory, 'tmux.mjs');
  await writeFile(tmux, `#!/usr/bin/env node
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const file=process.env.STATE_FILE; const args=process.argv.slice(2); const state=JSON.parse(readFileSync(file,'utf8'));
appendFileSync(process.env.TMUX_CALLS,JSON.stringify(args)+'\\n');
if(args[0]==='wait-for'){ if(args[1]==='-L'){if(state.locked){process.exitCode=1;}else{state.locked=true;writeFileSync(file,JSON.stringify(state));}}else if(args[1]==='-U'){state.locked=false;state.unlocks=(state.unlocks||0)+1;writeFileSync(file,JSON.stringify(state));} }
else if(args[0]==='show-options'){ if(state.arm) process.stdout.write(state.arm+'\\n'); else process.exitCode=1; }
else if(args[0]==='set-option'){ const unset=args.includes('-u'); const name=args[args.length-(unset?1:2)]; if(name==='@rac_calendar_arm'){ if(unset) delete state.arm; else state.arm=args.at(-1); } if(name==='@rac_calendar_journal') state.journal=args.at(-1); writeFileSync(file,JSON.stringify(state)); }
`, { mode: 0o755 });
  const traceFile = join(directory, 'filesystem.jsonl');
  const probe = join(directory, 'filesystem-probe.mjs');
  // observe real file descriptors and inject only the selected filesystem failure
  await writeFile(probe, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {dirname} from 'node:path';
const original = {open:fs.openSync,close:fs.closeSync,stat:fs.fstatSync,lstat:fs.lstatSync,sync:fs.fsyncSync,write:fs.writeSync};
const traceFd = original.open(process.env.FS_TRACE,'a',0o600);
const paths = new Map();
const trace = (action,path) => original.write(traceFd,JSON.stringify({action,path})+'\\n');
// retain descriptor identity through every real publication operation
fs.openSync = (path,...args) => { const fd=original.open(path,...args);paths.set(fd,String(path));trace('open',String(path));return fd; };
// validate the opened file rather than a race-prone pathname observation
fs.fstatSync = fd => {
  const value=original.stat(fd);trace('stat',paths.get(fd));
  // emulate a descriptor owned by a different uid without changing host ownership
  if(process.env.FS_FAULT==='owner'&&paths.get(fd)===process.env.RAC_CALENDAR_LIFECYCLE_SPOOL)return {...value,uid:value.uid+1,isFile:()=>value.isFile()};
  return value;
};
// a misleading path stat must not override the authoritative open descriptor size
fs.lstatSync = (path,...args) => { const value=original.lstat(path,...args);return process.env.FS_FAULT==='size'&&String(path)===process.env.RAC_CALENDAR_LIFECYCLE_SPOOL?{...value,size:0}:value; };
// trace actual writes without replacing storage behavior
fs.writeSync = (fd,...args) => {
  trace('write',paths.get(fd));
  // force a stalled append without replacing any other filesystem operation
  if(process.env.FS_FAULT==='zero-write'&&paths.get(fd)===process.env.RAC_CALENDAR_LIFECYCLE_SPOOL)return 0;
  // complete a real partial write so the helper must continue from its returned byte count
  if(process.env.FS_FAULT==='short-write'&&paths.get(fd)===process.env.RAC_CALENDAR_LIFECYCLE_SPOOL)return original.write(fd,args[0],args[1],Math.max(1,Math.floor(args[2]/2)));
  return original.write(fd,...args);
};
// refuse the directory barrier after the file barrier has completed
fs.fsyncSync = fd => {
  trace('sync',paths.get(fd));
  // emulate a failed durable directory publication
  if(process.env.FS_FAULT==='directory-sync'&&paths.get(fd)===dirname(process.env.RAC_CALENDAR_LIFECYCLE_SPOOL))throw new Error('synthetic_directory_sync_failure');
  return original.sync(fd);
};
// keep descriptor reuse from confusing the recorded publication order
fs.closeSync = fd => {trace('close',paths.get(fd));paths.delete(fd);return original.close(fd);};
syncBuiltinESMExports();
`);
  const environment = { ...process.env, RAC_TMUX_BIN: tmux, RAC_CALENDAR_LIFECYCLE_SPOOL: spool, TMUX_PANE: '%7', STATE_FILE: file, TMUX_CALLS: callsFile };
  const hookDirectory = join(directory, 'hook files');
  await mkdir(hookDirectory);
  const attention = join(hookDirectory, 'rac-attention');
  await writeFile(attention, await readFile(join(dirname(helper), 'rac-attention')), { mode: 0o755 });
  await writeFile(join(hookDirectory, 'rac-claude-lifecycle.mjs'), await readFile(helper), { mode: 0o755 });
  // retain direct helper fault injection separately from the real shell handoff
  const invoke = (event: string, body = '', fault = '') => new Promise<void>((resolve, reject) => {
    const child = execFile(process.execPath, ['--import', probe, helper, event], { env: { ...environment, FS_TRACE: traceFile, FS_FAULT: fault } }, error => error ? reject(error) : resolve());
    child.stdin!.end(body);
  });
  // exercise copied production scripts from an adjacent path containing spaces
  const invokeAttention = (args: string[], body = '') => new Promise<void>((resolve, reject) => {
    const child = execFile(attention, args, { env: { ...environment, CLAUDE_CODE_SESSION_ID: sessionId } }, error => error ? reject(error) : resolve());
    child.stdin!.end(body);
  });
  // expose actual attention commands without weakening the pane-state fixture
  const commands = async () => (await readFile(callsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
  // install exact producer wire bytes without re-encoding their object shape
  const setEncodedArm = async (encoded: string) => {
    const current = JSON.parse(await readFile(file, 'utf8'));
    current.arm = encoded;
    await writeFile(file, JSON.stringify(current));
  };
  // encode only synthetic mutations used by adversarial admission scenarios
  const setArm = (arm: unknown) => setEncodedArm(Buffer.from(JSON.stringify(arm)).toString('base64url'));
  // remove only this fixture's synthetic arm to model unsupported ordinary prompts
  const disarm = async () => {
    const current = JSON.parse(await readFile(file, 'utf8'));
    delete current.arm;
    await writeFile(file, JSON.stringify(current));
  };
  const state = async () => JSON.parse(await readFile(file, 'utf8')) as { arm?: string; journal?: string; locked?: boolean; unlocks?: number };
  // read the actual syscall boundary evidence from this isolated helper process
  const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { action: string; path: string });
  return { invoke, invokeAttention, setEncodedArm, setArm, disarm, commands, state, spool, trace };
}

// build the exact synthetic documented hook identity used by dormant helper tests
const startPayload = (prompt: string) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt_id: promptId, prompt });
const questionPayload = (id = promptId) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, prompt_id: id, tool_name: 'AskUserQuestion', tool_input: {}, tool_use_id: 'tool-1' });
const terminalPayload = (event: 'Stop' | 'StopFailure' = 'Stop') => JSON.stringify({ hook_event_name: event, session_id: sessionId, prompt_id: promptId, stop_hook_active: false });

describe('Claude managed lifecycle hook', () => {
  // cover real stdin forwarding and adjacent helper lookup without enabling production compatibility
  it.each(['Stop', 'StopFailure'] as const)('hands start, question and %s payloads through the shell while preserving attention', async terminalEvent => {
    const prompt = 'managed "quoted" work\nwith spaces and unicode λ';
    const test = await fixture(prompt);
    const original = await test.state();
    await test.invokeAttention(['working'], startPayload(prompt));
    expect(await test.state()).toEqual(original);
    await expect(readFile(test.spool, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await test.commands()).toEqual([['set-option', '-p', '-t', '%7', '@rac_attention', 'working', ';', 'set-option', '-p', '-t', '%7', '@rac_question', '', ';', 'set-option', '-p', '-t', '%7', '@rac_session', sessionId]]);

    await test.invokeAttention(['working', '--lifecycle', 'start'], startPayload(prompt));
    const question = questionPayload();
    await test.invokeAttention(['question', '--payload', '--lifecycle', 'question'], question);
    await test.invokeAttention(['finished', '--lifecycle', 'terminal'], terminalPayload(terminalEvent));
    const state = await test.state();
    expect(state.arm).toBeUndefined();
    expect(state.locked).toBe(false);
    const journal = JSON.parse(Buffer.from(state.journal!, 'base64url').toString('utf8'));
    expect(journal).toMatchObject({ activityId: 'activity-1', nonce: 'nonce-1', state: 'terminal', processGeneration: 'generation-1', sessionId, promptId });
    expect(journal.startedAt).toEqual(expect.any(String));
    expect(journal.firstQuestionAt).toEqual(expect.any(String));
    expect(journal.finishedAt).toEqual(expect.any(String));
    const records = (await readFile(test.spool, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const evidence = {
      v: 1, activityId: 'activity-1', nonce: 'nonce-1', paneId: '%7', processGeneration: 'generation-1',
      process: { pid: process.pid, start: expect.any(String) }, contract: { cliVersion: 'synthetic-test', payloadContract: 'synthetic-test-v1' },
      armedAt: expect.any(String), expiresAt: expect.any(String), startedAt: expect.any(String), sessionId, promptId, recordedAt: expect.any(String)
    };
    // exact nested records reject prompt fields even when JSON escapes their content
    expect(records).toEqual([
      { ...evidence, state: 'active' },
      { ...evidence, state: 'active', firstQuestionAt: expect.any(String) },
      { ...evidence, state: 'terminal', firstQuestionAt: expect.any(String), finishedAt: expect.any(String) }
    ]);
    expect(journal).toEqual(records[2]);
    const attention = (await test.commands()).filter(args => args[0] === 'set-option' && args.includes('@rac_attention'));
    expect(attention.map(args => args[args.indexOf('@rac_attention') + 1])).toEqual(['working', 'working', 'question', 'finished']);
    expect(attention[2]).toContain(Buffer.from(question).toString('base64'));
  });

  // generated lifecycle arguments must remain inert without managed authority
  it('preserves ordinary attention and releases locks for unarmed lifecycle hooks', async () => {
    const test = await fixture('ordinary unsupported work');
    await test.disarm();
    await test.invokeAttention(['working', '--lifecycle', 'start'], startPayload('ordinary unsupported work'));
    const question = questionPayload();
    await test.invokeAttention(['question', '--payload', '--lifecycle', 'question'], question);
    await test.invokeAttention(['finished', '--lifecycle', 'terminal'], terminalPayload());
    expect(await test.state()).toEqual({ locked: false, unlocks: 3 });
    await expect(readFile(test.spool, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const attention = (await test.commands()).filter(args => args[0] === 'set-option' && args.includes('@rac_attention'));
    expect(attention.map(args => args[args.indexOf('@rac_attention') + 1])).toEqual(['working', 'question', 'finished']);
    expect(attention[1]).toContain(Buffer.from(question).toString('base64'));
  });

  // pair the real backend producer with the closed helper without production attestation
  it('accepts exact backend-produced arm bytes through the real wrapper and helper', async () => {
    const prompt = 'synthetic producer contract';
    const test = await fixture(prompt);
    const lifecycle = new GoogleCalendarLifecycle({
      file: join(dirname(test.spool), 'backend-lifecycle.json'),
      // compatibility remains test-local and cannot enable the production application
      claudeCompatibility: () => ({ cliVersion: 'synthetic-test', payloadContract: 'synthetic-test-v1' }),
      sink: { admit: async () => true, signal: async () => undefined },
      labels: async () => ({ worktree: 'Cora', agent: 'Claude' })
    });
    const at = new Date().toISOString();
    const admission = { id: 'producer-activity', agentId: 'agent-1', kind: 'claude', submittedAt: at };
    await lifecycle.admit(admission);
    const intent = await lifecycle.beforeSend({ ...admission, prompt, socketFingerprint: 'fixture-socket', socketPath: '/tmp/synthetic-claude-socket', paneId: '%7', processId: process.pid, sentAt: at });
    expect(intent.arm).toEqual(expect.any(String));
    await test.setEncodedArm(intent.arm!);
    expect((await test.state()).arm).toBe(intent.arm);
    const produced = JSON.parse(Buffer.from(intent.arm!, 'base64url').toString('utf8'));
    await test.invokeAttention(['working', '--lifecycle', 'start'], startPayload(prompt));
    const state = await test.state();
    const records = (await readFile(test.spool, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    // exact evidence permits only approved producer identity and observed hook fields
    expect(records).toEqual([{
      v: 1, state: 'active', activityId: admission.id, nonce: produced.nonce, paneId: '%7', processGeneration: produced.processGeneration,
      process: produced.process, contract: { cliVersion: 'synthetic-test', payloadContract: 'synthetic-test-v1' },
      armedAt: at, expiresAt: produced.expiresAt, startedAt: expect.any(String), sessionId, promptId, recordedAt: expect.any(String)
    }]);
    expect(JSON.parse(Buffer.from(state.journal!, 'base64url').toString('utf8'))).toEqual(records[0]);
    expect(JSON.parse(Buffer.from(state.arm!, 'base64url').toString('utf8'))).toEqual(records[0]);
    expect(state.locked).toBe(false);
    const attention = (await test.commands()).filter(args => args[0] === 'set-option' && args.includes('@rac_attention'));
    expect(attention.at(-1)?.[5]).toBe('working');
  });

  // hostile pane metadata must never become lifecycle evidence or stored prompt content
  it.each([
    ['armed', 'root'], ['armed', 'process'], ['armed', 'contract'],
    ['active', 'root'], ['active', 'process'], ['active', 'contract']
  ] as const)('rejects content-bearing %s arm fields in %s', async (phase, location) => {
    const prompt = 'private adversarial prompt';
    const test = await fixture(prompt);
    // active authority must be revalidated as strictly as the original admission
    if (phase === 'active') await test.invoke('start', startPayload(prompt));
    const arm = JSON.parse(Buffer.from((await test.state()).arm!, 'base64url').toString('utf8'));
    const target = location === 'root' ? arm : arm[location];
    target.prompt = prompt;
    await test.setArm(arm);
    const before = await test.state();
    const spool = await readFile(test.spool, 'utf8').catch(() => undefined);
    // preserve ordinary attention while rejecting the untrusted lifecycle authority
    if (phase === 'active') await test.invokeAttention(['question', '--payload', '--lifecycle', 'question'], questionPayload());
    else await test.invokeAttention(['working', '--lifecycle', 'start'], startPayload(prompt));
    const after = await test.state();
    expect(after.arm).toBe(before.arm);
    expect(after.journal).toBe(before.journal);
    expect(after.locked).toBe(false);
    expect(await readFile(test.spool, 'utf8').catch(() => undefined)).toBe(spool);
    const attention = (await test.commands()).filter(args => args[0] === 'set-option' && args.includes('@rac_attention'));
    expect(attention.at(-1)?.[5]).toBe(phase === 'active' ? 'question' : 'working');
  });

  // characterize every closed arm member before reading process or publishing evidence
  it.each([
    ['armed', 'startedAt', '2026-10-23T17:00:00.000Z'],
    ['active', 'promptFingerprint', 'a'.repeat(64)],
    ['armed', 'promptFingerprint', undefined], ['active', 'sessionId', undefined],
    ['armed', 'activityId', 'x'.repeat(257)], ['armed', 'nonce', 'private\nnonce'],
    ['active', 'processGeneration', ''], ['active', 'sessionId', 'private\nsession'],
    ['armed', 'paneId', '%invalid'], ['armed', 'process.pid', 0], ['armed', 'process.start', 'not-digits'],
    ['armed', 'contract.cliVersion', 'x'.repeat(257)], ['armed', 'contract.payloadContract', false],
    ['armed', 'armedAt', 'not-time'], ['armed', 'expiresAt', 'not-time'],
    ['active', 'startedAt', 'not-time'], ['active', 'recordedAt', -1],
    ['armed', 'promptFingerprint', 'not-a-hash'], ['active', 'promptId', 'not-a-uuid'],
    ['active', 'firstQuestionAt', '1970-01-01T00:00:00.001Z']
  ] as const)('rejects invalid arm %s member %s', async (phase, field, value) => {
    const test = await fixture('managed');
    // recover a genuine active successor for active-only validation cases
    if (phase === 'active') await test.invoke('start', startPayload('managed'));
    const arm = JSON.parse(Buffer.from((await test.state()).arm!, 'base64url').toString('utf8'));
    const path = field.split('.');
    let target = arm;
    // mutate only the selected trusted fixture path
    for (const part of path.slice(0, -1)) target = target[part];
    target[path.at(-1)!] = value;
    await test.setArm(arm);
    const before = await test.state();
    const spool = await readFile(test.spool, 'utf8').catch(() => undefined);
    // use valid hook payloads so only the selected arm predicate rejects evidence
    if (phase === 'active') await test.invokeAttention(['question', '--payload', '--lifecycle', 'question'], questionPayload());
    else await test.invokeAttention(['working', '--lifecycle', 'start'], startPayload('managed'));
    const after = await test.state();
    expect(after.arm).toBe(before.arm);
    expect(after.journal).toBe(before.journal);
    expect(after.locked).toBe(false);
    expect(await readFile(test.spool, 'utf8').catch(() => undefined)).toBe(spool);
  });

  // malformed payload identity cannot enter a newly published active arm
  it('rejects a control-bearing session before active evidence publication', async () => {
    const test = await fixture('managed');
    await test.invokeAttention(['working', '--lifecycle', 'start'], JSON.stringify({ ...JSON.parse(startPayload('managed')), session_id: 'private\nsession' }));
    const state = await test.state();
    expect(state.arm).toBeUndefined();
    expect(state.locked).toBe(false);
    const journal = JSON.parse(Buffer.from(state.journal!, 'base64url').toString('utf8'));
    expect(journal).toMatchObject({ state: 'invalid', reason: 'missing_lifecycle_evidence' });
    expect(journal).not.toHaveProperty('sessionId');
    expect(journal).not.toHaveProperty('promptId');
    const records = (await readFile(test.spool, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(records).toEqual([journal]);
    const attention = (await test.commands()).filter(args => args[0] === 'set-option' && args.includes('@rac_attention'));
    expect(attention.at(-1)?.[5]).toBe('working');
  });

  // rejected spool paths must not modify another file or repair exposed permissions
  it.each(['symlink', 'directory', 'exposed'] as const)('refuses a %s spool without touching its target', async kind => {
    const test = await fixture('managed');
    const protectedFile = join(dirname(test.spool), 'protected.txt');
    await writeFile(protectedFile, 'unchanged', { mode: 0o640 });
    await chmod(protectedFile, 0o640);
    // a link cannot redirect append or chmod to a different same-account file
    if (kind === 'symlink') await symlink(protectedFile, test.spool);
    // reject a nonregular target before writing any evidence
    if (kind === 'directory') await mkdir(test.spool);
    // an existing exposed file is rejected rather than silently chmodded
    if (kind === 'exposed') {
      await writeFile(test.spool, 'unchanged', { mode: 0o644 });
      await chmod(test.spool, 0o644);
    }
    await test.invoke('start', startPayload('managed'));
    expect(await readFile(protectedFile, 'utf8')).toBe('unchanged');
    expect((await stat(protectedFile)).mode & 0o777).toBe(0o640);
    // retain the original public-mode file unchanged on refusal
    if (kind === 'exposed') {
      expect(await readFile(test.spool, 'utf8')).toBe('unchanged');
      expect((await stat(test.spool)).mode & 0o777).toBe(0o644);
    }
    expect(JSON.parse(Buffer.from((await test.state()).journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid' });
  });

  // only the size on the opened regular descriptor can authorize a bounded append
  it('uses descriptor size instead of a misleading path stat', async () => {
    const test = await fixture('managed');
    await writeFile(test.spool, Buffer.alloc(8 * 1024 * 1024, 0x20), { mode: 0o600 });
    await test.invoke('start', startPayload('managed'), 'size');
    expect((await stat(test.spool)).size).toBe(8 * 1024 * 1024);
    expect(JSON.parse(Buffer.from((await test.state()).journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid' });
  });

  // reject foreign descriptor ownership before any append
  it('rejects a spool descriptor whose owner does not match the helper', async () => {
    const test = await fixture('managed');
    await writeFile(test.spool, '', { mode: 0o600 });
    await test.invoke('start', startPayload('managed'), 'owner');
    expect(await readFile(test.spool, 'utf8')).toBe('');
    expect(JSON.parse(Buffer.from((await test.state()).journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid' });
  });

  // partial regular-file writes must complete one parseable record before acknowledgement
  it('finishes short writes before publishing active lifecycle authority', async () => {
    const test = await fixture('managed');
    await test.invoke('start', startPayload('managed'), 'short-write');
    expect(JSON.parse(await readFile(test.spool, 'utf8'))).toMatchObject({ state: 'active', activityId: 'activity-1' });
    expect(JSON.parse(Buffer.from((await test.state()).journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'active' });
    expect((await test.trace()).filter(entry => entry.action === 'write' && entry.path === test.spool).length).toBeGreaterThan(1);
  });

  // a stalled write must not acknowledge partial or empty durable evidence
  it('fails closed when a spool write makes no progress', async () => {
    const test = await fixture('managed');
    await test.invoke('start', startPayload('managed'), 'zero-write');
    expect(await readFile(test.spool, 'utf8')).toBe('');
    const state = await test.state();
    expect(state.arm).toBeUndefined();
    expect(JSON.parse(Buffer.from(state.journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid' });
  });

  // a failed parent barrier cannot acknowledge a durable lifecycle publication
  it('fails closed when the directory durability barrier rejects publication', async () => {
    const test = await fixture('managed');
    await test.invoke('start', startPayload('managed'), 'directory-sync');
    const state = await test.state();
    expect(state.arm).toBeUndefined();
    expect(JSON.parse(Buffer.from(state.journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid' });
  });

  it('consumes one matching arm and keeps authority through question to terminal', async () => {
    const prompt = 'perform the managed task';
    const test = await fixture(prompt);
    await test.invoke('start', startPayload(prompt));
    await test.invoke('question', questionPayload());
    await test.invoke('terminal', terminalPayload());
    const state = await test.state();
    expect(state.arm).toBeUndefined();
    expect(state.locked).toBe(false);
    expect(state.unlocks).toBe(3);
    const journal = JSON.parse(Buffer.from(state.journal!, 'base64url').toString('utf8'));
    expect(journal).toMatchObject({ activityId: 'activity-1', nonce: 'nonce-1', state: 'terminal', processGeneration: 'generation-1' });
    expect(journal.startedAt).toEqual(expect.any(String));
    expect(journal.firstQuestionAt).toEqual(expect.any(String));
    expect(journal.finishedAt).toEqual(expect.any(String));
    const spooled = (await readFile(test.spool, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(spooled.map(entry => entry.state)).toEqual(['active', 'active', 'terminal']);
    expect(await stat(test.spool).then(value => value.mode & 0o777)).toBe(0o600);
    const trace = await test.trace();
    const written = trace.findIndex(entry => entry.action === 'write' && entry.path === test.spool);
    const fileSync = trace.findIndex(entry => entry.action === 'sync' && entry.path === test.spool);
    const directorySync = trace.findIndex(entry => entry.action === 'sync' && entry.path === dirname(test.spool));
    expect(written).toBeGreaterThanOrEqual(0);
    expect(fileSync).toBeGreaterThan(written);
    expect(directorySync).toBeGreaterThan(fileSync);
  });

  // fail closed at each prompt admission boundary including the helper's input bound
  it('rejects stale, wrong-fingerprint and oversized starts without establishing authority', async () => {
    const stale = await fixture('expected', new Date(Date.now() - 1_000).toISOString());
    await stale.invoke('start', startPayload('expected'));
    expect(JSON.parse(Buffer.from((await stale.state()).journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid', reason: 'missing_lifecycle_evidence' });
    const wrong = await fixture('expected');
    await wrong.invoke('start', startPayload('direct terminal input'));
    expect(JSON.parse(Buffer.from((await wrong.state()).journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid', reason: 'missing_lifecycle_evidence' });
    const oversized = await fixture('expected');
    await oversized.invoke('start', startPayload('x'.repeat(65_537)));
    expect(JSON.parse(Buffer.from((await oversized.state()).journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid', reason: 'missing_lifecycle_evidence' });
  });

  it('invalidates an active generation on a fresh unarmed prompt submission', async () => {
    const prompt = 'managed';
    const test = await fixture(prompt);
    await test.invoke('start', startPayload(prompt));
    await test.invoke('start', startPayload('new direct input'));
    const state = await test.state();
    expect(state.arm).toBeUndefined();
    const journal = JSON.parse(Buffer.from(state.journal!, 'base64url').toString('utf8'));
    expect(journal).toMatchObject({ state: 'invalid', reason: 'missing_lifecycle_evidence' });
  });

  it('rejects a replacement prompt identity', async () => {
    const test = await fixture('managed');
    await test.invoke('start', startPayload('managed'));
    await test.invoke('question', questionPayload('00000000-0000-4000-8000-000000000002'));
    const journal = JSON.parse(Buffer.from((await test.state()).journal!, 'base64url').toString('utf8'));
    expect(journal).toMatchObject({ state: 'invalid', reason: 'missing_lifecycle_evidence' });
  });

  it('fails closed without deleting full-spool evidence or another writer lock', async () => {
    const full = await fixture('managed');
    await writeFile(full.spool, Buffer.alloc(8 * 1024 * 1024, 0x20));
    await full.invoke('start', startPayload('managed'));
    const fullState = await full.state();
    expect(fullState.arm).toBeUndefined();
    expect(JSON.parse(Buffer.from(fullState.journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid', reason: 'missing_lifecycle_evidence' });
    expect(await stat(full.spool).then(value => value.size)).toBe(8 * 1024 * 1024);

    const locked = await fixture('managed');
    await writeFile(`${locked.spool}.lock`, 'other-writer', { mode: 0o600 });
    await locked.invoke('start', startPayload('managed'));
    expect(await readFile(`${locked.spool}.lock`, 'utf8')).toBe('other-writer');
    expect(JSON.parse(Buffer.from((await locked.state()).journal!, 'base64url').toString('utf8'))).toMatchObject({ state: 'invalid', reason: 'missing_lifecycle_evidence' });
  });
});
