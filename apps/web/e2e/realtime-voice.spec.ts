import { expect, test } from '@playwright/test';

const enabledDavo = { enabled: true, available: true, name: 'Davo', context: '' };
type ConversationActivity = { working: boolean; messages: Array<{ id: string; sequence: number; kind: 'status'; text: string; createdAt: string; expiresAt: string }> };

// install inspectable browser media primitives
async function installMedia(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    class MockDataChannel extends EventTarget {
      readyState: RTCDataChannelState = 'open';
      readonly sent: string[] = [];
      // capture one provider command
      send(value: string) { this.sent.push(value); }
      // close one provider projection
      close() { this.readyState = 'closed'; }
    }
    class MockPeerConnection extends EventTarget {
      connectionState: RTCPeerConnectionState = 'new';
      ontrack: ((event: RTCTrackEvent) => void) | null = null;
      // expose each exact peer for retirement checks
      constructor() { super(); Object.assign(window, { davoPeer: this }); }
      // expose one provider data channel
      createDataChannel() {
        const data = new MockDataChannel();
        Object.assign(window, { davoChannel: data });
        window.setTimeout(() => data.dispatchEvent(new Event('open')));
        return data as unknown as RTCDataChannel;
      }
      // accept one microphone track
      addTrack() { return {} as RTCRtpSender; }
      // create one bounded fixture offer
      async createOffer() { return { type: 'offer' as const, sdp: 'fixture-offer' }; }
      // accept fixture descriptions
      async setLocalDescription() {}
      async setRemoteDescription() {}
      // close one fixture peer
      close() { this.connectionState = 'closed'; }
    }
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: MockPeerConnection });
    // create one fresh microphone per transport
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
      const track = {
        enabled: true,
        stopped: false,
        // record one exact microphone stop
        stop() { this.stopped = true; }
      };
      const media = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
      Object.assign(window, { davoTrack: track });
      return media;
    } } });
    HTMLMediaElement.prototype.play = async () => undefined;
  });
}

// complete one exact fixture readiness response
async function completeReadiness(page: import('@playwright/test').Page, providerSessionId: string, responseId: string, itemId: string, tools: string[], extraItems: Array<{ id?: string; surface: 'conversation.item.done' | 'response.output_item.done'; tools: string[] }> = []): Promise<void> {
  await page.evaluate(({ providerId, readyResponseId, readyItemId, importedTools, importedItems }) => {
    const channel = (window as unknown as { davoChannel: EventTarget & { sent: string[] } }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.created', session: { id: providerId } }) }));
    const deliver = () => {
      // wait until the client sends its exact readiness request
      if (!channel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.davo_phase === 'readiness')) { window.setTimeout(deliver, 10); return; }
      const item = { id: readyItemId, type: 'mcp_list_tools', server_label: 'rac', tools: importedTools.map(name => ({ name })) };
      channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'mcp_list_tools.completed', item_id: readyItemId }) }));
      channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.done', item }) }));
      for (const extra of importedItems) {
        const other = { ...item, id: extra.id ?? item.id, tools: extra.tools.map(name => ({ name })) };
        channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(extra.surface === 'response.output_item.done' ? { type: extra.surface, response_id: readyResponseId, item: other } : { type: extra.surface, item: other }) }));
      }
      channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: readyResponseId, metadata: { davo_phase: 'readiness', readiness_id: 'readiness-1' } } }) }));
      channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done', response: { id: readyResponseId, status: 'completed' } }) }));
    };
    deliver();
  }, { providerId: providerSessionId, readyResponseId: responseId, readyItemId: itemId, importedTools: tools, importedItems: extraItems });
}

// delete one finalized provider transcript before optional cue completion
async function completeTranscript(page: import('@playwright/test').Page, itemId: string, transcript: string, finalize = true): Promise<void> {
  const priorDeletes = await page.evaluate(id => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'conversation.item.delete' && event.item_id === id).length, itemId);
  await page.evaluate(({ id, text }) => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text }) })), { id: itemId, text: finalize ? `${transcript} over` : transcript });
  await expect.poll(() => page.evaluate(id => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'conversation.item.delete' && event.item_id === id).length, itemId)).toBe(priorDeletes + 1);
  await page.evaluate(id => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: id }) })), itemId);
}

