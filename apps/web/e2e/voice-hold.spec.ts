import { expect, test, type Locator, type Page } from '@playwright/test';

type VoiceWindow = typeof window & {
  __voiceTest: {
    speech: { starts: number; aborts: number };
    audio: Array<{ path: string; volume: number }>;
    emit: (transcript: string) => void;
    end: () => void;
    fail: (error: string) => void;
  };
  __voiceBounce?: { count: number; name: string; durationMs: number; iterations: string };
};

type VoiceOptions = {
  withRecognition?: boolean;
  rejectAudio?: boolean;
  startFailure?: boolean;
  secondAgent?: boolean;
  working?: boolean;
};

type VoiceQuestion = {
  id: string;
  text: string;
  field: { kind: 'choice'; choices: string[] };
  source: 'structured';
};

// use the same native touch delivery as a phone browser
test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

// install controllable speech, audio and websocket boundaries
async function installVoiceMocks(page: Page, options: Pick<VoiceOptions, 'withRecognition' | 'rejectAudio' | 'startFailure'> = {}) {
  await page.addInitScript(({ withRecognition, rejectAudio, startFailure }) => {
    const speech = { starts: 0, aborts: 0 };
    const audio: Array<{ path: string; volume: number }> = [];
    let active: MockSpeechRecognition | undefined;
    class MockSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
      onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      // fail synchronously only when requested
      start() {
        speech.starts += 1;
        if (startFailure) throw new DOMException('speech start failed', 'NotAllowedError');
        active = this;
      }
      // close the active recognition without a microphone
      abort() {
        speech.aborts += 1;
        if (active === this) active = undefined;
        this.onend?.();
      }
    }
    class MockAudio {
      volume = 1;
      // retain the requested sound path
      constructor(readonly src = '') {}
      // capture each attempted playback at its final volume
      play() {
        audio.push({ path: new URL(this.src, window.location.href).pathname, volume: this.volume });
        return rejectAudio ? Promise.reject(new DOMException('playback denied', 'NotAllowedError')) : Promise.resolve();
      }
    }
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // open locally without a network socket
      constructor(readonly url: string | URL) {
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event('open'));
        });
      }
      // ignore fixture messages
      send() {}
      // finish the local socket
      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }
    const fixture = {
      speech,
      audio,
      // deliver one final transcript
      emit: (transcript: string) => active?.onresult?.({ resultIndex: 0, results: [[{ transcript }]] }),
      // model a recoverable recognition end
      end: () => {
        const ended = active;
        active = undefined;
        ended?.onend?.();
      },
      // deliver a fatal recognition error without a later end event
      fail: (error: string) => active?.onerror?.({ error })
    };
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: withRecognition === false ? undefined : MockSpeechRecognition });
    // test keyboard dismissal independently from microphone support
    if (withRecognition === false) Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'Audio', { configurable: true, value: MockAudio });
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, '__voiceTest', { configurable: true, value: fixture });
  }, options);
}

