import { join } from 'node:path';
import { codexDraftState, codexOwnsDraft, failedTurnFromCapture, lastPromptFromHistory, latestAgentMessageFromHistory, latestCompletedAssistantTurn, queueReadyPrompt } from './codex-turns.js';
import { parseChoiceQuestion } from './codex-questions.js';
import { codexConversationName, codexConversationSummaries, codexHome, codexLatestMessage, codexManagedPromptLifecycle, codexPromptAccepted, codexRolloutBaseline, codexTurnSince, discoverCodexConversation, validCodexThreadId } from './codex-conversations.js';
import type { Adapter, AttentionState, PromptCommand } from './types.js';

// The new-conversation reset lives in its own module; both the Codex and OMX Adapters
// carry it by reference through this shared TUI module (ADR 0005).
export { codexNewConversation } from './codex-new-conversation.js';

/**
 * What the Codex TUI does, independent of who launched it. The Codex Adapter and
 * the OMX Adapter (ADR 0005) both carry these very objects — OMX launches this same
 * TUI — so title inference, submission, turn capture, commands, conversation lookup
 * and rollout completion are identical for both kinds by reference and cannot drift
 * apart. This is a helper module, not an Adapter: neither Adapter imports the other.
 */

// build the supported-version codex compatibility catalog
function codexSlash(): PromptCommand[] {
  return [
    { name: '/help', description: 'Show available commands' },
    { name: '/model', description: 'Choose what model and reasoning effort to use' },
    { name: '/ide', description: 'Include current selection, open files, and other IDE context' },
    { name: '/permissions', description: 'Choose what Codex is allowed to do' },
    { name: '/keymap', description: 'Remap TUI shortcuts' },
    { name: '/vim', description: 'Toggle Vim mode for the composer' },
    { name: '/setup-default-sandbox', description: 'Set up the elevated agent sandbox' },
    { name: '/experimental', description: 'Toggle experimental features' },
    { name: '/approve', description: 'Approve one retry of a recent auto-review denial' },
    { name: '/memories', description: 'Configure memory use and generation' },
    { name: '/skills', description: 'Use skills to improve how Codex performs specific tasks' },
    { name: '/import', description: 'Import setup, this project, and recent chats from Claude Code' },
    { name: '/hooks', description: 'View and manage lifecycle hooks' },
    { name: '/review', description: 'Review current changes and find issues' },
    { name: '/rename', description: 'Rename the current thread' },
    { name: '/new', description: 'Start a new chat during a conversation' },
    { name: '/archive', description: 'Archive this session and exit' },
    { name: '/delete', description: 'Permanently delete this session and exit' },
    { name: '/resume', description: 'Resume a saved chat' },
    { name: '/fork', description: 'Fork the current chat' },
    { name: '/init', description: 'Create an AGENTS.md file with instructions for Codex' },
    { name: '/compact', description: 'Summarize the conversation to prevent hitting the context limit' },
    { name: '/recap', description: 'Summarize the current conversation now' },
    { name: '/plan', description: 'Switch to Plan mode' },
    { name: '/goal', description: 'Set or view the goal for a long-running task' },
    { name: '/agent', description: 'Switch the active agent thread' },
    { name: '/agents', description: 'View and switch between all active agent sessions' },
    { name: '/side', description: 'Start a side conversation in an ephemeral fork' },
    { name: '/btw', description: 'Start a side conversation in an ephemeral fork' },
    { name: '/copy', description: 'Copy the last response, code block, or quote' },
    { name: '/export', description: 'Export the conversation as markdown' },
    { name: '/raw', description: 'Toggle raw scrollback mode for copy-friendly terminal selection' },
    { name: '/diff', description: 'Show git diff, including untracked files' },
    { name: '/mention', description: 'Mention a file' },
    { name: '/status', description: 'Show current session configuration and token usage' },
    { name: '/cd', description: 'Change the current working directory' },
    { name: '/pwd', description: 'Show the current working directory' },
    { name: '/usage', description: 'View account usage or use a usage limit reset' },
    { name: '/debug-config', description: 'Show config layers and requirement sources for debugging' },
    { name: '/title', description: 'Configure which items appear in the terminal title' },
    { name: '/statusline', description: 'Configure which items appear in the status line' },
    { name: '/theme', description: 'Choose a syntax highlighting theme' },
    { name: '/pets', description: 'Choose or hide the terminal pet' },
    { name: '/mcp', description: 'List configured MCP tools' },
    { name: '/apps', description: 'Manage apps' },
    { name: '/plugins', description: 'Browse plugins' },
    { name: '/logout', description: 'Log out of Codex' },
    { name: '/quit', description: 'Exit Codex' },
    { name: '/exit', description: 'Exit Codex' },
    { name: '/feedback', description: 'Send logs to maintainers' },
    { name: '/ps', description: 'List background terminals' },
    { name: '/stop', description: 'Stop all background terminals' },
    { name: '/clear', description: 'Clear the terminal and start a new chat' },
    { name: '/personality', description: 'Choose a communication style for Codex' },
    { name: '/subagents', description: "Switch between this session's subagents" },
  ];
}

