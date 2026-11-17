import { claudeAskUserTool } from '../transports/claude.js';
import { claudeReplyObserverConfiguration } from '../reply-suggestions/claude-observer.js';
import { responseUrlSessionHookCommand } from './response-urls.js';
import type { AdapterFileContext, AttentionState } from './types.js';

/**
 * The Claude Code hooks settings file the console injects with `--settings` on
 * every launch and resume (ADR 0001). Its handlers map Claude's lifecycle events
 * to the console's Attention vocabulary and run `scripts/hooks/rac-attention`,
 * which writes the pane options the console polls. Hook entries merge additively
 * across settings levels, so the file adds these handlers and changes nothing
 * else in the operator's own settings.
 */

// the rendered file's name — the contract between what `claudeFiles` writes and
// what the Adapter's `launch` reads back out of `LaunchInput.files`
export const claudeHooksFileName = 'hooks.json';

type CommandHandler = { type: 'command'; timeout: number; command: string };
type HookEntry = { matcher?: string; hooks: CommandHandler[] };
type StatusLine = { type: 'command'; command: string; padding: number; refreshInterval: number };

// add the launch's workspace URL guidance as session context
const responseUrlSessionHook = { type: 'command', timeout: 5, command: responseUrlSessionHookCommand } satisfies CommandHandler;

// quote one generated shell value without permitting expansion
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// One reporter invocation for a state: the tmux binary baked in (omitted under the
// bridge, where the host's PATH tmux is used) and the script named by its host path.
// `--payload` (AskUserQuestion only) carries the hook's stdin as the reported
// Inline question the console renders (ADR 0006). `--main-only` drops a report fired
// inside a subagent, which outlives the main agent's Stop when run in the background.
function report(context: AdapterFileContext, state: AttentionState, payload = false, lifecycle?: 'start' | 'question' | 'terminal', mainOnly = false): CommandHandler {
  const prefix = context.tmuxBin === undefined ? '' : `RAC_TMUX_BIN=${context.tmuxBin} `;
  const lifecyclePrefix = lifecycle === undefined ? '' : `RAC_CALENDAR_LIFECYCLE_SPOOL=${context.repoRoot}/.data/google-calendar-claude-lifecycle.jsonl `;
  return { type: 'command', timeout: 5, command: `${prefix}${lifecyclePrefix}${context.repoRoot}/scripts/hooks/rac-attention ${state} --hook-input${payload ? ' --payload' : ''}${mainOnly ? ' --main-only' : ''}${lifecycle === undefined ? '' : ` --lifecycle ${lifecycle}`}` };
}

// report one metadata-only source epoch into the private bounded observer
function sourceReport(context: AdapterFileContext, event: string, configuration: { observerDir: string; policyNonce: string }): CommandHandler {
  const environment = `RAC_REPLY_SOURCE_DIR=${shellQuote(configuration.observerDir)} RAC_REPLY_POLICY_NONCE=${shellQuote(configuration.policyNonce)}`;
  return { type: 'command', timeout: 5, command: `${environment} ${shellQuote(`${context.repoRoot}/scripts/hooks/rac-reply-source`)} hook ${event}` };
}

// observe current model and effort without drawing a status line
function sourceStatusLine(context: AdapterFileContext, configuration: { observerDir: string; policyNonce: string }): StatusLine {
  const environment = `RAC_REPLY_SOURCE_DIR=${shellQuote(configuration.observerDir)} RAC_REPLY_POLICY_NONCE=${shellQuote(configuration.policyNonce)}`;
  // native refreshInterval is seconds, so one supplies the causal idle heartbeat
  return { type: 'command', command: `${environment} ${shellQuote(`${context.repoRoot}/scripts/hooks/rac-reply-source`)} status`, padding: 0, refreshInterval: 1 };
}

// The event → state mapping (ADR 0001). Every native handler opts into its bounded
// hook input so top-level `session_id` can register or replace the pane session. `SessionEnd`
// deliberately reports nothing (Claude fires it on `/clear` and `/resume`).
// `PreToolUse` splits by tool (ADR 0006): AskUserQuestion sends its payload so the
// question renders as an Inline question, while ExitPlanMode only reports the state.
// The tool-driven `working` reports also fire inside subagents, so they are main-only.
export function claudeHooksSettings(context: AdapterFileContext): { hooks: Record<string, HookEntry[]>; statusLine?: StatusLine } {
  const observer = claudeReplyObserverConfiguration();
  const working = [{ hooks: [report(context, 'working', false, undefined, true)] }];
  const question = [{ hooks: [report(context, 'question')] }];
  const source = (event: string): CommandHandler[] => observer === undefined ? [] : [sourceReport(context, event, observer)];
  return {
    hooks: {
      SessionStart: [{ hooks: [report(context, 'finished'), ...source('SessionStart'), responseUrlSessionHook] }],
      UserPromptSubmit: [{ hooks: [report(context, 'working', false, 'start'), ...source('UserPromptSubmit')] }],
      PreToolUse: [
        { matcher: 'AskUserQuestion', hooks: [report(context, 'question', true, 'question')] },
        { matcher: 'ExitPlanMode', hooks: [report(context, 'question')] },
      ],
      ...(observer === undefined ? {} : {
        PreModelSwitch: [{ hooks: source('PreModelSwitch') }],
        PostModelSwitch: [{ hooks: source('PostModelSwitch') }]
      }),
      Elicitation: question,
      PermissionRequest: question,
      PostToolUse: working,
      PermissionDenied: working,
      ElicitationResult: working,
      Stop: [{ hooks: [report(context, 'finished', false, 'terminal'), ...source('Stop')] }],
      StopFailure: [{ hooks: [report(context, 'finished', false, 'terminal'), ...source('StopFailure')] }],
      Notification: [
        { matcher: 'permission_prompt', hooks: [report(context, 'question')] },
        { matcher: 'idle_prompt', hooks: [report(context, 'finished')] },
      ],
    },
    ...(observer === undefined ? {} : { statusLine: sourceStatusLine(context, observer) })
  };
}

// The rendered `hooks.json` content, pretty-printed with a trailing newline.
export function claudeHooksJson(context: AdapterFileContext): string {
  return `${JSON.stringify(claudeHooksSettings(context), null, 2)}\n`;
}

// The Claude Adapter's `files` capability: one console-owned settings file.
export function claudeFiles(context: AdapterFileContext): Record<string, string> {
  return { [claudeHooksFileName]: claudeHooksJson(context) };
}

// The structured Claude's settings, passed inline (`--settings <json>`) rather than rendered: a
// file beside `hooks.json` would be one more console-owned file a sandboxed model could rewrite,
// and Claude's sandbox protects only the session's own settings. Unlike `hooks.json` they report
// nothing into tmux (the holder's `$TMUX_PANE` is not an Agent's pane) and arm no Calendar
// lifecycle, which follows prompts over tmux only. one hook echoes the launch's nonce as JSON,
// which the CLI keeps out of the model's context and the Claude client reads from `hook_response`;
// the other adds the launch's workspace URL guidance to the model's session context.
// The model asks through the console's `ask_user`, which needs no permission. Claude's own
// `AskUserQuestion` is denied: under `--permission-prompt-tool stdio` it arrives as a permission
// request, and allowing that answers none of its questions.
export const claudeStructuredSettings = JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: 'command', timeout: 5, command: `printf '{"suppressOutput":true,"rac":"%s"}\\n' "$RAC_LAUNCH_NONCE"` } satisfies CommandHandler, responseUrlSessionHook] }] },
  permissions: { allow: [claudeAskUserTool], deny: ['AskUserQuestion'] }
});
