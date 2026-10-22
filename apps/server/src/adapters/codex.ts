import { classifyCodexPane } from './codex-panes.js';
import { isCodexCommand } from './codex-processes.js';
import { codexQuestionTextEntry, queuedCodexQuestion } from './codex-questions.js';
import { codexCommands, codexCompletion, codexConversations, codexInferState, codexNewConversation, codexSubmission, codexTurns, parseCodexQuestion } from './codex-tui.js';
import { codexReviewRuns } from './codex-review-runs.js';
import type { Adapter } from './types.js';

/**
 * The Codex Adapter — the first Adapter, extracted behind the interface with zero
 * behaviour change. `recognizes` is native; everything the TUI does comes from
 * `codex-tui.ts`, which the OMX Adapter shares by reference (ADR 0005). It
 * recognises plain Codex only: OMX is its own kind.
 */
export const codexAdapter = {
  kind: 'codex',
  stateSource: 'title',
  recognizes: ({ comm, argv }) => isCodexCommand(comm, argv),
  inferState: codexInferState,
  // Continue resumes the last conversation without a shell alias; a resume
  // resumes an exact conversation by id. Fresh launches append nothing, so the
  // configured command runs unchanged.
  launch: ({ mode, conversationId }) => {
    if (mode === 'continue') return { args: ['resume', '--last'] };
    if (mode === 'resume' && conversationId !== undefined) return { args: ['resume', conversationId] };
    return { args: [] };
  },
  submission: codexSubmission,
  turns: codexTurns,
  // plain Codex draws its questions on the pane; the structured question files are OMX's
  questions: { parse: parseCodexQuestion, queued: queuedCodexQuestion, textEntry: codexQuestionTextEntry },
  commands: codexCommands,
  conversations: codexConversations,
  completion: codexCompletion,
  newConversation: codexNewConversation,
  // Codex hides no panes and runs no helper processes; its one cleanup rule is the stale agent
  panes: { classify: classifyCodexPane },
  reviewRuns: codexReviewRuns,
} satisfies Adapter;