// mount one isolated agent and retain prompt submissions
async function mountVoicePage(page: Page, options: VoiceOptions = {}) {
  let queued = 0;
  let steered = 0;
  let dashboardReads = 0;
  let generation = 1;
  let question: VoiceQuestion | undefined;
  await installVoiceMocks(page, options);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // authenticate the fixture
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose the optional unmount target
    if (path === '/api/dashboard') {
      dashboardReads += 1;
      return route.fulfill({ json: {
      generation,
      adapters: { codex: { transports: { tmux: { steer: true } } } },
      agents: [
        { id: 'agent-1', sessionId: 'socket:$1', panel: 'terminal', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', kind: 'codex', title: question === undefined ? options.working ? 'Working' : 'Ready' : 'Question', attention: question === undefined ? options.working ? 'working' : 'finished' : 'question', queuedPromptCount: 0, ...(question === undefined ? {} : { question }) },
        ...(options.secondAgent ? [{ id: 'agent-2', sessionId: 'socket:$2', panel: 'terminal', home: '/worktrees/owen', worktreeId: 'owen', worktreeLabel: 'Owen', kind: 'codex', title: 'Ready', attention: 'finished', queuedPromptCount: 0 }] : [])
      ],
      projects: []
    } });
    }
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // serve the pane socket ticket
    if (path === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // count ordinary submissions
    if (path === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queued += 1;
      return route.fulfill({ status: 204 });
    }
    // count steering submissions
    if (path === '/api/agents/agent-1/steer' && request.method() === 'POST') {
      steered += 1;
      return route.fulfill({ status: 204 });
    }
    // keep prompt collections empty
    if (/^\/api\/agents\/agent-[12]\/(?:queued-prompts|prompt-history|saved-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  return {
    queued: () => queued,
    steered: () => steered,
    // publish a structured question through the next live dashboard refresh
    showQuestion: async () => {
      question = { id: 'voice-question', text: 'Choose the next step.', field: { kind: 'choice', choices: ['Continue', 'Stop'] }, source: 'structured' };
      generation += 1;
      const previousReads = dashboardReads;
      await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
      await expect.poll(() => dashboardReads).toBeGreaterThan(previousReads);
    }
  };
}

// dispatch a browser-native prompt gesture
async function swipePrompt(page: Page, prompt: Locator, dx: number, dy: number, { cancel = false, multiTouch = false, stepDelayMs = 0 }: { cancel?: boolean; multiTouch?: boolean; stepDelayMs?: number } = {}) {
  const bounds = await prompt.boundingBox();
  // require rendered prompt geometry
  if (bounds === null) throw new Error('prompt has no touch bounds');
  const x = Math.round(bounds.x + bounds.width / 2);
  const y = Math.round(bounds.y + bounds.height / 2);
  const session = await page.context().newCDPSession(page);
  // retain stable finger identities throughout the gesture
  const points = (offsetX: number, offsetY: number) => [
    { x: x + offsetX, y: y + offsetY, id: 1 },
    ...(multiTouch ? [{ x: x + offsetX + 28, y: y + offsetY, id: 2 }] : [])
  ];
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0, 0) });
    // cross thresholds gradually through the native pipeline
    for (let step = 1; step <= 8; step += 1) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(Math.round(dx * step / 8), Math.round(dy * step / 8)) });
      await page.evaluate(() => new Promise<number>(resolve => requestAnimationFrame(resolve)));
      // a slow deliberate drag must remain a swipe rather than a stationary hold
      if (stepDelayMs > 0) await page.waitForTimeout(stepDelayMs);
    }
    await session.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
}

// deliver a stationary native touch for a chosen duration
async function holdPrompt(page: Page, prompt: Locator, duration = 750) {
  const bounds = await prompt.boundingBox();
  // require rendered prompt geometry
  if (bounds === null) throw new Error('prompt has no touch bounds');
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, id: 1 }] });
    await page.waitForTimeout(duration);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
}

// observe every bounce edge without racing its short animation
async function observeBounces(page: Page, composer: Locator) {
  await composer.evaluate(element => {
    const state = { count: 0, name: '', durationMs: 0, iterations: '' };
    // count actual animation restarts instead of folded class mutations
    const capture = (event: AnimationEvent) => {
      // ignore descendant and unrelated animations
      if (event.target !== element || event.animationName !== 'prompt-voice-bounce') return;
      const style = getComputedStyle(element);
      const duration = style.animationDuration;
      state.count += 1;
      state.name = event.animationName;
      state.durationMs = parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000);
      state.iterations = style.animationIterationCount;
    };
    element.addEventListener('animationstart', capture);
    Object.defineProperty(window, '__voiceBounce', { configurable: true, value: state });
  });
}

// read the injected boundary state
const voiceState = (page: Page) => page.evaluate(() => {
  const fixture = (window as unknown as VoiceWindow).__voiceTest;
  return { speech: { ...fixture.speech }, audio: fixture.audio.map(entry => entry.path) };
});

