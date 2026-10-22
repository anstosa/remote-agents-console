import { codexRolloutBaseline, codexTurnSince } from './codex-conversations.js';
import type { CompletionBaseline, HeadlessRunResult, ReplyPane, ReviewRuns, ReviewRunSettings } from './types.js';

const authenticationDiagnostic = /(?:^|\n)(?:\d{4}-\d{2}-\d{2}T\S+\s+)?ERROR(?:\s+codex_login::auth::manager)?:\s*(?:Failed to refresh token|Your access token could not be refreshed|Provided authentication token is expired)\b/imu;
// a Codex MCP server name a dotted `-c mcp_servers.<name>…` override can address
const mcpServerName = /^[A-Za-z0-9_-]{1,64}$/u;
const modelArgs = (run: ReviewRunSettings) => [...(run.model === undefined ? [] : ['-m', run.model]), ...(run.effort === undefined ? [] : ['-c', `model_reasoning_effort=${run.effort}`])];

// the pane's rollout baseline: the exact fd-walk by pid, the unshared cwd as the fallback
async function baseline(pane: ReplyPane): Promise<CompletionBaseline | undefined> {
  if (pane.pid === undefined) return undefined;
  return await codexRolloutBaseline({ pid: pane.pid, ...(pane.cwd === undefined ? {} : { cwd: pane.cwd }) }).catch(() => undefined);
}

export const codexReviewRuns: ReviewRuns = {
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  headless: {
    probe: { help: ['exec', '--help'], flags: ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', '--output-schema', '--output-last-message'], login: ['login', 'status'] },
    // one isolated, read-only, schema-constrained run that writes its last message to the output file
    command: (run, files) => ({ args: ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', ...modelArgs(run), '--output-schema', files.schema, '--output-last-message', files.output, '--color', 'never', '-C', run.workspace, '-'] }),
    result: (outcome, outputBytes): HeadlessRunResult => {
      // distinguish an expired server login from model generation failures
      if (outcome.code !== 0) return { ok: false, failure: authenticationDiagnostic.test(outcome.diagnostics) ? 'authentication_required' : 'generation_failed' };
      if (outcome.output === undefined || outcome.output.length > outputBytes) return { ok: false, failure: 'malformed_result' };
      try { return { ok: true, value: JSON.parse(outcome.output.toString('utf8')) as unknown }; } catch { return { ok: false, failure: 'malformed_result' }; }
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
