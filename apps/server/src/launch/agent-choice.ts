import { z } from 'zod';
import { adapterFor } from '../adapters/registry.js';
import type { AgentKind } from '../adapters/types.js';

/**
 * Which Agent runs, and optionally on which model and Effort: the one shape the Launch profile and
 * the Review presets (and the tour) share. Each kind decides which Efforts it accepts.
 */
export type AgentChoice<K extends AgentKind = AgentKind> = { agent: K; model?: string; effort?: string };

// a model name is one argv value, so it never starts like a flag; `~` starts OpenRouter's
// rolling ids (`openrouter/~anthropic/claude-opus-latest`)
export const agentModel = z.string().regex(/^[A-Za-z0-9~][A-Za-z0-9._:/@[\]~-]{0,199}$/u, 'model names are letters, digits and `._:/@[]~-`');
export const agentEffort = z.string().min(1).max(20);
/** The fields of an Agent choice, for a schema that names its own `agent` enum. */
export const agentChoiceShape = <K extends z.ZodTypeAny>(agent: K) => ({ agent, model: agentModel.optional(), effort: agentEffort.optional() });

/** The Efforts a kind accepts: a Review run kind's CLI levels; none for any other kind yet. */
export function agentEfforts(kind: AgentKind): readonly string[] {
  return adapterFor(kind)?.reviewRuns?.efforts ?? [];
}

/** Why a choice is refused (an Effort its kind does not accept), or undefined when it is fine. */
export function agentChoiceProblem(label: string, choice: AgentChoice): string | undefined {
  const efforts = agentEfforts(choice.agent);
  if (choice.effort !== undefined && !efforts.includes(choice.effort)) return `${label} effort \`${choice.effort}\` is not one of ${choice.agent}'s levels: ${efforts.join(', ')}`;
  return undefined;
}
