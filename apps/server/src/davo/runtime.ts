import { createHash, randomBytes } from 'node:crypto';
import type { IntegrationControlService } from '../integrations/control/service.js';
import type { IntegrationScope } from '../integrations/auth/index.js';
import type { RealtimeService, RealtimeSessionContext } from '../integrations/realtime/service.js';
import { buildLiveContext, pendingChoiceDescriptors } from './context.js';
import { expiryForAnchor, retentionWindow } from './retention.js';
import { DavoLive } from './live.js';
import { DavoAdmissionPendingError, DavoStore } from './store.js';
import { DavoProviderCalls, type DavoProviderCallPersistence } from './provider-calls.js';
import { utf8Bytes } from './contracts.js';
import { DavoMetrics } from './metrics.js';

type Pending = { id: string; ownerId: string; voiceSessionId: string; generation: number; secret: string; model: string; expiresAt: number; descriptor: Record<string, unknown> };
export type DavoRuntimeOptions = {
  store: DavoStore;
  control: IntegrationControlService;
  realtime: RealtimeService;
  apiKey?: string;
  mcpUrl: string;
  instanceId: string;
  scopes: IntegrationScope[];
  allowedTools: () => string[];
  now?: () => number;
  fetch?: typeof fetch;
  selectWorktree?: (worktreeId: string) => Promise<boolean>;
};

// keep provider control and conversation ownership on the server
export class DavoRuntime {
  readonly live: DavoLive;
  readonly calls: DavoProviderCalls;
  readonly metrics = new DavoMetrics();
  private observedGeneration?: number;
  private pending?: Pending;
  private activeOwner?: string;
  private activeVoice?: { voiceSessionId: string; generation: number };
  private voiceContext?: RealtimeSessionContext;
  private ready = false;
  private readiness?: { id: string; voiceSessionId: string; generation: number; expectedTools: string[]; responseId?: string };
  private descriptor?: Record<string, unknown>;
  private responseInput?: Array<Record<string, unknown>>;
  private frontier: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  // bridge the private call ledger without exposing provider handles
  constructor(readonly options: DavoRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.live = new DavoLive({ generation: () => options.store.currentGeneration, authorize: key => options.control.authorizeMutation(key).ok, now: this.now });
    const persistence: DavoProviderCallPersistence = {
      mode: 0o600,
      // project only server-private control state
      read: async () => {
        const state = await options.store.read();
        return { providerCalls: state.providerCalls, providerQuarantineUntil: state.providerQuarantineUntil };
      },
      // persist every claim before sending provider effects
      mutate: async mutation => options.store.transact(state => {
        const changed = mutation({ providerCalls: state.providerCalls, providerQuarantineUntil: state.providerQuarantineUntil });
        state.providerCalls = changed.state.providerCalls;
        state.providerQuarantineUntil = changed.state.providerQuarantineUntil;
        return changed.result;
      })
    };
    this.calls = new DavoProviderCalls({ apiKey: options.apiKey, persistence, fetch: options.fetch, now: () => new Date(this.now()) });
  }