// read cue volumes separately from exact playback order
const voiceVolumes = (page: Page) => page.evaluate(() => (window as unknown as VoiceWindow).__voiceTest.audio.map(entry => entry.volume));

test('swipe toggles dictation with one cue, bounce and active indicator per transition', async ({ page }) => {
  const requests = await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const composer = page.locator('.prompt-composer');
  await expect(prompt).toHaveAttribute('aria-description', 'Swipe up to toggle dictation. Swipe down to unfocus.');
  await expect(page.getByRole('button', { name: /voice input/iu })).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Dictation recording' })).toHaveCount(0);
  await observeBounces(page, composer);

  await prompt.fill('typed');
  await swipePrompt(page, prompt, 0, -64);
  await expect(prompt).toHaveCSS('border-top-color', 'rgb(243, 139, 168)');
  await expect(prompt).toHaveCSS('outline-style', 'none');
  await expect(prompt).toHaveCSS('animation-name', 'voice-listening');
  const indicator = page.getByRole('status', { name: 'Dictation recording' });
  await expect(indicator).toHaveCSS('animation-name', 'prompt-recording-blink');
  await expect(indicator).toHaveCSS('animation-iteration-count', 'infinite');
  const promptBounds = await prompt.boundingBox();
  const indicatorBounds = await indicator.boundingBox();
  expect(promptBounds).not.toBeNull();
  expect(indicatorBounds).not.toBeNull();
  expect(Math.abs(indicatorBounds!.x + indicatorBounds!.width / 2 - (promptBounds!.x + promptBounds!.width / 2))).toBeLessThanOrEqual(8);
  expect(indicatorBounds!.y + indicatorBounds!.height).toBeLessThanOrEqual(promptBounds!.y + 4);
  expect(promptBounds!.y - (indicatorBounds!.y + indicatorBounds!.height)).toBeLessThanOrEqual(24);
  await expect.poll(() => voiceState(page)).toEqual({ speech: { starts: 1, aborts: 0 }, audio: ['/dictation-start.wav'] });
  const startVolumes = await voiceVolumes(page);
  expect(startVolumes).toHaveLength(1);
  // accept any audible normalized cue volume
  expect(startVolumes.every(volume => volume > 0 && volume <= 1)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce)).toMatchObject({ count: 1, name: 'prompt-voice-bounce', durationMs: 240, iterations: '1' });
  await expect(composer).not.toHaveClass(/voice-toggle-bounce/u);

  await page.evaluate(() => (window as unknown as VoiceWindow).__voiceTest.emit('dictated prompt'));
  await expect(prompt).toHaveValue('typed dictated prompt');
  await page.evaluate(() => (window as unknown as VoiceWindow).__voiceTest.end());
  await expect.poll(async () => (await voiceState(page)).speech.starts).toBe(2);
  expect((await voiceState(page)).audio).toEqual(['/dictation-start.wav']);
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce?.count)).toBe(1);

  await prompt.tap();
  await holdPrompt(page, prompt);
  await expect(prompt).toHaveClass(/voice-listening/u);
  expect(await voiceState(page)).toEqual({ speech: { starts: 2, aborts: 0 }, audio: ['/dictation-start.wav'] });

  await swipePrompt(page, prompt, 0, -64);
  await expect(prompt).not.toHaveClass(/voice-listening/u);
  await expect(indicator).toHaveCount(0);
  await expect.poll(() => voiceState(page)).toEqual({ speech: { starts: 2, aborts: 1 }, audio: ['/dictation-start.wav', '/dictation-stop.wav'] });
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce?.count)).toBe(2);

  await prompt.fill('queue this prompt');
  await swipePrompt(page, prompt, 0, -64);
  await page.getByRole('button', { name: 'Queue', exact: true }).tap();
  await expect.poll(requests.queued).toBe(1);
  await expect.poll(async () => (await voiceState(page)).speech.aborts).toBe(2);
  await expect(prompt).not.toHaveClass(/voice-listening/u);
  expect((await voiceState(page)).audio).toEqual(['/dictation-start.wav', '/dictation-stop.wav', '/dictation-start.wav', '/dictation-stop.wav']);
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce?.count)).toBe(4);
});

