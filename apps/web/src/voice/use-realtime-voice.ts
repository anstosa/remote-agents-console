import { useCallback, useEffect, useRef, useState } from 'react';
import { useDavoConversation, type DavoConversation, type DavoMessage } from './use-davo-conversation.js';

type Request = (url: string, init?: RequestInit) => Promise<Response>;
type VoiceState = 'idle' | 'connecting' | 'connected' | 'error';
type VoiceTarget = { worktreeId?: string; worktreeLabel?: string; agentId?: string };
type WorktreeSelection = { worktreeId: string; worktreeLabel: string };
type SelectWorktree = (worktreeId: string) => WorktreeSelection | undefined;
type SessionReceipt = { negotiationId: string; model: string; conversationId: string; generation: number; contextRevision: string; serverNow: string; leaseExpiresAt: string; retentionCutoffAt: string };
type NegotiationReceipt = { sdp: string; generation: number; readinessId: string; readinessResponse: Record<string, unknown> };
type AdmissionReceipt = { messageId: string; turnId: string; generation: number; response: Record<string, unknown> };
type ActiveSession = { voiceSessionId: string; generation: number; providerSessionId?: string; leaseExpiresAt: number; retentionCutoffAt: number };
type RuntimeWork = { session: ActiveSession; kind: 'foreground' | 'projection' };
type McpCall = { terminal: boolean; itemDone: boolean };
type ActiveTurn = { turnId: string; messageId: string; responseId?: string; bound: boolean; text: string; mcpCalls: Map<string, McpCall>; work: RuntimeWork; responseDone?: boolean; continuingMcp?: boolean; pendingFinal?: { responseId: string; text: string; intermediate?: boolean } };
type ReadinessImportItem = { itemId: string; serverLabel: string; tools: string[]; responseId?: string };
type ReadinessTracker = { readinessId: string; expectedServerLabels: string[]; expectedTools: string[]; responseId?: string; responseDone: boolean; mcpCompleted: boolean; completedItemId?: string; completedServerLabel?: string; completedResponseId?: string; importItems: ReadinessImportItem[]; importedTools?: string[]; failed: boolean };
type PendingRawItem = { timer: number; session: ActiveSession; channel: RTCDataChannel; bufferEpoch: number };
type DeletionWait = { session: ActiveSession; channel: RTCDataChannel; settle: (deleted: boolean) => void };
type AssistantReceiptFlight = { session: ActiveSession; channel: RTCDataChannel; turn: ActiveTurn };
type MutationResult = { kind: 'accepted'; response: Response } | { kind: 'conflict' } | { kind: 'ambiguous' };

export type RealtimeVoice = {
  state: VoiceState;
  error?: string;
  conversation: DavoConversation;
  inputLevel: number;
  outputLevel: number;
  muted: boolean;
  awaitingOver: boolean;
  working: boolean;
  start: () => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
};

const deleteTimeoutMilliseconds = 4_000;
const projectionTimeoutMilliseconds = 4_000;
const receiptRetryMilliseconds = 750;
const readinessTimeoutMilliseconds = 15_000;
const cleanupTimeoutMilliseconds = 20_000;
const heartbeatMilliseconds = 10_000;
const mcpTimeoutMilliseconds = 120_000;
const transcriptBudgetBytes = 12 * 1_024;