// open one minimal provider-readiness fixture
async function openReadinessFixture(page: import('@playwright/test').Page, tools: string[], extraItems: Array<{ id?: string; surface: 'conversation.item.done' | 'response.output_item.done'; tools: string[] }> = [], options: { admission?: 'receipt' | 'pending-202' | 'pending-body' | 'retry-pending'; deferContinuation?: boolean; deferFirstAdmission?: boolean; includeWorktree?: boolean; deferStop?: boolean; stopStatus?: number; deferMcp?: boolean; mcpStatus?: number; leaseMilliseconds?: number; emptyCatalog?: boolean; conversation?: () => ConversationActivity; deferFinish?: boolean; deferredLatencyMs?: number } = {}) {
  await installMedia(page);
  const readyBodies: unknown[] = [];
  const openBodies: unknown[] = [];
  const stopBodies: unknown[] = [];
  const transcriptBodies: unknown[] = [];
  const bindBodies: unknown[] = [];
  const assistantBodies: unknown[] = [];
  const continueBodies: unknown[] = [];
  const mcpBodies: unknown[] = [];
  const finishBodies: unknown[] = [];
  let releaseAdmission = () => undefined;
  let releaseContinuation = () => undefined;
  let releaseStop = () => undefined;
  let releaseMcp = () => undefined;
  let releaseFinish = () => undefined;
  let releaseConversation = () => undefined;
  let holdConversation = false;
  let heldConversationReads = 0;
  let settledAdmissions = 0;
  let settledContinuations = 0;
  let settledMcps = 0;
  const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve; });
  const continuationGate = new Promise<void>(resolve => { releaseContinuation = resolve; });
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
  const mcpGate = new Promise<void>(resolve => { releaseMcp = resolve; });
  const finishGate = new Promise<void>(resolve => { releaseFinish = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'davo-csrf', active: true, deviceName: 'Test browser', davo: enabledDavo, server: { name: 'Framework', url: 'https://framework.example', remotes: [] } } });
    // expose one selectable worktree only when requested
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: options.includeWorktree ? [{ id: 'agent-cora', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready' }] : [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // authorize one shared pane stream
    if (path === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    if (path === '/api/davo/conversation') {
      const activity = options.conversation?.();
      const projection = { conversationId: 'conversation-1', generation: 4, revision: '11111111-1111-4111-8111-111111111111', retainedFrom: '2026-11-03T08:00:00.000Z', serverNow: new Date().toISOString(), retentionCutoffAt: new Date(Date.now() + 3_600_000).toISOString(), nextSequence: 1 + (activity?.messages.length ?? 0), hasMore: false, pendingChoices: [], ...(activity === undefined ? {} : { working: activity.working }), messages: activity?.messages ?? [] };
      // hold one captured older projection across exact turn completion
      if (holdConversation) {
        holdConversation = false;
        heldConversationReads += 1;
        await new Promise<void>(resolve => { releaseConversation = resolve; });
      }
      return route.fulfill({ json: projection });
    }
    if (path === '/api/realtime/session') { openBodies.push(request.postDataJSON()); return route.fulfill({ json: { negotiationId: 'negotiation-1', model: 'gpt-realtime-2.1', conversationId: 'conversation-1', generation: 4, contextRevision: '22222222-2222-4222-8222-222222222222', serverNow: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + (options.leaseMilliseconds ?? 60_000)).toISOString(), retentionCutoffAt: new Date(Date.now() + 3_600_000).toISOString() } }); }
    if (path === '/api/realtime/negotiate') return route.fulfill({ json: { sdp: 'fixture-answer', generation: 4, readinessId: 'readiness-1', readinessResponse: { conversation: 'none', input: [], instructions: 'Return READY only', tools: [{ type: 'mcp', server_label: 'rac', allowed_tools: options.emptyCatalog ? [] : ['delegate_request', 'select_worktree'] }], tool_choice: 'none', output_modalities: ['text'], metadata: { davo_phase: 'readiness', readiness_id: 'readiness-1' } } } });
    if (path === '/api/davo/session/ready') { readyBodies.push(request.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (path === '/api/realtime/session/heartbeat') return route.fulfill({ json: { serverNow: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
    // retain the peer until exact server cleanup settles
    if (path === '/api/realtime/session/stop') {
      stopBodies.push(request.postDataJSON());
      // hold only the first exact cleanup receipt
      if (options.deferStop && stopBodies.length === 1) await stopGate;
      return route.fulfill({ status: options.stopStatus ?? 200, json: options.stopStatus === 503 ? { error: 'davo_provider_hangup_ambiguous' } : { ok: true } });
    }
    if (path === '/api/davo/responses/bind') { bindBodies.push(request.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (path === '/api/davo/responses/continue') {
      continueBodies.push(request.postDataJSON());
      // hold one old continuation across transport replacement
      if (options.deferContinuation) await continuationGate;
      // retain deliberate latency behind an observable settlement frontier
      if (options.deferredLatencyMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.deferredLatencyMs));
      await route.fulfill({ json: { messageId: 'message-old', turnId: 'turn-old', generation: 4, response: { conversation: 'none', input: [], tools: [], output_modalities: ['audio'], metadata: { fixture_continuation: 'old' } } } });
      settledContinuations += 1;
      return;
    }
    // hold exact tool-result continuation receipts without involving the provider
    if (path === '/api/davo/responses/mcp') {
      mcpBodies.push(request.postDataJSON());
      // hold only the requested fixture continuation
      if (options.deferMcp) await mcpGate;
      // retain deliberate latency behind an observable settlement frontier
      if (options.deferredLatencyMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.deferredLatencyMs));
      await route.fulfill({ status: options.mcpStatus ?? 200, json: options.mcpStatus === 503 ? { error: 'davo_unavailable' } : { messageId: 'message-old', turnId: 'turn-old', generation: 4, response: { conversation: 'none', input: [], tools: [], output_modalities: ['audio'], metadata: { fixture_mcp: mcpBodies.length } } } });
      settledMcps += 1;
      return;
    }
    if (path === '/api/davo/responses/finish') {
      finishBodies.push(request.postDataJSON());
      // hold exact completion while an older history read begins
      if (options.deferFinish) await finishGate;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/davo/transcripts/assistant') { assistantBodies.push(request.postDataJSON()); return route.fulfill({ json: { id: 'assistant-fixture' } }); }
    if (path === '/api/davo/transcripts/user') {
      transcriptBodies.push(request.postDataJSON());
      const first = transcriptBodies.length === 1;
      // expose exact handler settlement without production timing hooks
      const fulfillAdmission = async (response: { status?: number; json: unknown }) => {
        await route.fulfill(response);
        // count only the held first receipt used by stale-authority tests
        if (first) settledAdmissions += 1;
      };
      // hold only the old session's first admission receipt
      if (first && options.deferFirstAdmission) await admissionGate;
      // retain deliberate latency behind an observable settlement frontier
      if (first && options.deferredLatencyMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.deferredLatencyMs));
      // expose pending through the response status
      if (first && options.admission === 'pending-202') return await fulfillAdmission({ status: 202, json: { ok: true, pending: true, messageId: 'message-pending', generation: 4 } });
      // expose pending through the response body
      if (first && options.admission === 'pending-body') return await fulfillAdmission({ json: { ok: true, pending: true, messageId: 'message-pending', generation: 4 } });
      // exercise pending detection after the exact-receipt retry
      if (options.admission === 'retry-pending') return await fulfillAdmission({ json: first ? { ok: true } : { ok: true, pending: true, messageId: 'message-pending', generation: 4 } });
      return await fulfillAdmission({ json: { messageId: first ? 'message-old' : 'message-new', turnId: first ? 'turn-old' : 'turn-new', generation: 4, response: { conversation: 'none', input: [], tools: [], output_modalities: ['audio'], metadata: { fixture_admission: first ? 'old' : 'new' } } } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Davo' }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { davoChannel?: EventTarget }).davoChannel))).toBe(true);
  await completeReadiness(page, 'provider-session-1', 'readiness-response-1', 'mcp-list-1', tools, extraItems);
  return { assistantBodies, bindBodies, continueBodies, mcpBodies, finishBodies, openBodies, readyBodies, stopBodies, transcriptBodies, releaseAdmission, releaseContinuation, releaseMcp, releaseStop, releaseFinish, releaseConversation: () => releaseConversation(), holdNextConversation: () => { holdConversation = true; }, heldConversationReads: () => heldConversationReads, settledAdmissions: () => settledAdmissions, settledContinuations: () => settledContinuations, settledMcps: () => settledMcps };
}

// reducing every voice permission must not disable ordinary audio chat
test('opens listening with an exactly empty MCP catalog when Voice permissions deny every tool', async ({ page }) => {
  const fixture = await openReadinessFixture(page, [], [], { emptyCatalog: true });
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  expect(fixture.readyBodies[0]).toMatchObject({ importedTools: [] });
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toHaveText('Waiting for instructions...');
  await expect(page.getByRole('alert')).toHaveCount(0);
  // the frozen empty import has no fallback grant or substituted tool
  const readiness = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).find(event => event.response?.metadata?.davo_phase === 'readiness'));
  expect(readiness.response.tools[0].allowed_tools).toEqual([]);
  await completeTranscript(page, 'conversation-only', 'What is your name?');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
});

test('shows working only for an admitted request and returns to exact idle after completion', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect(page.getByRole('status')).toHaveText('Waiting for instructions...');
  await completeTranscript(page, 'working-request', 'Give me a concise status');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('Working...');
  await providerEvents(page, [{ type: 'response.created', response: { id: 'working-response' } }]);
  await expect.poll(() => fixture.bindBodies.length).toBe(1);
  await providerEvents(page, [
    { type: 'response.output_audio_transcript.delta', response_id: 'working-response', delta: 'The current work is ready.' },
    { type: 'response.done', response: { id: 'working-response', status: 'completed', output: [] } }
  ]);
  await expect.poll(() => fixture.finishBodies.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('Waiting for instructions...');
});

test('waits for an older history read then starts a fresh post-finish projection', async ({ page }) => {
  const activity: ConversationActivity = { working: true, messages: [] };
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { conversation: () => activity, deferFinish: true });
  await completeTranscript(page, 'fresh-finish-request', 'Finish after the older read');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await providerEvents(page, [{ type: 'response.created', response: { id: 'fresh-finish-response' } }]);
  await expect.poll(() => fixture.bindBodies.length).toBe(1);
  fixture.holdNextConversation();
  await providerEvents(page, [
    { type: 'response.output_audio_transcript.delta', response_id: 'fresh-finish-response', delta: 'Finished.' },
    { type: 'response.done', response: { id: 'fresh-finish-response', status: 'completed', output: [] } }
  ]);
  await expect.poll(() => fixture.heldConversationReads()).toBe(1);
  await expect.poll(() => fixture.finishBodies.length).toBe(0);
  fixture.releaseConversation();
  await expect.poll(() => fixture.finishBodies.length).toBe(1);
  fixture.holdNextConversation();
  await page.waitForTimeout(2_600);
  await expect.poll(() => fixture.heldConversationReads()).toBe(2);
  activity.working = false;
  fixture.releaseFinish();
  fixture.releaseConversation();
  await expect(page.getByRole('status')).toHaveText('Waiting for instructions...', { timeout: 1_500 });
});

test('buffers finalized speech until a standalone terminal over cue', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'chunk-one', 'Please inspect', false);
  await completeTranscript(page, 'chunk-two', 'go over the changes', false);
  await completeTranscript(page, 'chunk-three', 'and verify rollover behavior', false);
  await page.waitForTimeout(50);
  expect(fixture.transcriptBodies).toHaveLength(0);
  await expect(page.getByText(/listening — waiting for “over”/iu)).toBeVisible();
  await completeTranscript(page, 'chunk-cue', 'OvEr!!!', false);
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  expect(fixture.transcriptBodies[0]).toMatchObject({ providerItemId: 'chunk-cue', text: 'Please inspect go over the changes and verify rollover behavior' });
  await completeTranscript(page, 'chunk-cue', 'OvEr!!!', false);
  await page.waitForTimeout(50);
  expect(fixture.transcriptBodies).toHaveLength(1);
});

test('clears the whole unfinished turn when a later chunk fails or has no transcript', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'partial-before-failure', 'Commit these changes', false);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'failed-later-chunk' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'failed-later-chunk'))).toBe(true);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'failed-later-chunk' }) })));
  await expect(page.getByRole('alert')).toHaveText('Davo could not transcribe that turn. Please say it again, ending with “over”.');
  await completeTranscript(page, 'cue-after-failure', 'over', false);
  await page.waitForTimeout(50);
  expect(fixture.transcriptBodies).toHaveLength(0);
  await completeTranscript(page, 'partial-before-missing', 'Review but do not push', false);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'missing-later-chunk' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'missing-later-chunk'))).toBe(true);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'missing-later-chunk' }) })));
  await expect(page.getByRole('alert')).toHaveText('Davo could not transcribe that turn. Please say it again, ending with “over”.');
  await completeTranscript(page, 'cue-after-missing', 'over', false);
  await page.waitForTimeout(50);
  expect(fixture.transcriptBodies).toHaveLength(0);
});

