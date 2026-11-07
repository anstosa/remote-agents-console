import { expect, test } from '@playwright/test';

const enabledDavo = { enabled: true, available: true, name: 'Davo', context: '' };

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

// delete one finalized provider transcript before admission
async function completeTranscript(page: import('@playwright/test').Page, itemId: string, transcript: string): Promise<void> {
  await page.evaluate(({ id, text }) => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: text }) })), { id: itemId, text: transcript });
  await expect.poll(() => page.evaluate(id => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === id), itemId)).toBe(true);
  await page.evaluate(id => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: id }) })), itemId);
}

// open one minimal provider-readiness fixture
async function openReadinessFixture(page: import('@playwright/test').Page, tools: string[], extraItems: Array<{ id?: string; surface: 'conversation.item.done' | 'response.output_item.done'; tools: string[] }> = [], options: { admission?: 'receipt' | 'pending-202' | 'pending-body' | 'retry-pending'; deferContinuation?: boolean; deferFirstAdmission?: boolean; includeWorktree?: boolean; deferStop?: boolean; stopStatus?: number } = {}) {
  await installMedia(page);
  const readyBodies: unknown[] = [];
  const openBodies: unknown[] = [];
  const stopBodies: unknown[] = [];
  const transcriptBodies: unknown[] = [];
  const bindBodies: unknown[] = [];
  const assistantBodies: unknown[] = [];
  const continueBodies: unknown[] = [];
  let releaseAdmission = () => undefined;
  let releaseContinuation = () => undefined;
  let releaseStop = () => undefined;
  const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve; });
  const continuationGate = new Promise<void>(resolve => { releaseContinuation = resolve; });
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
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
    if (path === '/api/davo/conversation') return route.fulfill({ json: { conversationId: 'conversation-1', generation: 4, revision: '11111111-1111-4111-8111-111111111111', retainedFrom: '2026-11-03T08:00:00.000Z', serverNow: new Date().toISOString(), retentionCutoffAt: new Date(Date.now() + 3_600_000).toISOString(), nextSequence: 1, hasMore: false, pendingChoices: [], messages: [] } });
    if (path === '/api/realtime/session') { openBodies.push(request.postDataJSON()); return route.fulfill({ json: { negotiationId: 'negotiation-1', model: 'gpt-realtime-2.1', conversationId: 'conversation-1', generation: 4, contextRevision: '22222222-2222-4222-8222-222222222222', serverNow: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), retentionCutoffAt: new Date(Date.now() + 3_600_000).toISOString() } }); }
    if (path === '/api/realtime/negotiate') return route.fulfill({ json: { sdp: 'fixture-answer', generation: 4, readinessId: 'readiness-1', readinessResponse: { conversation: 'none', input: [], instructions: 'Return READY only', tools: [{ type: 'mcp', server_label: 'rac', allowed_tools: ['delegate_request', 'select_worktree'] }], tool_choice: 'none', output_modalities: ['text'], metadata: { davo_phase: 'readiness', readiness_id: 'readiness-1' } } } });
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
      return route.fulfill({ json: { messageId: 'message-old', turnId: 'turn-old', generation: 4, response: { conversation: 'none', input: [], tools: [], output_modalities: ['audio'], metadata: { fixture_continuation: 'old' } } } });
    }
    if (path === '/api/davo/transcripts/assistant') { assistantBodies.push(request.postDataJSON()); return route.fulfill({ json: { id: 'assistant-fixture' } }); }
    if (path === '/api/davo/transcripts/user') {
      transcriptBodies.push(request.postDataJSON());
      const first = transcriptBodies.length === 1;
      // hold only the old session's first admission receipt
      if (first && options.deferFirstAdmission) await admissionGate;
      // expose pending through the response status
      if (first && options.admission === 'pending-202') return route.fulfill({ status: 202, json: { ok: true, pending: true, messageId: 'message-pending', generation: 4 } });
      // expose pending through the response body
      if (first && options.admission === 'pending-body') return route.fulfill({ json: { ok: true, pending: true, messageId: 'message-pending', generation: 4 } });
      // exercise pending detection after the exact-receipt retry
      if (options.admission === 'retry-pending') return route.fulfill({ json: first ? { ok: true } : { ok: true, pending: true, messageId: 'message-pending', generation: 4 } });
      return route.fulfill({ json: { messageId: first ? 'message-old' : 'message-new', turnId: first ? 'turn-old' : 'turn-new', generation: 4, response: { conversation: 'none', input: [], tools: [], output_modalities: ['audio'], metadata: { fixture_admission: first ? 'old' : 'new' } } } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Davo' }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { davoChannel?: EventTarget }).davoChannel))).toBe(true);
  await completeReadiness(page, 'provider-session-1', 'readiness-response-1', 'mcp-list-1', tools, extraItems);
  return { assistantBodies, bindBodies, continueBodies, openBodies, readyBodies, stopBodies, transcriptBodies, releaseAdmission, releaseContinuation, releaseStop };
}

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
    if (url.pathname === '/api/davo/conversation') return route.fulfill({ json: { conversationId: 'conversation-1', generation: 4, revision: '11111111-1111-4111-8111-111111111111', retainedFrom: '2026-11-03T08:00:00.000Z', serverNow: new Date().toISOString(), retentionCutoffAt: new Date(Date.now() + 3_600_000).toISOString(), nextSequence: 2 + backgroundPhase, hasMore: false, pendingChoices: [], messages: [{ id: 'baseline-message', sequence: 1, kind: 'status', text: 'Listening ready', createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, ...(backgroundPhase >= 1 ? [{ id: 'failed-background-message', sequence: 2, kind: 'assistant', text: 'Dropped projection update', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }] : []), ...(backgroundPhase >= 2 ? [{ id: 'background-message', sequence: 3, kind: 'assistant', text: 'A retained background update', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }] : [])] } });
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
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'request-1', transcript: 'Check the current work' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'request-1'))).toBe(true);
  expect(transcriptBodies).toHaveLength(0);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'request-1' }) })));
  await expect.poll(() => transcriptBodies.length).toBe(1);
  expect(transcriptBodies[0]).toMatchObject({ generation: 4, providerSessionId: 'provider-session-1', providerItemId: 'request-1', text: 'Check the current work' });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create'))).toBe(true);

  // rapid second input is quarantined while the first turn remains active
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'rapid-1', transcript: 'Approve something else' }) })));
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
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) })));
  // project a later retained reply and keep it active through response.created
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.create' && JSON.stringify(event.response).includes('Speak this update exactly once')).length), { timeout: 5_000 }).toBe(1);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'projection-1' } }) })));

  // new input cancels and waits for the exact projected response completion
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'request-2', transcript: 'Start the next task' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'request-2'))).toBe(true);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'request-2' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.cancel' && event.response_id === 'projection-1'))).toBe(true);
  expect(transcriptBodies).toHaveLength(1);
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.output_audio_transcript.delta', response_id: 'projection-1', delta: 'stale projection text' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done', response: { id: 'projection-1', status: 'cancelled' } }) }));
  });
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
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { deferContinuation: true, includeWorktree: true });
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
  await page.waitForTimeout(100);
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
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { admission: 'pending-202', deferFirstAdmission: true });
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
  await page.waitForTimeout(100);
  expect(fixture.stopBodies).toHaveLength(1);
  expect(fixture.transcriptBodies).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(false);
});

test('discards a held admission receipt after transport replacement', async ({ page }) => {
  const fixture = await openReadinessFixture(page, ['delegate_request', 'select_worktree'], [], { deferFirstAdmission: true });
  const fallbackRelease = setTimeout(fixture.releaseAdmission, 8_000);
  await expect.poll(() => fixture.readyBodies.length).toBe(1);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'old-admission', transcript: 'Old request' }) })));
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
  await page.waitForTimeout(100);
  const oldResponses = await page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).filter(event => event.type === 'response.create' && event.response?.metadata?.fixture_admission === 'old'));
  expect(oldResponses).toEqual([]);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'new-admission', transcript: 'New request' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'conversation.item.delete' && event.item_id === 'new-admission'))).toBe(true);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.deleted', item_id: 'new-admission' }) })));
  await expect.poll(() => fixture.transcriptBodies.length).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.fixture_admission === 'new'))).toBe(true);
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
