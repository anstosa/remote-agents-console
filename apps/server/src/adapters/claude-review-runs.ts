import { claudeLastAssistantText } from './claude-conversations.js';
import type { HeadlessRunResult, ReplyPane, ReviewRuns, ReviewRunSettings } from './types.js';

// the only built-in tools a Claude Review run gets, headless or interactive: reading the
// repository, plus Skill so a preset prompt can name an operator's skill. With Edit, Write and
// Bash withheld, a skill can only read; one that runs a command or edits fails at that step
const claudeReviewTools = 'Read,Grep,Glob,Skill';

// Only the operator's own settings: a reviewed Worktree's `.claude/settings*.json` is content under
// review (a pull request may add it), and its hooks, `env` or `apiKeyHelper` would run commands or
// redirect credentials whatever the tool limits say. Flag settings (`--settings`) still apply.
const settingSources = ['--setting-sources', 'user'];

const authenticationFailure = /invalid api key|please run \/login|not logged in|authentication_error|oauth token (?:has )?expired/iu;

type ClaudeResult = { type?: unknown; is_error?: unknown; result?: unknown; structured_output?: unknown };

const modelArgs = (run: ReviewRunSettings) => [...(run.model === undefined ? [] : ['--model', run.model]), ...(run.effort === undefined ? [] : ['--effort', run.effort])];

// the result object from `--output-format json` (one object; an array of messages under --verbose)
function resultEnvelope(stdout: Buffer | undefined): ClaudeResult | undefined {
  if (stdout === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.toString('utf8')); } catch { return undefined; }
  const candidate: unknown = Array.isArray(parsed) ? [...parsed as unknown[]].reverse().find(entry => (entry as ClaudeResult | null)?.type === 'result') : parsed;
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as ClaudeResult : undefined;
}

// the last assistant message of the Claude session the pane reports
async function lastAssistantText(pane: ReplyPane): Promise<string | undefined> {
  const conversationId = await pane.conversationId();
  return conversationId === undefined ? undefined : await claudeLastAssistantText(conversationId, pane.directory());
}

export const claudeReviewRuns: ReviewRuns = {
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  headless: {
    probe: { help: ['--help'], flags: ['--json-schema', '--tools', '--output-format', '--effort', '--no-session-persistence', '--strict-mcp-config', '--setting-sources'] },
    // print mode, read-only and unpersisted: only the read tools, no MCP servers and only the operator's settings, run in the Worktree
    command: run => ({ args: ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(run.schema), '--tools', claudeReviewTools, '--strict-mcp-config', ...settingSources, '--no-session-persistence', ...modelArgs(run)], cwd: run.workspace }),
    // the result envelope carries the text result and usage beside the structured output
    stdoutBytes: outputBytes => 4 * outputBytes + 65_536,
    result: (outcome, outputBytes): HeadlessRunResult => {
      const envelope = resultEnvelope(outcome.stdout);
      // a non-zero exit or an error result is a failed run, classified from its text: a missing or expired login is the operator's to fix
      if (outcome.code !== 0 || envelope?.is_error === true) {
        const text = `${outcome.diagnostics}\n${typeof envelope?.result === 'string' ? envelope.result : ''}`;
        return { ok: false, failure: authenticationFailure.test(text) ? 'authentication_required' : 'generation_failed' };
      }
      const output = envelope?.structured_output;
      if (output === undefined || output === null || Buffer.byteLength(JSON.stringify(output)) > outputBytes) return { ok: false, failure: 'malformed_result' };
      return { ok: true, value: output };
    }
  },
  interactive: {
    // only the read tools and Skill, no MCP servers and only the operator's settings, plus read access
    // to the run's prompt directory; the Adapter's own `--settings` (the state-reporting hooks) stays in place
    args: run => ['--tools', claudeReviewTools, '--strict-mcp-config', ...settingSources, ...(run.readDirectory === undefined ? [] : ['--add-dir', run.readDirectory]), ...modelArgs(run)],
    // the ones that would loosen its read-only policy
    readOnlyFlags: [['--tools', 'many'], ['--strict-mcp-config', 'none'], ['--mcp-config', 'many'], ['--setting-sources', 'one']],
    modelFlags: ['--model'],
    effortFlags: ['--effort'],
    reply: {
      // the session's last assistant message before the prompt
      mark: pane => lastAssistantText(pane),
      // the last assistant message, once it differs from the one before the prompt
      since: async (pane, mark) => { const text = await lastAssistantText(pane); return text === mark ? undefined : text; }
    }
  }
};
