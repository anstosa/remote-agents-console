import { expect, test } from '@playwright/test';

const enabledDavo = { enabled: true, available: true, name: 'Davo', context: '' };
type VoiceApiCalls = { opens: number; stops: number };

// install deterministic browser media and meter primitives
async function installMedia(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    class MockDataChannel extends EventTarget {
      readyState: RTCDataChannelState = 'open';
      readonly sent: string[] = [];

      // retain provider commands for readiness assertions
      send(value: string) { this.sent.push(value); }

      // close the fixture transport
      close() { this.readyState = 'closed'; }
    }

    class MockPeerConnection extends EventTarget {
      connectionState: RTCPeerConnectionState = 'new';
      ontrack: ((event: RTCTrackEvent) => void) | null = null;

      // expose one inspectable provider channel
      createDataChannel() {
        const channel = new MockDataChannel();
        Object.assign(window, { davoChannel: channel });
        window.setTimeout(() => channel.dispatchEvent(new Event('open')));
        return channel as unknown as RTCDataChannel;
      }

      // accept fixture microphone tracks
      addTrack() { return {} as RTCRtpSender; }

      // create one bounded fixture offer
      async createOffer() { return { type: 'offer' as const, sdp: 'fixture-offer' }; }

      // accept fixture descriptions
      async setLocalDescription() {}

      // accept fixture descriptions
      async setRemoteDescription() {}

      // close the fixture peer
      close() { this.connectionState = 'closed'; }
    }

    class MockAudioContext {
      // create one active input meter
      createAnalyser() {
        return {
          fftSize: 256,
          // supply a stable nonzero waveform
          getByteTimeDomainData(samples: Uint8Array) { samples.fill(140); }
        } as AnalyserNode;
      }

      // create one disposable stream source
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} } as unknown as MediaStreamAudioSourceNode;
      }

      // preserve the async browser contract
      async resume() {}

      // preserve the async browser contract
      async close() {}
    }

    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: MockPeerConnection });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: MockAudioContext });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      // create one fresh microphone per transport
      getUserMedia: async () => {
        const track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
        Object.assign(window, { davoTrack: track });
        return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
      }
    } });
    HTMLMediaElement.prototype.play = async () => undefined;
  });
}

// expose one authenticated voice session without touching the host
async function mockVoiceApi(page: import('@playwright/test').Page, calls: VoiceApiCalls = { opens: 0, stops: 0 }): Promise<void> {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // restore one authenticated browser
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'davo-csrf', active: true, deviceName: 'Test browser', davo: enabledDavo, server: { name: 'Framework', url: 'https://framework.example', remotes: [] } } });
    // expose an empty dashboard
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // seed one retained row so the mounted transcript can be verified
    if (path === '/api/davo/conversation') return route.fulfill({ json: { conversationId: 'conversation-1', generation: 4, revision: '11111111-1111-4111-8111-111111111111', retainedFrom: '2026-11-03T08:00:00.000Z', serverNow: new Date().toISOString(), retentionCutoffAt: new Date(Date.now() + 3_600_000).toISOString(), nextSequence: 2, hasMore: false, pendingChoices: [], messages: [{ id: 'retained-1', sequence: 1, kind: 'assistant', text: 'Retained Davo update', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }] } });
    // create one server-owned pending negotiation
    if (path === '/api/realtime/session') {
      // count provider session creation without contacting a provider
      calls.opens += 1;
      return route.fulfill({ json: { negotiationId: 'negotiation-1', model: 'gpt-realtime-2.1', conversationId: 'conversation-1', generation: 4, contextRevision: '22222222-2222-4222-8222-222222222222', serverNow: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), retentionCutoffAt: new Date(Date.now() + 3_600_000).toISOString() } });
    }
    // release one exact provider readiness envelope
    if (path === '/api/realtime/negotiate') return route.fulfill({ json: { sdp: 'fixture-answer', generation: 4, readinessId: 'readiness-1', readinessResponse: { conversation: 'none', input: [], instructions: 'Return READY only', tools: [{ type: 'mcp', server_label: 'rac', allowed_tools: ['delegate_request'] }], tool_choice: 'none', output_modalities: ['text'], metadata: { davo_phase: 'readiness', readiness_id: 'readiness-1' } } } });
    if (path === '/api/davo/session/ready') return route.fulfill({ json: { ok: true } });
    if (path === '/api/realtime/session/heartbeat') return route.fulfill({ json: { serverNow: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() } });
    if (path === '/api/realtime/session/stop') {
      // count explicit audio cleanup separately from panel visibility
      calls.stops += 1;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

// finish the exact provider readiness exchange
async function completeReadiness(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget & { sent: string[] } }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'session.created', session: { id: 'provider-session-1' } }) }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(JSON.parse).some(event => event.type === 'response.create' && event.response?.metadata?.davo_phase === 'readiness'))).toBe(true);
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    const item = { id: 'mcp-list-1', type: 'mcp_list_tools', server_label: 'rac', tools: [{ name: 'delegate_request' }] };
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'mcp_list_tools.completed', item_id: 'mcp-list-1' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.done', item }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'readiness-response-1', metadata: { davo_phase: 'readiness', readiness_id: 'readiness-1' } } }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done', response: { id: 'readiness-response-1', status: 'completed' } }) }));
  });
}