// manage one replaceable audio transport over durable Davo history
export function useRealtimeVoice(request: Request, target: VoiceTarget, onSelectWorktree: SelectWorktree | undefined, assistantName: string): RealtimeVoice {
  const conversation = useDavoConversation(request);
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string>();
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [awaitingOver, setAwaitingOver] = useState(false);
  const [inputActive, setInputActive] = useState(false);
  const [runtimeWorking, setRuntimeWorking] = useState(false);
  const [projectionRevision, setProjectionRevision] = useState(0);
  const peer = useRef<RTCPeerConnection | undefined>(undefined);
  const stream = useRef<MediaStream | undefined>(undefined);
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  const channel = useRef<RTCDataChannel | undefined>(undefined);
  const session = useRef<ActiveSession | undefined>(undefined);
  const turn = useRef<ActiveTurn | undefined>(undefined);
  const readiness = useRef<ReadinessTracker | undefined>(undefined);
  const attempt = useRef(0);
  const heartbeat = useRef<number | undefined>(undefined);
  const deadline = useRef<number | undefined>(undefined);
  const mutedRef = useRef(false);
  const desiredOpen = useRef(false);
  const deletionAcks = useRef(new Map<string, DeletionWait>());
  const eventFrontier = useRef(Promise.resolve());
  const projectionPending = useRef(false);
  const projectionResponseId = useRef<string | undefined>(undefined);
  const projectionWork = useRef<RuntimeWork | undefined>(undefined);
  const projectionSettlers = useRef(new Set<(settled: boolean) => void>());
  const assistantReceiptTimer = useRef<number | undefined>(undefined);
  const mcpTimer = useRef<number | undefined>(undefined);
  const assistantReceiptInFlight = useRef<AssistantReceiptFlight | undefined>(undefined);
  const spokenMessages = useRef(new Set<string>());
  const priorMessages = useRef(new Set<string>());
  const inputSpeaking = useRef(false);
  const outputSpeaking = useRef(false);
  const outputEpoch = useRef(0);
  const inputEpochs = useRef(new Map<string, number>());
  const inputBufferEpochs = useRef(new Map<string, number>());
  const quarantinedItems = useRef(new Set<string>());
  const pendingRawItems = useRef(new Map<string, PendingRawItem>());
  const pendingBackgroundMessages = useRef(new Map<string, DavoMessage>());
  const bufferedTranscripts = useRef<string[]>([]);
  const inputTurnPending = useRef(false);
  const bufferEpoch = useRef(0);
  const meterFrame = useRef<number | undefined>(undefined);
  const inputAnalyser = useRef<AnalyserNode | undefined>(undefined);
  const outputAnalyser = useRef<AnalyserNode | undefined>(undefined);
  const meterContext = useRef<AudioContext | undefined>(undefined);
  const inputSource = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const outputSource = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const startRef = useRef<() => Promise<void>>(async () => undefined);
  const persistAssistantRef = useRef<(expectedSession: ActiveSession, expectedChannel: RTCDataChannel, expectedTurn: ActiveTurn) => Promise<void>>(async () => undefined);
  const bufferedOwner = useRef(`${target.worktreeId ?? ''}\u0000${target.agentId ?? ''}`);
  const activeWork = useRef(new Set<RuntimeWork>());
  const activityRefreshInFlight = useRef(false);
  const activityRefreshQueued = useRef(false);
  const selectWorktree = useRef(onSelectWorktree);
  selectWorktree.current = onSelectWorktree;

  // publish one exact runtime work lease
  const beginRuntimeWork = useCallback((work: RuntimeWork) => {
    activeWork.current.add(work);
    setRuntimeWorking(true);
  }, []);

  // release only one exact runtime work lease
  const endRuntimeWork = useCallback((work: RuntimeWork | undefined) => {
    // ignore absent or already retired work
    if (work === undefined || !activeWork.current.delete(work)) return;
    setRuntimeWorking(activeWork.current.size > 0);
  }, []);

  // retire one projected response before releasing its cancellation waits
  const finishProjection = useCallback(() => {
    projectionPending.current = false;
    projectionResponseId.current = undefined;
    endRuntimeWork(projectionWork.current);
    projectionWork.current = undefined;
    // release every waiter after the work token is gone
    for (const finish of [...projectionSettlers.current]) finish(true);
    setProjectionRevision(revision => revision + 1);
  }, [endRuntimeWork]);

  // coalesce provider activity refreshes to one active and one trailing read
  const refreshMcpActivity = useCallback(() => {
    activityRefreshQueued.current = true;
    // reuse the active history read
    if (activityRefreshInFlight.current) return;
    activityRefreshInFlight.current = true;
    activityRefreshQueued.current = false;
    void conversation.refreshAfterCurrent().finally(() => {
      activityRefreshInFlight.current = false;
      // retain one trailing refresh for events received during the first read
      if (activityRefreshQueued.current) refreshMcpActivity();
    });
  }, [conversation.refreshAfterCurrent]);

  // discard audio that has not reached its spoken cue
  const clearBufferedTranscripts = useCallback(() => {
    bufferEpoch.current += 1;
    bufferedTranscripts.current = [];
    inputTurnPending.current = false;
    setAwaitingOver(false);
  }, []);

  // send one provider data-channel event
  const send = useCallback((expectedSession: ActiveSession, expectedChannel: RTCDataChannel, payload: Record<string, unknown>): boolean => {
    // require the exact current provider transport
    if (session.current !== expectedSession || channel.current !== expectedChannel || expectedChannel.readyState !== 'open') return false;
    expectedChannel.send(JSON.stringify(payload));
    return true;
  }, []);

  // stop audio meters and their browser resources
  const stopMeter = useCallback(() => {
    // stop the current animation frame
    if (meterFrame.current !== undefined) window.cancelAnimationFrame(meterFrame.current);
    meterFrame.current = undefined;
    inputSource.current?.disconnect();
    outputSource.current?.disconnect();
    inputSource.current = undefined;
    outputSource.current = undefined;
    inputAnalyser.current = undefined;
    outputAnalyser.current = undefined;
    const context = meterContext.current;
    meterContext.current = undefined;
    // close one retained audio context
    if (context !== undefined) void context.close().catch(() => undefined);
    inputSpeaking.current = false;
    outputSpeaking.current = false;
    setInputActive(false);
    setInputLevel(0);
    setOutputLevel(0);
  }, []);

  // sample both audio directions
  const startMeter = useCallback(() => {
    // retain one animation loop
    if (meterFrame.current !== undefined) return;
    const update = () => {
      setInputLevel(Math.max(level(inputAnalyser.current), inputSpeaking.current ? .18 : 0));
      setOutputLevel(Math.max(level(outputAnalyser.current), outputSpeaking.current ? .22 : 0));
      meterFrame.current = window.requestAnimationFrame(update);
    };
    meterFrame.current = window.requestAnimationFrame(update);
  }, []);

  // attach one media stream to a meter edge
  const connectMeter = useCallback((media: MediaStream, side: 'input' | 'output') => {
    // keep voice usable without Web Audio
    if (typeof AudioContext === 'undefined') return;
    try {
      const context = meterContext.current ?? new AudioContext();
      meterContext.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      const source = context.createMediaStreamSource(media);
      source.connect(analyser);
      // retain the matching directional nodes
      if (side === 'input') { inputSource.current = source; inputAnalyser.current = analyser; }
      else { outputSource.current = source; outputAnalyser.current = analyser; }
      void context.resume().catch(() => undefined);
      startMeter();
    } catch {
      // meter failure never widens voice authority
    }
  }, [startMeter]);

  // revoke every local transport capability
  const closeLocal = useCallback((nextState: VoiceState = 'idle') => {
    attempt.current += 1;
    // stop lease and cutoff timers
    if (heartbeat.current !== undefined) window.clearInterval(heartbeat.current);
    if (deadline.current !== undefined) window.clearTimeout(deadline.current);
    if (assistantReceiptTimer.current !== undefined) window.clearTimeout(assistantReceiptTimer.current);
    // retire only this transport's pending tool deadline
    if (mcpTimer.current !== undefined) window.clearTimeout(mcpTimer.current);
    heartbeat.current = undefined;
    deadline.current = undefined;
    assistantReceiptTimer.current = undefined;
    mcpTimer.current = undefined;
    const currentChannel = channel.current;
    const currentPeer = peer.current;
    const currentStream = stream.current;
    const currentAudio = audio.current;
    const currentSession = session.current;
    channel.current = undefined;
    peer.current = undefined;
    stream.current = undefined;
    audio.current = undefined;
    currentStream?.getTracks().forEach(track => track.stop());
    // detach remote output immediately
    if (currentAudio !== undefined) currentAudio.srcObject = null;
    session.current = undefined;
    turn.current = undefined;
    readiness.current = undefined;
    // settle every old deletion wait before clearing its registry
    for (const pending of [...deletionAcks.current.values()]) pending.settle(false);
    deletionAcks.current.clear();
    // let a successor process events without waiting for stale async work
    eventFrontier.current = Promise.resolve();
    projectionPending.current = false;
    projectionResponseId.current = undefined;
    projectionWork.current = undefined;
    activeWork.current.clear();
    setRuntimeWorking(false);
    // release projection waits during transport replacement
    for (const settle of [...projectionSettlers.current]) settle(false);
    projectionSettlers.current.clear();
    assistantReceiptInFlight.current = undefined;
    inputEpochs.current.clear();
    inputBufferEpochs.current.clear();
    quarantinedItems.current.clear();
    // cancel every raw-item deadline with its transport
    for (const pending of pendingRawItems.current.values()) window.clearTimeout(pending.timer);
    pendingRawItems.current.clear();
    pendingBackgroundMessages.current.clear();
    clearBufferedTranscripts();
    mutedRef.current = false;
    setMuted(false);
    stopMeter();
    setState(nextState);
    // retire only captured resources after bounded server hangup
    const retire = () => { currentChannel?.close(); currentPeer?.close(); };
    // an unregistered local transport needs no provider cleanup
    if (currentSession === undefined) { retire(); return Promise.resolve(true); }
    return request('/api/realtime/session/stop', { ...json({ voiceSessionId: currentSession.voiceSessionId, generation: currentSession.generation }, true), signal: AbortSignal.timeout(cleanupTimeoutMilliseconds) })
      .then(response => response.ok, () => false)
      .finally(retire);
  }, [clearBufferedTranscripts, request, stopMeter]);

  // stop provider control and local media
  const stop = useCallback(() => {
    desiredOpen.current = false;
    void closeLocal('idle');
  }, [closeLocal]);

  // finish one exact active turn without adopting later callbacks
  const finishTurn = useCallback(async (expectedSession: ActiveSession, expectedTurn: ActiveTurn, responseId?: string): Promise<boolean> => {
    // require one matching live turn
    if (session.current !== expectedSession || turn.current !== expectedTurn) return false;
    const result = await exactMutation(request, '/api/davo/responses/finish', { voiceSessionId: expectedSession.voiceSessionId, generation: expectedSession.generation, turnId: expectedTurn.turnId, ...(responseId === undefined ? {} : { responseId }) });
    // retire only after the server confirms the exact turn
    if (session.current !== expectedSession || turn.current !== expectedTurn || result.kind !== 'accepted') return false;
    // final completion ends the pending tool budget
    if (mcpTimer.current !== undefined) window.clearTimeout(mcpTimer.current);
    mcpTimer.current = undefined;
    turn.current = undefined;
    endRuntimeWork(expectedTurn.work);
    void conversation.refreshAfterCurrent();
    return true;
  }, [conversation, endRuntimeWork, request]);

  // stop after ambiguous raw-item deletion
  const rotate = useCallback(async (expectedSession: ActiveSession, expectedChannel: RTCDataChannel) => {
    // never rotate a replacement transport
    if (session.current !== expectedSession || channel.current !== expectedChannel) return;
    const reopen = desiredOpen.current;
    const cleanup = closeLocal('idle');
    const closedAttempt = attempt.current;
    // close provider control before any successor
    const closed = await cleanup;
    // never apply old cleanup results to a replacement transport
    if (attempt.current !== closedAttempt) return;
    // an uncertain cleanup grants no automatic reopen
    if (!closed) { desiredOpen.current = false; setError('Davo provider cleanup is uncertain. Try again later.'); setState('error'); return; }
    // reopen only after exact server cleanup
    if (reopen && attempt.current === closedAttempt) window.setTimeout(() => {
      // require the queued reopen to still own an empty transport
      if (attempt.current !== closedAttempt || !desiredOpen.current || session.current !== undefined || channel.current !== undefined) return;
      void startRef.current();
    }, 0);
  }, [closeLocal]);

  // stop one exact transport while durable admission recovers
  const stopForPendingAdmission = useCallback((expectedSession: ActiveSession, expectedChannel: RTCDataChannel): void => {
    // never stop a successor for an old pending receipt
    if (session.current !== expectedSession || channel.current !== expectedChannel) return;
    desiredOpen.current = false;
    void closeLocal('error');
    setError('Davo storage is recovering. Try again shortly.');
  }, [closeLocal]);

  // fence one committed raw item until provider deletion
  const quarantineRawItem = useCallback((expectedSession: ActiveSession, expectedChannel: RTCDataChannel, itemId: string): void => {
    // ignore stale raw-item callbacks
    if (session.current !== expectedSession || channel.current !== expectedChannel) return;
    // keep the first deadline for one provider item
    if (pendingRawItems.current.has(itemId)) return;
    const timer = window.setTimeout(() => {
      const pending = pendingRawItems.current.get(itemId);
      // rotate only the transport that owns this deadline
      if (pending?.timer === timer && pending.session === expectedSession && pending.channel === expectedChannel) void rotate(expectedSession, expectedChannel);
    }, deleteTimeoutMilliseconds);
    pendingRawItems.current.set(itemId, { timer, session: expectedSession, channel: expectedChannel, bufferEpoch: inputBufferEpochs.current.get(itemId) ?? bufferEpoch.current });
  }, [rotate]);

  // release one raw item only after exact deletion acknowledgement
  const releaseRawItem = useCallback((expectedSession: ActiveSession, expectedChannel: RTCDataChannel, itemId: string): void => {
    const pending = pendingRawItems.current.get(itemId);
    // never release a successor item from an old callback
    if (session.current !== expectedSession || channel.current !== expectedChannel || pending?.session !== expectedSession || pending.channel !== expectedChannel) return;
    // retire the exact pending deadline
    window.clearTimeout(pending.timer);
    pendingRawItems.current.delete(itemId);
    quarantinedItems.current.add(itemId);
    setProjectionRevision(revision => revision + 1);
  }, []);

  // await one exact provider deletion acknowledgement
  const deleteItem = useCallback((expectedSession: ActiveSession, expectedChannel: RTCDataChannel, itemId: string): Promise<boolean> => new Promise(resolve => {
    let settled = false;
    const settle = (deleted: boolean) => {
      // settle one exact deletion wait once
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      const registered = deletionAcks.current.get(itemId);
      // delete only this transport's registered wait
      if (registered?.session === expectedSession && registered.channel === expectedChannel && registered.settle === settle) deletionAcks.current.delete(itemId);
      resolve(deleted);
    };
    const timer = window.setTimeout(() => settle(false), deleteTimeoutMilliseconds);
    deletionAcks.current.set(itemId, { session: expectedSession, channel: expectedChannel, settle });
    // deletion must precede every admission or response
    if (!send(expectedSession, expectedChannel, { type: 'conversation.item.delete', item_id: itemId })) settle(false);
  }), [send]);

  // cancel and settle one exact background projection
  const settleProjection = useCallback(async (expectedSession: ActiveSession, expectedChannel: RTCDataChannel): Promise<boolean> => {
    // reject stale projection work
    if (session.current !== expectedSession || channel.current !== expectedChannel) return false;
    // continue immediately without active projected speech
    if (!projectionPending.current) return true;
    const responseId = projectionResponseId.current;
    const settled = new Promise<boolean>(resolve => {
      let complete = false;
      const finish = (value: boolean) => {
        // resolve one waiter once
        if (complete) return;
        complete = true;
        window.clearTimeout(timer);
        projectionSettlers.current.delete(finish);
        resolve(value);
      };
      const timer = window.setTimeout(() => finish(false), projectionTimeoutMilliseconds);
      projectionSettlers.current.add(finish);
    });
    // cancellation must precede foreground inference
    if (!send(expectedSession, expectedChannel, { type: 'response.cancel', ...(responseId === undefined ? {} : { response_id: responseId }) })) {
      projectionPending.current = false;
      projectionResponseId.current = undefined;
      for (const finish of [...projectionSettlers.current]) finish(false);
    }
    return settled;
  }, [send]);

  // admit one final transcript only after quarantine clears
  const admitTranscript = useCallback(async (expectedSession: ActiveSession, expectedChannel: RTCDataChannel, itemId: string, transcript: string, expectedBufferEpoch: number, work: RuntimeWork) => {
    // reject stale callbacks before durable admission
    if (session.current !== expectedSession || channel.current !== expectedChannel || bufferEpoch.current !== expectedBufferEpoch || expectedSession.providerSessionId === undefined) return;
    if (Date.now() >= expectedSession.retentionCutoffAt) return rotate(expectedSession, expectedChannel);
    // never infer while any raw provider item remains undeleted
    if (pendingRawItems.current.size > 0) return rotate(expectedSession, expectedChannel);
    // never overlap foreground work with projected speech
    const projectionSettled = await settleProjection(expectedSession, expectedChannel);
    // discard work resolved after transport replacement
    if (session.current !== expectedSession || channel.current !== expectedChannel || bufferEpoch.current !== expectedBufferEpoch) return;
    // expire only the exact captured transport
    if (Date.now() >= expectedSession.retentionCutoffAt) return rotate(expectedSession, expectedChannel);
    if (!projectionSettled) return rotate(expectedSession, expectedChannel);
    // quarantine rapid input while an earlier turn remains active
    if (turn.current !== undefined) {
      return;
    }
    const body = { voiceSessionId: expectedSession.voiceSessionId, generation: expectedSession.generation, providerSessionId: expectedSession.providerSessionId, providerItemId: itemId, text: transcript };
    let admitted = await exactMutation(request, '/api/davo/transcripts/user', body);
    // never apply an old receipt to a successor
    if (session.current !== expectedSession || channel.current !== expectedChannel) return;
    if (Date.now() >= expectedSession.retentionCutoffAt) return rotate(expectedSession, expectedChannel);
    // retry only this provider item and rotate on unresolved admission
    if (admitted.kind !== 'accepted') {
      await conversation.refresh();
      // stale refresh completion cannot rotate a successor
      if (session.current !== expectedSession || channel.current !== expectedChannel) return;
      return rotate(expectedSession, expectedChannel);
    }
    // 202 never carries inference authority
    if (admitted.response.status === 202) return stopForPendingAdmission(expectedSession, expectedChannel);
    const admittedValue = await admitted.response.json().catch(() => undefined);
    // discard JSON resolved after transport replacement
    if (session.current !== expectedSession || channel.current !== expectedChannel) return;
    if (Date.now() >= expectedSession.retentionCutoffAt) return rotate(expectedSession, expectedChannel);
    // pending bodies never carry inference authority
    if (pendingAdmission(admittedValue)) return stopForPendingAdmission(expectedSession, expectedChannel);
    let receipt = admissionFrom(admittedValue);
    // reconcile an accepted response with an unreadable receipt
    if (receipt === undefined) {
      admitted = await exactMutation(request, '/api/davo/transcripts/user', body);
      // never retry into a replacement transport
      if (session.current !== expectedSession || channel.current !== expectedChannel) return;
      if (Date.now() >= expectedSession.retentionCutoffAt) return rotate(expectedSession, expectedChannel);
      // retry pending status still has no turn authority
      if (admitted.kind === 'accepted' && admitted.response.status === 202) return stopForPendingAdmission(expectedSession, expectedChannel);
      const retryValue = admitted.kind === 'accepted' ? await admitted.response.json().catch(() => undefined) : undefined;
      // discard retry parsing after replacement
      if (session.current !== expectedSession || channel.current !== expectedChannel) return;
      if (Date.now() >= expectedSession.retentionCutoffAt) return rotate(expectedSession, expectedChannel);
      // retry pending body still has no turn authority
      if (pendingAdmission(retryValue)) return stopForPendingAdmission(expectedSession, expectedChannel);
      receipt = admissionFrom(retryValue);
    }
    // never infer without one exact durable receipt
    if (receipt === undefined || receipt.generation !== expectedSession.generation) return rotate(expectedSession, expectedChannel);
    const admittedTurn: ActiveTurn = { turnId: receipt.turnId, messageId: receipt.messageId, bound: false, text: '', mcpCalls: new Map(), work };
    turn.current = admittedTurn;
    await conversation.refresh();
    // preserve a successor or competing exact turn
    if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== admittedTurn) return;
    if (Date.now() >= expectedSession.retentionCutoffAt) return rotate(expectedSession, expectedChannel);
    // create only the server-authored response
    if (!send(expectedSession, expectedChannel, { type: 'response.create', response: receipt.response })) return rotate(expectedSession, expectedChannel);
  }, [conversation, request, rotate, send, settleProjection, stopForPendingAdmission]);

  // buffer quarantined speech until one terminal over cue
  const bufferTranscript = useCallback(async (expectedSession: ActiveSession, expectedChannel: RTCDataChannel, itemId: string, transcript: string, expectedBufferEpoch: number) => {
    // reject audio invalidated before its deletion acknowledgement
    if (bufferEpoch.current !== expectedBufferEpoch) return;
    inputTurnPending.current = true;
    // stop only projected speech before retaining a new user turn
    if (projectionPending.current) {
      const settled = await settleProjection(expectedSession, expectedChannel);
      // discard cancellation completion after replacement
      if (session.current !== expectedSession || channel.current !== expectedChannel || bufferEpoch.current !== expectedBufferEpoch) return;
      if (!settled) return rotate(expectedSession, expectedChannel);
    }
    const parsed = overCue(transcript);
    const chunks = parsed.text === '' ? bufferedTranscripts.current : [...bufferedTranscripts.current, parsed.text];
    const combined = chunks.join(' ').trim();
    // reject oversized turns without inference or truncation
    if (new TextEncoder().encode(combined).byteLength > transcriptBudgetBytes) {
      clearBufferedTranscripts();
      setError('That turn was too long. Please say it again more briefly, ending with “over”.');
      setProjectionRevision(revision => revision + 1);
      return;
    }
    bufferedTranscripts.current = chunks;
    // never admit an unfinished spoken turn
    if (!parsed.complete) {
      setAwaitingOver(inputTurnPending.current);
      return;
    }
    bufferedTranscripts.current = [];
    // an empty cue has no turn authority
    if (combined === '') {
      inputTurnPending.current = false;
      setAwaitingOver(false);
      setProjectionRevision(revision => revision + 1);
      return;
    }
    inputTurnPending.current = true;
    setAwaitingOver(false);
    const work: RuntimeWork = { session: expectedSession, kind: 'foreground' };
    beginRuntimeWork(work);
    try {
      await admitTranscript(expectedSession, expectedChannel, itemId, combined, expectedBufferEpoch, work);
    } finally {
      // admitted turns retain their lease through exact server completion
      if (turn.current?.work !== work) endRuntimeWork(work);
      // release only the transport that owned this admission
      if (session.current === expectedSession && channel.current === expectedChannel && bufferEpoch.current === expectedBufferEpoch) {
        inputTurnPending.current = false;
        setProjectionRevision(revision => revision + 1);
      }
    }
  }, [admitTranscript, beginRuntimeWork, clearBufferedTranscripts, endRuntimeWork, rotate, settleProjection]);

  // fail one current unfinished turn without touching admitted work
  const failBufferedTranscript = useCallback((expectedBufferEpoch: number) => {
    // ignore stale, muted, empty, and already admitted audio
    if (bufferEpoch.current !== expectedBufferEpoch || mutedRef.current || turn.current !== undefined || bufferedTranscripts.current.length === 0 && !inputTurnPending.current) return;
    clearBufferedTranscripts();
    setError('Davo could not transcribe that turn. Please say it again, ending with “over”.');
    setProjectionRevision(revision => revision + 1);
  }, [clearBufferedTranscripts]);

  // execute one server-authorized browser-local selection continuation
  const selectLocalWorktree = useCallback(async (expectedSession: ActiveSession, expectedChannel: RTCDataChannel, expectedTurn: ActiveTurn, payload: Record<string, unknown>) => {
    const responseId = text(payload.response_id);
    const callId = text(payload.call_id);
    const worktreeId = worktreeArgument(payload.arguments);
    // require bound response and exact provider callback
    if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn) return;
    if (pendingRawItems.current.size > 0) return rotate(expectedSession, expectedChannel);
    if (!expectedTurn.bound || expectedTurn.responseId === undefined || responseId !== expectedTurn.responseId || callId === undefined || worktreeId === undefined) return;
    const selection = selectWorktree.current?.(worktreeId);
    // refuse unavailable browser targets without inventing output authority
    if (selection === undefined) return;
    const continued = await request('/api/davo/responses/continue', json({ voiceSessionId: expectedSession.voiceSessionId, generation: expectedSession.generation, turnId: expectedTurn.turnId, responseId: expectedTurn.responseId, callId, worktreeId: selection.worktreeId }));
    // discard a continuation resolved after session or turn replacement
    if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn) return;
    const receipt = continued.ok ? admissionFrom(await continued.json()) : undefined;
    // discard parsing resolved after session or turn replacement
    if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn) return;
    // retire unsafe continuation failure
    if (receipt === undefined || receipt.turnId !== expectedTurn.turnId || receipt.messageId !== expectedTurn.messageId || receipt.generation !== expectedSession.generation) { send(expectedSession, expectedChannel, { type: 'response.cancel' }); await finishTurn(expectedSession, expectedTurn, expectedTurn.responseId); return; }
    expectedTurn.responseId = undefined;
    expectedTurn.bound = false;
    expectedTurn.text = '';
    expectedTurn.mcpCalls.clear();
    expectedTurn.responseDone = false;
    send(expectedSession, expectedChannel, { type: 'response.create', response: receipt.response });
  }, [finishTurn, request, rotate, send]);

  // resume the original admitted request only after every asynchronous tool result settles
  const continueMcp = useCallback(async (expectedSession: ActiveSession, expectedChannel: RTCDataChannel, expectedTurn: ActiveTurn) => {
    // stale, incomplete and duplicate callbacks cannot mint another response
    if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn || !expectedTurn.bound || expectedTurn.responseId === undefined || !expectedTurn.responseDone || expectedTurn.continuingMcp || expectedTurn.pendingFinal !== undefined || expectedTurn.mcpCalls.size === 0 || [...expectedTurn.mcpCalls.values()].some(call => !call.terminal || !call.itemDone)) return;
    // never infer through unresolved raw provider audio
    if (pendingRawItems.current.size > 0) return rotate(expectedSession, expectedChannel);
    const responseId = expectedTurn.responseId;
    expectedTurn.continuingMcp = true;
    try {
      const continued = await request('/api/davo/responses/mcp', { ...json({ voiceSessionId: expectedSession.voiceSessionId, generation: expectedSession.generation, turnId: expectedTurn.turnId, responseId, itemIds: [...expectedTurn.mcpCalls.keys()] }), signal: AbortSignal.timeout(15_000) });
      // discard a receipt resolved after its transport or response was replaced
      if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn || expectedTurn.responseId !== responseId) return;
      const receipt = continued.ok ? admissionFrom(await continued.json()) : undefined;
      // parsing never grants authority to a successor
      if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn || expectedTurn.responseId !== responseId) return;
      // a missing exact receipt cannot silently become final prose or an automatic retry
      if (receipt === undefined || receipt.turnId !== expectedTurn.turnId || receipt.messageId !== expectedTurn.messageId || receipt.generation !== expectedSession.generation || Date.now() >= expectedSession.retentionCutoffAt || pendingRawItems.current.size > 0) throw new Error('davo_tool_continuation_failed');
      if (mcpTimer.current !== undefined) window.clearTimeout(mcpTimer.current);
      mcpTimer.current = undefined;
      expectedTurn.responseId = undefined;
      expectedTurn.bound = false;
      expectedTurn.text = '';
      expectedTurn.responseDone = false;
      expectedTurn.continuingMcp = false;
      expectedTurn.mcpCalls.clear();
      // inference uses only the server's retained context and exact tool item references
      if (!send(expectedSession, expectedChannel, { type: 'response.create', response: receipt.response })) throw new Error('davo_tool_continuation_failed');
    } catch {
      // keep a successor untouched and make failure explicit without retrying a possible effect
      if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn) return;
      void closeLocal('error');
      setError('Davo could not finish reading the tool results. Reopen listening to try again.');
    }
  }, [closeLocal, request, rotate, send]);

  // retry one exact assistant receipt until durable or fenced
  const persistAssistantReceipt = useCallback(async (expectedSession: ActiveSession, expectedChannel: RTCDataChannel, expectedTurn: ActiveTurn) => {
    const flight = { session: expectedSession, channel: expectedChannel, turn: expectedTurn };
    // serialize receipt reconciliation for the active turn
    if (assistantReceiptInFlight.current !== undefined) return;
    const pending = expectedTurn.pendingFinal;
    // retain no final beyond its server-derived window
    if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn || pending === undefined) return;
    if (Date.now() >= expectedSession.retentionCutoffAt) return rotate(expectedSession, expectedChannel);
    assistantReceiptInFlight.current = flight;
    const persisted = await exactMutation(request, '/api/davo/transcripts/assistant', { voiceSessionId: expectedSession.voiceSessionId, generation: expectedSession.generation, turnId: expectedTurn.turnId, responseId: pending.responseId, messageId: expectedTurn.messageId, text: pending.text });
    // clear only this exact receipt flight
    if (assistantReceiptInFlight.current === flight) assistantReceiptInFlight.current = undefined;
    // ignore a receipt resolved after transport replacement
    if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn) return;
    // rotate on an authoritative conflict or generation fence
    if (persisted.kind === 'conflict') return rotate(expectedSession, expectedChannel);
    // retain the exact transcript and retry ambiguity within its window
    if (persisted.kind === 'ambiguous') {
      const remaining = expectedSession.retentionCutoffAt - Date.now();
      // stop rather than dropping a final at expiry
      if (remaining <= 0) return rotate(expectedSession, expectedChannel);
      assistantReceiptTimer.current = window.setTimeout(() => void persistAssistantRef.current(expectedSession, expectedChannel, expectedTurn), Math.min(receiptRetryMilliseconds, remaining));
      return;
    }
    const value = await persisted.response.clone().json().catch(() => undefined) as { id?: unknown } | undefined;
    // discard parsed receipts for a replaced exact turn
    if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn) return;
    if (typeof value?.id === 'string') spokenMessages.current.add(value.id);
    await conversation.refresh();
    // discard refresh completion for a replaced exact turn
    if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== expectedTurn) return;
    // retain spoken progress in chat without ending the original tool-backed request
    if (pending.intermediate) {
      expectedTurn.pendingFinal = undefined;
      await continueMcp(expectedSession, expectedChannel, expectedTurn);
      return;
    }
    // finish only after durable transcript confirmation
    if (!await finishTurn(expectedSession, expectedTurn, pending.responseId)) return rotate(expectedSession, expectedChannel);
  }, [continueMcp, conversation, finishTurn, request, rotate]);
  persistAssistantRef.current = persistAssistantReceipt;

  // retain one completed response until its receipt is durable
  const completeResponse = useCallback(async (expectedSession: ActiveSession, expectedChannel: RTCDataChannel, expectedTurn: ActiveTurn | undefined, response: Record<string, unknown>) => {
    // reject response completion from a replaced transport
    if (session.current !== expectedSession || channel.current !== expectedChannel) return;
    const responseId = text(response.id);
    // settle only the exact background speech projection
    if (responseId !== undefined && responseId === projectionResponseId.current) {
      finishProjection();
      return;
    }
    // reject late or unbound response completion
    if (expectedTurn === undefined || turn.current !== expectedTurn || responseId === undefined || expectedTurn.responseId !== responseId || !expectedTurn.bound) return;
    const status = text(response.status);
    const finalText = expectedTurn.text.trim() || responseText(response);
    // response.done closes inference, not an asynchronous MCP-backed user turn
    if (Array.isArray(response.output)) {
      // retain calls even when their earlier streamed item event was unavailable
      for (const item of response.output) trackMcpItem(expectedTurn, object(item), false);
    }
    // do not mistake a spoken preamble for the requested result
    if (status === 'completed' && expectedTurn.mcpCalls.size > 0) {
      expectedTurn.responseDone = true;
      // spoken progress belongs in retained chat but never retires tool authority
      if (finalText !== '') {
        expectedTurn.pendingFinal = { responseId, text: finalText, intermediate: true };
        await persistAssistantReceipt(expectedSession, expectedChannel, expectedTurn);
      } else await continueMcp(expectedSession, expectedChannel, expectedTurn);
      return;
    }
    // persist only a completed nonempty assistant final
    if (status === 'completed' && finalText !== '') {
      expectedTurn.pendingFinal = { responseId, text: finalText };
      await persistAssistantReceipt(expectedSession, expectedChannel, expectedTurn);
      return;
    }
    // retire canceled and empty exact responses without persistence
    if (!await finishTurn(expectedSession, expectedTurn, responseId)) await rotate(expectedSession, expectedChannel);
  }, [continueMcp, finishProjection, finishTurn, persistAssistantReceipt, rotate]);

  // handle one provider event under a serialized frontier
  const handlePayload = useCallback(async (expectedSession: ActiveSession, expectedChannel: RTCDataChannel, payload: Record<string, unknown>) => {
    // reject every callback from a replaced transport
    if (session.current !== expectedSession || channel.current !== expectedChannel) return;
    const type = text(payload.type) ?? '';
    // surface rejected provider continuations instead of leaving a completed-looking preamble
    if (type === 'error' && turn.current !== undefined) {
      void closeLocal('error');
      setError('Davo could not complete that request. Reopen listening to try again.');
      return;
    }
    // track exact MCP output items separately from response inference completion
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const currentTurn = turn.current;
      // never attach another response's tool item to this admitted turn
      if (currentTurn?.bound && text(payload.response_id) === currentTurn.responseId && trackMcpItem(currentTurn, object(payload.item), type === 'response.output_item.done')) {
        refreshMcpActivity();
        // bound a stalled remote operation without retrying or claiming success
        if (mcpTimer.current === undefined) mcpTimer.current = window.setTimeout(() => {
          // an old tool deadline cannot close a successor transport or turn
          if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== currentTurn) return;
          void closeLocal('error');
          setError('Davo is still waiting for a tool result. Reopen listening to check its status.');
        }, mcpTimeoutMilliseconds);
        await continueMcp(expectedSession, expectedChannel, currentTurn);
        return;
      }
    }
    // terminal MCP events identify their registered output item rather than a response id
    if (type === 'response.mcp_call.completed' || type === 'response.mcp_call.failed') {
      const currentTurn = turn.current;
      const itemId = text(payload.item_id);
      const call = itemId === undefined ? undefined : currentTurn?.mcpCalls.get(itemId);
      // unrelated or repeated old items cannot advance the current response
      if (currentTurn?.bound && call !== undefined) {
        call.terminal = true;
        refreshMcpActivity();
        // success and failure both wait for the exact finalized item before referencing it
        await continueMcp(expectedSession, expectedChannel, currentTurn);
      }
      return;
    }
    // retain the provider session identity for transcript receipts
    if (type === 'session.created') {
      const provider = object(payload.session);
      const providerSessionId = provider === undefined ? undefined : text(provider.id);
      if (providerSessionId !== undefined) expectedSession.providerSessionId = providerSessionId;
      return;
    }
    // fail closed on provider MCP import failure
    if (type === 'mcp_list_tools.failed') {
      const tracker = readiness.current;
      if (tracker !== undefined) tracker.failed = true;
      return;
    }
    // retain the official readiness import completion
    if (type === 'mcp_list_tools.completed') {
      const tracker = readiness.current;
      const responseId = text(payload.response_id);
      const itemId = text(payload.item_id);
      const serverLabel = text(payload.server_label);
      if (tracker !== undefined && itemId !== undefined) {
        // reject conflicting completion identities
        if (tracker.completedItemId !== undefined && (tracker.completedItemId !== itemId || tracker.completedResponseId !== responseId || tracker.completedServerLabel !== serverLabel)) tracker.failed = true;
        else {
          tracker.completedItemId = itemId;
          tracker.completedResponseId = responseId;
          tracker.completedServerLabel = serverLabel;
        }
        reconcileReadinessImport(tracker);
      }
      return;
    }
    // retain exact imported names from either official item surface
    if (type === 'conversation.item.done' || type === 'response.output_item.done') {
      const tracker = readiness.current;
      const item = object(payload.item);
      if (tracker !== undefined && item?.type === 'mcp_list_tools') {
        const candidate = readinessImportItem(item, type === 'response.output_item.done' ? text(payload.response_id) : undefined);
        if (candidate === undefined || !tracker.expectedServerLabels.includes(candidate.serverLabel)) tracker.failed = true;
        else {
          // bound staged imports before response.created
          if (tracker.importItems.length >= 8) tracker.failed = true;
          else tracker.importItems.push(candidate);
          reconcileReadinessImport(tracker);
        }
      }
      return;
    }
    // resolve one exact deletion acknowledgement
    if (type === 'conversation.item.deleted') {
      const item = object(payload.item);
      const itemId = text(payload.item_id) ?? (item === undefined ? undefined : text(item.id));
      const pending = itemId === undefined ? undefined : deletionAcks.current.get(itemId);
      // settle only this transport's deletion wait
      if (pending?.session === expectedSession && pending.channel === expectedChannel) pending.settle(true);
      return;
    }
    // record directional activity only
    if (type === 'input_audio_buffer.speech_started') {
      inputSpeaking.current = true;
      setInputActive(true);
      const itemId = text(payload.item_id);
      // bind overlap to this raw item at speech start
      if (itemId !== undefined) {
        inputEpochs.current.set(itemId, outputSpeaking.current ? outputEpoch.current : 0);
        // bind mute and owner authority at the earliest item identity
        if (!inputBufferEpochs.current.has(itemId)) inputBufferEpochs.current.set(itemId, bufferEpoch.current);
      }
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') { inputSpeaking.current = false; setInputActive(false); return; }
    if (type === 'input_audio_buffer.committed') {
      const itemId = text(payload.item_id);
      // an unidentified commit cannot be deleted safely
      if (itemId === undefined) return rotate(expectedSession, expectedChannel);
      // preserve a commit-time overlap when start identity was unavailable
      if (!inputEpochs.current.has(itemId)) inputEpochs.current.set(itemId, outputSpeaking.current ? outputEpoch.current : 0);
      quarantineRawItem(expectedSession, expectedChannel, itemId);
      return;
    }
    if (type === 'output_audio_buffer.started') {
      outputEpoch.current += 1;
      outputSpeaking.current = true;
      // mark every active or committed input as overlapped
      for (const itemId of inputEpochs.current.keys()) inputEpochs.current.set(itemId, outputEpoch.current);
      return;
    }
    if (type === 'output_audio_buffer.stopped') { outputSpeaking.current = false; return; }
    // quarantine every committed final transcript
    if (type === 'conversation.item.input_audio_transcription.failed') {
      const itemId = text(payload.item_id);
      // rotate when failed raw input cannot be identified or deleted
      if (itemId === undefined) return rotate(expectedSession, expectedChannel);
      // a later terminal item cannot pass an earlier pending commit
      if ([...pendingRawItems.current.keys()].some(pendingId => pendingId !== itemId)) return rotate(expectedSession, expectedChannel);
      quarantineRawItem(expectedSession, expectedChannel, itemId);
      const failedBufferEpoch = pendingRawItems.current.get(itemId)?.bufferEpoch ?? inputBufferEpochs.current.get(itemId) ?? bufferEpoch.current;
      const deleted = await deleteItem(expectedSession, expectedChannel, itemId);
      // discard deletion completion from a replaced transport
      if (session.current !== expectedSession || channel.current !== expectedChannel) return;
      if (!deleted) return rotate(expectedSession, expectedChannel);
      releaseRawItem(expectedSession, expectedChannel, itemId);
      inputBufferEpochs.current.delete(itemId);
      failBufferedTranscript(failedBufferEpoch);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = text(payload.item_id);
      const transcript = text(payload.transcript);
      if (itemId === undefined) return rotate(expectedSession, expectedChannel);
      // delete repeated terminal events without reusing their text
      if (quarantinedItems.current.has(itemId)) {
        const deleted = await deleteItem(expectedSession, expectedChannel, itemId);
        // discard repeated deletion completion after replacement
        if (session.current !== expectedSession || channel.current !== expectedChannel) return;
        if (!deleted) await rotate(expectedSession, expectedChannel);
        inputBufferEpochs.current.delete(itemId);
        return;
      }
      // a later item cannot cross an unresolved earlier commit
      if ([...pendingRawItems.current.keys()].some(pendingId => pendingId !== itemId)) return rotate(expectedSession, expectedChannel);
      quarantineRawItem(expectedSession, expectedChannel, itemId);
      const expectedBufferEpoch = pendingRawItems.current.get(itemId)?.bufferEpoch ?? inputBufferEpochs.current.get(itemId) ?? bufferEpoch.current;
      const overlapEpoch = inputEpochs.current.get(itemId) ?? (outputSpeaking.current ? outputEpoch.current : 0);
      inputEpochs.current.delete(itemId);
      inputBufferEpochs.current.delete(itemId);
      const deleted = await deleteItem(expectedSession, expectedChannel, itemId);
      // discard deletion completion from a replaced transport
      if (session.current !== expectedSession || channel.current !== expectedChannel) return;
      // never use text before exact deletion acknowledgement
      if (!deleted) return rotate(expectedSession, expectedChannel);
      releaseRawItem(expectedSession, expectedChannel, itemId);
      // discard overlap, duplicate and stale raw items after quarantine
      if (overlapEpoch > 0) return;
      // discard audio invalidated while transcription or deletion was pending
      if (bufferEpoch.current !== expectedBufferEpoch) return;
      // missing text invalidates the whole unfinished turn
      if (transcript === undefined) { failBufferedTranscript(expectedBufferEpoch); return; }
      // muted mode recognizes only the configured exact name
      if (mutedRef.current) {
        if (normalized(transcript) === normalized(assistantName)) { mutedRef.current = false; setMuted(false); }
        return;
      }
      // discard speech while an earlier exact turn remains active
      if (turn.current !== undefined) return;
      await bufferTranscript(expectedSession, expectedChannel, itemId, transcript, expectedBufferEpoch);
      return;
    }
    // bind provider response before accepting callbacks
    if (type === 'response.created') {
      const response = object(payload.response);
      const responseId = response === undefined ? undefined : text(response.id);
      const tracker = readiness.current;
      // bind only the server-authored readiness response metadata
      if (tracker !== undefined && responseId !== undefined && readinessMetadata(response, tracker.readinessId)) { tracker.responseId = responseId; reconcileReadinessImport(tracker); return; }
      // raw input must clear before any other provider response
      if (pendingRawItems.current.size > 0) return rotate(expectedSession, expectedChannel);
      // classify one background speech response
      if (projectionPending.current && turn.current === undefined && responseId !== undefined && projectionResponseId.current === undefined) { projectionResponseId.current = responseId; return; }
      const currentTurn = turn.current;
      if (currentTurn === undefined || responseId === undefined) return;
      const bound = await request('/api/davo/responses/bind', json({ voiceSessionId: expectedSession.voiceSessionId, generation: expectedSession.generation, turnId: currentTurn.turnId, responseId }));
      // discard binding completion after session or turn replacement
      if (session.current !== expectedSession || channel.current !== expectedChannel || turn.current !== currentTurn) return;
      // cancel unbound provider work
      if (!bound.ok) { send(expectedSession, expectedChannel, { type: 'response.cancel', response_id: responseId }); await finishTurn(expectedSession, currentTurn); return; }
      currentTurn.responseId = responseId;
      currentTurn.bound = true;
      return;
    }
    // accumulate only bound final-response speech text
    if (type === 'response.output_audio_transcript.delta') {
      const delta = text(payload.delta);
      const responseId = text(payload.response_id);
      const currentTurn = turn.current;
      // accept text only from the exact bound foreground response
      if (delta !== undefined && currentTurn?.bound && responseId === currentTurn.responseId) currentTurn.text += delta;
      return;
    }
    // run only the approved browser-local function
    if (type === 'response.function_call_arguments.done' && payload.name === 'select_worktree') {
      if (pendingRawItems.current.size > 0) return rotate(expectedSession, expectedChannel);
      const currentTurn = turn.current;
      // require one exact turn for the continuation
      if (currentTurn !== undefined) await selectLocalWorktree(expectedSession, expectedChannel, currentTurn, payload);
      return;
    }
    // finalize or retire one exact response
    if (type === 'response.done') {
      const response = object(payload.response);
      const tracker = readiness.current;
      const responseId = response === undefined ? undefined : text(response.id);
      // settle only a completed exact readiness response
      if (tracker !== undefined && responseId === tracker.responseId) {
        tracker.responseDone = text(response?.status) === 'completed';
        if (!tracker.responseDone) tracker.failed = true;
        return;
      }
      if (response !== undefined) await completeResponse(expectedSession, expectedChannel, turn.current, response);
    }
  }, [assistantName, bufferTranscript, closeLocal, completeResponse, continueMcp, deleteItem, failBufferedTranscript, finishTurn, quarantineRawItem, refreshMcpActivity, releaseRawItem, request, rotate, selectLocalWorktree, send]);

  // start one server-owned WebRTC projection
  const start = useCallback(async () => {
    desiredOpen.current = true;
    const cleanup = closeLocal('connecting');
    const token = attempt.current;
    setError(undefined);
    setState('connecting');
    const closed = await cleanup;
    // discard replaced cleanup before opening
    if (token !== attempt.current) return;
    // preserve uncertainty before any successor negotiation
    if (!closed) { setError('Davo provider cleanup is uncertain. Try again later.'); setState('error'); return; }
    const snapshot = await conversation.refresh();
    // discard history completion after a newer start
    if (token !== attempt.current) return;
    // require retained context before microphone authority
    if (snapshot === undefined) { setError('Davo history is unavailable.'); setState('error'); return; }
    const voiceSessionId = crypto.randomUUID().replaceAll('-', '');
    let startedSession: ActiveSession | undefined;
    try {
      const opened = await request('/api/realtime/session', json({ voiceSessionId, generation: snapshot.generation, ...(target.worktreeId === undefined ? {} : { worktreeId: target.worktreeId }), ...(target.agentId === undefined ? {} : { agentId: target.agentId }) }));
      // discard an opening response after a newer start
      if (token !== attempt.current) return;
      const openedValue = opened.ok ? await opened.json().catch(() => undefined) : undefined;
      // discard opening JSON after a newer start
      if (token !== attempt.current) return;
      const receipt = sessionFrom(openedValue);
      // require one server-owned pending negotiation before microphone access
      if (receipt === undefined || receipt.generation !== snapshot.generation) throw new Error('Davo could not start listening.');
      const serverOffset = Date.parse(receipt.serverNow) - Date.now();
      const active: ActiveSession = { voiceSessionId, generation: receipt.generation, leaseExpiresAt: Date.parse(receipt.leaseExpiresAt) - serverOffset, retentionCutoffAt: Date.parse(receipt.retentionCutoffAt) - serverOffset };
      startedSession = active;
      session.current = active;
      // renew control while permission and provider setup remain pending
      heartbeat.current = window.setInterval(async () => {
        // stop only the session that owns this heartbeat
        if (session.current !== active) return;
        if (Date.now() >= Math.min(active.leaseExpiresAt, active.retentionCutoffAt)) return stop();
        const response = await request('/api/realtime/session/heartbeat', json({ voiceSessionId: active.voiceSessionId, generation: active.generation }));
        // discard heartbeat completion after replacement
        if (session.current !== active) return;
        if (!response.ok) return stop();
        const value = await response.json() as { leaseExpiresAt?: unknown; serverNow?: unknown };
        // discard heartbeat parsing after replacement
        if (session.current !== active) return;
        // advance only with bounded server proof
        if (typeof value.leaseExpiresAt === 'string' && typeof value.serverNow === 'string') active.leaseExpiresAt = Math.min(Date.parse(value.leaseExpiresAt) - (Date.parse(value.serverNow) - Date.now()), active.retentionCutoffAt);
      }, heartbeatMilliseconds);
      deadline.current = window.setTimeout(() => {
        // expire only this exact retained session
        if (session.current === active) stop();
      }, Math.max(0, active.retentionCutoffAt - Date.now()));
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      // discard permission resolved after replacement
      if (token !== attempt.current || session.current !== active) { media.getTracks().forEach(track => track.stop()); return; }
      media.getAudioTracks().forEach(track => { track.enabled = false; });
      stream.current = media;
      connectMeter(media, 'input');
      const connection = new RTCPeerConnection();
      peer.current = connection;
      const remoteAudio = new Audio();
      remoteAudio.autoplay = true;
      audio.current = remoteAudio;
      connection.ontrack = event => {
        const remote = event.streams[0];
        if (remote !== undefined && peer.current === connection) { remoteAudio.srcObject = remote; connectMeter(remote, 'output'); void remoteAudio.play().catch(() => undefined); }
      };
      media.getTracks().forEach(track => connection.addTrack(track, media));
      const data = connection.createDataChannel('oai-events');
      channel.current = data;
      data.addEventListener('message', event => {
        let payload: unknown;
        try { payload = JSON.parse(String(event.data)); }
        catch { return; }
        const providerEvent = object(payload);
        // discard events from a replaced transport
        if (session.current !== active || channel.current !== data) return;
        // release deletion waits outside the serialized admission frontier
        if (providerEvent?.type === 'conversation.item.deleted') {
          const item = object(providerEvent.item);
          const itemId = text(providerEvent.item_id) ?? (item === undefined ? undefined : text(item.id));
          const pending = itemId === undefined ? undefined : deletionAcks.current.get(itemId);
          // settle only this transport's deletion wait
          if (pending?.session === active && pending.channel === data) pending.settle(true);
          return;
        }
        // classify projected response ids outside foreground waits
        if (providerEvent?.type === 'response.created' && projectionPending.current && turn.current === undefined) {
          const response = object(providerEvent.response);
          const responseId = response === undefined ? undefined : text(response.id);
          if (responseId !== undefined && projectionResponseId.current === undefined) { projectionResponseId.current = responseId; return; }
        }
        // release projection cancellation waits outside the serialized frontier
        if (providerEvent?.type === 'response.done') {
          const response = object(providerEvent.response);
          const responseId = response === undefined ? undefined : text(response.id);
          if (responseId !== undefined && responseId === projectionResponseId.current) {
            finishProjection();
            return;
          }
        }
        // serialize only callbacks from the captured transport
        if (providerEvent !== undefined) eventFrontier.current = eventFrontier.current
          .then(() => handlePayload(active, data, providerEvent))
          .catch(error => {
            // an old frontier cannot recover or stop a successor
            if (session.current !== active || channel.current !== data) return;
            // capacity rejection is explicit and never retries possibly completed tool work
            if (error instanceof Error && error.message === 'davo_tool_capacity') {
              void closeLocal('error');
              setError('Davo reached the tool continuation limit. Reopen listening to continue.');
              return;
            }
            return rotate(active, data);
          });
      });
      const openedChannel = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Davo provider channel timed out.')), 15_000);
        data.addEventListener('open', () => { window.clearTimeout(timer); resolve(); }, { once: true });
      });
      const offer = await connection.createOffer();
      // discard offer completion after replacement
      if (token !== attempt.current || session.current !== active || channel.current !== data) return;
      await connection.setLocalDescription(offer);
      // discard local-description completion after replacement
      if (token !== attempt.current || session.current !== active || channel.current !== data) return;
      const negotiated = await request('/api/realtime/negotiate', json({ voiceSessionId, generation: receipt.generation, negotiationId: receipt.negotiationId, sdp: offer.sdp ?? '' }));
      // discard negotiation response after replacement
      if (token !== attempt.current || session.current !== active || channel.current !== data) return;
      const negotiatedValue = negotiated.ok ? await negotiated.json().catch(() => undefined) : undefined;
      // discard negotiation JSON after replacement
      if (token !== attempt.current || session.current !== active || channel.current !== data) return;
      const answer = negotiationFrom(negotiatedValue);
      if (answer === undefined || answer.generation !== receipt.generation) throw new Error('Davo provider setup failed.');
      const expectedCatalog = readinessCatalog(answer.readinessResponse);
      if (expectedCatalog === undefined) throw new Error('Davo provider readiness failed.');
      const tracker: ReadinessTracker = { readinessId: answer.readinessId, expectedServerLabels: expectedCatalog.serverLabels, expectedTools: expectedCatalog.tools, responseDone: false, mcpCompleted: false, importItems: [], failed: false };
      readiness.current = tracker;
      await connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await openedChannel;
      if (token !== attempt.current || session.current !== active || channel.current !== data) return;
      if (Date.now() >= active.retentionCutoffAt) throw new Error('Davo session expired.');
      // require the provider session before sending internal readiness work
      const providerSessionReady = await waitUntil(() => token !== attempt.current || session.current?.providerSessionId !== undefined, readinessTimeoutMilliseconds);
      // stop quietly after explicit transport replacement
      if (token !== attempt.current || session.current !== active || channel.current !== data) return;
      if (!providerSessionReady) throw new Error('Davo provider readiness timed out.');
      if (!send(active, data, { type: 'response.create', response: answer.readinessResponse })) throw new Error('Davo provider readiness failed.');
      // require completed text readiness and actual MCP import evidence
      const imported = await waitUntil(() => token !== attempt.current || tracker.failed || tracker.responseDone && tracker.mcpCompleted && tracker.importedTools !== undefined, readinessTimeoutMilliseconds);
      if (token !== attempt.current || session.current !== active || channel.current !== data) return;
      if (!imported || tracker.failed || tracker.responseId === undefined || tracker.importedTools === undefined) throw new Error('Davo provider readiness failed.');
      const acknowledged = await request('/api/davo/session/ready', json({ voiceSessionId, generation: receipt.generation, readinessId: tracker.readinessId, responseId: tracker.responseId, importedTools: tracker.importedTools }));
      if (token !== attempt.current || session.current !== active || channel.current !== data) return;
      if (!acknowledged.ok) throw new Error('Davo provider readiness failed.');
      readiness.current = undefined;
      // microphone authority begins only after server readiness acknowledgement
      media.getAudioTracks().forEach(track => { track.enabled = true; });
      setState('connected');
    } catch (failure) {
      // never let an older start failure close a successor
      if (token !== attempt.current || startedSession !== undefined && session.current !== startedSession) return;
      void closeLocal('error');
      setError(failure instanceof Error ? failure.message : 'Davo could not start listening.');
    }
  }, [closeLocal, connectMeter, conversation, finishProjection, handlePayload, request, rotate, stop, target.agentId, target.worktreeId]);
  startRef.current = start;

  // toggle logical wake mode without stopping microphone transmission
  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    clearBufferedTranscripts();
    mutedRef.current = next;
    setMuted(next);
    setProjectionRevision(revision => revision + 1);
  }, [clearBufferedTranscripts]);

  // speak new server-authored background replies while open
  useEffect(() => {
    const known = priorMessages.current;
    const added = conversation.messages.filter(message => !known.has(message.id));
    priorMessages.current = new Set(conversation.messages.map(message => message.id));
    // seed existing history without replay
    if (known.size === 0) return;
    // retain each new background assistant reply until speech is safe
    for (const message of added) {
      if (message.kind === 'assistant' && !spokenMessages.current.delete(message.id)) pendingBackgroundMessages.current.set(message.id, message);
    }
    // wait for input, raw deletion, and existing output to clear
    if (state !== 'connected' || inputActive || inputSpeaking.current || inputBufferEpochs.current.size > 0 || pendingRawItems.current.size > 0 || inputTurnPending.current || turn.current !== undefined || projectionPending.current) return;
    const message = pendingBackgroundMessages.current.values().next().value as DavoMessage | undefined;
    if (message === undefined) return;
    const currentSession = session.current;
    const currentChannel = channel.current;
    // require one exact connected provider transport
    if (currentSession === undefined || currentChannel === undefined) return;
    pendingBackgroundMessages.current.delete(message.id);
    projectionPending.current = true;
    const work: RuntimeWork = { session: currentSession, kind: 'projection' };
    projectionWork.current = work;
    beginRuntimeWork(work);
    // release the projection latch when provider dispatch fails
    if (!send(currentSession, currentChannel, { type: 'response.create', response: { conversation: 'none', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Speak this update exactly once: ${message.text}` }] }], tools: [], tool_choice: 'none', output_modalities: ['audio'] } })) {
      projectionPending.current = false;
      projectionWork.current = undefined;
      endRuntimeWork(work);
    }
  }, [awaitingOver, beginRuntimeWork, conversation.messages, endRuntimeWork, inputActive, projectionRevision, send, state]);

  // close immediately when the document cannot run deadlines
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') stop();
    };
    window.addEventListener('pagehide', stop);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', stop);
      document.removeEventListener('visibilitychange', hidden);
      stop();
    };
  }, [stop]);

  // fence transport state on retention generation changes
  useEffect(() => {
    const current = session.current;
    if (current !== undefined && conversation.snapshot !== undefined && current.generation !== conversation.snapshot.generation) stop();
  }, [conversation.snapshot, stop]);

  // never carry unfinished audio across a target owner change
  useEffect(() => {
    const owner = `${target.worktreeId ?? ''}\u0000${target.agentId ?? ''}`;
    // retain an admission already owned by its captured server session
    if (bufferedOwner.current === owner) return;
    bufferedOwner.current = owner;
    clearBufferedTranscripts();
    setProjectionRevision(revision => revision + 1);
  }, [clearBufferedTranscripts, target.agentId, target.worktreeId]);

  return { state, error: error ?? conversation.error, conversation, inputLevel, outputLevel, muted, awaitingOver, working: runtimeWorking || conversation.snapshot?.working === true, start, stop, toggleMute };
}

// split one terminal standalone spoken cue from its content
function overCue(value: string): { complete: boolean; text: string } {
  const cueOnly = /^[\s\p{P}]*over[\s\p{P}]*$/iu;
  // accept a cue-only transcription with spoken punctuation
  if (cueOnly.test(value)) return { complete: true, text: '' };
  const terminal = /(?:\s|[.,;:!?…])over[\s\p{P}]*$/iu.exec(value);
  // keep mid-sentence and substring uses as ordinary speech
  if (terminal === null) return { complete: false, text: value.trim() };
  const boundary = value[terminal.index] ?? '';
  const contentEnd = /\s/u.test(boundary) ? terminal.index : terminal.index + boundary.length;
  return { complete: true, text: value.slice(0, contentEnd).trim() };
}

// build one JSON mutation request
function json(body: unknown, keepalive = false): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive };
}

// parse one session receipt
function sessionFrom(value: unknown): SessionReceipt | undefined {
  const record = object(value);
  if (record === undefined || typeof record.negotiationId !== 'string' || typeof record.model !== 'string' || typeof record.conversationId !== 'string' || !integer(record.generation) || typeof record.contextRevision !== 'string' || typeof record.serverNow !== 'string' || typeof record.leaseExpiresAt !== 'string' || typeof record.retentionCutoffAt !== 'string') return undefined;
  return record as SessionReceipt;
}

// parse one server-authored readiness negotiation
function negotiationFrom(value: unknown): NegotiationReceipt | undefined {
  const record = object(value);
  const response = record === undefined ? undefined : object(record.readinessResponse);
  const metadata = response === undefined ? undefined : object(response.metadata);
  // require the exact internal readiness marker
  if (record === undefined || typeof record.sdp !== 'string' || !integer(record.generation) || typeof record.readinessId !== 'string' || response === undefined || metadata?.davo_phase !== 'readiness' || metadata.readiness_id !== record.readinessId) return undefined;
  return { sdp: record.sdp, generation: record.generation, readinessId: record.readinessId, readinessResponse: response };
}

// match one provider response to the readiness nonce
function readinessMetadata(response: Record<string, unknown> | undefined, readinessId: string): boolean {
  const metadata = response === undefined ? undefined : object(response.metadata);
  return metadata?.davo_phase === 'readiness' && metadata.readiness_id === readinessId;
}

// read the exact frozen MCP catalog from readiness tools
function readinessCatalog(response: Record<string, unknown>): { serverLabels: string[]; tools: string[] } | undefined {
  // require one server-authored tools array
  if (!Array.isArray(response.tools)) return undefined;
  const labels: string[] = [];
  const names: string[] = [];
  // retain only exact MCP descriptor labels
  for (const candidate of response.tools) {
    const tool = object(candidate);
    if (tool?.type !== 'mcp') continue;
    const label = text(tool.server_label);
    const allowed = allowedToolNames(tool.allowed_tools);
    if (label === undefined || allowed === undefined) return undefined;
    labels.push(label);
    names.push(...allowed);
  }
  // reject ambiguous descriptors and tool ownership
  if (labels.length === 0 || new Set(labels).size !== labels.length || new Set(names).size !== names.length) return undefined;
  return { serverLabels: [...labels].sort(), tools: [...names].sort() };
}

// parse server-authored allowed tool names
function allowedToolNames(value: unknown): string[] | undefined {
  // require a complete descriptor list
  if (!Array.isArray(value)) return undefined;
  const names = value.map(candidate => text(candidate));
  // reject missing and duplicate names
  if (names.some(name => name === undefined) || new Set(names).size !== names.length) return undefined;
  return (names as string[]).sort();
}

// parse one provider MCP list item
function readinessImportItem(item: Record<string, unknown>, responseId: string | undefined): ReadinessImportItem | undefined {
  const itemId = text(item.id);
  const serverLabel = text(item.server_label);
  const tools = importedToolNames(item.tools);
  // require exact list identity and imported names
  if (itemId === undefined || serverLabel === undefined || tools === undefined) return undefined;
  return { itemId, serverLabel, tools, ...(responseId === undefined ? {} : { responseId }) };
}

// correlate completed MCP import with its exact item and response
function reconcileReadinessImport(tracker: ReadinessTracker): void {
  const itemId = tracker.completedItemId;
  // wait for both official event halves
  if (itemId === undefined) return;
  // reject completion from another readiness response
  if (tracker.responseId !== undefined && tracker.completedResponseId !== undefined && tracker.completedResponseId !== tracker.responseId) { tracker.failed = true; return; }
  // reject completion from another frozen MCP descriptor
  if (tracker.completedServerLabel !== undefined && !tracker.expectedServerLabels.includes(tracker.completedServerLabel)) { tracker.failed = true; return; }
  // wait to classify response-bound observations against the readiness response
  if (tracker.responseId === undefined && tracker.importItems.some(candidate => candidate.responseId !== undefined)) return;
  // require one logical import item per frozen descriptor
  for (const serverLabel of tracker.expectedServerLabels) {
    const itemIds = new Set(tracker.importItems
      .filter(candidate => candidate.serverLabel === serverLabel && (candidate.responseId === undefined || candidate.responseId === tracker.responseId))
      .map(candidate => candidate.itemId));
    // a second item cannot be duplicate evidence for the completed import
    if (itemIds.size > 1) { tracker.failed = true; return; }
  }
  const matches = tracker.importItems.filter(candidate => candidate.itemId === itemId
    && (tracker.completedServerLabel === undefined || candidate.serverLabel === tracker.completedServerLabel)
    && (candidate.responseId === undefined || tracker.responseId !== undefined && candidate.responseId === tracker.responseId));
  // wait while a response-bound item precedes response.created
  if (matches.length === 0) return;
  const canonical = JSON.stringify({ itemId: matches[0]!.itemId, serverLabel: matches[0]!.serverLabel, tools: matches[0]!.tools });
  // reject conflicting duplicate item evidence
  if (matches.some(candidate => JSON.stringify({ itemId: candidate.itemId, serverLabel: candidate.serverLabel, tools: candidate.tools }) !== canonical)) { tracker.failed = true; return; }
  // require duplicate-free exact catalog equality
  if (JSON.stringify(matches[0]!.tools) !== JSON.stringify(tracker.expectedTools)) { tracker.failed = true; return; }
  tracker.importedTools = matches[0]!.tools;
  tracker.mcpCompleted = true;
}

// parse actual imported provider tool names
function importedToolNames(value: unknown): string[] | undefined {
  // require a complete provider tool array
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  // accept only named imported tool objects
  for (const candidate of value) {
    const name = text(object(candidate)?.name);
    if (name === undefined) return undefined;
    names.push(name);
  }
  // duplicate names cannot prove one exact frozen catalog
  if (new Set(names).size !== names.length) return undefined;
  return [...names].sort();
}

// await one bounded provider transport condition
function waitUntil(predicate: () => boolean, timeoutMilliseconds: number): Promise<boolean> {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMilliseconds;
    const inspect = () => {
      // settle at the first satisfied condition
      if (predicate()) { resolve(true); return; }
      // fail closed at the transport deadline
      if (Date.now() >= deadline) { resolve(false); return; }
      window.setTimeout(inspect, 10);
    };
    inspect();
  });
}

// parse one durable admission receipt
function admissionFrom(value: unknown): AdmissionReceipt | undefined {
  const record = object(value);
  if (record === undefined || typeof record.messageId !== 'string' || typeof record.turnId !== 'string' || !integer(record.generation) || !object(record.response)) return undefined;
  return { messageId: record.messageId, turnId: record.turnId, generation: record.generation, response: record.response as Record<string, unknown> };
}

// detect admission without inference authority
function pendingAdmission(value: unknown): boolean {
  return object(value)?.pending === true;
}

// register only provider MCP items belonging to an already bound response
function trackMcpItem(turn: ActiveTurn, item: Record<string, unknown> | undefined, itemDone: boolean): boolean {
  // readiness catalogs and ordinary assistant content are not asynchronous calls
  if (item?.type !== 'mcp_call') return false;
  const id = text(item.id);
  // bound pending calls independently of the provider or server context budgets
  if (id === undefined || id.length > 256 || !turn.mcpCalls.has(id) && turn.mcpCalls.size >= 16) throw new Error('davo_tool_capacity');
  const call = turn.mcpCalls.get(id) ?? { terminal: false, itemDone: false };
  call.itemDone ||= itemDone;
  turn.mcpCalls.set(id, call);
  return true;
}

// read one completed provider response transcript
function responseText(response: Record<string, unknown>): string {
  // require provider output items
  if (!Array.isArray(response.output)) return '';
  const parts: string[] = [];
  // collect only assistant audio transcripts
  for (const item of response.output) {
    const record = object(item);
    if (record === undefined || !Array.isArray(record.content)) continue;
    for (const content of record.content) {
      const part = object(content);
      if (part !== undefined && typeof part.transcript === 'string') parts.push(part.transcript);
    }
  }
  return parts.join(' ').trim();
}

// parse one local worktree function argument
function worktreeArgument(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const parsed = object(JSON.parse(value));
    return parsed === undefined ? undefined : text(parsed.worktree_id);
  } catch {
    return undefined;
  }
}

// normalize exact wake phrases
function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

// measure one audio edge
function level(analyser: AnalyserNode | undefined): number {
  // keep an absent meter quiet
  if (analyser === undefined) return 0;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let energy = 0;
  // collect normalized waveform energy
  for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(energy / samples.length) * 5);
}

// read one nonempty string
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// recognize nonnegative integers
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// recognize plain provider objects
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// reconcile one idempotent mutation with its exact request body
async function exactMutation(request: Request, url: string, body: unknown): Promise<MutationResult> {
  const init = json(body);
  // retry only the same receipt after an ambiguous server outcome
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await request(url, init).catch(() => undefined);
    // return the accepted response for strict receipt parsing
    if (response?.ok) return { kind: 'accepted', response };
    // treat client and generation conflicts as authoritative fences
    if (response !== undefined && response.status < 500) return { kind: 'conflict' };
  }
  return { kind: 'ambiguous' };
}
