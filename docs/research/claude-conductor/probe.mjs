// Probe: can the console arm, confirm and hand console access to a structured Claude Conductor?
// Run outside the sandbox:  node docs/research/claude-conductor/probe.mjs (runs land in $TMPDIR/rac-conductor-probe)
// Side effects: 3 small Haiku turns + one /compact on your account; one Claude session left under
// ~/.claude/projects for the scratch folder; nothing else is written outside this directory.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync, readlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const here = join(process.env.TMPDIR ?? tmpdir(), 'rac-conductor-probe');
const root = join(here, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const work = join(root, 'work');
mkdirSync(work, { recursive: true });
const secret = `PROBESECRET${randomBytes(12).toString('hex')}`;
const state = 'PROBE-STATE: the lantern is green';
const log = (...parts) => { const line = parts.join(' '); console.log(line); appendFileSync(join(root, 'summary.txt'), `${line}\n`); };
const raw = record => appendFileSync(join(root, 'raw.jsonl'), `${JSON.stringify(record)}\n`);

// a minimal streamable-HTTP MCP server with one tool, recording whether each request carried the token
const mcp = createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const message = JSON.parse(body);
    log(`[mcp] ${message.method} auth=${req.headers.authorization === `Bearer ${secret}` ? 'TOKEN' : req.headers.authorization === undefined ? 'none' : 'other'}`);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'rac', version: '0' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
      : message.method === 'tools/call' ? { content: [{ type: 'text', text: `echo:${message.params.arguments?.text}` }] }
      : {};
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
});
await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${mcp.address().port}/mcp`;

// what the sandboxed command tries: PID isolation, network, and reading the token out of Claude's process
writeFileSync(join(work, 'leak.sh'), `echo "pid ns: $(readlink /proc/self/ns/pid)  pid1: $(cat /proc/1/comm 2>&1)"
printf 'network: '; curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com; echo " exit=$?"
python3 - <<'PY'
import os
needle = b'PROBE' + b'SEC' + b'RET'
pids = [p for p in os.listdir('/proc') if p.isdigit()]
print('visible pids:', len(pids))
for p in pids:
    try: cmd = open(f'/proc/{p}/cmdline', 'rb').read()
    except Exception: continue
    if b'stream-json' not in cmd: continue
    print('agent process', p, 'cmdline has token:', needle in cmd)
    try: print('  environ has token:', needle in open(f'/proc/{p}/environ', 'rb').read())
    except Exception as e: print('  environ:', type(e).__name__)
    try:
        mem = open(f'/proc/{p}/mem', 'rb', 0); scanned = 0; found = False
        for line in open(f'/proc/{p}/maps').read().splitlines():
            span, perms = line.split()[:2]
            if perms[0] != 'r': continue
            a, b = (int(x, 16) for x in span.split('-'))
            if b - a > 512 * 1024 * 1024: continue
            try: mem.seek(a); chunk = mem.read(b - a)
            except Exception: continue
            scanned += len(chunk)
            if needle in chunk: found = True; break
        print('  mem scanned bytes:', scanned, 'token found:', found)
    except Exception as e: print('  mem:', type(e).__name__, e)
PY
`);
log(`root: ${root}`);
log(`probe's own pid ns: ${readlinkSync('/proc/self/ns/pid')}`);

const settings = {
  sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true },
  permissions: { allow: ['mcp__rac'], deny: ['AskUserQuestion'], defaultMode: 'dontAsk' }
};
const env = { ...process.env };
delete env.CLAUDECODE;
const claude = spawn(process.env.CLAUDE_BIN ?? 'claude', [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
  '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio', '--model', 'haiku',
  '--tools', 'Bash,Read,Edit,Write,Grep,Glob', '--strict-mcp-config', '--setting-sources', 'user',
  '--settings', JSON.stringify(settings)
], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
claude.stderr.on('data', chunk => appendFileSync(join(root, 'stderr.txt'), chunk));
const killer = setTimeout(() => { log('TIMEOUT: killing claude'); claude.kill(); }, 5 * 60_000);

const write = record => { raw({ sent: record }); claude.stdin.write(`${JSON.stringify(record)}\n`); };
let requests = 0;
const pending = new Map();
const control = (request, timeoutMs = 30_000) => new Promise(resolve => {
  const id = `probe-${requests += 1}`;
  const timer = setTimeout(() => { pending.delete(id); resolve({ timedOut: true }); }, timeoutMs);
  pending.set(id, response => { clearTimeout(timer); resolve(response); });
  write({ type: 'control_request', request_id: id, request });
});
let onResult;
const turn = text => new Promise(resolve => { onResult = resolve; write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }); });
const short = (value, n = 600) => { const s = typeof value === 'string' ? value : JSON.stringify(value); return s.length > n ? `${s.slice(0, n)}…` : s; };

