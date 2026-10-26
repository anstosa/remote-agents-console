#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const event = process.argv[2];
const pane = process.env.TMUX_PANE;
const tmux = process.env.RAC_TMUX_BIN || 'tmux';
const spool = process.env.RAC_CALENDAR_LIFECYCLE_SPOOL;
const option = '@rac_calendar_arm';
const journalOption = '@rac_calendar_journal';
const maxPayloadBytes = 64 * 1024;
const maxSpoolBytes = 8 * 1024 * 1024;
const now = new Date().toISOString();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hash = value => createHash('sha256').update(value).digest('hex');
// bound every helper command so instrumentation cannot stall the agent
const call = args => spawnSync(tmux, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 750 });

// read one bounded hook payload without retaining prompt content
async function hookPayload() {
  const chunks = [];
  let bytes = 0;
  // stop before a hook can allocate unbounded input
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxPayloadBytes) return undefined;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return undefined; }
}

// require the documented per-prompt correlation fields
function promptIdentity(payload, hookEvents) {
  if (payload === null || typeof payload !== 'object' || !hookEvents.includes(payload.hook_event_name)) return undefined;
  if (typeof payload.session_id !== 'string' || payload.session_id.length < 1 || payload.session_id.length > 256) return undefined;
  if (typeof payload.prompt_id !== 'string' || !uuid.test(payload.prompt_id)) return undefined;
  return { sessionId: payload.session_id, promptId: payload.prompt_id };
}

// retain only sanitized correlation evidence in pane and disk journals
function journal(arm, updates) {
  return {
    v: 1, activityId: arm.activityId, nonce: arm.nonce, paneId: arm.paneId,
    processGeneration: arm.processGeneration, process: arm.process, contract: arm.contract,
    armedAt: arm.armedAt, expiresAt: arm.expiresAt,
    ...(arm.startedAt === undefined ? {} : { startedAt: arm.startedAt }),
    ...(arm.firstQuestionAt === undefined ? {} : { firstQuestionAt: arm.firstQuestionAt }),
    ...(arm.sessionId === undefined ? {} : { sessionId: arm.sessionId }),
    ...(arm.promptId === undefined ? {} : { promptId: arm.promptId }),
    ...updates, recordedAt: now
  };
}

// append one private bounded record with single-writer rotation
function appendSpool(record) {
  if (!spool) return false;
  const folder = dirname(spool);
  const lock = `${spool}.lock`;
  let lockFd;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    try { lockFd = openSync(lock, 'wx', 0o600); } catch {
      // recover only an abandoned bounded helper lock
      try {
        if (Date.now() - statSync(lock).mtimeMs <= 5_000) return false;
        unlinkSync(lock);
        lockFd = openSync(lock, 'wx', 0o600);
      } catch { return false; }
    }
    const line = `${JSON.stringify(record)}\n`;
    const size = existsSync(spool) ? lstatSync(spool).size : 0;
    // never discard unconsumed evidence when the private spool is full
    if (size + Buffer.byteLength(line) > maxSpoolBytes) return false;
    const fd = openSync(spool, 'a', 0o600);
    try { chmodSync(spool, 0o600); writeSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
  finally {
    try { if (lockFd !== undefined) closeSync(lockFd); } catch {}
    // remove only a lock acquired by this invocation
    if (lockFd !== undefined) try { unlinkSync(lock); } catch {}
  }
}

// publish disk first so pane loss cannot erase a completed lifecycle
function publish(record) {
  const durable = appendSpool(record);
  const published = durable ? record : { ...record, state: 'invalid', reason: 'missing_lifecycle_evidence', contaminatedAt: now };
  const encoded = Buffer.from(JSON.stringify(published)).toString('base64url');
  call(['set-option', '-p', '-t', pane, journalOption, encoded]);
  // failed durable publication revokes authority instead of reporting success
  if (!durable) call(['set-option', '-p', '-t', pane, '-u', option]);
  return { durable, encoded };
}

// invalidate one exact authority without exposing hook payloads
function invalidate(arm) {
  publish(journal(arm, { state: 'invalid', reason: 'missing_lifecycle_evidence', contaminatedAt: now }));
  call(['set-option', '-p', '-t', pane, '-u', option]);
}

// always unwind the lock before finishing a lifecycle hook
async function main() {
  // retain attention behavior when lifecycle context is absent
  if (!pane || !['start', 'question', 'terminal'].includes(event)) return;
  const lock = `rac-calendar-${hash(pane).slice(0, 16)}`;
  const acquired = call(['wait-for', '-L', lock]);
  // never mutate a pane unless this invocation owns the lock
  if (acquired.status !== 0) return;
  try {
    const shown = call(['show-options', '-p', '-v', '-t', pane, option]);
    if (shown.status !== 0 || !shown.stdout.trim()) return;
    let arm;
    try { arm = JSON.parse(Buffer.from(shown.stdout.trim(), 'base64url').toString('utf8')); } catch { return; }
    if (arm?.v !== 1 || arm.paneId !== pane || typeof arm.nonce !== 'string' || typeof arm.process?.pid !== 'number' || typeof arm.process?.start !== 'string' || typeof arm.contract?.cliVersion !== 'string' || typeof arm.contract?.payloadContract !== 'string') return;
    let ancestor = process.ppid;
    let processMatches = false;
    // bind the hook to the exact armed Claude process generation
    for (let depth = 0; depth < 32 && ancestor > 1; depth += 1) {
      let stat;
      try { stat = readFileSync(`/proc/${ancestor}/stat`, 'utf8'); } catch { break; }
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      if (ancestor === arm.process.pid && fields[19] === arm.process.start) { processMatches = true; break; }
      ancestor = Number(fields[1]);
    }
    if (!processMatches) return;
    const payload = await hookPayload();
    if (event === 'start') {
      // a new user submission contaminates existing active authority
      if (arm.state === 'active') { invalidate(arm); return; }
      const identity = promptIdentity(payload, ['UserPromptSubmit']);
      if (arm.state !== 'armed' || Date.parse(arm.expiresAt) < Date.now() || identity === undefined || typeof payload?.prompt !== 'string' || Buffer.byteLength(payload.prompt) > maxPayloadBytes || hash(payload.prompt) !== arm.promptFingerprint) { invalidate(arm); return; }
      const active = journal(arm, { state: 'active', startedAt: now, ...identity });
      const publication = publish(active);
      if (publication.durable) call(['set-option', '-p', '-t', pane, option, publication.encoded]);
      return;
    }
    if (arm.state !== 'active') return;
    const expected = promptIdentity(payload, event === 'question' ? ['PreToolUse'] : ['Stop', 'StopFailure']);
    if (expected === undefined || expected.sessionId !== arm.sessionId || expected.promptId !== arm.promptId) { invalidate(arm); return; }
    if (event === 'question') {
      if (payload.tool_name !== 'AskUserQuestion') { invalidate(arm); return; }
      const active = journal(arm, { state: 'active', firstQuestionAt: arm.firstQuestionAt ?? now });
      const publication = publish(active);
      if (publication.durable) call(['set-option', '-p', '-t', pane, option, publication.encoded]);
      return;
    }
    const terminal = journal(arm, { state: 'terminal', finishedAt: now });
    publish(terminal);
    // clear authority even when journal publication failed
    call(['set-option', '-p', '-t', pane, '-u', option]);
  } finally {
    call(['wait-for', '-U', lock]);
  }
}

// hooks remain best-effort without preventing normal attention updates
await main().catch(() => undefined);
