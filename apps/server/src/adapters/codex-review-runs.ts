import { codexRolloutBaseline, codexTurnSince, validCodexThreadId } from './codex-conversations.js';
import type { CompletionBaseline, HeadlessReviewRun, HeadlessRunFiles, HeadlessRunResult, ReplyPane, ReviewRuns, ReviewRunSettings } from './types.js';

const authenticationDiagnostic = /(?:^|\n)(?:\d{4}-\d{2}-\d{2}T\S+\s+)?ERROR(?:\s+codex_login::auth::manager)?:\s*(?:Failed to refresh token|Your access token could not be refreshed|Provided authentication token is expired)\b/imu;
// the same failures as `--json` reports them, in an error event's message on stdout
const authenticationEvent = /"message":"[^"]*(?:Failed to refresh token|Your access token could not be refreshed|Provided authentication token is expired)/u;
// a Codex MCP server name a dotted `-c mcp_servers.<name>…` override can address
const mcpServerName = /^[A-Za-z0-9_-]{1,64}$/u;
const modelArgs = (run: ReviewRunSettings) => [...(run.model === undefined ? [] : ['-m', run.model]), ...(run.effort === undefined ? [] : ['-c', `model_reasoning_effort=${run.effort}`])];

// The thread a fresh `--json` run started, from the `thread.started` event that leads its stdout;
// undefined when the head holds none
function startedThread(stdout: Buffer | undefined): string | undefined {
  for (const line of stdout?.toString('utf8').split('\n') ?? []) {
    let event: { type?: unknown; thread_id?: unknown } | null;
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    if (event?.type === 'thread.started') return typeof event.thread_id === 'string' && validCodexThreadId(event.thread_id) ? event.thread_id : undefined;
  }
  return undefined;
}

// One run, isolated from the operator's config and rules, read-only, its events on stdout (the
// thread id leads them), its last message written to the output file and constrained by the schema
// when it has one. A fresh run starts a persisted thread in the Worktree; `exec resume` has no
// `--sandbox` or `-C`, so a resumed one is made read-only through config and runs in the Worktree.
function command(run: HeadlessReviewRun, files: HeadlessRunFiles): { args: string[]; cwd?: string; conversation?: string } {
  const reply = [...modelArgs(run), ...(files.schema === undefined ? [] : ['--output-schema', files.schema]), '--output-last-message', files.output];
  const isolated = ['--json', '--ignore-user-config', '--ignore-rules'];
  if ('resume' in run.conversation) return { args: ['exec', 'resume', ...isolated, '-c', 'sandbox_mode="read-only"', ...reply, run.conversation.resume, '-'], cwd: run.workspace, conversation: run.conversation.resume };
  return { args: ['exec', ...isolated, '--sandbox', 'read-only', ...reply, '--color', 'never', '-C', run.workspace, '-'] };
}

// the pane's rollout baseline: the exact fd-walk by pid, the unshared cwd as the fallback
async function baseline(pane: ReplyPane): Promise<CompletionBaseline | undefined> {
  if (pane.pid === undefined) return undefined;
  return await codexRolloutBaseline({ pid: pane.pid, ...(pane.cwd === undefined ? {} : { cwd: pane.cwd }) }).catch(() => undefined);
}

export const codexReviewRuns: ReviewRuns = {
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  headless: {
    probe: { help: ['exec', '--help'], flags: ['resume', '--json', '--ignore-user-config', '--ignore-rules', '--sandbox', '--output-schema', '--output-last-message'], login: ['login', 'status'] },
    command,
    // only the head is read, for the thread id
    stdoutBytes: () => 65_536,
    result: (outcome, { outputBytes, text }): HeadlessRunResult => {
      // distinguish an expired server login from model generation failures
      if (outcome.code !== 0) return { ok: false, failure: authenticationDiagnostic.test(outcome.diagnostics) || authenticationEvent.test(outcome.stdout?.toString('utf8') ?? '') ? 'authentication_required' : 'generation_failed' };
      if (outcome.output === undefined || outcome.output.length > outputBytes) return { ok: false, failure: 'malformed_result' };
      const thread = startedThread(outcome.stdout);
      const conversation = thread === undefined ? {} : { conversation: thread };
      const reply = outcome.output.toString('utf8');
      if (text) return reply.trim() === '' ? { ok: false, failure: 'malformed_result' } : { ok: true, value: reply, ...conversation };
      try { return { ok: true, value: JSON.parse(reply) as unknown, ...conversation }; } catch { return { ok: false, failure: 'malformed_result' }; }
    }
  },
  interactive: {
    // read-only and never asking for approval; MCP servers are disabled by `mcp`
    args: run => ['--sandbox', 'read-only', '--ask-for-approval', 'never', ...modelArgs(run)],
    // the ones its own arguments always replace (Codex refuses a repeated `--sandbox`) and the ones that would loosen its read-only policy
    readOnlyFlags: [['-s', 'one'], ['--sandbox', 'one'], ['-a', 'one'], ['--ask-for-approval', 'one'], ['--dangerously-bypass-approvals-and-sandbox', 'none'], ['--yolo', 'none'], ['--full-auto', 'none'], ['--approve-for-me', 'none'], ['--add-dir', 'one']],
    // Codex refuses a repeated `--model`; it takes effort through `-c`, where the run's later value wins
    modelFlags: ['-m', '--model'],
    effortFlags: [],
    // The Codex TUI has no `--ignore-user-config`, and an empty `-c mcp_servers={}` merges into the
    // configured table rather than replacing it, so each server is disabled by name.
    mcp: {
      list: ['mcp', 'list', '--json'],
      servers: stdout => {
        try {
          const servers = JSON.parse(stdout) as unknown;
          if (!Array.isArray(servers)) return undefined;
          const names = servers.map(server => (server as { name?: unknown } | null)?.name);
          return names.every(name => typeof name === 'string') ? names as string[] : undefined;
        } catch { return undefined; }
      },
      disable: names => names.every(name => mcpServerName.test(name)) ? names.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]) : undefined
    },
    reply: {
      mark: pane => baseline(pane),
      // The answer of the newest completed turn past the pre-prompt rollout ordinal. A fresh thread
      // opens its rollout only at its first turn, so without a baseline it is read from the start of
      // the rollout once the pane holds one.
      since: async (pane, mark, maxBytes) => {
        const before = mark as CompletionBaseline | undefined;
        const opened = before ?? await baseline(pane);
        if (opened === undefined || !('rollout' in opened)) return undefined;
        const event = await codexTurnSince(before ?? { rollout: opened.rollout, ordinal: 0 }, maxBytes + 1).catch(() => undefined);
        return event?.kind === 'completed' ? event.answer : undefined;
      }
    }
  }
};