  // serialize admission and transport replacement
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.frontier.then(operation);
    this.frontier = next.then(() => undefined, () => undefined);
    return next;
  }

  // fence local authority before cleaning stale provider sessions
  async ensureCurrent(): Promise<void> {
    const result = await this.options.store.ensureCurrent(new Date(this.now()));
    // observe monotonic advances even when another store reader performed the sweep
    if (this.observedGeneration !== undefined && result.generation > this.observedGeneration) this.metrics.count('generation_advances', result.generation - this.observedGeneration);
    this.observedGeneration = result.generation;
    this.metrics.count('expired_requests', result.expiredRequestIds.length);
    // generation changes revoke every live token and pending credential
    if (result.swept) this.fence();
    const cleanup = await this.calls.expire({ beforeGeneration: result.generation });
    this.metrics.count('provider_hangups', cleanup.closed);
    // failed provider cleanup cannot silently authorize a successor
    if (!cleanup.ok) this.recordFailure(cleanup.code);
  }

  // recover uncertain provider cleanup before reopening the microphone
  async recover(): Promise<void> { await this.options.store.ensureCurrent(); await this.calls.recover(); }

  // erase live context and revoke the real lease before sanitized store persistence
  fence(): void {
    this.live.close();
    // revoke only the actual current browser voice session
    if (this.activeVoice !== undefined && this.activeOwner !== undefined) this.options.control.stopVoice(this.activeOwner, this.activeVoice.voiceSessionId);
    this.pending = undefined;
    this.readiness = undefined;
    this.descriptor = undefined;
    this.responseInput = undefined;
    this.voiceContext = undefined;
    this.activeVoice = undefined;
    this.activeOwner = undefined;
    this.ready = false;
  }

  // serve retained rows without provider identifiers or request secrets
  async conversation(input: { beforeSequence?: number; afterSequence?: number; limit?: number } = {}) {
    await this.ensureCurrent();
    const state = await this.options.store.read();
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));
    const eligible = state.messages.filter(message => (input.beforeSequence === undefined || message.sequence < input.beforeSequence) && (input.afterSequence === undefined || message.sequence > input.afterSequence));
    const selected = input.afterSequence === undefined ? eligible.slice(-limit) : eligible.slice(0, limit);
    return {
      conversationId: state.logicalConversationId,
      generation: state.retention.generation,
      revision: state.retention.contextRevision,
      retainedFrom: state.retention.retainedFrom,
      serverNow: new Date(this.now()).toISOString(),
      retentionCutoffAt: retentionWindow(this.now()).nextSweepAt,
      nextSequence: state.nextSequence,
      pendingChoices: pendingChoiceDescriptors(state),
      hasMore: eligible.length > selected.length,
      messages: selected.map(message => ({ id: message.id, sequence: message.sequence, kind: message.kind, text: message.text, createdAt: message.createdAt, expiresAt: expiryForAnchor(message.retentionAnchorAt), ...(message.requestId === undefined ? {} : { requestId: message.requestId }) }))
    };
  }

  // mint a pending negotiation without returning provider credentials
  open(ownerId: string, input: { voiceSessionId: string; generation: number; worktreeId?: string; agentId?: string }) {
    return this.serialize(async () => {
      await this.ensureCurrent();
      const state = await this.options.store.read();
      // reject stale client state before opening a lease
      if (input.generation !== state.retention.generation) throw new Error('davo_generation_changed');
      this.fence();
      const closed = await this.calls.closeAll();
      // ambiguous provider cleanup blocks new authority
      if (!closed.ok) throw new Error(closed.code);
      const credential = this.options.control.startVoiceLease(ownerId, input.voiceSessionId, this.options.scopes);
      // preserve controller and exact browser ownership
      if (credential === undefined) throw new Error('davo_voice_inactive');
      const allowedTools = this.options.allowedTools();
      const minted = await this.options.realtime.create({ subject: ownerId, mcpUrl: this.options.mcpUrl, mcpAuthorization: credential.bearer, allowedTools, context: { instanceId: this.options.instanceId, worktreeId: input.worktreeId, agentId: input.agentId } });
      // revoke before returning a failed negotiation
      if (!minted.ok) { this.options.control.stopVoice(ownerId, input.voiceSessionId); throw new Error(minted.code); }
      const hardCutoffAt = Date.parse(retentionWindow(this.now()).nextSweepAt);
      const negotiationId = randomBytes(24).toString('base64url');
      const descriptor = { type: 'mcp', server_label: 'remote_agents', server_url: this.options.mcpUrl, authorization: credential.bearer, allowed_tools: allowedTools, require_approval: 'never' };
      this.pending = { id: negotiationId, ownerId, voiceSessionId: input.voiceSessionId, generation: input.generation, secret: minted.clientSecret.value, model: minted.model, expiresAt: this.now() + 30_000, descriptor };
      this.activeOwner = ownerId;
      this.activeVoice = { voiceSessionId: input.voiceSessionId, generation: input.generation };
      this.voiceContext = { instanceId: this.options.instanceId, ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }), ...(input.agentId === undefined ? {} : { agentId: input.agentId }) };
      this.descriptor = descriptor;
      this.live.open({ voiceSessionId: input.voiceSessionId, leaseKey: credential.leaseKey, ownerHash: createHash('sha256').update(credential.stableOwnerKey).digest('hex'), generation: input.generation, hardCutoffAt });
      return { ok: true, voiceSessionId: input.voiceSessionId, negotiationId, model: minted.model, conversationId: state.logicalConversationId, generation: input.generation, contextRevision: state.retention.contextRevision, serverNow: new Date(this.now()).toISOString(), leaseExpiresAt: new Date(credential.expiresAt).toISOString(), retentionCutoffAt: new Date(hardCutoffAt).toISOString() };
    });
  }

  // register hangup authority durably before releasing the answer sdp
  negotiate(ownerId: string, input: { voiceSessionId: string; generation: number; negotiationId: string; sdp: string }) {
    return this.serialize(async () => {
      await this.ensureCurrent();
      const session = this.live.current(input.voiceSessionId, input.generation);
      const pending = this.pending;
      // consume the exact one-use pending negotiation
      if (pending === undefined || pending.id !== input.negotiationId || pending.ownerId !== ownerId || pending.voiceSessionId !== input.voiceSessionId || pending.generation !== input.generation || pending.expiresAt <= this.now()) throw new Error('davo_voice_inactive');
      this.pending = undefined;
      try {
        const result = await this.calls.negotiate({ voiceSessionId: input.voiceSessionId, ownerHash: session.ownerHash, generation: input.generation, hardCutoffAt: new Date(session.hardCutoffAt).toISOString(), offer: input.sdp, session: { type: 'realtime', model: pending.model, clientSecret: pending.secret, tools: [], audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' }, turn_detection: { type: 'server_vad', create_response: false, interrupt_response: false } } } } });
        // reject provider setup without disclosing control handles
        if (!result.ok) throw new Error(result.code);
        this.live.current(input.voiceSessionId, input.generation);
        const state = await this.options.store.read();
        const readinessId = randomBytes(24).toString('base64url');
        const tools = this.responseTools();
        const instructions = 'Initialize only the supplied retained context. Return exactly READY as text. Do not speak, call tools, or perform any user action. This is a transport readiness check, not an admitted user request.';
        const metadata = { davo_phase: 'readiness', readiness_id: readinessId };
        const framing = { conversation: 'none', tools, instructions, tool_choice: 'none', output_modalities: ['text'], max_output_tokens: 16, metadata };
        const projection = buildLiveContext(state, { currentTurn: 'Initialize retained chat context without taking action.', reservedBytes: utf8Bytes(JSON.stringify(framing)) + 1024 });
        const readinessResponse = { ...framing, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: projection.text }] }] };
        // reject oversized actual envelopes before releasing inference instructions
        if (utf8Bytes(JSON.stringify(readinessResponse)) > 40_960) throw new Error('davo_context_capacity');
        this.readiness = { id: readinessId, voiceSessionId: input.voiceSessionId, generation: input.generation, expectedTools: [...(this.descriptor!.allowed_tools as string[])] };
        return { ok: true, sdp: result.answer, generation: input.generation, readinessId, readinessResponse };
      } catch (error) {
        await this.failNegotiation(input);
        throw error;
      }
    });
  }

  // revoke every private session field before exact provider cleanup
  private async failNegotiation(input: { voiceSessionId: string; generation: number }): Promise<void> {
    this.fence();
    await this.calls.stop(input);
  }

  // acknowledge exact provider seed acceptance and frozen-tool import before unmuting
  acknowledgeReady(ownerId: string, input: { voiceSessionId: string; generation: number; readinessId: string; responseId: string; importedTools: string[] }): { ok: true } {
    this.owned(ownerId, input);
    const pending = this.readiness;
    const imported = new Set(input.importedTools);
    const expected = new Set(pending?.expectedTools ?? []);
    // transport metadata never substitutes for the current registered negotiation
    if (pending === undefined || pending.id !== input.readinessId || pending.voiceSessionId !== input.voiceSessionId || pending.generation !== input.generation || pending.responseId !== undefined && pending.responseId !== input.responseId || expected.size !== pending.expectedTools.length || imported.size !== input.importedTools.length || imported.size !== expected.size || [...expected].some(name => !imported.has(name))) throw new Error('davo_provider_not_ready');
    pending.responseId = input.responseId;
    this.ready = true;
    this.metrics.count('readiness_checks');
    return { ok: true };
  }

  // admit final user text before creating any inference or tool authority
  admit(ownerId: string, input: { voiceSessionId: string; generation: number; providerSessionId: string; providerItemId: string; text: string }) {
    return this.serialize(async () => {
      await this.ensureCurrent();
      this.owned(ownerId, input);
      // raw input cannot create a turn before registered provider readiness
      if (!this.ready) throw new Error('davo_voice_inactive');
      this.live.accepting(input.providerItemId);
      const state = await this.options.store.read();
      this.owned(ownerId, input);
      const messageId = `davo-user-${createHash('sha256').update(`${input.generation}\0${input.providerSessionId}\0${input.providerItemId}`).digest('hex')}`;
      const reservedBytes = utf8Bytes(JSON.stringify(this.response('x'.repeat(43), []))) + 1024;
      const projection = buildLiveContext(state, { currentTurn: input.text, currentMessageId: messageId, reservedBytes });
      const turn = this.live.admit({ ...input, messageId });
      this.responseInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: projection.text }] }];
      let response;
      try {
        response = this.response(turn.capability);
        // count the actual authored envelope, not just its plain-text seed
        if (utf8Bytes(JSON.stringify(response)) > 40_960) throw new Error('davo_context_capacity');
      } catch (error) {
        this.responseInput = undefined;
        // a failed response preflight cannot retain a phantom turn
        try { this.live.finish(input.voiceSessionId, input.generation, turn.id); }
        catch { this.fence(); }
        throw error;
      }
      let message;
      try {
        this.owned(ownerId, input);
        message = await this.options.store.appendUserTranscript({ ...input, id: messageId, authorize: () => this.owned(ownerId, input) });
      } catch (error) {
        this.responseInput = undefined;
        // return no inference authority while exact disk recovery is pending
        if (error instanceof DavoAdmissionPendingError) {
          this.fence();
          return { ok: true, pending: true, messageId: error.messageId, generation: input.generation };
        }
        // retire the reservation while authority remains or revoke the transport
        try { this.live.finish(input.voiceSessionId, input.generation, turn.id); }
        catch { this.fence(); }
        throw error;
      }
      this.metrics.count('admitted_inputs');
      return { ok: true, pending: false, messageId: message.id, turnId: turn.id, generation: input.generation, response };
    });
  }

  // freeze response-scoped tools around explicitly retained text only
  private response(capability: string, input = this.responseInput) {
    const instructions = `${this.options.realtime.instructions(this.voiceContext)} Respond only to the admitted user text. Turn capability: ${capability}. Include this exact turn_capability in every Davo tool call. Never substitute another message. For development work resolve and bind the canonical target then delegate_request. No raw mutation tool is permitted.`;
    return { conversation: 'none', input: structuredClone(input), instructions, tools: this.responseTools(), output_modalities: ['audio'] };
  }

  // bound the complete response-scoped descriptor catalog
  private responseTools(): Array<Record<string, unknown>> {
    // no response is valid without an exact current ephemeral descriptor
    if (this.descriptor === undefined) throw new Error('davo_voice_inactive');
    const tools = [this.descriptor, { type: 'function', name: 'select_worktree', description: 'Select an already resolved canonical worktree in the browser.', parameters: { type: 'object', properties: { worktree_id: { type: 'string', maxLength: 240 } }, required: ['worktree_id'], additionalProperties: false } }];
    // tool schemas share the fixed descriptor component budget
    if (utf8Bytes(JSON.stringify(tools)) > 4096) throw new Error('davo_context_capacity');
    return structuredClone(tools);
  }

  // resume only an acknowledged canonical local worktree-selection result
  continue(ownerId: string, input: { voiceSessionId: string; generation: number; turnId: string; responseId: string; callId: string; worktreeId: string }) {
    return this.serialize(async () => {
      await this.ensureCurrent();
      this.owned(ownerId, input);
      this.live.bound(input.voiceSessionId, input.generation, input.turnId, input.responseId);
      // do not mint continuation authority for unresolved selections
      if (!await this.options.selectWorktree?.(input.worktreeId) || this.responseInput === undefined || this.responseInput.length > 9) throw new Error('davo_target_changed');
      const turn = this.live.advance(input.voiceSessionId, input.generation, input.turnId, input.responseId);
      this.voiceContext = { instanceId: this.options.instanceId, worktreeId: input.worktreeId };
      this.responseInput.push({ type: 'function_call', call_id: input.callId, name: 'select_worktree', arguments: JSON.stringify({ worktree_id: input.worktreeId }) }, { type: 'function_call_output', call_id: input.callId, output: JSON.stringify({ selected: true, worktree_id: input.worktreeId }) });
      const response = this.response(turn.capability);
      // every continuation obeys the same complete envelope ceiling
      if (utf8Bytes(JSON.stringify(response)) > 40_960) { this.live.finish(input.voiceSessionId, input.generation, turn.id); this.responseInput = undefined; throw new Error('davo_context_capacity'); }
      return { ok: true, messageId: turn.messageId, turnId: turn.id, generation: input.generation, response };
    });
  }

  // bind a provider response before accepting its tools or final text
  bind(ownerId: string, input: { voiceSessionId: string; generation: number; turnId: string; responseId: string }): void {
    this.owned(ownerId, input);
    this.live.bind(input.voiceSessionId, input.generation, input.turnId, input.responseId);
  }

  // persist only one final assistant transcript anchored to its admitted user
  assistant(ownerId: string, input: { voiceSessionId: string; generation: number; turnId: string; responseId: string; messageId: string; text: string }) {
    return this.serialize(async () => {
      await this.ensureCurrent();
      this.owned(ownerId, input);
      const turn = this.live.bound(input.voiceSessionId, input.generation, input.turnId, input.responseId);
      // final prose belongs only to the admitted original user
      if (turn.messageId !== input.messageId) throw new Error('davo_turn_changed');
      const state = await this.options.store.read();
      const user = state.messages.find(message => message.id === input.messageId && message.kind === 'user');
      // late responses cannot reintroduce expired user context
      if (user === undefined) throw new Error('davo_generation_changed');
      this.live.bind(input.voiceSessionId, input.generation, input.turnId, input.responseId);
      return await this.options.store.appendMessage({ kind: 'assistant', text: input.text, source: { kind: 'assistant-final', voiceSessionId: input.voiceSessionId, responseId: input.responseId, inReplyToMessageId: user.id }, retentionAnchorAt: user.retentionAnchorAt, retentionAnchorLocalDate: user.retentionAnchorLocalDate });
    });
  }

  // retire exact response authority after final persistence
  finish(ownerId: string, input: { voiceSessionId: string; generation: number; turnId: string; responseId?: string }): void {
    this.owned(ownerId, input);
    this.live.finish(input.voiceSessionId, input.generation, input.turnId, input.responseId);
    this.responseInput = undefined;
  }

  // check the browser owner independently of provider event contents
  private owned(ownerId: string, input: { voiceSessionId: string; generation: number }): void {
    // do not admit audio from a replacement controller
    if (this.activeOwner !== ownerId) throw new Error('davo_voice_inactive');
    this.live.current(input.voiceSessionId, input.generation);
  }

  // renew only actual browser control, never a background evaluator
  heartbeat(ownerId: string, input: { voiceSessionId: string; generation: number }) {
    this.owned(ownerId, input);
    // reject a lease that already lapsed
    if (!this.options.control.heartbeatVoice(ownerId, input.voiceSessionId)) throw new Error('davo_voice_inactive');
    return { ok: true, generation: input.generation, serverNow: new Date(this.now()).toISOString(), leaseExpiresAt: new Date(this.options.control.currentLease()!.expiresAt).toISOString() };
  }

  // stop the transport without canceling ordinary agents or deleting chat
  async stop(ownerId: string, input: { voiceSessionId: string; generation: number }): Promise<void> {
    // a stale browser cannot stop a newer transport
    if (this.activeOwner !== ownerId) return;
    // an old close receipt may clean its own call but cannot clear newer state
    if (!this.live.matches(input.voiceSessionId, input.generation)) { await this.calls.stop(input); return; }
    this.fence();
    await this.calls.stop(input);
  }

  // enforce cutoff and lease loss even when browser javascript is frozen
  async tick(): Promise<void> {
    await this.ensureCurrent();
    const state = await this.options.store.read();
    // close only stale or unowned provider sessions
    for (const call of state.providerCalls) {
      let active = true;
      try { this.live.current(call.voiceSessionId, call.generation); }
      catch { active = false; }
      // revoke locally before issuing a provider hangup
      if (!active || Date.parse(call.hardCutoffAt) <= this.now()) { this.live.close(call.voiceSessionId); await this.calls.stop(call); }
    }
    // erase credentials when their negotiation deadline passes
    if (this.pending !== undefined && this.pending.expiresAt <= this.now()) { this.live.close(this.pending.voiceSessionId); this.pending = undefined; }
  }

  // classify faults without retaining messages, ids, paths or provider data
  recordFailure(value: unknown): void {
    const code = typeof value === 'string' ? value : value instanceof Error ? value.message : '';
    // persistence uncertainty is a privacy fault, never an empty successful reset
    if (code.includes('store_')) this.metrics.count('privacy_faults');
    // provider ambiguity uses only a content-free quarantine counter
    else if (code.includes('provider_hangup') || code.includes('provider_control')) this.metrics.count('provider_quarantines');
    // stale authority is rejected rather than attached to a newer turn
    else if (code.includes('capability')) this.metrics.count('capability_replays');
    else if (code.includes('generation') || code.includes('turn_changed')) this.metrics.count('stale_events_rejected');
  }

  // serve coarse diagnostics without opening conversation context
  status() {
    let listening = false;
    try { this.live.current(); listening = this.ready; } catch { /* closed transport */ }
    return { available: this.options.store.available, listening, counters: this.metrics.snapshot() };
  }
}
