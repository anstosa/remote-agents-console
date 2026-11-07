import { z } from 'zod';
import type { IntegrationPrincipal } from '../auth/index.js';
import type { DavoLive, DavoLiveTurn } from '../../davo/live.js';
import type { DavoInstanceQualifiedTargetV1 } from '../../davo/contracts.js';
import { canonicalizeDavo, digestDavo } from '../../davo/remote.js';
import { developerFailure, developerSuccess, developerTool, developerIdentifier, developerIdSchema, developerRequestId, developerRequestSchema, type DeveloperResult, type DeveloperTool } from './developer-tool.js';

export type DavoHumanAnswer = { index: number } | { text: string } | { dismiss: true };
export type DavoToolPorts = {
  live: DavoLive;
  resolveTarget: (input: { agentId: string; worktreeId: string; instanceId?: string }, principal: IntegrationPrincipal, turn: DavoLiveTurn) => Promise<DavoInstanceQualifiedTargetV1 | undefined>;
  delegate: (input: { target: DavoInstanceQualifiedTargetV1; turn: DavoLiveTurn; principal: IntegrationPrincipal; operationId: string; criteria: string[]; requiredChecks: string[] }) => Promise<DeveloperResult>;
  relay: (input: { target: DavoInstanceQualifiedTargetV1; turn: DavoLiveTurn; principal: IntegrationPrincipal; questionId: string; answer: DavoHumanAnswer; operationId: string }) => Promise<DeveloperResult>;
  answerChoice: (input: { requestId: string; choiceId: string; answer: string; turn: DavoLiveTurn; principal: IntegrationPrincipal; operationId: string }) => Promise<DeveloperResult>;
};
const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const capabilitySchema = { type: 'string', minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]{43}$' };
const common = { request_id: developerRequestId, turn_capability: capability };
const commonProperties = { request_id: developerRequestSchema, turn_capability: capabilitySchema };
const output = z.record(z.unknown());
const humanAnswer = z.union([z.object({ index: z.number().int().min(0).max(99) }).strict(), z.object({ text: z.string().min(1).max(8000) }).strict(), z.object({ dismiss: z.literal(true) }).strict()]);
const humanAnswerSchema = { oneOf: [{ type: 'object', properties: { index: { type: 'integer', minimum: 0, maximum: 99 } }, required: ['index'], additionalProperties: false }, { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['text'], additionalProperties: false }, { type: 'object', properties: { dismiss: { const: true } }, required: ['dismiss'], additionalProperties: false }] };

// bind one-use authority to tool kind and every canonical argument
function actionDigest(name: string, input: Record<string, unknown>): string {
  return digestDavo(canonicalizeDavo({ name, arguments: JSON.parse(JSON.stringify(input)) }));
}