test('accepts a same-chunk over cue but ignores an empty cue', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'empty-cue', 'over.', false);
  await page.waitForTimeout(50);
  expect(fixture.transcriptBodies).toHaveLength(0);
  await completeTranscript(page, 'same-chunk', 'Review this branch.OvEr?!', false);
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  expect(fixture.transcriptBodies[0]).toMatchObject({ providerItemId: 'same-chunk', text: 'Review this branch.' });
});

test('clears unfinished speech on mute and requires over after exact-name wake', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'discarded-before-mute', 'Do not retain this', false);
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await completeTranscript(page, 'wake-after-clear', 'Davo.', false);
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeVisible();
  await completeTranscript(page, 'empty-after-wake', 'over', false);
  await page.waitForTimeout(50);
  expect(fixture.transcriptBodies).toHaveLength(0);
  await completeTranscript(page, 'fresh-after-wake', 'Handle only this request over.', false);
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  expect(fixture.transcriptBodies[0]).toMatchObject({ providerItemId: 'fresh-after-wake', text: 'Handle only this request' });
});

test('discards speech invalidated before its delete acknowledgement', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'pre-mute-delete' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'pre-mute-delete' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'pre-mute-delete', transcript: 'Never retain this' }) }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'pre-mute-delete'))).toBe(true);
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await page.getByRole('button', { name: 'Muted — say Davo', exact: true }).click();
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'pre-mute-delete' }) })));
  await completeTranscript(page, 'pre-mute-empty-cue', 'over', false);
  await page.waitForTimeout(50);
  expect(fixture.transcriptBodies).toHaveLength(0);
  await completeTranscript(page, 'post-mute-fresh', 'Use this instead over.', false);
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  expect(fixture.transcriptBodies[0]).toMatchObject({ providerItemId: 'post-mute-fresh', text: 'Use this instead' });
});

test('clears unfinished speech when the transport is replaced', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'discarded-before-close', 'Do not carry this', false);
  await page.evaluate(() => Object.assign(window, { oldDavoChannel: (window as unknown as { davoChannel: EventTarget }).davoChannel }));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  await page.getByRole('button', { name: 'Open listening' }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { davoChannel?: EventTarget; oldDavoChannel?: EventTarget };
    return state.davoChannel !== undefined && state.davoChannel !== state.oldDavoChannel;
  })).toBe(true);
  await completeReadiness(page, 'provider-session-2', 'readiness-response-2', 'mcp-list-2', ['delegate_request', 'select_worktree']);
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeEnabled();
  await completeTranscript(page, 'successor-empty-cue', 'over', false);
  await page.waitForTimeout(50);
  expect(fixture.transcriptBodies).toHaveLength(0);
});

test('clears and reports a spoken turn above the transcript budget', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'oversized-turn', 'x'.repeat(12 * 1_024 + 1), false);
  await expect(page.getByRole('alert')).toHaveText('That turn was too long. Please say it again more briefly, ending with “over”.');
  await completeTranscript(page, 'oversized-cue', 'over', false);
  await page.waitForTimeout(50);
  expect(fixture.transcriptBodies).toHaveLength(0);
});

// deliver provider events in their original transport order
async function providerEvents(page: import('@playwright/test').Page, events: unknown[]): Promise<void> {
  await page.evaluate(values => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    // deliver each exact fixture event
    for (const value of values) channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }, events);
}

// model the documented asynchronous remote tool item without invented status fields
function mcpItem(id: string, output?: string) {
  return { id, type: 'mcp_call', name: 'list_worktrees', arguments: '{}', server_label: 'rac', ...(output === undefined ? {} : { output }) };
}

test('refreshes one persisted activity row across MCP phases without speaking it', async ({ page }) => {
  const now = new Date();
  const activity: ConversationActivity = { working: false, messages: [] };
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { conversation: () => activity });
  await expect(page.locator('.voice-status-line')).toHaveCount(0);
  await completeTranscript(page, 'activity-request', 'Read the notes');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await providerEvents(page, [{ type: 'response.created', response: { id: 'activity-response' } }]);
  await expect.poll(() => fixture.bindBodies.length).toBe(1);

  activity.working = true;
  activity.messages = [{ id: 'activity-row', sequence: 1, kind: 'status', text: 'Reading notes...', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3_600_000).toISOString() }];
  await providerEvents(page, [{ type: 'response.output_item.added', response_id: 'activity-response', item: mcpItem('activity-call') }]);
  const row = page.locator('.voice-status-line', { hasText: 'Reading notes...' });
  await expect(row).toBeVisible();
  await row.evaluate(element => { element.setAttribute('data-same-call', 'true'); });

  activity.messages = [{ ...activity.messages[0]!, text: 'Read notes.' }];
  await providerEvents(page, [{ type: 'response.mcp_call.completed', item_id: 'activity-call', output_index: 0 }]);
  await expect(page.locator('.voice-status-line', { hasText: 'Read notes.' })).toHaveAttribute('data-same-call', 'true');
  const spoken = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => (JSON.stringify(event.response) ?? '').includes('Reading notes') || (JSON.stringify(event.response) ?? '').includes('Read notes')));
  expect(spoken).toEqual([]);
});

