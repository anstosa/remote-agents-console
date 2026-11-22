// Probe 2: can a Conductor launch load NO setting sources, and do the outside-folder blocks hold?
// Run outside the sandbox:  node docs/research/claude-conductor/probe2.mjs (runs land in $TMPDIR/rac-conductor-probe)
// Side effects: one small Haiku turn per variant (2 variants); one session file each under ~/.claude/projects.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const here = join(process.env.TMPDIR ?? tmpdir(), 'rac-conductor-probe');
const root = join(here, `run2-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const outside = join(root, 'outside');
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-FILE-CONTENT\n');
const log = (...parts) => { const line = parts.join(' '); console.log(line); appendFileSync(join(root, 'summary.txt'), `${line}\n`); };
const short = (value, n = 600) => { const s = typeof value === 'string' ? value : JSON.stringify(value); return s.length > n ? `${s.slice(0, n)}…` : s; };

const settings = {
  sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true },
  permissions: { allow: [], deny: ['AskUserQuestion'], defaultMode: 'dontAsk', blockFileToolReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true }
};

async function variant(name, sourceArgs) {
  const work = join(root, name);
  mkdirSync(work, { recursive: true });
  log(`\n== variant ${name}: ${JSON.stringify(sourceArgs)}`);
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const claude = spawn(process.env.CLAUDE_BIN ?? 'claude', [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--model', 'haiku',
    '--tools', 'Bash,Read,Edit,Write,Grep,Glob', '--strict-mcp-config', ...sourceArgs, '--settings', JSON.stringify(settings)
  ], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  claude.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => claude.on('exit', code => resolve(code)));
  const killer = setTimeout(() => { log('TIMEOUT'); claude.kill(); }, 3 * 60_000);
  const pending = new Map();
  let requests = 0, onResult;
  const send = record => claude.stdin.write(`${JSON.stringify(record)}\n`);
  const control = request => new Promise(resolve => {
    const id = `p-${requests += 1}`;
    const timer = setTimeout(() => { pending.delete(id); resolve({ timedOut: true }); }, 30_000);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    send({ type: 'control_request', request_id: id, request });
  });
  let buffer = '';
  claude.stdout.setEncoding('utf8');
  claude.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let record; try { record = JSON.parse(line); } catch { continue; }
      appendFileSync(join(root, `${name}.jsonl`), `${line}\n`);
      if (record.type === 'control_response') {
        const r = record.response; const done = pending.get(r.request_id); pending.delete(r.request_id);
        done?.(r.subtype === 'success' ? (r.response ?? {}) : { error: r.error });
      } else if (record.type === 'control_request') {
        log(`[cli asks] ${record.request.subtype} ${short(record.request, 300)}`);
        send({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response: record.request.subtype === 'can_use_tool' ? { behavior: 'deny', message: 'probe denies' } : {} } });
      } else if (record.type === 'system' && record.subtype === 'hook_started') {
        log(`[hook] ${record.hook_name}`);
      } else if (record.type === 'assistant') {
        for (const block of record.message?.content ?? []) {
          if (block.type === 'text') log(`[assistant] ${short(block.text, 1200)}`);
          if (block.type === 'tool_use') log(`[tool_use] ${block.name} ${short(block.input, 300)}`);
        }
      } else if (record.type === 'user') {
        for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
          if (block.type === 'tool_result') log(`[tool_result] ${short(typeof block.content === 'string' ? block.content : block.content?.map?.(c => c.text).join(''), 600)}`);
        }
      } else if (record.type === 'result') {
        log(`[result] ${record.subtype} cost=${record.total_cost_usd}`);
        const done = onResult; onResult = undefined; done?.();
      }
    }
  });
  const init = await control({ subtype: 'initialize' });
  if (init.error !== undefined || init.timedOut) {
    log(`initialize failed: ${short(init)}; exit=${await Promise.race([exited, new Promise(r => setTimeout(() => r('still running'), 2000))])}; stderr=${short(stderr, 800)}`);
    claude.kill(); clearTimeout(killer); return;
  }
  const got = await control({ subtype: 'get_settings' });
  writeFileSync(join(root, `${name}-get_settings.json`), JSON.stringify(got, null, 2));
  log(`sources: ${short((got.sources ?? []).map(s => s.source))}`);
  log(`effective sandbox: ${short(got.effective?.sandbox, 400)}`);
  log(`effective hooks: ${short(Object.keys(got.effective?.hooks ?? {}))}  plugins: ${short(Object.keys(got.effective?.enabledPlugins ?? {}).length)}`);
  log(`applied: ${short(got.applied, 500)}`);
  await new Promise(resolve => {
    onResult = resolve;
    send({ type: 'user', message: { role: 'user', content: `Do these four things and report each outcome in one line, quoting any error verbatim. 1) Use the Read tool on ${join(outside, 'secret.txt')}. 2) Use the Write tool to create ${join(outside, 'written-by-write-tool.txt')} containing "x". 3) Use the Read tool on ./ok.txt after creating it with the Write tool containing "fine". 4) Run in Bash: cat ${join(outside, 'secret.txt')}` }, parent_tool_use_id: null, session_id: '' });
  });
  log(`outside write by Write tool landed: ${existsSync(join(outside, 'written-by-write-tool.txt'))}`);
  clearTimeout(killer);
  claude.stdin.end();
  log(`exit ${await exited}${stderr.trim() === '' ? '' : ` stderr=${short(stderr, 400)}`}`);
}

await variant('empty-sources', ['--setting-sources', '']);
await variant('no-sources-flag', ['--setting-sources', 'none']);
log(`\nDone. ${root}`);