// keyboard dismissal does not depend on browser speech support
for (const withRecognition of [true, false]) {
  // retain the draft and leave voice state untouched after a deliberate dismissal
  test(`swiping down unfocuses the prompt ${withRecognition ? 'with' : 'without'} speech support`, async ({ page }) => {
    const requests = await mountVoicePage(page, { withRecognition });
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    await prompt.fill('keep this unsent draft');
    await expect(prompt).toBeFocused();
    await swipePrompt(page, prompt, 0, 64);
    await expect(prompt).not.toBeFocused();
    // a compatibility click must not reopen the keyboard
    await page.waitForTimeout(100);
    await expect(prompt).not.toBeFocused();
    await expect(prompt).toHaveValue('keep this unsent draft');
    await expect(prompt).toHaveAttribute('aria-description', withRecognition ? 'Swipe up to toggle dictation. Swipe down to unfocus.' : 'Swipe down to unfocus.');
    await expect(page.locator('.log-output')).not.toHaveClass(/input-active/u);
    expect(await voiceState(page)).toEqual({ speech: { starts: 0, aborts: 0 }, audio: [] });
    expect(requests.queued()).toBe(0);
    expect(requests.steered()).toBe(0);
  });
}

// dismissal must not change an intentionally latched recording session
test('swiping down hides the keyboard without toggling dictation', async ({ page }) => {
  await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('recording draft');
  await swipePrompt(page, prompt, 0, -64);
  await expect(prompt).toHaveClass(/voice-listening/u);
  await swipePrompt(page, prompt, 0, 64);
  await expect(prompt).not.toBeFocused();
  await expect(prompt).toHaveClass(/voice-listening/u);
  expect(await voiceState(page)).toEqual({ speech: { starts: 1, aborts: 0 }, audio: ['/dictation-start.wav'] });
});

