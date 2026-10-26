import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
  const tmux = join(directory, 'tmux.mjs');
  await writeFile(tmux, `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const file=process.env.STATE_FILE; const args=process.argv.slice(2); const state=JSON.parse(readFileSync(file,'utf8'));
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
  const invoke = (event: string, body = '', fault = '') => new Promise<void>((resolve, reject) => {
    const child = execFile(process.execPath, ['--import', probe, helper, event], { env: { ...process.env, RAC_TMUX_BIN: tmux, RAC_CALENDAR_LIFECYCLE_SPOOL: spool, TMUX_PANE: '%7', STATE_FILE: file, FS_TRACE: traceFile, FS_FAULT: fault } }, error => error ? reject(error) : resolve());
    child.stdin!.end(body);
  });
  const state = async () => JSON.parse(await readFile(file, 'utf8')) as { arm?: string; journal?: string; locked?: boolean; unlocks?: number };
  // read the actual syscall boundary evidence from this isolated helper process
  const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { action: string; path: string });
  return { invoke, state, spool, trace };
}

// build the exact synthetic documented hook identity used by dormant helper tests
const startPayload = (prompt: string) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt_id: promptId, prompt });
const questionPayload = (id = promptId) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, prompt_id: id, tool_name: 'AskUserQuestion', tool_input: {}, tool_use_id: 'tool-1' });
const terminalPayload = () => JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, prompt_id: promptId, stop_hook_active: false });

describe('Claude managed lifecycle hook', () => {
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