test('uses a connecting skeleton and hides muted microphone motion', async ({ page }) => {
  await installMedia(page);
  await mockVoiceApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Davo' }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { davoChannel?: EventTarget }).davoChannel))).toBe(true);

  const dialog = page.getByRole('dialog', { name: 'Davo' });
  const shell = dialog.locator('.voice-transcript-shell');
  const transcript = dialog.locator('.voice-transcript');
  const skeleton = dialog.locator('.voice-connecting-skeleton');
  await expect(shell).toHaveAttribute('aria-busy', 'true');
  await expect(shell).toHaveAttribute('aria-label', 'Connecting Davo');
  await expect(skeleton).toBeVisible();
  await expect(skeleton.locator('.skeleton')).toHaveCount(8);
  await expect(transcript).toHaveAttribute('aria-hidden', 'true');
  await expect(transcript).toHaveAttribute('inert', '');
  await expect(dialog.locator('.progress-border, .update-progress-ring')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await skeleton.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await completeReadiness(page);
  await expect(page.getByRole('button', { name: 'Mute' })).toBeEnabled();
  await expect(skeleton).toHaveCount(0);
  await expect(shell).not.toHaveAttribute('aria-busy', 'true');
  await expect(transcript).not.toHaveAttribute('aria-hidden', 'true');
  await expect(transcript).not.toHaveAttribute('inert', '');
  await expect(dialog.getByText('Retained Davo update')).toBeVisible();
  await expect(dialog.getByText(/listening — say “over” when finished/iu)).toBeVisible();

  const surface = dialog.locator(':scope > div');
  const microphone = dialog.locator('.voice-soundwave.mic');
  const assistant = dialog.locator('.voice-soundwave.davo');
  const compactTrigger = page.locator('.server-switcher-voice.active');
  await page.evaluate(() => {
    const channel = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) }));
    channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.started' }) }));
  });
  await expect.poll(() => surface.evaluate(element => (element as HTMLElement).style.getPropertyValue('--mic-level'))).not.toBe('0.000');
  await expect.poll(() => surface.evaluate(element => (element as HTMLElement).style.getPropertyValue('--davo-level'))).toBe('0.220');
  await expect.poll(() => microphone.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
  await expect.poll(() => assistant.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
  await expect.poll(() => compactTrigger.evaluate(element => Number(getComputedStyle(element, '::before').opacity))).toBeGreaterThan(0);
  await expect.poll(() => compactTrigger.evaluate(element => Number(getComputedStyle(element, '::after').opacity))).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Mute' }).click();
  await expect(page.getByRole('button', { name: 'Muted — say Davo' })).toBeVisible();
  await expect.poll(() => surface.evaluate(element => (element as HTMLElement).style.getPropertyValue('--mic-level'))).toBe('0.000');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--davo-input-level'))).toBe('0.000');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--davo-activity-level'))).toBe('0.220');
  await expect(microphone).toHaveCount(0);
  await expect.poll(() => assistant.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(0);
  await expect.poll(() => compactTrigger.evaluate(element => getComputedStyle(element, '::after').opacity)).toBe('0');
  await expect.poll(() => compactTrigger.evaluate(element => Number(getComputedStyle(element, '::before').opacity))).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { enabled: boolean } }).davoTrack.enabled)).toBe(true);
});