// prove both valid completion orders keep the original admitted request alive
for (const toolFirst of [false, true]) {
  test(`continues a remote MCP result when tools finish ${toolFirst ? 'before' : 'after'} response.done`, async ({ page }) => {
    const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
    await expect.poll(() => fixture.readyBodies.length).toBe(1);
    await completeTranscript(page, 'worktree-status', "What's the status of all my worktrees?");
    await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
    await providerEvents(page, [{ type: 'response.created', response: { id: 'status-response' } }]);
    await expect.poll(() => fixture.bindBodies.length).toBe(1);
    await providerEvents(page, [
      { type: 'response.output_item.added', response_id: 'status-response', item: mcpItem('mcp-status') },
      { type: 'response.output_audio_transcript.delta', response_id: 'status-response', delta: "I'll take a look across your worktrees." }
    ]);
    const done = { type: 'response.done', response: { id: 'status-response', status: 'completed', output: [mcpItem('mcp-status')] } };
    const terminal = [
      { type: 'response.mcp_call.completed', item_id: 'mcp-status', output_index: 1 },
      { type: 'response.output_item.done', response_id: 'status-response', item: mcpItem('mcp-status', '{"worktrees":["Cora"]}') }
    ];
    await providerEvents(page, toolFirst ? terminal : [done]);
    await page.waitForTimeout(50);
    expect(fixture.mcpBodies).toHaveLength(0);
    expect(fixture.assistantBodies).toHaveLength(toolFirst ? 0 : 1);
    expect(fixture.finishBodies).toHaveLength(0);
    await providerEvents(page, toolFirst ? [done] : terminal);
    await expect.poll(() => fixture.mcpBodies.length).toBe(1);
    expect(fixture.mcpBodies[0]).toMatchObject({ turnId: 'turn-old', responseId: 'status-response', generation: 4, itemIds: ['mcp-status'] });
    await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.response?.metadata?.fixture_mcp === 1))).toBe(true);
    // duplicate terminal callbacks cannot repeat a server continuation
    await providerEvents(page, terminal);
    await providerEvents(page, [{ type: 'response.created', response: { id: 'status-answer' } }]);
    await expect.poll(() => fixture.bindBodies.length).toBe(2);
    await providerEvents(page, [
      { type: 'response.output_audio_transcript.delta', response_id: 'status-answer', delta: 'Cora is ready. Here is the worktree status.' },
      { type: 'response.done', response: { id: 'status-answer', status: 'completed', output: [] } }
    ]);
    await expect.poll(() => fixture.finishBodies.length).toBe(1);
    expect(fixture.mcpBodies).toHaveLength(1);
    expect(fixture.assistantBodies).toEqual([
      expect.objectContaining({ responseId: 'status-response', text: "I'll take a look across your worktrees." }),
      expect.objectContaining({ responseId: 'status-answer', text: 'Cora is ready. Here is the worktree status.' })
    ]);
  });
}

test('waits for every remote call and continues failed calls as evidence instead of success', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'multiple-tools', 'Inspect all worktrees');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await providerEvents(page, [{ type: 'response.created', response: { id: 'multiple-response' } }]);
  await expect.poll(() => fixture.bindBodies.length).toBe(1);
  await providerEvents(page, [
    { type: 'response.output_item.added', response_id: 'multiple-response', item: mcpItem('mcp-one') },
    { type: 'response.output_item.added', response_id: 'multiple-response', item: mcpItem('mcp-two') },
    { type: 'response.done', response: { id: 'multiple-response', status: 'completed', output: [mcpItem('mcp-one'), mcpItem('mcp-two')] } },
    { type: 'response.mcp_call.completed', item_id: 'mcp-one', output_index: 0 },
    { type: 'response.output_item.done', response_id: 'multiple-response', item: mcpItem('mcp-one', 'Cora is ready') },
    { type: 'response.mcp_call.completed', item_id: 'unrelated-item', output_index: 1 }
  ]);
  await page.waitForTimeout(50);
  expect(fixture.mcpBodies).toHaveLength(0);
  expect(fixture.finishBodies).toHaveLength(0);
  // a terminal failure alone cannot reference a result item that has not finalized
  await providerEvents(page, [{ type: 'response.mcp_call.failed', item_id: 'mcp-two', output_index: 1 }]);
  await page.waitForTimeout(50);
  expect(fixture.mcpBodies).toHaveLength(0);
  await providerEvents(page, [{ type: 'response.output_item.done', response_id: 'multiple-response', item: { ...mcpItem('mcp-two'), error: { message: 'Tool unavailable' } } }]);
  await expect.poll(() => fixture.mcpBodies.length).toBe(1);
  expect(fixture.mcpBodies[0]).toMatchObject({ itemIds: ['mcp-one', 'mcp-two'] });
  expect(fixture.assistantBodies).toHaveLength(0);
  // a follow-up can need another tool round before answering the original request
  await providerEvents(page, [{ type: 'response.created', response: { id: 'second-tool-round' } }]);
  await expect.poll(() => fixture.bindBodies.length).toBe(2);
  await providerEvents(page, [
    { type: 'response.output_item.added', response_id: 'second-tool-round', item: mcpItem('mcp-three') },
    { type: 'response.mcp_call.completed', item_id: 'mcp-three', output_index: 0 },
    { type: 'response.output_item.done', response_id: 'second-tool-round', item: mcpItem('mcp-three', 'Owen is busy') },
    { type: 'response.done', response: { id: 'second-tool-round', status: 'completed', output: [mcpItem('mcp-three')] } }
  ]);
  await expect.poll(() => fixture.mcpBodies.length).toBe(2);
  expect(fixture.mcpBodies[1]).toMatchObject({ turnId: 'turn-old', responseId: 'second-tool-round', itemIds: ['mcp-three'] });
});

test('does not send an old MCP continuation through a ready successor', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { deferMcp: true, deferredLatencyMs: 75 });
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'old-mcp', 'Inspect the worktree');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await providerEvents(page, [{ type: 'response.created', response: { id: 'old-mcp-response' } }]);
  await expect.poll(() => fixture.bindBodies.length).toBe(1);
  await providerEvents(page, [
    { type: 'response.output_item.added', response_id: 'old-mcp-response', item: mcpItem('old-mcp-item') },
    { type: 'response.done', response: { id: 'old-mcp-response', status: 'completed' } },
    { type: 'response.mcp_call.completed', item_id: 'old-mcp-item', output_index: 0 },
    { type: 'response.output_item.done', response_id: 'old-mcp-response', item: mcpItem('old-mcp-item', 'Ready') }
  ]);
  await expect.poll(() => fixture.mcpBodies.length).toBe(1);
  await page.evaluate(() => Object.assign(window, { oldDavoChannel: (window as unknown as { davoChannel: EventTarget }).davoChannel }));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Open listening' }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { davoChannel: EventTarget; oldDavoChannel: EventTarget };
    return state.davoChannel !== state.oldDavoChannel;
  })).toBe(true);
  await completeReadiness(page, 'provider-session-2', 'readiness-response-2', 'mcp-list-2', ['delegate_request', 'select_worktree']);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  fixture.releaseMcp();
  await expect.poll(() => fixture.settledMcps()).toBe(1);
  await completeTranscript(page, 'new-after-old-mcp', 'Continue in the successor');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.fixture_admission === 'new'))).toBe(true);
  const stale = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.cancel' || event.response?.metadata?.fixture_mcp !== undefined));
  expect(stale).toEqual([]);
  expect(fixture.stopBodies).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
});

