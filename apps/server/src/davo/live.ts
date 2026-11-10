import { randomBytes, timingSafeEqual } from 'node:crypto';

export type DavoLiveSession = { voiceSessionId: string; leaseKey: string; ownerHash: string; generation: number; hardCutoffAt: number };
export type DavoLiveTurn = { id: string; capability: string; messageId: string; providerItemId: string; responseId?: string; actionOperationId?: string; actionDigest?: string; target?: { token: string; canonical: Record<string, unknown>; operationId?: string } };
export type DavoLiveActivity = { voiceSessionId: string; generation: number; messageId: string };
type Options = { generation: () => number | undefined; authorize: (leaseKey: string) => boolean; now?: () => number };

// compare opaque tokens without prefix timing differences
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// mint bounded nonsemantic authority
function token(): string { return randomBytes(32).toString('base64url'); }

// own one live transport and one admitted response
export class DavoLive {
  private session?: DavoLiveSession;
  private turn?: DavoLiveTurn;
  private readonly bindings = new Set<() => void>();
  private readonly now: () => number;

  // inject actual lease and generation authority
  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; }

  // replace transport authority without replacing conversation history
  open(session: DavoLiveSession): void {
    this.session = { ...session };
    this.turn = undefined;
    this.wakeBindings();
  }

  // revoke authority before any provider cleanup
  close(voiceSessionId?: string): void {
    // preserve another transport's authority
    if (voiceSessionId !== undefined && this.session?.voiceSessionId !== voiceSessionId) return;
    this.session = undefined;
    this.turn = undefined;
    this.wakeBindings();
  }

  // compare transport identity even after its lease deadline
  matches(voiceSessionId: string, generation: number): boolean {
    return this.session?.voiceSessionId === voiceSessionId && this.session.generation === generation;
  }

  // enforce the exact current lease and retention generation
  current(voiceSessionId?: string, generation?: number): DavoLiveSession {
    const session = this.session;
    // reject closed or superseded transports
    if (session === undefined || voiceSessionId !== undefined && session.voiceSessionId !== voiceSessionId) throw new Error('davo_voice_inactive');
    // generation fences override every retained capability
    if (session.generation !== this.options.generation() || generation !== undefined && generation !== session.generation) throw new Error('davo_generation_changed');
    // require the real browser lease and absolute cutoff
    if (this.now() >= session.hardCutoffAt || !this.options.authorize(session.leaseKey)) throw new Error('davo_voice_inactive');
    return { ...session };
  }

  // observe one admitted turn without granting action authority
  activity(leaseKey: string): DavoLiveActivity | undefined {
    const session = this.current();
    // never attach a call from another lease or an unadmitted response
    if (!equal(session.leaseKey, leaseKey) || this.turn === undefined) return undefined;
    return { voiceSessionId: session.voiceSessionId, generation: session.generation, messageId: this.turn.messageId };
  }

  // report only a currently authorized admitted turn
  working(): boolean {
    try { this.current(); }
    catch { return false; }
    return this.turn !== undefined;
  }

  // reject overlapping input before durable transcript admission
  accepting(providerItemId: string): void {
    this.current();
    // exact provider retries may reuse the current receipt
    if (this.turn !== undefined && this.turn.providerItemId !== providerItemId) throw new Error('davo_response_active');
  }

  // resolve an opaque capability to its already bound response
  capability(leaseKey: string, capability: string): DavoLiveTurn {
    // never resolve authority from a latest-message heuristic
    if (this.turn?.responseId === undefined) throw new Error('davo_response_unbound');
    return this.authorize(leaseKey, capability, this.turn.responseId);
  }

  // wait briefly for the exact response-created browser receipt
  async awaitCapability(leaseKey: string, capability: string): Promise<DavoLiveTurn> {
    this.current();
    // reject unrelated capabilities without waiting for another turn
    if (this.turn === undefined || !equal(this.turn.capability, capability)) throw new Error('davo_turn_changed');
    // cap transport-race waiters independently of user questions
    if (this.bindings.size >= 16) throw new Error('davo_response_unbound');
    // wait only for this exact unbound provider response
    if (this.turn.responseId === undefined) await new Promise<void>(resolve => {
      // release on binding, revocation or transport deadline
      const ready = () => { clearTimeout(timer); this.bindings.delete(ready); resolve(); };
      const timer = setTimeout(ready, 10_000);
      timer.unref();
      this.bindings.add(ready);
    });
    return this.capability(leaseKey, capability);
  }

  // release waiters so each revalidates its original capability
  private wakeBindings(): void {
    // snapshot because resolving removes individual waiters
    for (const ready of [...this.bindings]) ready();
  }

  // admit only a durably accepted final transcript
  admit(input: { voiceSessionId: string; generation: number; messageId: string; providerItemId: string }): DavoLiveTurn {
    this.current(input.voiceSessionId, input.generation);
    // never guess which overlapping utterance owns an action
    if (this.turn !== undefined) {
      // exact receipt retries do not mint fresh authority
      if (this.turn.messageId === input.messageId && this.turn.providerItemId === input.providerItemId) return structuredClone(this.turn);
      throw new Error('davo_response_active');
    }
    this.turn = { id: token(), capability: token(), messageId: input.messageId, providerItemId: input.providerItemId };
    return structuredClone(this.turn);
  }

  // bind the provider response to its previously admitted turn
  bind(voiceSessionId: string, generation: number, turnId: string, responseId: string): void {
    this.current(voiceSessionId, generation);
    // reject late response callbacks and response substitution
    if (this.turn?.id !== turnId || this.turn.responseId !== undefined && this.turn.responseId !== responseId) throw new Error('davo_turn_changed');
    this.turn.responseId = responseId;
    this.wakeBindings();
  }

  // inspect only an exact already bound final-response receipt
  bound(voiceSessionId: string, generation: number, turnId: string, responseId: string): DavoLiveTurn {
    this.current(voiceSessionId, generation);
    // do not adopt callbacks by response recency
    if (this.turn?.id !== turnId || this.turn.responseId !== responseId) throw new Error('davo_turn_changed');
    return structuredClone(this.turn);
  }

  // rotate authority for an explicit local-selection continuation
  advance(voiceSessionId: string, generation: number, turnId: string, responseId: string): DavoLiveTurn {
    this.bound(voiceSessionId, generation, turnId, responseId);
    this.turn!.capability = token();
    this.turn!.responseId = undefined;
    return structuredClone(this.turn!);
  }

  // verify every mutation against the actual bound response
  authorize(leaseKey: string, capability: string, responseId: string): DavoLiveTurn {
    const session = this.current();
    // a previous lease cannot reuse a response capability
    if (!equal(session.leaseKey, leaseKey) || this.turn === undefined || !equal(this.turn.capability, capability)) throw new Error('davo_turn_changed');
    // provider response creation must be acknowledged before mutation
    if (this.turn.responseId === undefined) throw new Error('davo_response_unbound');
    // bind calls to the real response, never the latest utterance
    if (!equal(this.turn.responseId, responseId)) throw new Error('davo_turn_changed');
    return structuredClone(this.turn);
  }

  // freeze one canonical target for this utterance
  bindTarget(leaseKey: string, capability: string, responseId: string, canonical: Record<string, unknown>): string {
    this.authorize(leaseKey, capability, responseId);
    const turn = this.turn!;
    // retries must bind exactly the same canonical target
    if (turn.target !== undefined) {
      // reject retargeting within an admitted response
      if (JSON.stringify(turn.target.canonical) !== JSON.stringify(canonical)) throw new Error('davo_target_changed');
      return turn.target.token;
    }
    turn.target = { token: token(), canonical: structuredClone(canonical) };
    return turn.target.token;
  }

  // consume mutation authority once while allowing exact operation reconciliation
  consumeTarget(leaseKey: string, capability: string, responseId: string, targetToken: string, operationId: string, actionDigest = operationId): Record<string, unknown> {
    this.authorize(leaseKey, capability, responseId);
    const target = this.turn!.target;
    // reject unbound targets and cross-operation replay
    if (target === undefined || !equal(target.token, targetToken) || target.operationId !== undefined && target.operationId !== operationId) throw new Error('davo_capability_replayed');
    this.consumeAction(leaseKey, capability, operationId, actionDigest);
    target.operationId = operationId;
    return structuredClone(target.canonical);
  }

  // consume exactly one domain action per admitted utterance
  consumeAction(leaseKey: string, capability: string, operationId: string, actionDigest = operationId): void {
    this.capability(leaseKey, capability);
    // different operations cannot reuse one utterance as fresh consent
    if (this.turn!.actionOperationId !== undefined && (this.turn!.actionOperationId !== operationId || this.turn!.actionDigest !== actionDigest)) throw new Error('davo_capability_replayed');
    this.turn!.actionOperationId = operationId;
    this.turn!.actionDigest = actionDigest;
  }

  // discard only the exact completed or canceled response
  finish(voiceSessionId: string, generation: number, turnId: string, responseId?: string): void {
    this.current(voiceSessionId, generation);
    // late completion cannot retire a newer turn
    if (this.turn?.id !== turnId || responseId !== undefined && this.turn.responseId !== responseId) throw new Error('davo_turn_changed');
    this.turn = undefined;
    this.wakeBindings();
  }
}
