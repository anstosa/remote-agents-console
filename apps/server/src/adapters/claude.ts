import { basename } from 'node:path';
import { claudeConfigDir, claudeConversationLatestMessage, claudeConversationName, claudeConversationSummaries, validClaudeSessionId } from './claude-conversations.js';
import { claudeSkillDirectories, claudeSlash } from './claude-commands.js';
import { claudeFiles, claudeHooksFileName } from './claude-hooks.js';
import { claudeNewConversation } from './claude-new-conversation.js';
import { claudeReviewRuns } from './claude-review-runs.js';
import { claudeQuestionTextAnswer, claudeQuestionTextEntry, reportedClaudeQuestion } from './claude-questions.js';
import type { Adapter, TmuxKey } from './types.js';

// The packaged CLI entry a `node …` invocation of Claude Code runs.
const claudeCliEntry = '@anthropic-ai/claude-code/cli.js';

/**
 * Recognise the Claude Code process itself, never a descendant. It presents as
 * `comm === 'claude'`, an argv[0] whose basename is `claude`, or `node` running the
 * packaged CLI (`…/@anthropic-ai/claude-code/cli.js`). A `bash -c` tool child of a
 * live session — or an `srt`/`bwrap` wrapper ancestor — must not match; the walker
 * owns ancestry, the Adapter classifies one process (ADR 0002).
 */
function recognizes({ comm, argv }: { comm: string; argv: string[] }): boolean {
  if (comm === 'claude') return true;
  const arg0 = argv[0];
  if (arg0 !== undefined && basename(arg0) === 'claude') return true;
  const isNode = comm === 'node' || (arg0 !== undefined && basename(arg0) === 'node');
  return isNode && argv.some(argument => argument.endsWith(claudeCliEntry));
}

// The operator arguments the Adapter composes itself (so a duplicate in
// `adapters.claude.args` is warned and dropped at boot): the injected settings, the
// non-interactive/bare modes, and every mode flag the console selects by launch mode.
const conflictingArgs = ['--settings', '--bare', '--safe-mode', '-c', '--continue', '-r', '--resume', '--session-id', '-p', '--print'] as const;

// Slash commands that clear or reset the session and return straight to an idle
// composer with no model turn, so they fire SessionStart (`finished`) but never
// UserPromptSubmit (`working`). The console submits these fire-and-forget (no
// awaiting-start phase). Commands that open a persistent picker (/model, /resume,
// /fork…) are deliberately excluded: a queued follow-up must not paste into them.
const instantCommands = new Set(['/clear']);

/**
 * The Claude Code Adapter (chunk 2). State is reported through hooks (`stateSource:
 * 'reported'`), so the title carries no signal and `inferState` is always
 * `undefined`. Every launch injects the console-owned `hooks.json` through
 * `--settings`, leaving `~/.claude` untouched. There are no `turns` (fullscreen
 * viewport) and no `panes`, and `conversations` has no `discover` (the transcript
 * fd is not held open) — only a reported `@rac_session` id, whose name is read from
 * the transcript. `AskUserQuestion` renders as an Inline question through the reported
 * hook payload (ADR 0006): the dialog draws options in payload order with the
 * highlight on the first, so `selectOption` navigates it by Down-key count.
 */
export const claudeAdapter = {
  kind: 'claude',
  stateSource: 'reported',
  conflictingArgs: [...conflictingArgs],
  recognizes,
  inferState: () => undefined,
  // fresh → --settings <file>; continue → --continue --settings <file>; resume →
  // --resume <id> --settings <file>. Nothing else; chunk 4 selects among settings
  // variants by availability and Sandboxed.
  launch: ({ mode, conversationId, files }) => {
    const settings = files?.[claudeHooksFileName];
    const settingsArgs = settings === undefined ? [] : ['--settings', settings];
    if (mode === 'continue') return { args: ['--continue', ...settingsArgs] };
    if (mode === 'resume' && conversationId !== undefined) return { args: ['--resume', conversationId, ...settingsArgs] };
    return { args: settingsArgs };
  },
  submission: {
    // both modes: paste the text and press Enter — no trailing space, never Tab
    prepare: (prompt) => ({ text: prompt, keys: ['Enter'] }),
    // /clear and its like complete without a `working` report — track no completion
    completesWithoutWork: (prompt) => instantCommands.has(prompt.trim().split(/\s+/u)[0] ?? ''),
    // Escape then C-c as separate writes; never Escape Escape (Rewind) or C-c C-c (exit)
    interrupt: ['Escape', 'C-c'],
    selectOption: (index) => [...Array.from({ length: index }, () => 'Down' as TmuxKey), 'Enter'],
  },
  commands: {
    stateDirectory: (env) => claudeConfigDir(env),
    skillDirectories: claudeSkillDirectories,
    slash: claudeSlash,
    skillInvocation: (name) => `/${name}`,
  },
  questions: {
    // the Agent reports the question payload on its own pane; the matcher confirms
    // the dialog is live against the capture and answers it on the same pane
    reported: reportedClaudeQuestion,
    // free text goes through the dialog's `Type something.` row
    textEntry: claudeQuestionTextEntry,
    textAnswer: claudeQuestionTextAnswer,
  },
  conversations: {
    validId: validClaudeSessionId,
    // the Named Claude conversations under the Project's Worktree directories
    list: (directories) => claudeConversationSummaries(directories),
    // Claude renames the current Conversation with `/rename <name>`, submitted as Enter
    rename: (name) => ({ text: `/rename ${name}`, keys: ['Enter'] }),
    readName: (id, cwd) => claudeConversationName(id, cwd),
    // read ordinary questions without opening an answer dialog
    latestMessage: (pane) => claudeConversationLatestMessage(pane),
  },
  newConversation: claudeNewConversation,
  files: claudeFiles,
  reviewRuns: claudeReviewRuns,
} satisfies Adapter;