test('shows a rejected MCP continuation without claiming completion or retrying', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { mcpStatus: 503 });
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'failed-continuation', 'Inspect the worktree');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await providerEvents(page, [{ type: 'response.created', response: { id: 'failed-response' } }]);
  await expect.poll(() => fixture.bindBodies.length).toBe(1);
  await providerEvents(page, [
    { type: 'response.output_item.added', response_id: 'failed-response', item: mcpItem('failed-item') },
    { type: 'response.mcp_call.failed', item_id: 'failed-item', output_index: 0 },
    { type: 'response.output_item.done', response_id: 'failed-response', item: { ...mcpItem('failed-item'), error: { message: 'Tool unavailable' } } },
    { type: 'response.done', response: { id: 'failed-response', status: 'completed' } }
  ]);
  await expect(page.getByRole('alert')).toHaveText('Davo could not finish reading the tool results. Reopen listening to try again.');
  await expect(page.getByRole('button', { name: 'Open listening' })).toBeVisible();
  expect(fixture.mcpBodies).toHaveLength(1);
  expect(fixture.assistantBodies).toHaveLength(0);
  expect(fixture.finishBodies).toHaveLength(0);
});

test('shows a stalled remote tool without silently retrying the request', async ({ page }) => {
  await page.clock.install();
  // isolate the tool budget from the independently tested lease-expiry guard
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { leaseMilliseconds: 180_000 });
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'stalled-mcp', 'Inspect the worktree');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await providerEvents(page, [{ type: 'response.created', response: { id: 'stalled-response' } }]);
  await expect.poll(() => fixture.bindBodies.length).toBe(1);
  await providerEvents(page, [
    { type: 'response.output_item.added', response_id: 'stalled-response', item: mcpItem('stalled-item') },
    { type: 'response.done', response: { id: 'stalled-response', status: 'completed' } }
  ]);
  await page.clock.fastForward(120_001);
  await expect(page.getByRole('alert')).toHaveText('Davo is still waiting for a tool result. Reopen listening to check its status.');
  expect(fixture.mcpBodies).toHaveLength(0);
  expect(fixture.assistantBodies).toHaveLength(0);
  expect(fixture.finishBodies).toHaveLength(0);
  expect(fixture.openBodies).toHaveLength(1);
});

test('shows the remote tool capacity limit instead of silently reconnecting', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'over-capacity', 'Inspect the worktree');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await providerEvents(page, [{ type: 'response.created', response: { id: 'capacity-response' } }]);
  await expect.poll(() => fixture.bindBodies.length).toBe(1);
  await providerEvents(page, Array.from({ length: 17 }, (_, index) => ({ type: 'response.output_item.added', response_id: 'capacity-response', item: mcpItem(`capacity-${index}`) })));
  await expect(page.getByRole('alert')).toHaveText('Davo reached the tool continuation limit. Reopen listening to continue.');
  expect(fixture.mcpBodies).toHaveLength(0);
  expect(fixture.assistantBodies).toHaveLength(0);
  expect(fixture.openBodies).toHaveLength(1);
});

// preserve server cleanup authority without retaining local audio authority
test('retires only the captured peer after server hangup while capture stops immediately', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { deferStop: true });
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  await page.evaluate(() => Object.assign(window, { retiringChannel: (window as unknown as { davoChannel: EventTarget }).davoChannel, retiringPeer: (window as unknown as { davoPeer: EventTarget }).davoPeer }));
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { retiringChannel: { readyState: string } }).retiringChannel.readyState)).toBe('open');
  expect(await page.evaluate(() => (window as unknown as { retiringPeer: { connectionState: string } }).retiringPeer.connectionState)).not.toBe('closed');
  // an open old channel still has no admission authority
  await page.evaluate(() => (window as unknown as { retiringChannel: EventTarget }).retiringChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late-retired', transcript: 'Never admit this retired input' }) })));
  await page.getByRole('button', { name: 'Open listening' }).click();
  // deliver readiness only after the successor channel actually exists
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: EventTarget; retiringChannel: EventTarget }).davoChannel !== (window as unknown as { retiringChannel: EventTarget }).retiringChannel)).toBe(true);
  await completeReadiness(page, 'provider-session-2', 'readiness-response-2', 'mcp-list-2', ['delegate_request', 'select_worktree']);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  fixture.releaseStop();
  await expect.poll(() => page.evaluate(() => (window as unknown as { retiringChannel: { readyState: string } }).retiringChannel.readyState)).toBe('closed');
  expect(await page.evaluate(() => (window as unknown as { retiringPeer: { connectionState: string } }).retiringPeer.connectionState)).toBe('closed');
  expect(await page.evaluate(() => (window as unknown as { davoChannel: { readyState: string } }).davoChannel.readyState)).toBe('open');
  expect(fixture.transcriptBodies).toEqual([]);
  expect(fixture.openBodies).toHaveLength(2);
});

// preserve the safety fence after an uncertain hangup
test('does not reopen automatically after server cleanup fails', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { stopStatus: 503 });
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  // trigger an exact transport rotation without a raw item identity
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed' }) })));
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  await page.waitForTimeout(100);
  expect(fixture.openBodies).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as { davoChannel: { readyState: string } }).davoChannel.readyState)).toBe('closed');
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(true);
});

// bound transport retention even when the cleanup receipt never arrives
test('retires a stopped peer when exact cleanup times out', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { deferStop: true });
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  // trigger rotation while the server receipt remains pending
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed' }) })));
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { readyState: string } }).davoChannel.readyState), { timeout: 25_000 }).toBe('closed');
  expect(fixture.openBodies).toHaveLength(1);
  fixture.releaseStop();
});