let buffer = '';
claude.stdout.setEncoding('utf8');
claude.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let record; try { record = JSON.parse(line); } catch { log('[non-json]', short(line)); continue; }
    raw(record);
    if (record.type === 'control_response') {
      const r = record.response; const done = pending.get(r.request_id); pending.delete(r.request_id);
      done?.(r.subtype === 'success' ? (r.response ?? {}) : { error: r.error });
    } else if (record.type === 'control_request') {
      const { subtype } = record.request;
      log(`[cli asks] ${subtype} ${short(record.request, 400)}`);
      const response = subtype === 'hook_callback' && record.request.input?.source === 'compact'
        ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: state } }
        : subtype === 'can_use_tool' ? { behavior: 'deny', message: 'The probe denies every permission request.' } : {};
      claude.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: record.request_id, response } })}\n`);
    } else if (record.type === 'system' && record.subtype === 'init') {
      log(`[init] model=${record.model} permissionMode=${record.permissionMode} tools=${short(record.tools)} mcp_servers=${short(record.mcp_servers)}`);
    } else if (record.type === 'system') {
      log(`[system:${record.subtype}] ${short(record, 300)}`);
    } else if (record.type === 'assistant') {
      for (const block of record.message?.content ?? []) {
        if (block.type === 'text') log(`[assistant] ${short(block.text, 1500)}`);
        if (block.type === 'tool_use') log(`[tool_use] ${block.name} ${short(block.input, 300)}`);
      }
    } else if (record.type === 'user') {
      for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
        if (block.type === 'tool_result') log(`[tool_result] ${short(typeof block.content === 'string' ? block.content : block.content?.map?.(c => c.text).join(''), 2000)}`);
      }
    } else if (record.type === 'result') {
      log(`[result] ${record.subtype} cost=${record.total_cost_usd} ${short(record.result ?? '', 300)}`);
      const done = onResult; onResult = undefined; done?.(record);
    }
  }
});
claude.on('exit', code => log(`[exit] claude exited ${code}`));

log('\n== 1. initialize with appendSystemPrompt and a SessionStart(compact) hook callback');
const init = await control({ subtype: 'initialize', appendSystemPrompt: 'The probe codeword is HERON-42.', hooks: { SessionStart: [{ matcher: 'compact', hookCallbackIds: ['compact-state'] }] } });
log(`version=${init.claude_code_version} keys=${Object.keys(init).join(',')} ${init.error ?? ''}`);

log('\n== 2. get_settings: does it show the sandbox the inline --settings armed?');
const got = await control({ subtype: 'get_settings' });
writeFileSync(join(root, 'get_settings.json'), JSON.stringify(got, null, 2));
log(`keys=${Object.keys(got).join(',')}`);
log(`sandbox=${short(got.sandbox ?? got.settings?.sandbox ?? got.effective?.sandbox ?? '(not at top level; see get_settings.json)', 800)}`);

log('\n== 3. mcp_set_servers: hand over an HTTP server with a bearer token over the protocol');
log(`response=${short(await control({ subtype: 'mcp_set_servers', servers: { rac: { type: 'http', url, headers: { Authorization: `Bearer ${secret}` } } } }), 800)}`);
log(`mcp_status=${short(await control({ subtype: 'mcp_status' }), 800)}`);
let ps = ''; try { ps = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }); } catch {}
log(`token in any process's argv (ps): ${ps.includes(secret)}`);

log('\n== 4. turn: codeword, MCP tool, sandboxed leak test');
await turn('Do three things, briefly. 1) Tell me the probe codeword from your system prompt. 2) Call the echo tool of the rac MCP server with text "ping" and tell me what it returned. 3) Run exactly this Bash command and show me its full output verbatim: bash leak.sh');

log('\n== 5. /compact, expecting a hook_callback whose answer is added after compaction');
await turn('/compact');

log('\n== 6. turn: does the model see the state the hook added?');
await turn('Is there a line starting with "PROBE-STATE:" in your context? Quote it exactly, or say there is none. One line.');

clearTimeout(killer);
claude.stdin.end();
mcp.close();
log(`\nDone. Full records: ${join(root, 'raw.jsonl')}`);