// Codex writes its Attention state into the pane title: a Braille spinner while
// working, an "action required" banner when it needs input, anything else once
// it has finished. This is the single home of that title rule (ADR 0001/0002).
const workingTitle = /^[\u2800-\u28ff]/u;
const actionRequiredTitle = /action required/iu;

export function codexInferState(pane: { title: string }): AttentionState {
  if (actionRequiredTitle.test(pane.title)) return 'question';
  return workingTitle.test(pane.title) ? 'working' : 'finished';
}

export const codexSubmission: Adapter['submission'] = {
  // codex submits idle prompts with Enter and queues active prompts with Tab
  // a trailing space dismisses the completion menu before either key
  prepare: (prompt, mode) => mode === 'shell'
    ? { text: prompt, keys: ['Enter'] }
    : { text: queueReadyPrompt(prompt), keys: ['Tab'], idleKeys: ['Enter'] },
  observeDraft: codexDraftState,
  ownsDraft: codexOwnsDraft,
  // ctrl-c clears a nonempty rich composer before native work interruption
  clearDraft: ['C-c'],
  interrupt: ['C-c'],
  // navigate from the live highlight rather than assuming the first option
  selectOption: (index, selectedIndex = 0) => {
    const offset = index - selectedIndex;
    // move only the distance to the requested row before confirming
    return [...Array.from({ length: Math.abs(offset) }, () => offset < 0 ? 'Up' as const : 'Down' as const), 'Enter'];
  },
};

export const codexTurns: NonNullable<Adapter['turns']> = {
  latestCompleted: (capture) => latestCompletedAssistantTurn(capture),
  lastPrompt: (capture) => lastPromptFromHistory(capture),
  latestMessage: (capture) => latestAgentMessageFromHistory(capture),
  failed: failedTurnFromCapture,
};

// `capture` is either a raw pane capture or an already-isolated latest message.
// Isolate the agent's latest message when a prompt boundary is present (so the
// composer box below it never reads as a choice list); an already-isolated message
// has none and is parsed as-is. Both paths yield the same question — and so the
// same id — for a given on-screen list.
export const parseCodexQuestion = (capture: string) => parseChoiceQuestion(latestAgentMessageFromHistory(capture) ?? capture);

export const codexCommands: NonNullable<Adapter['commands']> = {
  // The account-global skills override nothing; the workspace's `.codex/skills`
  // shadow same-named entries. Codex invokes a skill as `$name`.
  runtimeCatalog: 'codex-app-server',
  stateDirectory: (env) => codexHome(env),
  skillDirectories: (workspace, stateDirectory) => [join(stateDirectory, 'skills'), join(workspace, '.codex', 'skills')],
  slash: codexSlash,
  skillInvocation: (name) => `$${name}`,
};

export const codexConversations: NonNullable<Adapter['conversations']> = {
  validId: validCodexThreadId,
  discover: (pane) => discoverCodexConversation(pane),
  // the Named Codex/OMX conversations under the Project's Worktree directories. OMX carries
  // this very object (ADR 0005), so the console dedupes the shared reader to one row per
  // rollout and badges it with the Worktree's remembered kind.
  list: (directories) => codexConversationSummaries(directories),
  // Codex and OMX rename the current thread with `/rename <name> ` (trailing space), submitted as Enter
  rename: (name) => ({ text: `/rename ${name} `, keys: ['Enter'] }),
  readName: (id) => codexConversationName(id),
  // read ordinary questions without opening an answer dialog
  latestMessage: (pane) => codexLatestMessage(pane),
};

export const codexCompletion: NonNullable<Adapter['completion']> = {
  baseline: (pane, resetAt, followReset) => codexRolloutBaseline(pane, resetAt, followReset),
  // confirm durable prompt receipt
  accepted: (baseline, prompt) => codexPromptAccepted(baseline, prompt),
  since: (baseline) => codexTurnSince(baseline),
};

// expose schema-validated correlation independently of CLI release labels
export const codexManagedPromptLifecycleV1: NonNullable<Adapter['managedPromptLifecycleV1']> = {
  version: 1,
  // validate compatibility against each activity's actual native evidence
  compatible: () => true,
  // inspect only the pinned rollout and exact prompt identity
  inspect: (baseline, prompt, checkpoint) => codexManagedPromptLifecycle(baseline, prompt, checkpoint),
};
