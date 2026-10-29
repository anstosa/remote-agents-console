import { createHash } from 'node:crypto';
import type { InlineQuestion } from './types.js';

/**
 * The identity every Inline question transport agrees on, shared by the three
 * Adapters that produce one: the Codex numbered list parsed off the pane
 * (`codex-questions.ts`), OMX's structured question files (`omx-questions.ts`),
 * and the Claude question the Agent reports through its pane (`claude-questions.ts`).
 *
 * The operator answers the question they saw, and a re-derive at answer time
 * refuses a stale id. Text plus choices is the identity — the same NUL-joined
 * hash the socket fingerprints use — so the same dialog captured at two pane
 * widths yields the same id.
 */
export function inlineQuestionId(text: string, choices: readonly string[]): string {
  return createHash('sha256').update([text, ...choices].join('\0')).digest('base64url').slice(0, 22);
}

/** A pane question with its Transport-neutral answer field: one of its choices. */
export function withQuestionShape(question: InlineQuestion): InlineQuestion {
  const { choices, descriptions } = question;
  return { ...question, field: { kind: 'choice', choices, ...(descriptions === undefined ? {} : { descriptions }) } };
}
