import { randomBytes } from 'node:crypto';
import type { IntegrationConfig } from '../../config/schema.js';
import type { OrchestrationResult, OrchestrationService } from '../../orchestration/index.js';
import type { IntegrationAuditService } from '../audit/service.js';
import type { IntegrationPrincipal } from '../auth/index.js';
import type { IntegrationControlService } from '../control/index.js';
import { digest, type IntegrationPolicyService } from '../policy/service.js';
import { conductorCallable, integrationToolByName, integrationTools, type IntegrationTool } from './catalog.js';

export type ToolCallResult = { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown>; isError?: boolean };
export type IntegrationGatewayOptions = { config: IntegrationConfig; instanceId: string; orchestration: OrchestrationService; policy: IntegrationPolicyService; audit: Pick<IntegrationAuditService, 'record'>; control: IntegrationControlService; forward?: (instanceId: string, principal: IntegrationPrincipal, name: string, args: Record<string, unknown>, voiceAuthorized: boolean) => Promise<ToolCallResult | undefined> };
export type IntegrationGatewayContext = { voiceAuthorized?: boolean };

type MutationArguments = Record<string, unknown> & { request_id: string };

// route all transports through one policy boundary
export class IntegrationGateway {
  // retain only injected policy dependencies
  constructor(private readonly options: IntegrationGatewayOptions) {}

  // list only tools enabled for this deployment and principal
  listTools(principal: IntegrationPrincipal): IntegrationTool[] {
    return integrationTools.filter(candidate => this.enabled(candidate, principal) && candidate.requiredScopes.every(scope => principal.scopes.includes(scope)));
  }

  // validate, authorize, execute, and audit one tool call
  async call(principal: IntegrationPrincipal, name: string, rawArguments: unknown, context: IntegrationGatewayContext = {}): Promise<ToolCallResult> {
    const started = Date.now();
    const correlationId = randomBytes(12).toString('base64url');
    const definition = integrationToolByName.get(name);
    const rawRecord = rawArguments !== null && typeof rawArguments === 'object' && !Array.isArray(rawArguments) ? { ...(rawArguments as Record<string, unknown>) } : undefined;
    const instanceId = rawRecord?.instance_id;
    // validate local tool arguments separately
    if (rawRecord !== undefined) delete rawRecord.instance_id;
    const parsed = definition?.schema.safeParse(rawRecord ?? rawArguments ?? {});
    const argumentsDigest = digest(stableJson(rawArguments ?? {}));
    const principalKey = digest(`${principal.authentication}:${principal.subjectId}:${principal.clientId ?? 'realtime'}`);
    let requestId: string | undefined;
    let idempotencyId: string | undefined;
    let strictOutcomeAudit = false;
    let result: ToolCallResult;

    // write one payload-free audit event
    const audit = async (phase: 'intent' | 'outcome', outcome: 'pending' | 'success' | 'error', errorCode?: string): Promise<void> => {
      await this.options.audit.record({
        phase,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        correlationId,
        ...(requestId === undefined ? {} : { requestId }),
        principalHash: digest(principal.subjectId),
        clientId: principal.clientId ?? principal.authentication,
        tool: name,
        scopes: [...principal.scopes],
        risk: definition?.risk ?? 'read',
        argumentsDigest,
        targetSummary: auditTarget(instanceId, parsed?.success ? parsed.data : rawRecord),
        ...(idempotencyId === undefined ? {} : { idempotencyId }),
        result: outcome,
        ...(errorCode === undefined ? {} : { errorCode })
      });
    };

    // reject unknown, disabled, or malformed calls before dispatch
    if (definition === undefined) result = errorResult('unknown_tool', 'The requested tool does not exist.', correlationId);
    else if (!this.enabled(definition, principal)) result = errorResult('tool_disabled', 'The requested tool is disabled.', correlationId);
    else if (!definition.requiredScopes.every(scope => principal.scopes.includes(scope))) result = errorResult('insufficient_scope', 'The access token lacks a required scope.', correlationId);
    else if (instanceId !== undefined && (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > 240)) result = errorResult('invalid_request', 'The instance identifier is invalid.', correlationId);
    else if (parsed === undefined || !parsed.success) result = errorResult('invalid_request', 'The tool arguments are invalid.', correlationId);
    // the Conductor, and any principal held to Places, acts on its own console only
    else if (instanceId !== undefined && instanceId !== this.options.instanceId && (principal.authentication === 'conductor' || principal.places !== undefined)) result = errorResult('instance_unavailable', 'The requested instance is unavailable.', correlationId);
    else if (instanceId !== undefined && instanceId !== this.options.instanceId) {
      const control = definition.risk === 'read' ? { ok: true as const } : this.options.control.authorizeMutation();
      // require local purple Davo mode before forwarding mutations
      if (!control.ok) result = errorResult(control.code, controlMessage(control.code), correlationId, true);
      else {
        const forwarded = this.options.config.multiInstance.enabled && this.options.forward !== undefined ? await this.options.forward(instanceId, principal, name, parsed.data, definition.risk !== 'read') : undefined;
        result = forwarded ?? errorResult('instance_unavailable', 'The requested instance is unavailable.', correlationId, true);
      }
    } else if (definition.risk === 'read') result = operationResult(await this.execute(definition.name, parsed.data, principal), correlationId);
    else {
      const mutation = parsed.data as MutationArguments;
      requestId = mutation.request_id;
      const canonicalDigest = digest(stableJson(mutation));
      // require active purple Davo mode, which the Conductor works without (ADR 0018)
      const control = context.voiceAuthorized || principal.authentication === 'conductor' ? { ok: true as const } : this.options.control.authorizeMutation();
      if (!control.ok) result = errorResult(control.code, controlMessage(control.code), correlationId, true);
      else {
        const claim = await this.options.policy.claim(principalKey, definition.name, mutation.request_id, canonicalDigest);
        // preserve at-most-once behavior across retries
        if (claim.kind === 'conflict') result = errorResult('idempotency_conflict', 'The request identifier was already used with different arguments.', correlationId);
        else if (claim.kind === 'in_progress') { idempotencyId = claim.recordId; result = errorResult('in_progress', 'The operation is already in progress.', correlationId, true); }
        else if (claim.kind === 'replay') { idempotencyId = claim.recordId; result = replayResult(claim.state, claim.result, correlationId); }
        else {
          idempotencyId = claim.recordId;
          try {
            // persist intent before the side effect
            await audit('intent', 'pending');
            strictOutcomeAudit = true;
            result = operationResult(await this.execute(definition.name, mutation, principal), correlationId);
            await this.options.policy.finish(claim.recordId, result.isError ? 'failed' : 'completed', result.structuredContent);
          } catch {
            await this.options.policy.finish(claim.recordId, 'failed', { ok: false, error: { code: 'audit_unavailable' } });
            result = errorResult('audit_unavailable', 'The operation was not run because its audit intent could not be stored.', correlationId, true);
          }
        }
      }
    }

    const errorCode = resultErrorCode(result);
    try {
      await audit('outcome', result.isError ? 'error' : 'success', errorCode);
    } catch {
      // surface missing outcome audit after any possible side effect
      if (strictOutcomeAudit) return errorResult('audit_outcome_unavailable', 'The operation finished but its audit outcome could not be stored. Retry only with the same request identifier.', correlationId, true);
    }
    return result;
  }

