import { codexCommands, codexCompletion, codexConversations, codexInferState, codexNewConversation, codexSubmission, codexTurns, parseCodexQuestion } from './codex-tui.js';
import { classifyOmxPane, classifyOmxProcess, isOmxWorkerPane } from './omx-panes.js';
import { isOmxLeaderCommand } from './omx-processes.js';
import { pendingOmxQuestion } from './omx-questions.js';
import { codexQuestionTextEntry, queuedCodexQuestion } from './codex-questions.js';
import type { Adapter } from './types.js';

/**
 * The OMX Adapter (ADR 0005). OMX (oh-my-codex) wraps the Codex TUI: its wrapper
 * process — `node …/oh-my-codex/dist/cli/omx.js` — launches Codex as a child and
 * stays alive as its parent, so the walker meets it before the Codex child and the
 * pane is badged OMX. What differs from Codex is the launch (`--direct`, forcing
 * OMX's direct policy inside tmux so it manages no HUD panes; `resume` forwarded to
 * Codex unchanged), recognition (the bare launch and `resume` are Agents, decided
 * from the first argument as OMX's own dispatcher does; hud/team/sidecar/mcp-serve
 * and every other subcommand are helpers), the structured question files OMX
 * writes, and the runtime-cleanup rules for its worker and HUD panes. Everything
 * the TUI itself does — title, submission, turns, commands, conversations, rollout
 * completion — is the shared `codex-tui.ts` object, so the two kinds cannot drift.
 *
 * The Codex-only console features (review tour, ChatGPT accounts, update advisor,
 * app-server command catalog) stay keyed on `adapters.codex`; an OMX-only
 * configuration does without them.
 */
export const omxAdapter = {
  kind: 'omx',
  stateSource: 'title',
  // the console composes OMX's tmux policy itself; an operator copy is warned and dropped at boot
  conflictingArgs: ['--direct', '--tmux'],
  recognizes: ({ comm, argv }) => isOmxLeaderCommand(comm, argv),
  inferState: codexInferState,
  // `--direct` always; continue and resume forward Codex's own `resume` forms
  launch: ({ mode, conversationId }) => {
    if (mode === 'continue') return { args: ['--direct', 'resume', '--last'] };
    if (mode === 'resume' && conversationId !== undefined) return { args: ['--direct', 'resume', conversationId] };
    return { args: ['--direct'] };
  },
  submission: codexSubmission,
  turns: codexTurns,
  questions: { parse: parseCodexQuestion, pending: pendingOmxQuestion, queued: queuedCodexQuestion, textEntry: codexQuestionTextEntry },
  commands: codexCommands,
  conversations: codexConversations,
  completion: codexCompletion,
  // OMX runs the Codex TUI, so `/new` resets it identically (shared by reference)
  newConversation: codexNewConversation,
  // team worker panes are hidden; orphan workers, HUD panes/processes and stale OMX panes are cleanup targets
  panes: { exclude: isOmxWorkerPane, classify: classifyOmxPane, classifyProcess: classifyOmxProcess },
} satisfies Adapter;