test('deletes every raw item after readiness and keeps muted microphone transport enabled', async ({ page }) => {
  await installMedia(page);
  const transcriptBodies: unknown[] = [];
  const assistantBodies: Array<Record<string, unknown>> = [];
  const finishBodies: unknown[] = [];
  const readyBodies: unknown[] = [];
  const stopBodies: unknown[] = [];
  let backgroundPhase = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one authenticated dashboard
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'davo-csrf', active: true, deviceName: 'Test browser', davo: enabledDavo, server: { name: 'Framework', url: 'https://framework.example', remotes: [] } } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // authorize one shared pane stream
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/davo/conversation') return route.fulfill({ json: { conversationId: 'conversation-1', generation: 4, revision: '11111111-1111-4111-8111-111111111111', retainedFrom: '2026-11-03T08:00:00.000Z', serverNow: new Date().toISOString(), retentionCutoffAt: new Date(Date.now() + 3_600_000).toISOString(), nextSequence: 2 + backgroundPhase, hasMore: false, pendingChoices: [], messages: [{ id: 'baseline-message', sequence: 1, kind: 'status', text: 'Listening ready', createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, ...(backgroundPhase >= 1 ? [{ id: 'failed-background-message', sequence: 2, kind: 'assistant', text: 'Dropped projection update', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }] : []), ...(backgroundPhase >= 2 ? [{ id: 'background-message', sequence: 3, kind: 'assistant', text: 'A retained background update', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }] : []), ...(backgroundPhase >= 3 ? [{ id: 'completed-background-message', sequence: 4, kind: 'assistant', text: 'A completed retained update', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }] : [])] } });
    // create one server-owned pending negotiation
    if (url.pathname === '/api/realtime/session') return route.fulfill({ json: { negotiationId: 'negotiation-1', model: 'gpt-realtime-2.1', conversationId: 'conversation-1', generation: 4, contextRevision: '22222222-2222-4222-8222-222222222222', serverNow: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), retentionCutoffAt: new Date(Date.now() + 3_600_000).toISOString() } });
    if (url.pathname === '/api/realtime/negotiate') return route.fulfill({ json: { sdp: 'fixture-answer', generation: 4, readinessId: 'readiness-1', readinessResponse: { conversation: 'none', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Retained context seed' }] }], instructions: 'Return READY only; no tools', tools: [{ type: 'mcp', server_label: 'rac', allowed_tools: ['delegate_request', 'select_worktree'] }, { type: 'function', name: 'select_worktree' }], tool_choice: 'none', output_modalities: ['text'], max_output_tokens: 256, metadata: { davo_phase: 'readiness', readiness_id: 'readiness-1' } } } });
    if (url.pathname === '/api/davo/session/ready') { readyBodies.push(request.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/api/realtime/session/heartbeat') return route.fulfill({ json: { serverNow: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
    if (url.pathname === '/api/realtime/session/stop') { stopBodies.push(request.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    if (url.pathname === '/api/davo/transcripts/user') {
      transcriptBodies.push(request.postDataJSON());
      return route.fulfill({ json: { messageId: 'message-1', turnId: 'turn-1', generation: 4, response: { conversation: 'none', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'retained projection' }] }], tools: [], instructions: 'fixture', output_modalities: ['audio'] } } });
    }
    if (url.pathname === '/api/davo/transcripts/assistant') {
      assistantBodies.push(request.postDataJSON() as Record<string, unknown>);
      // force one ambiguous pair before exact retry reconciliation
      if (assistantBodies.length <= 2) return route.fulfill({ status: 503, json: { error: 'davo_store_unavailable' } });
      return route.fulfill({ json: { id: `assistant-${assistantBodies.length}` } });
    }
    if (url.pathname === '/api/davo/responses/bind') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/davo/responses/finish') { finishBodies.push(request.postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open Davo' }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { davoChannel?: EventTarget }).davoChannel))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { enabled: boolean } }).davoTrack.enabled)).toBe(false);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.created', session: { id: 'provider-session-1' } }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.davo_phase === 'readiness'))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { enabled: boolean } }).davoTrack.enabled)).toBe(false);
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    const item = { id: 'mcp-list-1', type: 'mcp_list_tools', server_label: 'rac', tools: [{ name: 'delegate_request' }, { name: 'select_worktree' }] };
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'mcp_list_tools.in_progress' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'mcp_list_tools.completed', item_id: 'mcp-list-1' }) }));
    // stage the official import item before response.created
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.output_item.done', response_id: 'readiness-response-1', item }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'readiness-response-1', metadata: { davo_phase: 'readiness', readiness_id: 'readiness-1' } } }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done', response: { id: 'readiness-response-1', status: 'completed' } }) }));
  });
  await expect.poll(() => readyBodies.length).toBe(1);
  expect(readyBodies[0]).toMatchObject({ generation: 4, readinessId: 'readiness-1', responseId: 'readiness-response-1', importedTools: ['delegate_request', 'select_worktree'] });
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();

  const mute = page.getByRole('button', { name: 'Mute' });
  await mute.click();
  await expect(page.getByRole('button', { name: 'Muted — say Davo' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { enabled: boolean } }).davoTrack.enabled)).toBe(true);

  // ambient muted speech is deleted and never admitted
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'ambient-1', transcript: 'unrelated room speech' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'ambient-1'))).toBe(true);
  expect(transcriptBodies).toHaveLength(0);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'ambient-1' }) })));
  await page.waitForTimeout(20);
  expect(transcriptBodies).toHaveLength(0);

  // assistant name echo during output cannot wake muted listening
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.started' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'echo-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'echo-1', transcript: 'Davo' }) }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'echo-1'))).toBe(true);
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'echo-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.stopped' }) }));
  });
  await expect(page.getByRole('button', { name: 'Muted — say Davo' })).toBeVisible();
  expect(transcriptBodies).toHaveLength(0);

  // exact-name wake is deleted and only changes logical mute
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'wake-1', transcript: 'Davo.' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'wake-1'))).toBe(true);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'wake-1' }) })));
  await expect(mute).toBeVisible();
  expect(transcriptBodies).toHaveLength(0);

  // output beginning after speech start also discards that raw item
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'reverse-overlap-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.started' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'reverse-overlap-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'reverse-overlap-1', transcript: 'Approve the reverse overlap' }) }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'reverse-overlap-1'))).toBe(true);
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'reverse-overlap-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.stopped' }) }));
  });
  await page.waitForTimeout(20);
  expect(transcriptBodies).toHaveLength(0);

  // overlapped user speech is deleted but never admitted
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.started' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'overlap-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'overlap-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'overlap-1', transcript: 'Approve the change' }) }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'overlap-1'))).toBe(true);
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'overlap-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.stopped' }) }));
  });
  await page.waitForTimeout(20);
  expect(transcriptBodies).toHaveLength(0);

  // unmuted speech is admitted only after delete acknowledgement
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'request-1', transcript: 'Check the current work over' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'request-1'))).toBe(true);
  expect(transcriptBodies).toHaveLength(0);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'request-1' }) })));
  await expect.poll(() => transcriptBodies.length).toBe(1);
  expect(transcriptBodies[0]).toMatchObject({ generation: 4, providerSessionId: 'provider-session-1', providerItemId: 'request-1', text: 'Check the current work' });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create'))).toBe(true);

  // rapid second input is quarantined while the first turn remains active
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'rapid-1', transcript: 'Approve something else over' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'rapid-1'))).toBe(true);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'rapid-1' }) })));
  await page.waitForTimeout(20);
  expect(transcriptBodies).toHaveLength(1);

  // bind and persist foreground speech before retiring its exact turn
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'foreground-1' } }) })));
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.output_audio_transcript.delta', response_id: 'foreground-1', delta: 'Durable answer' }) })));
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done', response: { id: 'foreground-1', status: 'completed' } }) })));
  await expect.poll(() => assistantBodies.length).toBe(2);
  expect(finishBodies).toHaveLength(0);
  await expect.poll(() => assistantBodies.length).toBe(3);
  await expect.poll(() => finishBodies.length).toBe(1);
  expect(assistantBodies).toHaveLength(3);
  expect(assistantBodies.every(body => body.responseId === 'foreground-1' && body.text === 'Durable answer')).toBe(true);

  // a failed projected send clears its latch for a later retained reply
  await page.evaluate(() => { (window as unknown as { davoChannel: { readyState: RTCDataChannelState } }).davoChannel.readyState = 'closed'; });
  backgroundPhase = 1;
  await expect(page.getByText('Dropped projection update')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(50);
  await page.evaluate(() => { (window as unknown as { davoChannel: { readyState: RTCDataChannelState } }).davoChannel.readyState = 'open'; });
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started', item_id: 'projection-blocker' }) })));
  backgroundPhase = 2;
  await expect(page.getByText('A retained background update')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.create' && JSON.stringify(event.response).includes('Speak this update exactly once')).length)).toBe(0);
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'projection-blocker' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'projection-blocker' }) }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'projection-blocker'))).toBe(true);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'projection-blocker' }) })));
  // project a later retained reply and keep it active through response.created
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.create' && JSON.stringify(event.response).includes('Speak this update exactly once')).length), { timeout: 5_000 }).toBe(1);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'projection-1' } }) })));
  const workStatus = page.getByRole('status');
  await expect(workStatus).toHaveText('Working...');

  // new unfinished input cancels projected speech without starting work
  await completeTranscript(page, 'request-2', 'Start the next task', false);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.cancel' && event.response_id === 'projection-1'))).toBe(true);
  expect(transcriptBodies).toHaveLength(1);
  await page.getByRole('button', { name: 'Mute', exact: true }).click();
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.output_audio_transcript.delta', response_id: 'projection-1', delta: 'stale projection text' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done', response: { id: 'projection-1', status: 'cancelled' } }) }));
  });
  await expect(workStatus).toHaveText('Waiting for instructions...');
  expect(transcriptBodies).toHaveLength(1);
  await expect(page.getByRole('dialog', { name: 'Davo' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { davoChannel: { readyState: RTCDataChannelState } }).davoChannel.readyState)).toBe('open');
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(false);
  await completeTranscript(page, 'request-2-wake', 'Davo.', false);
  await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeVisible();
  await completeTranscript(page, 'request-2-over', 'over', false);
  await page.waitForTimeout(50);
  expect(transcriptBodies).toHaveLength(1);
  await completeTranscript(page, 'request-2-fresh', 'Start the next task over.', false);
  await expect.poll(() => transcriptBodies.length).toBe(2);

  // stale projection deltas cannot contaminate the new foreground final
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'foreground-2' } }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.output_audio_transcript.delta', response_id: 'projection-1', delta: 'wrong text' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.output_audio_transcript.delta', response_id: 'foreground-2', delta: 'Exact next answer' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done', response: { id: 'foreground-2', status: 'completed' } }) }));
  });
  await expect.poll(() => finishBodies.length).toBe(2);
  expect(assistantBodies.at(-1)).toMatchObject({ responseId: 'foreground-2', text: 'Exact next answer' });
  await expect(workStatus).toHaveText('Waiting for instructions...');

  // completed projections release work without closing the listening surface
  backgroundPhase = 3;
  await expect(page.getByText('A completed retained update')).toBeVisible({ timeout: 5_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.create' && JSON.stringify(event.response).includes('Speak this update exactly once')).length), { timeout: 5_000 }).toBe(2);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'projection-2' } }) })));
  await expect(workStatus).toHaveText('Working...');
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done', response: { id: 'projection-2', status: 'completed' } }) })));
  await expect(workStatus).toHaveText('Waiting for instructions...');
  await expect(page.getByRole('dialog', { name: 'Davo' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { davoChannel: { readyState: RTCDataChannelState } }).davoChannel.readyState)).toBe('open');
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(false);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => stopBodies.length).toBe(1);
  expect(stopBodies[0]).toMatchObject({ generation: 4, voiceSessionId: expect.any(String) });
});