  // apply deployment feature gates independently of OAuth scopes; the Conductor has its own parent
  // gate (its configuration), independent of the integrations', and calls only what it may
  private enabled(definition: IntegrationTool, principal: IntegrationPrincipal): boolean {
    if (principal.authentication === 'conductor' ? !conductorCallable(definition) : !this.options.config.enabled) return false;
    // apply read-only deployment policy
    if (definition.feature === 'read') return this.options.config.mcp.readEnabled;
    // apply ordinary write deployment policy
    if (definition.feature === 'write') return this.options.config.mcp.writeEnabled;
    return this.options.config.mcp.dangerousEnabled;
  }

  // dispatch one already-authorized typed operation
  private async execute(name: string, input: Record<string, unknown>, principal: IntegrationPrincipal): Promise<OrchestrationResult<unknown>> {
    const orchestration = principal.places === undefined ? this.options.orchestration : this.options.orchestration.scoped(principal.places, principal.authentication === 'conductor' ? principal.subjectId : undefined);
    // an Agent outside a principal's Places is not found, whatever the tool
    if (principal.places !== undefined && typeof input.agent_id === 'string' && !await orchestration.hasAgent(input.agent_id)) return { ok: false, version: 'v1', error: { code: 'not_found', message: 'Agent not found.', retryable: false } };
    // map transport names to stable orchestration operations
    switch (name) {
      case 'list_instances': return await orchestration.listInstances();
      case 'list_worktrees': return await orchestration.listWorktrees();
      case 'get_worktree_status': return await orchestration.worktreeStatus(input.worktree_id as string);
      case 'list_agents': return await orchestration.listAgents();
      case 'get_agent_status': return await orchestration.agentStatus(input.agent_id as string);
      case 'get_agent_latest_response':
      case 'summarize_agent_response': return await orchestration.latestResponse(input.agent_id as string);
      case 'get_agent_log_tail': return await orchestration.logTail(input.agent_id as string, input.rows as number | undefined);
      case 'list_prompt_history': return await orchestration.promptHistory(input.agent_id as string);
      case 'list_queued_prompts': return await orchestration.queuedPrompts(input.agent_id as string);
      case 'get_stack_status':
      case 'get_stack_log': return await orchestration.stackStatus(input.worktree_id as string);
      case 'preview_file': return await orchestration.previewFile({ path: input.path as string, ...(input.agent_id === undefined ? {} : { agentId: input.agent_id as string }), ...(input.worktree_id === undefined ? {} : { worktreeId: input.worktree_id as string }), ...(input.max_bytes === undefined ? {} : { maxBytes: input.max_bytes as number }) });
      case 'get_process_log': return await orchestration.processLog(input.worktree_id as string, input.process as string);
      case 'get_pull_request_status': return await orchestration.pullRequestStatus(input.agent_id as string);
      case 'get_review_status': return await orchestration.reviewStatus(input.worktree_id as string);
      case 'summarize_workspace': return await orchestration.workspaceSummary();
      case 'summarize_attention_items': return await orchestration.attentionSummary();
      case 'queue_prompt': return await orchestration.queuePrompt({ agentId: input.agent_id as string, prompt: input.prompt as string });
      case 'update_queued_prompt': return await orchestration.updateQueuedPrompt({ agentId: input.agent_id as string, promptId: input.prompt_id as string, prompt: input.prompt as string });
      case 'move_queued_prompt': return await orchestration.moveQueuedPrompt({ agentId: input.agent_id as string, promptId: input.prompt_id as string, direction: input.direction as 'earlier' | 'later' });
      case 'remove_queued_prompt': return await orchestration.removeQueuedPrompt({ agentId: input.agent_id as string, promptId: input.prompt_id as string });
      case 'answer_agent_question': return await orchestration.answerQuestion({ agentId: input.agent_id as string, questionId: input.question_id as string, index: input.index as number });
      case 'cancel_agent': return await orchestration.cancel(input.agent_id as string);
      case 'launch_worktree_agent': return await orchestration.launchWorktree(input.worktree_id as string);
      case 'launch_scratch_agent': return await orchestration.launchScratch();
      case 'deactivate_agent': return await orchestration.deactivate(input.agent_id as string);
      case 'start_new_task': return await orchestration.startNewTask(input.agent_id as string);
      case 'run_stack_action': return await orchestration.runStackAction({ worktreeId: input.worktree_id as string, action: input.action as 'start' | 'stop' | 'build' | 'restart' | 'migrate', ...(input.process === undefined ? {} : { process: input.process as string }) });
      case 'start_review': return await orchestration.startReview({ agentId: input.agent_id as string, scope: input.scope as 'working' | 'pr', includeTests: input.include_tests as boolean, includeDocs: input.include_docs as boolean });
      case 'spawn_agent': return await orchestration.spawnAgent({ worktreeId: input.worktree_id as string, ...(input.model === undefined ? {} : { model: input.model as string }) });
      case 'close_agent': return await orchestration.closeWorker(input.agent_id as string);
      case 'switch_pull_request': return await orchestration.switchPullRequest({ agentId: input.agent_id as string, number: input.number as number });
      default: return { ok: false, version: 'v1', error: { code: 'invalid_request', message: 'Unknown tool.', retryable: false } };
    }
  }
}

