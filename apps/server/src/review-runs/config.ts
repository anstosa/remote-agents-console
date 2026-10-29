import { z } from 'zod';
import { agentChoiceProblem, agentChoiceShape, type AgentChoice } from '../launch/agent-choice.js';
import { byReviewAgentKind, reviewAgentKinds, type ReviewAgentKind } from './kinds.js';

export type ReviewRunMode = 'headless' | 'interactive';
export type ResolvedReviewTour = AgentChoice<ReviewAgentKind> & { prompt: string };
export type ReviewPreset = AgentChoice<ReviewAgentKind> & { id: string; label: string; prompt: string };
// the `review` section with every default filled: a run mode per kind, the tour's agent and
// prompt, at least one preset, and a defaultPreset naming one of them (ADR 0010)
export type ResolvedReviewConfig = { agents: Record<ReviewAgentKind, { mode: ReviewRunMode }>; tour: ResolvedReviewTour; presets: ReviewPreset[]; defaultPreset: string };

// the narration guidance a tour uses without a configured prompt; the server appends the contract
export const builtInTourPrompt = [
  'Create a narrated implementation-change tour for a human reviewer.',
  'Give the tour a concise, specific title naming the implementation change or outcome. Do not use a broad category label such as "Mobile layout" as the title.',
  'Explain mechanism, intent, dependencies, and the order in which the implementation fits together.',
  'Group related change IDs across files into logical steps.'
].join('\n\n');

// what the built-in Correctness preset looks for; the server appends the Findings contract
export const builtInCorrectnessPrompt = [
  'Review these changes for correctness.',
  'Look for bugs, regressions, broken edge cases, error handling that hides failures, concurrency or ordering mistakes, and security problems such as injection, missing authorization, or unsafe input handling.',
  'Read the surrounding code when a change depends on it. Report only problems you can explain concretely from the code, with the input or sequence that triggers them.',
  'Do not report style, naming, formatting, or preferences, and do not restate what the change does.'
].join('\n\n');

const reviewPrompt = z.string().trim().min(1).max(8_000).refine(value => !value.includes('\0'), 'NUL is forbidden');
const reviewAgent = z.enum(reviewAgentKinds);
const reviewMode = z.object({ mode: z.enum(['headless', 'interactive']).default('headless') }).strict();
// a run mode per Review run kind, each optional
const reviewAgents = z.object(byReviewAgentKind(() => reviewMode.optional())).strict();
const reviewTour = z.object({ ...agentChoiceShape(reviewAgent.optional()), prompt: reviewPrompt.optional() }).strict();
const reviewPresetId = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/u, 'preset ids are 1-40 letters, digits, `_` and `-`');
const reviewPreset = z.object({ id: reviewPresetId, label: z.string().trim().min(1).max(80).refine(value => !value.includes('\0'), 'NUL is forbidden'), ...agentChoiceShape(reviewAgent), prompt: reviewPrompt }).strict();
export const reviewConfigSchema = z.object({ agents: reviewAgents.optional(), tour: reviewTour.optional(), presets: z.array(reviewPreset).max(20).optional(), defaultPreset: reviewPresetId.optional() }).strict();
type ParsedReviewConfig = z.output<typeof reviewConfigSchema>;

// refuse an agent that is not configured under `adapters`, or an effort it does not accept
function checkRun(label: string, agent: ReviewAgentKind, effort: string | undefined, configured: (kind: ReviewAgentKind) => boolean, explicitAgent: boolean): void {
  if (explicitAgent && !configured(agent)) throw new Error(`${label} runs on ${agent}, which is not configured under adapters`);
  const problem = agentChoiceProblem(label, { agent, ...(effort === undefined ? {} : { effort }) });
  if (problem !== undefined) throw new Error(problem);
}

// fill the `review` section's defaults and cross-check it against the configured adapters:
// the tour runs on the first configured Review run kind in registry order (Codex, then Claude),
// else the first kind (reported unavailable);
// with no presets one built-in Correctness preset runs on the tour's agent
export function resolveReviewConfig(parsed: ParsedReviewConfig | undefined, adapters: Partial<Record<string, unknown>>): ResolvedReviewConfig {
  const configured = (kind: ReviewAgentKind) => adapters[kind] !== undefined;
  const raw = parsed ?? {};
  const agent = raw.tour?.agent ?? reviewAgentKinds.find(configured) ?? reviewAgentKinds[0];
  checkRun('review.tour', agent, raw.tour?.effort, configured, raw.tour?.agent !== undefined);
  const tour: ResolvedReviewTour = { agent, prompt: raw.tour?.prompt ?? builtInTourPrompt, ...(raw.tour?.model === undefined ? {} : { model: raw.tour.model }), ...(raw.tour?.effort === undefined ? {} : { effort: raw.tour.effort }) };
  const ids = new Set<string>();
  for (const preset of raw.presets ?? []) {
    if (ids.has(preset.id)) throw new Error(`review.presets has duplicate id \`${preset.id}\``);
    ids.add(preset.id);
    checkRun(`review.presets.${preset.id}`, preset.agent, preset.effort, configured, true);
  }
  const presets: ReviewPreset[] = raw.presets !== undefined && raw.presets.length > 0
    ? raw.presets.map(preset => ({ id: preset.id, label: preset.label, agent: preset.agent, prompt: preset.prompt, ...(preset.model === undefined ? {} : { model: preset.model }), ...(preset.effort === undefined ? {} : { effort: preset.effort }) }))
    : [{ id: 'correctness', label: 'Correctness', agent, prompt: builtInCorrectnessPrompt }];
  if (raw.defaultPreset !== undefined && !presets.some(preset => preset.id === raw.defaultPreset)) throw new Error(`review.defaultPreset \`${raw.defaultPreset}\` names no preset`);
  return { agents: byReviewAgentKind(kind => ({ mode: raw.agents?.[kind]?.mode ?? 'headless' })), tour, presets, defaultPreset: raw.defaultPreset ?? presets[0]!.id };
}