test('accepts the conversation readiness surface without repeating the audio lifecycle', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [{ surface: 'response.output_item.done', tools: ['delegate_request', 'select_worktree'] }]);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  expect(fixture.readyBodies[0]).toMatchObject({ importedTools: ['delegate_request', 'select_worktree'] });
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
});

for (const invalid of [
  { name: 'extra', tools: ['delegate_request', 'select_worktree', 'raw_mutation'], extraItems: [] },
  { name: 'duplicate', tools: ['delegate_request', 'select_worktree', 'delegate_request'], extraItems: [] },
  { name: 'conflicting', tools: ['delegate_request', 'select_worktree'], extraItems: [{ surface: 'response.output_item.done' as const, tools: ['delegate_request', 'raw_mutation'] }] },
  { name: 'a second item with forbidden tools', tools: ['delegate_request', 'select_worktree'], extraItems: [{ id: 'mcp-list-2', surface: 'response.output_item.done' as const, tools: ['delegate_request', 'select_worktree', 'raw_mutation'] }] },
  { name: 'a second item with an identical catalog', tools: ['delegate_request', 'select_worktree'], extraItems: [{ id: 'mcp-list-2', surface: 'response.output_item.done' as const, tools: ['delegate_request', 'select_worktree'] }] }
]) {
  test(`rejects ${invalid.name} provider readiness imports`, async ({ page }) => {
    const fixture = await openReadinessFixture(page, invalid.tools, invalid.extraItems);
    await expect(page.getByText('Davo provider readiness failed.')).toBeVisible();
    expect(fixture.readyBodies).toHaveLength(0);
    expect(await page.evaluate(() => (window as unknown as { davoTrack: { enabled: boolean } }).davoTrack.enabled)).toBe(false);
    await expect.poll(() => fixture.stopBodies.length).toBe(1);
  });
}

test('does not run an old queued reopen after a successor starts', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  await page.evaluate(() => {
    const original = window.setTimeout.bind(window);
    let heldReopen: (() => void) | undefined;
    Object.assign(window, {
      hasHeldQueuedReopen: false,
      releaseQueuedReopen: () => {
        const reopen = heldReopen;
        heldReopen = undefined;
        // release only the captured reopen through the installed clock
        if (reopen !== undefined) original(reopen, 0);
      }
    });
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...arguments_: unknown[]) => {
      // hold only the first queued zero-delay reopen
      if (timeout === 0 && heldReopen === undefined && typeof handler === 'function') {
        heldReopen = () => handler(...arguments_);
        Object.assign(window, { hasHeldQueuedReopen: true });
        return 1;
      }
      return original(handler, timeout, ...arguments_);
    }) as typeof window.setTimeout;
  });
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed' }) })));
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { hasHeldQueuedReopen: boolean }).hasHeldQueuedReopen)).toBe(true);
  await expect(page.getByRole('button', { name: 'Open listening' })).toBeEnabled();
  await page.evaluate(() => Object.assign(window, { oldDavoChannel: (window as unknown as { davoChannel: EventTarget }).davoChannel }));
  await page.getByRole('button', { name: 'Open listening' }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { davoChannel?: EventTarget; oldDavoChannel?: EventTarget };
    return state.davoChannel !== undefined && state.davoChannel !== state.oldDavoChannel;
  })).toBe(true);
  await page.evaluate(() => {
    const successor = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    successor.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.created', session: { id: 'provider-session-2' } }) }));
  });
  expect(fixture.openBodies).toHaveLength(2);
  await page.clock.runFor(1);
  expect(await page.evaluate(() => (window as unknown as { davoChannel: { readyState: RTCDataChannelState } }).davoChannel.readyState)).toBe('open');
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new Event('open')));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.davo_phase === 'readiness'))).toBe(true);
  await completeReadiness(page, 'provider-session-2', 'readiness-response-2', 'mcp-list-2', ['delegate_request', 'select_worktree']);
  await page.clock.runFor(20);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  await page.evaluate(() => Object.assign(window, { successorDavoChannel: (window as unknown as { davoChannel: EventTarget }).davoChannel }));
  await page.evaluate(() => (window as unknown as { releaseQueuedReopen: () => void }).releaseQueuedReopen());
  await page.clock.runFor(1);
  expect(fixture.openBodies).toHaveLength(2);
  expect(fixture.stopBodies).toHaveLength(1);
  expect(await page.evaluate(() => {
    const state = window as unknown as { davoChannel?: EventTarget; successorDavoChannel?: EventTarget };
    return state.davoChannel === state.successorDavoChannel;
  })).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { davoChannel: { readyState: RTCDataChannelState } }).davoChannel.readyState)).toBe('open');
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  const staleCommands = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.cancel'));
  expect(staleCommands).toEqual([]);
});

