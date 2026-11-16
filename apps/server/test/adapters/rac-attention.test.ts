import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../../scripts/hooks/rac-attention', import.meta.url));
const testPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
const nativeSession = '11111111-2222-4333-8444-555555555555';
const otherSession = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

// a stub tmux that records each invocation's arguments, one line per call, and
// answers `display-message` with the given current Attention state
async function stubTmux(current = 'finished'): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'rac-tmux-'));
  dirs.push(dir);
  const record = join(dir, 'calls.log');
  const bin = join(dir, 'tmux');
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${record}'\n[ "$1" != display-message ] || echo ${current}\n`, { mode: 0o755 });
  return { bin, calls: async () => (await readFile(record, 'utf8').catch(() => '')).split('\n').filter(line => line !== '') };
}

async function attention(args: string[], env: Record<string, string>): Promise<void> {
  await run('/bin/sh', [script, ...args], { env: { PATH: testPath, ...env } });
}

// invoke the reporter with a hook body piped on stdin (the --payload path)
function attentionWithStdin(args: string[], env: Record<string, string>, stdin: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('/bin/sh', [script, ...args], { env: { PATH: testPath, ...env } }, error => error ? reject(error) : resolve());
    child.stdin!.end(stdin);
  });
}

describe('rac-attention', () => {
  it('sets @rac_attention and @rac_session in one tmux invocation', async () => {
    const tmux = await stubTmux();
    await attention(['working'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%7', CLAUDE_CODE_SESSION_ID: 'sid-123' });
    const calls = await tmux.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('set-option -p -t %7 @rac_attention working');
    expect(calls[0]).toContain('set-option -p -t %7 @rac_session sid-123');
  });

  it('sets only @rac_attention when no session id is known', async () => {
    const tmux = await stubTmux();
    await attention(['finished'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%7' });
    const calls = await tmux.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('@rac_attention finished');
    expect(calls[0]).not.toContain('@rac_session');
  });

  it('prefers an explicit --session over $CLAUDE_CODE_SESSION_ID and ignores extra args', async () => {
    const tmux = await stubTmux();
    await attention(['question', '--session', 'explicit', '{"hook":"event"}'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%9', CLAUDE_CODE_SESSION_ID: 'env-session' });
    const calls = await tmux.calls();
    expect(calls[0]).toContain('@rac_attention question');
    expect(calls[0]).toContain('@rac_session explicit');
  });

  it('reads the native top-level session when hook input is explicitly enabled', async () => {
    const tmux = await stubTmux();
    await attentionWithStdin(['finished', '--hook-input'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%9' }, JSON.stringify({ session_id: nativeSession, hook_event_name: 'Stop' }));
    expect((await tmux.calls())[0]).toContain(`@rac_session ${nativeSession}`);
  });

  it('prefers explicit then native hook sessions over a stale environment session', async () => {
    const tmux = await stubTmux();
    const body = JSON.stringify({ session_id: nativeSession, hook_event_name: 'SessionStart' });
    await attentionWithStdin(['finished', '--hook-input'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%9', CLAUDE_CODE_SESSION_ID: otherSession }, body);
    await attentionWithStdin(['finished', '--hook-input', '--session', 'explicit'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%9', CLAUDE_CODE_SESSION_ID: otherSession }, body);
    const calls = await tmux.calls();
    expect(calls[0]).toContain(`@rac_session ${nativeSession}`);
    expect(calls[0]).not.toContain(otherSession);
    expect(calls[1]).toContain('@rac_session explicit');
  });

  it('never lets malformed nested invalid or oversized hook sessions replace the environment fallback', async () => {
    const bodies = [
      '{not json',
      JSON.stringify({ hook_event_name: 'Stop', nested: { session_id: nativeSession } }),
      JSON.stringify({ session_id: 'not-a-native-uuid', hook_event_name: 'Stop' }),
      JSON.stringify({ session_id: nativeSession, padding: 'x'.repeat(65_537) })
    ];
    // each rejected body still reports attention with only the environment fallback
    for (const body of bodies) {
      const tmux = await stubTmux();
      await attentionWithStdin(['finished', '--hook-input'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%9', CLAUDE_CODE_SESSION_ID: otherSession }, body);
      const calls = await tmux.calls();
      expect(calls[0]).toContain('@rac_attention finished');
      expect(calls[0]).toContain(`@rac_session ${otherSession}`);
      expect(calls[0]).not.toContain(nativeSession);
    }
  });

  it('does not read or bind hook input without an opt-in flag', async () => {
    const tmux = await stubTmux();
    await attention(['finished'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%9' });
    expect((await tmux.calls())[0]).not.toContain('@rac_session');
  });

  it('stores the base64 hook body and the state in one invocation with --payload', async () => {
    const tmux = await stubTmux();
    const body = '{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[]}}\n';
    await attentionWithStdin(['question', '--payload'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%3' }, body);
    const calls = await tmux.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('set-option -p -t %3 @rac_attention question');
    expect(calls[0]).toContain(`set-option -p -t %3 @rac_question ${Buffer.from(body).toString('base64')}`);
  });

  it('clears @rac_question on a working/finished report without --payload', async () => {
    const tmux = await stubTmux();
    await attention(['working'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%3', CLAUDE_CODE_SESSION_ID: 'sid' });
    const calls = await tmux.calls();
    expect(calls[0]).toContain('@rac_attention working');
    // @rac_question is written, but with no base64 value following it
    expect(calls[0]).toContain('@rac_question');
    expect(calls[0]).not.toMatch(/@rac_question\s+[A-Za-z0-9+/=]/u);
  });

  it('leaves @rac_question untouched on a bare question report without --payload', async () => {
    // AskUserQuestion also fires a sibling question hook (Elicitation/PermissionRequest/
    // Notification) with no --payload; it must not wipe the payload the --payload hook wrote
    const tmux = await stubTmux();
    await attention(['question'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%3' });
    const calls = await tmux.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('@rac_attention question');
    expect(calls[0]).not.toContain('@rac_question');
  });

  it('drops a payload over 64 KiB but still reports the state', async () => {
    const tmux = await stubTmux();
    const oversize = 'x'.repeat(65_537);
    await attentionWithStdin(['question', '--payload'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%3' }, oversize);
    const calls = await tmux.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('@rac_attention question');
    // the oversize body never reaches @rac_question
    expect(calls[0]).not.toMatch(/@rac_question\s+[A-Za-z0-9+/=]/u);
  });

  it('drops a --main-only report fired inside a subagent', async () => {
    const tmux = await stubTmux('finished');
    const body = '{"session_id":"sid","cwd":"/repo","agent_id":"a1b2","agent_type":"general-purpose","hook_event_name":"PostToolUse","tool_name":"Bash"}';
    await attentionWithStdin(['working', '--main-only'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%3' }, body);
    expect(await tmux.calls()).toEqual(['display-message -p -t %3 #{@rac_attention}']);
  });

  it('lets a subagent clear a question pane without rebinding its session', async () => {
    const tmux = await stubTmux('question');
    const body = JSON.stringify({ session_id: nativeSession, agent_id: 'a1b2', hook_event_name: 'PostToolUse' });
    await attentionWithStdin(['working', '--main-only', '--hook-input'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%3', CLAUDE_CODE_SESSION_ID: otherSession }, body);
    const calls = await tmux.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('@rac_attention working');
    expect(calls[1]).not.toContain('@rac_session');
  });

  it('fails closed for malformed empty and invalid-utf8 main-only metadata', async () => {
    const bodies = ['', '{not json', Buffer.from([0xff, 0xfe, 0xfd])];
    // invalid provenance cannot mutate attention or session state
    for (const body of bodies) {
      const tmux = await stubTmux('question');
      await attentionWithStdin(['working', '--main-only', '--hook-input'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%3' }, body);
      expect(await tmux.calls()).toEqual([]);
    }
  });

  it('reports a --main-only report from the main agent even when its tool input names agent_id', async () => {
    const tmux = await stubTmux();
    const body = '{"session_id":"sid","cwd":"/repo","hook_event_name":"PostToolUse","tool_name":"SendMessage","tool_input":{"agent_id":"a1b2"}}';
    await attentionWithStdin(['working', '--main-only'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%3' }, body);
    const calls = await tmux.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('@rac_attention working');
  });

  it('does nothing outside a tmux pane', async () => {
    const tmux = await stubTmux();
    await attention(['working'], { RAC_TMUX_BIN: tmux.bin, CLAUDE_CODE_SESSION_ID: 'sid' });
    expect(await tmux.calls()).toHaveLength(0);
  });

  it('does nothing for an unrecognized state', async () => {
    const tmux = await stubTmux();
    await attention(['bogus'], { RAC_TMUX_BIN: tmux.bin, TMUX_PANE: '%7' });
    expect(await tmux.calls()).toHaveLength(0);
  });

  it('exits cleanly when no tmux binary resolves', async () => {
    // RAC_TMUX_BIN unset and PATH without tmux: command -v tmux fails, exit 0
    await expect(attention(['working'], { TMUX_PANE: '%7', PATH: '/nonexistent' })).resolves.toBeUndefined();
  });
});