// sending a previous prompt must not trap keyboard focus on the next draft
test('swiping down unfocuses the prompt while a submission is pending', async ({ page }) => {
  await mountVoicePage(page);
  let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  let submissions = 0;
  // hold the existing submission without sending anything to a real agent
  await page.route('**/api/agents/agent-1/prompt', async route => {
    submissions += 1;
    await response;
    await route.fulfill({ status: 204 });
  });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  try {
    await prompt.fill('send first');
    await page.getByRole('button', { name: 'Queue', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Queueing', exact: true })).toBeDisabled();
    await prompt.fill('keep the next draft');
    await swipePrompt(page, prompt, 0, 64);
    await expect(prompt).not.toBeFocused();
    await expect(prompt).toHaveValue('keep the next draft');
    expect(submissions).toBe(1);
    expect(await voiceState(page)).toEqual({ speech: { starts: 0, aborts: 0 }, audio: [] });
  } finally { release(); }
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeEnabled();
  await expect(prompt).not.toBeFocused();
});

// only a completed predominantly vertical downward swipe dismisses focus
test('short, sideways, diagonal, cancelled and multi-touch swipes keep prompt focus', async ({ page }) => {
  await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('keep editing');
  await swipePrompt(page, prompt, 0, 39);
  await expect(prompt).toBeFocused();
  await swipePrompt(page, prompt, 64, 0);
  await expect(prompt).toBeFocused();
  await swipePrompt(page, prompt, 64, 64);
  await expect(prompt).toBeFocused();
  await swipePrompt(page, prompt, 0, 64, { cancel: true });
  await expect(prompt).toBeFocused();
  await swipePrompt(page, prompt, 0, 64, { multiTouch: true });
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('keep editing');
  expect(await voiceState(page)).toEqual({ speech: { starts: 0, aborts: 0 }, audio: [] });
  // the threshold itself is a complete dismissal gesture
  await swipePrompt(page, prompt, 0, 40);
  await expect(prompt).not.toBeFocused();
});

test('short, downward, sideways, diagonal, cancelled, multi-touch and held gestures stay idle', async ({ page }) => {
  await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.tap();
  await holdPrompt(page, prompt);
  await swipePrompt(page, prompt, 0, -39);
  await swipePrompt(page, prompt, 0, 64);
  await swipePrompt(page, prompt, 64, 0);
  await swipePrompt(page, prompt, 64, -64);
  await swipePrompt(page, prompt, 0, -64, { cancel: true });
  await swipePrompt(page, prompt, 0, -64, { multiTouch: true });
  await expect(page.getByRole('status', { name: 'Dictation recording' })).toHaveCount(0);
  expect(await voiceState(page)).toEqual({ speech: { starts: 0, aborts: 0 }, audio: [] });

  await swipePrompt(page, prompt, 0, -40);
  await expect(prompt).toHaveClass(/voice-listening/u);
  await expect.poll(async () => (await voiceState(page)).speech.starts).toBe(1);
});

// touch movement, not an arbitrary overall deadline, distinguishes a swipe from a hold
test('unhurried upward swipes still toggle dictation', async ({ page }) => {
  await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await swipePrompt(page, prompt, 0, -64, { stepDelayMs: 100 });
  await expect(prompt).toHaveClass(/voice-listening/u);
  await expect.poll(() => voiceState(page)).toEqual({ speech: { starts: 1, aborts: 0 }, audio: ['/dictation-start.wav'] });
  await swipePrompt(page, prompt, 0, -64, { stepDelayMs: 100 });
  await expect(prompt).not.toHaveClass(/voice-listening/u);
  await expect.poll(() => voiceState(page)).toEqual({ speech: { starts: 1, aborts: 1 }, audio: ['/dictation-start.wav', '/dictation-stop.wav'] });
});

// native draft scrolling must preserve both idle and active microphone intent
for (const active of [false, true]) {
  // retain native editing in either direction rather than interpreting a scroll as a gesture
  for (const dy of [-72, 72]) {
    test(`scrolling ${dy < 0 ? 'up' : 'down'} an overflowing prompt preserves ${active ? 'active' : 'idle'} dictation`, async ({ page }) => {
      await mountVoicePage(page);
      const prompt = page.getByRole('textbox', { name: 'Prompt' });
      const composer = page.locator('.prompt-composer');
      await observeBounces(page, composer);
      // start the logical session before the draft grows scrollable
      if (active) {
        await swipePrompt(page, prompt, 0, -64);
        await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce?.count)).toBe(1);
        await expect(composer).not.toHaveClass(/voice-toggle-bounce/u);
      }
      const draft = Array.from({ length: 80 }, (_, index) => `line ${index + 1} — scrollable prompt content`).join('\n');
      await prompt.fill(draft);
      const initialTop = await prompt.evaluate((element: HTMLTextAreaElement) => {
        element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 4);
        return element.scrollTop;
      });
      expect(initialTop).toBeGreaterThan(100);
      await swipePrompt(page, prompt, 0, dy);
      // compare actual native scroll movement in the requested direction
      if (dy < 0) await expect.poll(() => prompt.evaluate(element => element.scrollTop)).toBeGreaterThan(initialTop);
      else await expect.poll(() => prompt.evaluate(element => element.scrollTop)).toBeLessThan(initialTop);
      await expect(prompt).toBeFocused();
      await expect(prompt).toHaveValue(draft);
      await expect(page.getByRole('status', { name: 'Dictation recording' })).toHaveCount(active ? 1 : 0);
      expect(await voiceState(page)).toEqual({ speech: { starts: active ? 1 : 0, aborts: 0 }, audio: active ? ['/dictation-start.wav'] : [] });
      expect(await page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce?.count)).toBe(active ? 1 : 0);
    });
  }
}