test('does not rotate a ready successor when an old deletion wait expires', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-delete-wait', transcript: 'Old request' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'old-delete-wait'))).toBe(true);
  await page.evaluate(() => Object.assign(window, { oldDavoChannel: (window as unknown as { davoChannel: EventTarget }).davoChannel }));
  await page.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  await page.getByRole('button', { name: 'Open listening' }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { davoChannel?: EventTarget; oldDavoChannel?: EventTarget };
    return state.davoChannel !== undefined && state.davoChannel !== state.oldDavoChannel;
  })).toBe(true);
  await completeReadiness(page, 'provider-session-2', 'readiness-response-2', 'mcp-list-2', ['delegate_request', 'select_worktree']);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  await page.waitForTimeout(4_200);
  expect(fixture.stopBodies).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
});

test('does not send an old worktree continuation through a ready successor', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { deferContinuation: true, includeWorktree: true, deferredLatencyMs: 75 });
  const fallbackRelease = setTimeout(fixture.releaseContinuation, 8_000);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'old-continuation', 'Switch worktrees');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.fixture_admission === 'old'))).toBe(true);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'foreground-old' } }) })));
  await expect.poll(() => fixture.bindBodies.length).toBe(1);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', name: 'select_worktree', response_id: 'foreground-old', call_id: 'call-old', arguments: JSON.stringify({ worktree_id: 'cora' }) }) })));
  await expect.poll(() => fixture.continueBodies.length).toBe(1);
  await page.evaluate(() => Object.assign(window, { oldDavoChannel: (window as unknown as { davoChannel: EventTarget }).davoChannel }));
  await page.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  await page.getByRole('button', { name: 'Open listening' }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { davoChannel?: EventTarget; oldDavoChannel?: EventTarget };
    return state.davoChannel !== undefined && state.davoChannel !== state.oldDavoChannel;
  })).toBe(true);
  await completeReadiness(page, 'provider-session-2', 'readiness-response-2', 'mcp-list-2', ['delegate_request', 'select_worktree']);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  clearTimeout(fallbackRelease);
  fixture.releaseContinuation();
  await expect.poll(() => fixture.settledContinuations()).toBe(1);
  await completeTranscript(page, 'new-after-old-continuation', 'Continue after the worktree switch');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.fixture_admission === 'new'))).toBe(true);
  const staleCommands = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.cancel' || event.type === 'response.create' && event.response?.metadata?.fixture_continuation === 'old'));
  expect(staleCommands).toEqual([]);
  expect(fixture.stopBodies).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
});

// reject either official pending admission representation
for (const pending of [
  { name: 'http 202', admission: 'pending-202' as const },
  { name: 'pending body', admission: 'pending-body' as const }
]) {
  test(`stops listening without inference for a ${pending.name} admission`, async ({ page }) => {
    const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { admission: pending.admission });
    await expect.poll(() => fixture.readyBodies.length).toBe(1);
    await completeTranscript(page, `pending-${pending.admission}`, 'Wait for storage');
    await expect(page.getByText('Davo storage is recovering. Try again shortly.')).toBeVisible();
    await expect.poll(() => fixture.stopBodies.length).toBe(1);
    expect(fixture.stopBodies[0]).toMatchObject({ generation: 4, voiceSessionId: expect.any(String) });
    await page.waitForTimeout(100);
    expect(fixture.transcriptBodies).toHaveLength(1);
    expect(fixture.bindBodies).toHaveLength(0);
    expect(fixture.assistantBodies).toHaveLength(0);
    expect(await page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(true);
    const foregroundResponses = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.create' && event.response?.metadata?.davo_phase !== 'readiness'));
    expect(foregroundResponses).toEqual([]);
  });
}

test('stops without inference when the exact receipt retry returns pending', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { admission: 'retry-pending' });
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'retry-pending', 'Wait for retry storage');
  await expect(page.getByText('Davo storage is recovering. Try again shortly.')).toBeVisible();
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  expect(fixture.transcriptBodies).toHaveLength(2);
  expect(fixture.bindBodies).toHaveLength(0);
  expect(fixture.assistantBodies).toHaveLength(0);
  const foregroundResponses = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.create' && event.response?.metadata?.davo_phase !== 'readiness'));
  expect(foregroundResponses).toEqual([]);
});

test('does not stop a successor when an old pending admission resolves', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { admission: 'pending-202', deferFirstAdmission: true, deferredLatencyMs: 75 });
  const fallbackRelease = setTimeout(fixture.releaseAdmission, 8_000);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await completeTranscript(page, 'old-pending', 'Old pending request');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  await page.getByRole('button', { name: 'Open listening' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(false);
  await completeReadiness(page, 'provider-session-2', 'readiness-response-2', 'mcp-list-2', ['delegate_request', 'select_worktree']);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  clearTimeout(fallbackRelease);
  fixture.releaseAdmission();
  await expect.poll(() => fixture.settledAdmissions()).toBe(1);
  await completeTranscript(page, 'new-after-old-pending', 'Continue after pending storage');
  await expect.poll(() => fixture.transcriptBodies.length).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.fixture_admission === 'new'))).toBe(true);
  expect(fixture.stopBodies).toHaveLength(1);
  expect(fixture.transcriptBodies).toHaveLength(2);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(false);
});

test('discards a held admission receipt after transport replacement', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { deferFirstAdmission: true, deferredLatencyMs: 75 });
  const fallbackRelease = setTimeout(fixture.releaseAdmission, 8_000);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-admission', transcript: 'Old request over' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'old-admission'))).toBe(true);
  await page.evaluate(() => {
    const current = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    current.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'old-admission' }) }));
    Object.assign(window, { oldDavoChannel: current });
  });
  await expect.poll(() => fixture.transcriptBodies.length).toBe(1);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => fixture.stopBodies.length).toBe(1);
  await page.getByRole('button', { name: 'Open listening' }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { davoChannel?: EventTarget; oldDavoChannel?: EventTarget };
    return state.davoChannel !== undefined && state.davoChannel !== state.oldDavoChannel;
  })).toBe(true);
  await completeReadiness(page, 'provider-session-2', 'readiness-response-2', 'mcp-list-2', ['delegate_request', 'select_worktree']);
  // the successor must become ready before the old receipt resolves
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  clearTimeout(fallbackRelease);
  fixture.releaseAdmission();
  await expect.poll(() => fixture.settledAdmissions()).toBe(1);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-admission', transcript: 'New request over' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'new-admission'))).toBe(true);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'new-admission' }) })));
  await expect.poll(() => fixture.transcriptBodies.length).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.fixture_admission === 'new'))).toBe(true);
  const oldResponses = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.create' && event.response?.metadata?.fixture_admission === 'old'));
  expect(oldResponses).toEqual([]);
});

test('rotates when an earlier committed raw item has no transcript terminal event', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree']);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'missing-terminal-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'later-item-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'later-item-1', transcript: 'Do not admit this' }) }));
  });
  await expect.poll(() => fixture.stopBodies.length, { timeout: 5_000 }).toBeGreaterThan(0);
  expect(fixture.transcriptBodies).toHaveLength(0);
  const foregroundResponses = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.create' && event.response?.metadata?.davo_phase !== 'readiness'));
  expect(foregroundResponses).toEqual([]);
});