// encode one successful or failed orchestration result for MCP
function operationResult(result: OrchestrationResult<unknown>, correlationId: string): ToolCallResult {
  const envelope = result.ok
    ? { ok: true, contract_version: result.version, correlation_id: correlationId, data: result.value }
    : { ok: false, contract_version: result.version, correlation_id: correlationId, error: result.error };
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, ...(result.ok ? {} : { isError: true }) };
}

// encode one stable gateway failure
function errorResult(code: string, message: string, correlationId: string, retryable = false): ToolCallResult {
  const envelope = { ok: false, contract_version: 'v1', correlation_id: correlationId, error: { code, message, retryable } };
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: true };
}

// return a completed replay or fail-closed interrupted result
function replayResult(state: 'completed' | 'failed' | 'unknown_outcome', stored: unknown, correlationId: string): ToolCallResult {
  // replay a stored result without repeating its side effect
  if (stored !== undefined && typeof stored === 'object' && stored !== null) {
    const structuredContent = { ...(stored as Record<string, unknown>), correlation_id: correlationId, replayed: true };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent, ...(state === 'completed' ? {} : { isError: true }) };
  }
  return errorResult(state, state === 'unknown_outcome' ? 'The earlier operation may have completed; it will not be repeated.' : 'The earlier operation failed.', correlationId);
}

// describe one canonical audit target
function auditTarget(instanceId: unknown, input: Record<string, unknown> | undefined): string {
  const instance = typeof instanceId === 'string' ? instanceId : 'local';
  const target = input?.agent_id ?? input?.worktree_id ?? 'instance';
  const detail = input?.number === undefined ? input?.action === undefined ? '' : `:action=${String(input.action)}${input.process === undefined ? '' : `:process=${String(input.process)}`}` : `:pr=${String(input.number)}`;
  return `${instance}:${String(target)}${detail}`.slice(0, 256);
}

// explain external control failures
function controlMessage(code: 'voice_mode_required' | 'browser_control_changed'): string {
  return code === 'voice_mode_required' ? 'Purple Davo mode must be active before remote tools can mutate agents.' : 'Browser control changed; restart purple Davo mode.';
}

// read one gateway error code
function resultErrorCode(result: ToolCallResult): string | undefined {
  return typeof result.structuredContent.error === 'object' && result.structuredContent.error !== null ? String((result.structuredContent.error as { code?: unknown }).code ?? 'error') : undefined;
}

// serialize objects with stable key order for policy digests
function stableJson(value: unknown): string {
  // normalize arrays recursively
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  // normalize plain objects recursively
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
