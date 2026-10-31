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

// One reporter invocation for a state: the tmux binary baked in (omitted under the
// bridge, where the host's PATH tmux is used) and the script named by its host path.
// `--payload` (AskUserQuestion only) carries the hook's stdin as the reported
// Inline question the console renders (ADR 0006). `--main-only` drops a report fired
// inside a subagent, which outlives the main agent's Stop when run in the background.
function report(context: AdapterFileContext, state: AttentionState, payload = false, lifecycle?: 'start' | 'question' | 'terminal', mainOnly = false): CommandHandler {
  const prefix = context.tmuxBin === undefined ? '' : `RAC_TMUX_BIN=${context.tmuxBin} `;
  const lifecyclePrefix = lifecycle === undefined ? '' : `RAC_CALENDAR_LIFECYCLE_SPOOL=${context.repoRoot}/.data/google-calendar-claude-lifecycle.jsonl `;
  return { type: 'command', timeout: 5, command: `${prefix}${lifecyclePrefix}${context.repoRoot}/scripts/hooks/rac-attention ${state}${payload ? ' --payload' : ''}${mainOnly ? ' --main-only' : ''}${lifecycle === undefined ? '' : ` --lifecycle ${lifecycle}`}` };
}

// The event → state mapping (ADR 0001). `SessionStart` also registers the session
// id, which every invocation carries from `$CLAUDE_CODE_SESSION_ID`. `SessionEnd`
// deliberately reports nothing (Claude fires it on `/clear` and `/resume`).
// `PreToolUse` splits by tool (ADR 0006): AskUserQuestion sends its payload so the
// question renders as an Inline question, while ExitPlanMode only reports the state.
// The tool-driven `working` reports also fire inside subagents, so they are main-only.
export function claudeHooksSettings(context: AdapterFileContext): { hooks: Record<string, HookEntry[]> } {
  const working = [{ hooks: [report(context, 'working', false, undefined, true)] }];
  const finished = [{ hooks: [report(context, 'finished')] }];
  const question = [{ hooks: [report(context, 'question')] }];
  return {
    hooks: {
      SessionStart: finished,
      UserPromptSubmit: [{ hooks: [report(context, 'working', false, 'start')] }],
      PreToolUse: [
        { matcher: 'AskUserQuestion', hooks: [report(context, 'question', true, 'question')] },
        { matcher: 'ExitPlanMode', hooks: [report(context, 'question')] },
      ],
      Elicitation: question,
      PermissionRequest: question,
      PostToolUse: working,
      PermissionDenied: working,
      ElicitationResult: working,
      Stop: [{ hooks: [report(context, 'finished', false, 'terminal')] }],
      StopFailure: [{ hooks: [report(context, 'finished', false, 'terminal')] }],
      Notification: [
        { matcher: 'permission_prompt', hooks: [report(context, 'question')] },
        { matcher: 'idle_prompt', hooks: [report(context, 'finished')] },
      ],
    },
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