// verify panel visibility remains independent from the live audio session
for (const viewport of [{ label: 'desktop', width: 1440, height: 900 }, { label: 'mobile', width: 390, height: 844 }]) {
  test(`keeps the Davo toolbar toggle visible and selected on ${viewport.label}`, async ({ page }) => {
    const calls: VoiceApiCalls = { opens: 0, stops: 0 };
    await installMedia(page);
    await mockVoiceApi(page, calls);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');

    const trigger = page.locator('.server-switcher-voice');
    await page.getByRole('button', { name: 'Open Davo', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { davoChannel?: EventTarget }).davoChannel))).toBe(true);
    await page.evaluate(() => Object.assign(window, { initialDavoChannel: (window as unknown as { davoChannel: EventTarget }).davoChannel }));
    await expect.poll(() => calls.opens).toBe(1);

    const dialog = page.getByRole('dialog', { name: 'Davo' });
    await expect(dialog).toBeVisible();
    const headerToggle = dialog.getByRole('button', { name: 'Show main UI while Davo remains available', exact: true });
    expect(await headerToggle.isVisible()).toBe(viewport.label === 'mobile');
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeEnabled();
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    const connectingBox = await trigger.boundingBox();
    expect(connectingBox).not.toBeNull();
    expect(connectingBox!.width).toBeGreaterThanOrEqual(40);
    expect(connectingBox!.height).toBeGreaterThanOrEqual(40);
    expect(connectingBox!.x).toBeGreaterThanOrEqual(0);
    expect(connectingBox!.x + connectingBox!.width).toBeLessThanOrEqual(viewport.width);
    const connectingHit = await trigger.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      const ancestors = [];
      // retain stacking context details when the live target is obscured
      for (let current = element.parentElement; current !== null; current = current.parentElement) {
        const style = getComputedStyle(current);
        ancestors.push({ className: current.className, overflow: style.overflow, position: style.position, transform: style.transform, zIndex: style.zIndex });
      }
      return { hits: target === element || target !== null && element.contains(target), targetClass: target?.className ?? '', targetTag: target?.tagName ?? '', ancestors };
    });
    expect(connectingHit.hits, JSON.stringify(connectingHit)).toBe(true);
    await expect(dialog).toHaveAttribute('aria-modal', 'false');
    await expect(trigger).toHaveAccessibleName('Hide Davo');
    const connectingSelectedStyle = await trigger.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.backgroundImage, style.borderColor, style.boxShadow, style.color];
    });

    await trigger.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-pressed', 'false');
    await expect(trigger).toHaveAccessibleName('Show Davo');
    await expect.poll(() => calls.stops).toBe(0);
    await expect.poll(() => calls.opens).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { davoTrack: { stopped: boolean } }).davoTrack.stopped)).toBe(false);
    expect(await page.evaluate(() => {
      const state = window as unknown as { davoChannel: EventTarget; initialDavoChannel: EventTarget };
      return state.davoChannel === state.initialDavoChannel;
    })).toBe(true);
    const hiddenStyle = await trigger.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.backgroundImage, style.borderColor, style.boxShadow, style.color];
    });
    expect(connectingSelectedStyle).not.toEqual(hiddenStyle);

    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect(trigger).toHaveAccessibleName('Hide Davo');
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => calls.opens).toBe(1);
    await completeReadiness(page);
    await expect(page.getByRole('button', { name: 'Mute', exact: true })).toBeEnabled();
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAccessibleName('Hide Davo');

    await trigger.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => calls.stops).toBe(0);
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect.poll(() => calls.opens).toBe(1);

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => calls.stops).toBe(1);
    await expect(dialog).toBeVisible();
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    await expect(trigger).toHaveAccessibleName('Hide Davo');
    const stoppedSelectedStyle = await trigger.evaluate(element => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.backgroundImage, style.borderColor, style.boxShadow, style.color];
    });
    expect(stoppedSelectedStyle).not.toEqual(hiddenStyle);

    await trigger.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-pressed', 'false');
    await expect(trigger).toHaveAccessibleName('Open Davo');
    await trigger.click();
    await expect(dialog).toBeVisible();
    await expect.poll(() => calls.opens).toBe(2);
  });
}
