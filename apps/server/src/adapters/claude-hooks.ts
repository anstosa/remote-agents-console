import { claudeAskUserTool, claudeConductorAskUserTool } from '../transports/claude.js';
import { join } from 'node:path';
import { folderWritable, homeSecrets, piSecrets, piStateDir, staticPolicy } from './pi-sandbox.js';
import { claudeReplyObserverConfiguration } from '../reply-suggestions/claude-observer.js';
import { responseUrlSessionHookCommand } from './response-urls.js';
import type { AdapterFileContext, AttentionState, SandboxSettings } from './types.js';

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
const structuredHooks = { SessionStart: [{ hooks: [{ type: 'command', timeout: 5, command: `printf '{"suppressOutput":true,"rac":"%s"}\\n' "$RAC_LAUNCH_NONCE"` } satisfies CommandHandler, responseUrlSessionHook] }] };
export const claudeStructuredSettings = JSON.stringify({
  hooks: structuredHooks,
  permissions: { allow: [claudeAskUserTool], deny: ['AskUserQuestion'] }
});

// what in a Claude account's config directory holds credentials, MCP server headers, or other
// Conversations' prompts and transcripts
const claudeSecrets = ['.credentials.json', '.claude.json', 'history.jsonl'];
const claudeTranscripts = 'projects';
// a path as a permission rule takes it: `//` starts an absolute path, `~/` the home directory
const rulePath = (path: string): string => path === '~' || path.startsWith('~/') ? path : `/${path}`;
const rules = (tool: string, paths: readonly string[]): string[] => paths.flatMap(path => [`${tool}(${rulePath(path)})`, `${tool}(${rulePath(path)}/**)`]);
const noSandbox: SandboxSettings = { allowedDomains: [], deniedDomains: [], allowWrite: [], denyWrite: [], denyRead: [], env: [] };

/**
 * A Claude Conductor's settings (ADR 0022), the only ones it loads: the launch's hooks; a sandbox
 * that fails closed and lets no command out, on the kind's lists (the console's own hosts and paths
 * denied), with the operator's credentials, the account's Claude state and Pi's unreadable and, as
 * for a Sandboxed Pi, its folder unwritable where it holds the home directory or a console
 * repository; and, asking no one, the console's MCP tools, `ask_user` and edits allowed, the file
 * tools kept to its folder and, since they follow permission rules rather than the sandbox's lists,
 * denied the same paths. `stateDirectory` is the launch account's Claude config directory.
 */
export function claudeConductorSettings({ cwd, stateDirectory, sandbox = noSandbox }: { cwd: string; stateDirectory: string; sandbox?: SandboxSettings }): string {
  const { network, filesystem } = staticPolicy(sandbox);
  const writable = folderWritable(cwd, sandbox.repositories ?? []);
  const secrets = [...filesystem.denyRead, ...homeSecrets.map(name => `~/${name}`), ...claudeSecrets.map(name => join(stateDirectory, name)), '~/.claude.json', ...piSecrets.map(name => join(piStateDir(process.env), name))];
  const denyWrite = [...filesystem.denyWrite, ...(writable ? [] : [cwd])];
  return JSON.stringify({
    hooks: structuredHooks,
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
      network,
      // other Conversations' transcripts are kept from commands only: the file tools read the large
      // results Claude saves beside its own
      filesystem: { allowWrite: filesystem.allowWrite, denyWrite, denyRead: [...secrets, join(stateDirectory, claudeTranscripts)] }
    },
    permissions: {
      defaultMode: 'dontAsk', allow: ['mcp__rac', claudeConductorAskUserTool, ...(writable ? ['Edit', 'Write'] : [])],
      deny: ['AskUserQuestion', ...rules('Read', secrets), ...rules('Edit', denyWrite)],
      blockFileToolReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true
    }
  });
}
