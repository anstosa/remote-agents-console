import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const invoke = (event: string, body = '') => new Promise<void>((resolve, reject) => {
    const child = execFile(helper, [event], { env: { ...process.env, RAC_TMUX_BIN: tmux, RAC_CALENDAR_LIFECYCLE_SPOOL: spool, TMUX_PANE: '%7', STATE_FILE: file } }, error => error ? reject(error) : resolve());
    child.stdin!.end(body);
  });
  const state = async () => JSON.parse(await readFile(file, 'utf8')) as { arm?: string; journal?: string; locked?: boolean; unlocks?: number };
  return { invoke, state, spool };
}

// build the exact synthetic documented hook identity used by dormant helper tests
const startPayload = (prompt: string) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt_id: promptId, prompt });
const questionPayload = (id = promptId) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, prompt_id: id, tool_name: 'AskUserQuestion', tool_input: {}, tool_use_id: 'tool-1' });
const terminalPayload = () => JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, prompt_id: promptId, stop_hook_active: false });

describe('Claude managed lifecycle hook', () => {
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