// expose only admitted-turn mutations to the realtime principal
export function createDavoTools(ports: DavoToolPorts): DeveloperTool[] {
  // verify capability before resolving any mutation target
  async function admitted(input: Record<string, unknown>, principal: IntegrationPrincipal): Promise<DavoLiveTurn> {
    // federated raw realtime calls cannot manufacture a local admitted response
    if (principal.authentication !== 'realtime' || principal.leaseKey === undefined || principal.federated !== undefined) throw new Error('davo_voice_inactive');
    return await ports.live.awaitCapability(principal.leaseKey, input.turn_capability as string);
  }

  // keep safe errors out of provider detail
  async function guarded(effect: () => Promise<DeveloperResult>): Promise<DeveloperResult> {
    try { return await effect(); }
    catch (error) { return developerFailure(error instanceof Error && /^davo_[a-z_]+$/u.test(error.message) ? error.message : 'davo_unavailable', 'Davo could not authorize this exact operation.'); }
  }

  // share paired schemas and audited gateway policy
  function tool(name: string, description: string, shape: z.ZodRawShape, properties: Record<string, unknown>, execute: DeveloperTool['execute']): DeveloperTool {
    return developerTool({ name, title: name.replaceAll('_', ' '), description, audiences: ['realtime'], requiredScopes: ['status:read', 'prompts:write'], risk: 'write', idempotency: 'domain_cursor', schema: z.object({ ...common, ...shape }).strict(), inputSchema: { type: 'object', properties: { ...commonProperties, ...properties }, required: [...Object.keys(commonProperties), ...Object.keys(properties).filter(key => key !== 'target_instance_id')], additionalProperties: false }, output, dataSchema: { type: 'object', additionalProperties: true }, execute });
  }

  return [
    tool('bind_davo_target', 'Bind an exact canonical ordinary Agent and Worktree to this admitted audio request. Resolve both identifiers with read tools first.', { agent_id: developerIdentifier, worktree_id: developerIdentifier, target_instance_id: developerIdentifier.optional() }, { agent_id: developerIdSchema, worktree_id: developerIdSchema, target_instance_id: developerIdSchema }, async (input, principal) => guarded(async () => {
      const turn = await admitted(input, principal);
      const target = await ports.resolveTarget({ agentId: input.agent_id as string, worktreeId: input.worktree_id as string, instanceId: input.target_instance_id as string | undefined }, principal, turn);
      // an ambiguous or unauthorized target never receives a capability
      if (target === undefined) return developerFailure('not_found', 'The canonical Agent and Worktree could not be resolved.');
      const token = ports.live.bindTarget(principal.leaseKey!, turn.capability, turn.responseId!, target);
      return developerSuccess({ target_capability: token, agent_id: target.agentId, worktree_id: target.worktreeId, instance_id: target.instanceId });
    })),
    tool('delegate_request', 'Delegate the original admitted user request to the bound ordinary RAC Agent. The immutable transcript supplies the task; criteria and checks do not replace it.', { target_capability: capability, criteria: z.array(z.string().min(1).max(512)).min(1).max(32), required_checks: z.array(z.string().min(1).max(128)).max(16) }, { target_capability: capabilitySchema, criteria: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 512 } }, required_checks: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 128 } } }, async (input, principal) => guarded(async () => {
      const turn = await admitted(input, principal);
      const target = ports.live.consumeTarget(principal.leaseKey!, turn.capability, turn.responseId!, input.target_capability as string, input.request_id as string, actionDigest('delegate_request', input)) as DavoInstanceQualifiedTargetV1;
      return await ports.delegate({ target, turn, principal, operationId: input.request_id as string, criteria: input.criteria as string[], requiredChecks: input.required_checks as string[] });
    })),
    tool('relay_agent_question_answer', 'Relay only an explicit answer in this newly admitted user audio to one exact currently pending Agent question. Never infer approval or choose a default.', { target_capability: capability, question_id: developerIdentifier, answer: humanAnswer }, { target_capability: capabilitySchema, question_id: developerIdSchema, answer: humanAnswerSchema }, async (input, principal) => guarded(async () => {
      const turn = await admitted(input, principal);
      const target = ports.live.consumeTarget(principal.leaseKey!, turn.capability, turn.responseId!, input.target_capability as string, input.request_id as string, actionDigest('relay_agent_question_answer', input)) as DavoInstanceQualifiedTargetV1;
      return await ports.relay({ target, turn, principal, questionId: input.question_id as string, answer: input.answer as DavoHumanAnswer, operationId: input.request_id as string });
    })),
    tool('answer_davo_choice', 'Answer an exact pending Davo continuation choice from this newly admitted user audio. This is not an Agent question or permission grant.', { davo_request_id: developerIdentifier, choice_id: developerIdentifier, answer: z.string().min(1).max(512) }, { davo_request_id: developerIdSchema, choice_id: developerIdSchema, answer: { type: 'string', minLength: 1, maxLength: 512 } }, async (input, principal) => guarded(async () => {
      const turn = await admitted(input, principal);
      ports.live.consumeAction(principal.leaseKey!, turn.capability, input.request_id as string, actionDigest('answer_davo_choice', input));
      return await ports.answerChoice({ requestId: input.davo_request_id as string, choiceId: input.choice_id as string, answer: input.answer as string, turn, principal, operationId: input.request_id as string });
    }))
  ];
}