// physical-keyboard output mode leaves a visible composer that still acknowledges a stop
test('focusing desktop output gives the visible prompt one stop bounce', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const composer = page.locator('.prompt-composer');
  const output = page.locator('.log-output');
  await prompt.fill('desktop draft');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveClass(/physical-keyboard/u);
  await observeBounces(page, composer);
  await swipePrompt(page, prompt, 0, -64);
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce?.count)).toBe(1);
  await expect(composer).not.toHaveClass(/voice-toggle-bounce/u);

  await output.locator('.xterm-screen').click();
  await expect(output).toHaveClass(/input-active/u);
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue('desktop draft');
  await expect(page.getByRole('status', { name: 'Dictation recording' })).toHaveCount(0);
  await expect.poll(() => voiceState(page)).toEqual({ speech: { starts: 1, aborts: 1 }, audio: ['/dictation-start.wav', '/dictation-stop.wav'] });
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce)).toMatchObject({ count: 2, name: 'prompt-voice-bounce', durationMs: 240, iterations: '1' });
  await expect(composer).not.toHaveClass(/voice-toggle-bounce/u);
});

// a second finger outside the field must never turn a mixed gesture into microphone intent
test('an outside second finger invalidates a prompt swipe even when it lifts first', async ({ page }) => {
  await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const field = await prompt.boundingBox();
  const output = await page.getByLabel('Live log').boundingBox();
  // require distinct visible prompt and output targets
  if (field === null || output === null) throw new Error('missing dictation multi-touch targets');
  const primary = { x: field.x + field.width / 2, y: field.y + field.height / 2, id: 1 };
  const secondary = { x: output.x + output.width / 2, y: output.y + Math.min(100, output.height / 4), id: 2 };
  expect(secondary.y).toBeLessThan(primary.y - 100);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [primary] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [primary, secondary] });
    // CDP releases the supplied secondary while the prompt finger remains active
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [secondary] });
    // complete an otherwise qualifying upward gesture with the original finger
    for (let step = 1; step <= 8; step += 1) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...primary, y: primary.y - 64 * step / 8 }] });
      await page.evaluate(() => new Promise<number>(resolve => requestAnimationFrame(resolve)));
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
  await expect(prompt).toBeVisible();
  await expect(page.locator('.log-output')).not.toHaveClass(/input-active/u);
  await expect(prompt).not.toHaveClass(/voice-listening/u);
  expect(await voiceState(page)).toEqual({ speech: { starts: 0, aborts: 0 }, audio: [] });
});

test('a synchronous speech start failure stays idle and plays no start cue', async ({ page }) => {
  await mountVoicePage(page, { startFailure: true });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await swipePrompt(page, prompt, 0, -64);
  await expect(page.getByRole('status', { name: 'Dictation recording' })).toHaveCount(0);
  await expect.poll(() => voiceState(page)).toEqual({ speech: { starts: 1, aborts: 0 }, audio: [] });
});

test('fatal permission errors stop promptly without restarting recognition', async ({ page }) => {
  await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await swipePrompt(page, prompt, 0, -64);
  await page.evaluate(() => (window as unknown as VoiceWindow).__voiceTest.fail('not-allowed'));
  await expect(page.getByRole('status', { name: 'Dictation recording' })).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(await voiceState(page)).toEqual({ speech: { starts: 1, aborts: 1 }, audio: ['/dictation-start.wav', '/dictation-stop.wav'] });
});

test('rejected sound playback never breaks dictation state changes', async ({ page }) => {
  await mountVoicePage(page, { rejectAudio: true });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await swipePrompt(page, prompt, 0, -64);
  await expect(prompt).toHaveClass(/voice-listening/u);
  await swipePrompt(page, prompt, 0, -64);
  await expect(prompt).not.toHaveClass(/voice-listening/u);
  await expect.poll(() => voiceState(page)).toEqual({ speech: { starts: 1, aborts: 1 }, audio: ['/dictation-start.wav', '/dictation-stop.wav'] });
});

// retain static active feedback for either reduced-motion source
for (const motion of ['os', 'app'] as const) {
  test(`${motion} reduced motion disables dictation animation but keeps static feedback and sounds`, async ({ page }) => {
    // configure the requested motion source before toggling
    if (motion === 'os') await page.emulateMedia({ reducedMotion: 'reduce' });
    if (motion === 'app') await page.addInitScript(() => { localStorage.setItem('rac.reduced-motion', 'enabled'); });
    await mountVoicePage(page);
    const prompt = page.getByRole('textbox', { name: 'Prompt' });
    const composer = page.locator('.prompt-composer');
    await observeBounces(page, composer);
    await swipePrompt(page, prompt, 0, -64);
    await expect(prompt).toHaveCSS('border-top-color', 'rgb(243, 139, 168)');
    await expect(prompt).toHaveCSS('animation-name', 'none');
    const indicator = page.getByRole('status', { name: 'Dictation recording' });
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveCSS('animation-name', 'none');
    expect(await page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce?.count)).toBe(0);
    expect(await voiceState(page)).toEqual({ speech: { starts: 1, aborts: 0 }, audio: ['/dictation-start.wav'] });
  });
}

test('a dashboard question stops dictation before replacing the composer', async ({ page }) => {
  const requests = await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await swipePrompt(page, prompt, 0, -64);
  await expect(prompt).toHaveClass(/voice-listening/u);

  await requests.showQuestion();
  await expect(page.getByRole('region', { name: 'Agent question' })).toContainText('Choose the next step.');
  await expect(page.locator('textarea[data-prompt-id="agent-1"]')).toHaveCount(0);
  await expect(page.locator('.prompt-recording-indicator')).toHaveCount(0);
  await expect.poll(() => voiceState(page)).toEqual({ speech: { starts: 1, aborts: 1 }, audio: ['/dictation-start.wav', '/dictation-stop.wav'] });
  await page.waitForTimeout(100);
  expect((await voiceState(page)).speech.starts).toBe(1);
});

test('focusing mobile agent output stops dictation while the prompt stays mounted but hidden', async ({ page }) => {
  await mountVoicePage(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const composer = page.getByRole('region', { name: 'Prompt composer' });
  const bounceTarget = page.locator('.prompt-composer');
  const output = page.locator('.log-output');
  await observeBounces(page, bounceTarget);
  await swipePrompt(page, prompt, 0, -64);
  await expect(prompt).toHaveClass(/voice-listening/u);
  await expect.poll(() => page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce?.count)).toBe(1);

  await output.locator('.xterm-screen').tap();
  await expect(output).toHaveClass(/input-active/u);
  await expect(composer).toBeHidden();
  await expect(page.locator('textarea[data-prompt-id="agent-1"]')).toHaveCount(1);
  await expect(bounceTarget).not.toHaveClass(/voice-toggle-bounce/u);
  expect(await page.evaluate(() => (window as unknown as VoiceWindow).__voiceBounce?.count)).toBe(1);
  await expect(page.locator('.prompt-recording-indicator')).toHaveCount(0);
  await expect.poll(() => voiceState(page)).toEqual({ speech: { starts: 1, aborts: 1 }, audio: ['/dictation-start.wav', '/dictation-stop.wav'] });
  await page.waitForTimeout(100);
  expect((await voiceState(page)).speech.starts).toBe(1);
});

test('steering and prompt unmount both stop an active session', async ({ page }) => {
  const requests = await mountVoicePage(page, { secondAgent: true, working: true });
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('steer now');
  await swipePrompt(page, prompt, 0, -64);
  await page.getByRole('button', { name: 'Alt+Enter steers', exact: true }).tap();
  await expect.poll(requests.steered).toBe(1);
  await expect.poll(async () => (await voiceState(page)).speech.aborts).toBe(1);
  await expect(prompt).not.toHaveClass(/voice-listening/u);

  await prompt.fill('unmount next');
  await swipePrompt(page, prompt, 0, -64);
  await page.evaluate(() => { window.location.hash = 'agent=agent-2'; });
  await expect(page.locator('textarea[data-prompt-id="agent-2"]')).toBeVisible();
  await expect.poll(async () => (await voiceState(page)).speech.aborts).toBe(2);
});
