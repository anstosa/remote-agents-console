import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockAccountSocket } from './account-fixture.js';

const gib = 1024 ** 3;

type RequestSummary = { requests: number; aborts: number; active: number; maxActive: number };
type ResourceTransport = 'metrics' | 'disks' | 'live';
type CachedTransport = Exclude<ResourceTransport, 'live'>;
type TransportState = RequestSummary & {
  hold: boolean;
  response: unknown;
  status: number;
  pending: Set<() => void>;
};
type LiveTransportState = RequestSummary & { controllers: Set<ReadableStreamDefaultController<Uint8Array>> };
type TestWindow = Window & {
  __racResourceLive: LiveTransportState;
  __racResourceTransports: Record<CachedTransport, TransportState>;
  __racVisibility?: DocumentVisibilityState;
};
type TransportControls = {
  summary: (transport: ResourceTransport) => Promise<RequestSummary>;
  hold: (transport: CachedTransport, value: boolean) => Promise<void>;
  release: (transport: CachedTransport) => Promise<void>;
  respond: (transport: CachedTransport, value: unknown, status?: number) => Promise<void>;
  pushLive: (value: unknown) => Promise<void>;
  pushLiveRaw: (value: string) => Promise<void>;
};
type ResourceControls = TransportControls & {
  sessionSummary: () => Promise<{ requests: number; resourceMonitoring: boolean }>;
  setSessionMonitoring: (value: boolean) => Promise<void>;
};

// return one cpu and memory sample without disk collection
const metricsSample = (wslCpu: number | null = 12.25, wslMemory = 25, hostCpu: number | null = 37.5, hostMemory = 50) => ({
  sampledAt: '2026-11-17T20:00:00.000Z',
  host: {
    cpuPercent: hostCpu,
    memory: { usedBytes: 16 * gib * hostMemory / 100, totalBytes: 16 * gib },
    disks: []
  },
  wsl: {
    cpuPercent: wslCpu,
    memory: { usedBytes: 8 * gib * wslMemory / 100, totalBytes: 8 * gib },
    disks: []
  }
});

// return the separately cached attached-disk sample
const diskSample = () => ({
  sampledAt: '2026-11-17T20:00:00.000Z',
  host: {
    cpuPercent: null,
    memory: null,
    disks: [
      { mount: 'C:\\', usedBytes: 100 * gib, totalBytes: 200 * gib },
      { mount: 'D:\\', usedBytes: 256 * gib, totalBytes: 1024 * gib }
    ]
  },
  wsl: {
    cpuPercent: null,
    memory: null,
    disks: [
      { mount: '/', usedBytes: 80 * gib, totalBytes: 160 * gib },
      { mount: '/mnt/data', usedBytes: 500 * gib, totalBytes: 1000 * gib }
    ]
  }
});

// install controllable cached and live resource transports before startup
async function installResourceTransports(page: Page, options: { holdMetrics?: boolean; holdDisks?: boolean; metrics?: unknown; disks?: unknown } = {}): Promise<TransportControls> {
  await page.addInitScript(({ initial }) => {
    const originalFetch = window.fetch.bind(window);
    const transports: Record<CachedTransport, TransportState> = {
      metrics: { requests: 0, aborts: 0, active: 0, maxActive: 0, hold: initial.holdMetrics, response: initial.metrics, status: 200, pending: new Set() },
      disks: { requests: 0, aborts: 0, active: 0, maxActive: 0, hold: initial.holdDisks, response: initial.disks, status: 200, pending: new Set() }
    };
    const live: LiveTransportState = { requests: 0, aborts: 0, active: 0, maxActive: 0, controllers: new Set() };
    (window as TestWindow).__racResourceTransports = transports;
    (window as TestWindow).__racResourceLive = live;
    // intercept only the optional resource transports
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString(), location.href);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      // expose one newline-delimited live stream per open visible flyout
      if (url.pathname === '/api/server/resources/live') {
        live.requests += 1;
        let finish: (aborted: boolean) => void = () => undefined;
        const body = new ReadableStream<Uint8Array>({
          // retain this reader until its exact owner closes
          start(controller) {
            let finished = false;
            live.controllers.add(controller);
            live.active += 1;
            live.maxActive = Math.max(live.maxActive, live.active);
            // close this exact synthetic collector once
            finish = aborted => {
              // ignore duplicate abort and reader-cancel signals
              if (finished) return;
              finished = true;
              live.controllers.delete(controller);
              live.active -= 1;
              // count only owning-request cancellation
              if (aborted) live.aborts += 1;
              try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* reader already released */ }
            };
            // honor cancellation before or after reader registration
            if (signal?.aborted) finish(true);
            else signal?.addEventListener('abort', () => finish(true), { once: true });
          },
          // release a reader-initiated cancellation
          cancel() { finish(false); }
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
      }
      const transport = url.pathname === '/api/server/resources/metrics' ? 'metrics' : url.pathname === '/api/server/resources/disks' ? 'disks' : undefined;
      // preserve every ordinary application request
      if (transport === undefined) return originalFetch(input, init);
      const state = transports[transport];
      state.requests += 1;
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      return new Promise<Response>((resolve, reject) => {
        let finished = false;
        // settle this request with the latest configured response
        const complete = () => {
          // ignore release after cancellation or another completion
          if (finished) return;
          finished = true;
          state.pending.delete(complete);
          signal?.removeEventListener('abort', abort);
          state.active -= 1;
          resolve(new Response(JSON.stringify(state.response), { status: state.status, headers: { 'content-type': 'application/json' } }));
        };
        // reject this exact request when monitoring releases ownership
        const abort = () => {
          // ignore duplicate cancellation notifications
          if (finished) return;
          finished = true;
          state.pending.delete(complete);
          state.active -= 1;
          state.aborts += 1;
          reject(new DOMException('Aborted', 'AbortError'));
        };
        // honor cancellation before registration
        if (signal?.aborted) abort();
        else {
          signal?.addEventListener('abort', abort, { once: true });
          // hold only explicitly gated responses
          if (state.hold) state.pending.add(complete);
          else complete();
        }
      });
    };
  }, {
    initial: {
      holdMetrics: options.holdMetrics ?? false,
      holdDisks: options.holdDisks ?? false,
      metrics: options.metrics ?? metricsSample(),
      disks: options.disks ?? diskSample()
    }
  });
  return {
    // read one transport's ownership counters
    summary: transport => page.evaluate(name => {
      // route the streaming lifecycle to its separate state
      if (name === 'live') {
        const state = (window as TestWindow).__racResourceLive;
        return { requests: state.requests, aborts: state.aborts, active: state.active, maxActive: state.maxActive };
      }
      const state = (window as TestWindow).__racResourceTransports[name];
      return { requests: state.requests, aborts: state.aborts, active: state.active, maxActive: state.maxActive };
    }, transport),
    // control whether future responses remain in flight
    hold: (transport, value) => page.evaluate(({ name, next }) => { (window as TestWindow).__racResourceTransports[name].hold = next; }, { name: transport, next: value }),
    // settle every held response against the latest configuration
    release: transport => page.evaluate(name => {
      const state = (window as TestWindow).__racResourceTransports[name];
      // copy callbacks because completion removes each entry
      for (const complete of [...state.pending]) complete();
    }, transport),
    // configure the status and body returned to future or held callers
    respond: (transport, value, status = 200) => page.evaluate(({ name, response, responseStatus }) => {
      const state = (window as TestWindow).__racResourceTransports[name];
      state.response = response;
      state.status = responseStatus;
    }, { name: transport, response: value, responseStatus: status }),
    // publish one complete newline-delimited live sample
    pushLive: value => page.evaluate(sample => {
      const encoder = new TextEncoder();
      // deliver to the currently owned visible-flyout stream
      for (const controller of [...(window as TestWindow).__racResourceLive.controllers]) {
        try { controller.enqueue(encoder.encode(`${JSON.stringify(sample)}\n`)); } catch { /* reader closed during this turn */ }
      }
    }, value),
    // publish one exact fragment for framing and malformed-record tests
    pushLiveRaw: value => page.evaluate(fragment => {
      const encoder = new TextEncoder();
      // deliver to the currently owned visible-flyout stream
      for (const controller of [...(window as TestWindow).__racResourceLive.controllers]) {
        try { controller.enqueue(encoder.encode(fragment)); } catch { /* reader closed during this turn */ }
      }
    }, value)
  };
}

// provide the smallest authenticated dashboard surface used by the server flyout
async function installFixture(page: Page, monitoring: boolean, options?: Parameters<typeof installResourceTransports>[1]): Promise<ResourceControls> {
  await mockAccountSocket(page);
  const controls = await installResourceTransports(page, options);
  let resourceMonitoring = monitoring;
  let sessionRequests = 0;
  // keep the rendered fixture free of unrelated missing-icon noise
  await page.route('**/instance-icons/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2" fill="#89b4fa"/><path d="M8 21h8" stroke="#cdd6f4" stroke-width="2"/></svg>' }));
  // isolate every application request from the live stack
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one controlling browser
    if (url.pathname === '/api/auth/session') {
      sessionRequests += 1;
      return route.fulfill({ json: { csrfToken: 'resource-csrf', active: true, deviceName: 'Resource browser', resourceMonitoring, server: { name: 'Fixture server', url: 'https://fixture.example.test', remotes: [] } } });
    }
    // publish an empty ready dashboard
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, editor: false, adapters: {}, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    // authorize the dashboard socket
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'resource-dashboard-ticket' } });
    // keep unrelated optional monitors settled
    if (url.pathname === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // suppress push setup in this fixture
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // settle update polling
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // keep the current server idle
    if (url.pathname === '/api/server-statuses') return route.fulfill({ json: { servers: [{ name: 'Fixture server', url: 'https://fixture.example.test', attention: 'idle' }] } });
    // supply deterministic revision details
    if (url.pathname === '/api/server/revision') return route.fulfill({ json: { sha: '1'.repeat(40), committedAt: '2026-11-17T19:00:00.000Z' } });
    // disable optional cloudflare state
    if (url.pathname === '/api/settings/cloudflare/health') return route.fulfill({ json: { state: 'disabled' } });
    // retain the default console theme
    if (url.pathname === '/api/console/theme') return route.fulfill({ json: {} });
    // settle settings restart state
    if (url.pathname === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    // leave the optional assistant idle
    if (url.pathname === '/api/davo/conversation') return route.fulfill({ json: {} });
    // settle push receipt polling
    if (url.pathname === '/api/push/receipts') return route.fulfill({ json: { receipts: [] } });
    return route.fulfill({ status: 404, json: { error: `not mocked: ${url.pathname}` } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Switch server/u })).toBeVisible();
  return {
    ...controls,
    // expose the installation flag without bypassing the application's refresh path
    sessionSummary: async () => ({ requests: sessionRequests, resourceMonitoring }),
    // mutate only future authenticated session responses
    setSessionMonitoring: async value => { resourceMonitoring = value; }
  };
}

// open the server selector and return its resource section
async function openResources(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /^Switch server/u }).click();
  const resources = page.getByRole('region', { name: 'Server resource monitoring' });
  await expect(resources).toBeVisible();
  return resources;
}

// publish an enabled installation flag through the authenticated refresh path
async function enableMonitoring(page: Page, controls: ResourceControls): Promise<void> {
  const previous = await controls.sessionSummary();
  await controls.setSessionMonitoring(true);
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect.poll(async () => (await controls.sessionSummary()).requests).toBeGreaterThan(previous.requests);
}

// publish a disabled installation flag through the authenticated refresh path
async function disableMonitoring(page: Page, controls: ResourceControls): Promise<void> {
  const previous = await controls.sessionSummary();
  await controls.setSessionMonitoring(false);
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/session');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect.poll(async () => (await controls.sessionSummary()).requests).toBeGreaterThan(previous.requests);
}

// emulate tab visibility without depending on a headed browser window
async function setVisibility(page: Page, visibility: DocumentVisibilityState): Promise<void> {
  await page.evaluate(value => {
    const view = window as TestWindow;
    view.__racVisibility = value;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => view.__racVisibility });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => view.__racVisibility === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visibility);
}

// require one transport to reach an exact lifecycle state
async function expectSummary(controls: ResourceControls, transport: ResourceTransport, expected: RequestSummary): Promise<void> {
  await expect.poll(() => controls.summary(transport)).toEqual(expected);
}

// resolve a theme token through the active color mode
async function themeColor(page: Page, token: '--teal' | '--yellow' | '--peach' | '--red' | '--overlay-2'): Promise<string> {
  return page.evaluate(name => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

// read one gauge's numeric stroke contract
async function gaugeValue(button: Locator, resource: 'cpu' | 'memory'): Promise<number | undefined> {
  const gauge = button.locator(`.server-selector-gauge-fill[data-resource="${resource}"]`);
  // unavailable and zero primary metrics omit their active fill
  if (await gauge.count() === 0) return undefined;
  const dasharray = await gauge.getAttribute('stroke-dasharray');
  return dasharray === null ? undefined : Number.parseFloat(dasharray);
}

// apply mixed threshold values to every disk namespace
function thresholdDisks(wsl: number, host: number) {
  const sample = diskSample();
  // retain each capacity while changing its utilization
  for (const [usage, value] of [[sample.wsl, wsl], [sample.host, host]] as const) {
    usage.disks = usage.disks.map(disk => ({ ...disk, usedBytes: disk.totalBytes * value / 100 }));
  }
  return sample;
}

test('uses the installation session flag and ignores legacy browser storage across reloads', async ({ page }) => {
  const controls = await installFixture(page, false);
  await expectSummary(controls, 'metrics', { requests: 0, aborts: 0, active: 0, maxActive: 0 });
  await expectSummary(controls, 'disks', { requests: 0, aborts: 0, active: 0, maxActive: 0 });

  // a retained browser-era opt-in cannot enable an installation that is off
  await page.evaluate(() => {
    localStorage.setItem('rac.resource-monitoring', 'enabled');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.resource-monitoring', newValue: 'enabled' }));
  });
  await page.reload();
  await expect(page.getByRole('button', { name: /^Switch server/u })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rac.resource-monitoring'))).toBe('enabled');
  await expectSummary(controls, 'metrics', { requests: 0, aborts: 0, active: 0, maxActive: 0 });
  await expectSummary(controls, 'disks', { requests: 0, aborts: 0, active: 0, maxActive: 0 });

  await enableMonitoring(page, controls);
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expect(selector.locator('.server-selector-resource-gauges')).toBeVisible();

  // removing the obsolete key cannot disable the installation-wide flag
  await page.evaluate(() => {
    localStorage.removeItem('rac.resource-monitoring');
    window.dispatchEvent(new StorageEvent('storage', { key: 'rac.resource-monitoring', oldValue: 'enabled' }));
  });
  await expect(selector.locator('.server-selector-resource-gauges')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: /^Switch server/u }).locator('.server-selector-resource-gauges')).toBeVisible();
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 1, aborts: 0, active: 0, maxActive: 1 });

  // a stale opt-in remains inert when the installation later turns off
  await page.evaluate(() => localStorage.setItem('rac.resource-monitoring', 'enabled'));
  await openResources(page);
  await disableMonitoring(page, controls);
  await expect(page.getByRole('region', { name: 'Server resource monitoring' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Switch server/u }).locator('.server-selector-resource-gauges')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rac.resource-monitoring'))).toBe('enabled');
  await expect.poll(async () => (await controls.sessionSummary()).resourceMonitoring).toBe(false);
});

test('stays idle when off and samples metrics every minute independently from disk refreshes', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const controls = await installFixture(page, false);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));

  // disabled monitoring must remain idle across every schedule
  await page.clock.fastForward(20 * 60_000);
  await expectSummary(controls, 'metrics', { requests: 0, aborts: 0, active: 0, maxActive: 0 });
  await expectSummary(controls, 'disks', { requests: 0, aborts: 0, active: 0, maxActive: 0 });
  await page.getByRole('button', { name: /^Switch server/u }).click();
  await expect(page.getByRole('region', { name: 'Server resource monitoring' })).toHaveCount(0);
  await expectSummary(controls, 'live', { requests: 0, aborts: 0, active: 0, maxActive: 0 });
  await page.keyboard.press('Escape');

  await enableMonitoring(page, controls);
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'live', { requests: 0, aborts: 0, active: 0, maxActive: 0 });

  // metric cadence starts at the exact one-minute boundary while closed
  await page.clock.fastForward(60_000 - 1);
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await page.clock.fastForward(1);
  await expectSummary(controls, 'metrics', { requests: 2, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 1, aborts: 0, active: 0, maxActive: 1 });

  // disk cadence remains ten minutes while metrics continue every minute
  for (let minute = 0; minute < 9; minute += 1) await page.clock.fastForward(60_000);
  await expectSummary(controls, 'metrics', { requests: 11, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 2, aborts: 0, active: 0, maxActive: 1 });
  await openResources(page);
  await expectSummary(controls, 'metrics', { requests: 11, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 3, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'live', { requests: 1, aborts: 0, active: 1, maxActive: 1 });
  await page.keyboard.press('Escape');
  await expectSummary(controls, 'live', { requests: 1, aborts: 1, active: 0, maxActive: 1 });
});

test('shows skeletons first then reuses cached metrics without requesting them on flyout open', async ({ page }) => {
  const controls = await installFixture(page, true, { holdMetrics: true, holdDisks: true });
  const resources = await openResources(page);
  await expect(resources).toHaveAttribute('aria-busy', 'true');
  await expect(resources.getByRole('status').filter({ hasText: 'Loading server resources' })).toBeAttached();
  expect(await resources.locator('.server-resource-skeleton .skeleton').count()).toBeGreaterThan(3);
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 1, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 1, aborts: 0, active: 1, maxActive: 1 });
  await expectSummary(controls, 'live', { requests: 1, aborts: 0, active: 1, maxActive: 1 });

  await controls.release('metrics');
  await controls.release('disks');
  await expect(resources).not.toHaveAttribute('aria-busy', 'true');
  await expect(resources.locator('.server-resource-skeleton')).toHaveCount(0);
  const hostCpu = resources.getByRole('group', { name: 'Host resources' }).getByRole('meter', { name: 'CPU usage' });
  await expect(hostCpu).toHaveAttribute('aria-valuenow', '37.5');
  await page.keyboard.press('Escape');
  await expectSummary(controls, 'live', { requests: 1, aborts: 1, active: 0, maxActive: 1 });

  // reopen must synchronously paint the cache and refresh disks only
  await controls.hold('disks', true);
  const reopened = await openResources(page);
  await expect(reopened.locator('.server-resource-skeleton')).toHaveCount(0);
  await expect(reopened.getByRole('group', { name: 'Host resources' }).getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '37.5');
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 2, aborts: 0, active: 1, maxActive: 1 });
  await expectSummary(controls, 'live', { requests: 2, aborts: 1, active: 1, maxActive: 1 });
});

test('updates the open flyout every second without adding live readings to button averages', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const controls = await installFixture(page, false, { metrics: metricsSample(10, 20, 90, 80) });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  // establish the minute cache after the clock is frozen
  await enableMonitoring(page, controls);
  const selector = page.getByRole('button', { name: /^Switch server/u });
  const resources = await openResources(page);
  const wsl = resources.getByRole('group', { name: 'WSL resources' });
  await expect(wsl.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '10');
  await expect(wsl.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '20');
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 2, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'live', { requests: 1, aborts: 0, active: 1, maxActive: 1 });

  // publish the first one-second flyout-only reading
  await page.clock.fastForward(1_000);
  await controls.pushLive(metricsSample(80, 90, 10, 20));
  await expect(wsl.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '80');
  await expect(wsl.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '90');
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(10);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(20);

  // later live records still do not trigger one-shot metric or disk requests
  await page.clock.fastForward(1_000);
  await controls.pushLive(metricsSample(40, 50, 10, 20));
  await expect(wsl.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '40');
  await expect(wsl.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '50');
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 2, aborts: 0, active: 0, maxActive: 1 });
  await page.keyboard.press('Escape');
  await expectSummary(controls, 'live', { requests: 1, aborts: 1, active: 0, maxActive: 1 });

  // reopening paints the last live value before its new stream produces data
  const reopened = await openResources(page);
  await expect(reopened.locator('.server-resource-skeleton')).toHaveCount(0);
  await expect(reopened.getByRole('group', { name: 'WSL resources' }).getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '40');
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 3, aborts: 0, active: 0, maxActive: 1 });
  await page.keyboard.press('Escape');

  // the next minute reading supersedes the older flyout cache
  await controls.respond('metrics', metricsSample(15, 25, 10, 20));
  await page.clock.fastForward(58_000);
  await expectSummary(controls, 'metrics', { requests: 2, aborts: 0, active: 0, maxActive: 1 });
  const refreshed = await openResources(page);
  await expect(refreshed.getByRole('group', { name: 'WSL resources' }).getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '15');
  await expect(refreshed.getByRole('group', { name: 'WSL resources' }).getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '25');
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(12.5);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(22.5);
});

test('cancels the exact live stream on close, hidden tabs, and opt-out', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const controls = await installFixture(page, false, { holdMetrics: true, holdDisks: true });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await enableMonitoring(page, controls);
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 1, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 1, aborts: 0, active: 1, maxActive: 1 });

  await openResources(page);
  await expectSummary(controls, 'live', { requests: 1, aborts: 0, active: 1, maxActive: 1 });
  await page.keyboard.press('Escape');
  await expectSummary(controls, 'live', { requests: 1, aborts: 1, active: 0, maxActive: 1 });

  // hiding an open flyout cancels its second owner
  await openResources(page);
  await expectSummary(controls, 'live', { requests: 2, aborts: 1, active: 1, maxActive: 1 });
  await setVisibility(page, 'hidden');
  await expectSummary(controls, 'live', { requests: 2, aborts: 2, active: 0, maxActive: 1 });
  await setVisibility(page, 'visible');
  await expectSummary(controls, 'live', { requests: 3, aborts: 2, active: 1, maxActive: 1 });

  // opt-out cancels the visible stream and both pending background owners
  await disableMonitoring(page, controls);
  await expect(page.getByRole('region', { name: 'Server resource monitoring' })).toHaveCount(0);
  await expectSummary(controls, 'live', { requests: 3, aborts: 3, active: 0, maxActive: 1 });
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 1, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 1, aborts: 1, active: 0, maxActive: 1 });
  await controls.release('metrics');
  await controls.release('disks');
  await page.clock.fastForward(20 * 60_000);
  await expectSummary(controls, 'live', { requests: 3, aborts: 3, active: 0, maxActive: 1 });
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 1, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 1, aborts: 1, active: 0, maxActive: 1 });
});

test('frames live records, keeps stale readings on errors, and recovers on the next stream', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const controls = await installFixture(page, false);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await enableMonitoring(page, controls);
  const selector = page.getByRole('button', { name: /^Switch server/u });
  const resources = await openResources(page);
  const cpu = resources.getByRole('group', { name: 'WSL resources' }).getByRole('meter', { name: 'CPU usage' });
  const splitRecord = JSON.stringify(metricsSample(55, 65, 20, 30));
  const boundary = Math.floor(splitRecord.length / 2);

  // an incomplete record must not replace the readable minute cache
  await controls.pushLiveRaw(splitRecord.slice(0, boundary));
  await expect(cpu).toHaveAttribute('aria-valuenow', '12.25');
  await controls.pushLiveRaw(`${splitRecord.slice(boundary)}\n`);
  await expect(cpu).toHaveAttribute('aria-valuenow', '55');

  // several records in one chunk publish only their latest rendered result
  await controls.pushLiveRaw(`${JSON.stringify(metricsSample(60, 70, 20, 30))}\n${JSON.stringify(metricsSample(70, 80, 20, 30))}\n`);
  await expect(cpu).toHaveAttribute('aria-valuenow', '70');
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(12.25);

  // reject one malformed sample without clearing the last usable live value
  await controls.pushLiveRaw('{}\n');
  await expect(cpu).toHaveAttribute('aria-valuenow', '70');
  await expect(resources.getByRole('status').filter({ hasText: 'CPU or memory refresh failed. Showing last available readings.' })).toBeVisible();
  await expect.poll(async () => (await controls.summary('live')).active).toBe(0);
  await page.clock.fastForward(2_000);
  await expectSummary(controls, 'live', { requests: 2, aborts: 1, active: 1, maxActive: 1 });

  // the retry connection can replace stale data without changing averages
  await controls.pushLive(metricsSample(44, 54, 20, 30));
  await expect(cpu).toHaveAttribute('aria-valuenow', '44');
  await expect(resources.getByRole('status').filter({ hasText: 'CPU or memory refresh failed. Showing last available readings.' })).toHaveCount(0);
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(12.25);
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 2, aborts: 0, active: 0, maxActive: 1 });
});

test('keeps newer live WSL readings across late and partial minute responses', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const controls = await installFixture(page, false, { holdMetrics: true });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await enableMonitoring(page, controls);
  const selector = page.getByRole('button', { name: /^Switch server/u });
  const resources = await openResources(page);
  await page.clock.fastForward(1);

  // a live response received after the minute request started owns the flyout
  await controls.pushLive(metricsSample(70, 80, 30, 40));
  const wsl = resources.getByRole('group', { name: 'WSL resources' });
  const host = resources.getByRole('group', { name: 'Host resources' });
  await expect(wsl.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '70');
  await expect(host.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '30');

  // completing the older held minute request must not roll back live values
  await controls.release('metrics');
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });
  await expect(wsl.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '70');
  await expect(wsl.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '80');
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(12.25);
  await page.keyboard.press('Escape');

  // a later partial minute updates Host without replacing newer live WSL
  const freshHost = metricsSample(1, 1, 99, 60);
  await controls.hold('metrics', false);
  await controls.respond('metrics', { sampledAt: freshHost.sampledAt, host: freshHost.host, errors: ['WSL resource monitoring is unavailable.'] });
  await page.clock.fastForward(60_000 - 1);
  await expectSummary(controls, 'metrics', { requests: 2, aborts: 0, active: 0, maxActive: 1 });
  const reopened = await openResources(page);
  const reopenedWsl = reopened.getByRole('group', { name: 'WSL resources' });
  const reopenedHost = reopened.getByRole('group', { name: 'Host resources' });
  await expect(reopenedWsl.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '70');
  await expect(reopenedWsl.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '80');
  await expect(reopenedHost.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '99');
  await expect(reopenedHost.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '60');
  await expect(reopened.getByRole('status').filter({ hasText: 'CPU or memory refresh failed. Showing last available readings.' })).toBeVisible();
});

test('renders WSL first with memory capacity in its label and mount-only disk bars', async ({ page }) => {
  const controls = await installFixture(page, true, { metrics: metricsSample(55, 90, 37.5, 50) });
  const resources = await openResources(page);
  const groups = resources.locator('.server-resource-group');
  await expect(groups).toHaveCount(2);
  await expect.poll(() => groups.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['WSL resources', 'Host resources']);
  await expect(resources.getByRole('group', { name: 'WSL resources' }).locator('.server-resource-group-title')).toHaveCount(0);
  await expect(resources.getByRole('group', { name: 'Host resources' }).locator('.server-resource-group-title')).toHaveText('Host');

  const wsl = resources.getByRole('group', { name: 'WSL resources' });
  const host = resources.getByRole('group', { name: 'Host resources' });
  await expect(wsl.getByText('Memory (9 GB)', { exact: true })).toBeVisible();
  await expect(host.getByText('Memory (18 GB)', { exact: true })).toBeVisible();
  await expect(wsl.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute('aria-valuenow', '90');
  await expect(resources.getByText('8 GB / 9 GB', { exact: true })).toHaveCount(0);
  await expect(resources.getByText('9 GB / 18 GB', { exact: true })).toHaveCount(0);

  await expect(host.locator('.server-resource-disk')).toHaveCount(2);
  await expect(wsl.locator('.server-resource-disk')).toHaveCount(2);
  await expect(host.getByRole('meter', { name: 'C:\\ usage' })).toHaveAttribute('aria-valuetext', '108 GB / 215 GB');
  await expect(wsl.getByRole('meter', { name: '/ usage' })).toHaveAttribute('aria-valuetext', '86 GB / 172 GB');
  await expect(host.locator('.server-resource-disk')).toHaveText(['C:\\108 GB / 215 GB', 'D:\\275 GB / 1.1 TB']);
  await expect(wsl.locator('.server-resource-disk')).toHaveText(['/86 GB / 172 GB', '/mnt/data537 GB / 1.1 TB']);
  await expect(resources.locator('.server-resource-disk').filter({ hasText: '%' })).toHaveCount(0);
  await expectSummary(controls, 'metrics', { requests: 1, aborts: 0, active: 0, maxActive: 1 });

  // keep the flyout and mount-only rows usable on a phone viewport
  await page.setViewportSize({ width: 360, height: 640 });
  const menu = page.getByRole('group', { name: 'Remote Agents servers' });
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  const lastDisk = host.locator('.server-resource-disk').last();
  await lastDisk.scrollIntoViewIfNeeded();
  await expect(lastDisk).toBeInViewport();
});

// keep display rounding separate from precise resource geometry
test('rounds labels upward while preserving fractional bars and gauges', async ({ page }) => {
  const disks = diskSample();
  disks.wsl.disks = [
    { mount: '/', usedBytes: 1_000_000_001, totalBytes: 12_000_000_001 },
    { mount: '/mnt/data', usedBytes: 1_250_000_000_000, totalBytes: 2_000_000_000_000 }
  ];
  disks.host.disks = [
    { mount: 'C:\\', usedBytes: 999, totalBytes: 1_000 },
    { mount: 'D:\\', usedBytes: 1_000_000, totalBytes: 1_000_000_000 }
  ];
  await installFixture(page, true, { metrics: metricsSample(0.1, 50.1), disks });
  const selector = page.getByRole('button', { name: /^Switch server/u });
  const cpuGauge = selector.locator('.server-selector-gauge-fill[data-resource="cpu"]');
  const memoryGauge = selector.locator('.server-selector-gauge-fill[data-resource="memory"]');
  await expect(cpuGauge).toHaveAttribute('stroke-dasharray', '0.1 100');
  await expect(memoryGauge).toHaveAttribute('stroke-dasharray', '50.1 100');
  await expect(selector).toHaveAttribute('aria-description', /5-minute CPU average: 1%/u);
  await expect(selector).toHaveAttribute('aria-description', /5-minute memory average: 51%/u);

  const resources = await openResources(page);
  const wsl = resources.getByRole('group', { name: 'WSL resources' });
  const host = resources.getByRole('group', { name: 'Host resources' });
  const cpu = wsl.getByRole('meter', { name: 'CPU usage' });
  const memory = wsl.getByRole('meter', { name: 'Memory usage' });
  await expect(cpu).toHaveAttribute('aria-valuenow', '0.1');
  await expect(cpu).toHaveAttribute('aria-valuetext', '1%');
  await expect(memory).toHaveAttribute('aria-valuenow', '50.1');
  await expect(memory).toHaveAttribute('aria-valuetext', '51%');
  await expect.poll(() => cpu.evaluate(meter => meter.style.getPropertyValue('--resource-fill'))).toBe('0.1%');
  await expect.poll(() => memory.evaluate(meter => meter.style.getPropertyValue('--resource-fill'))).toBe('50.1%');
  await expect(cpu.locator('..').getByText('1%', { exact: true })).toBeVisible();
  await expect(memory.locator('..').getByText('51%', { exact: true })).toBeVisible();
  const fill = cpu.locator('.server-resource-bar-fill');
  await expect(fill).toHaveCSS('border-top-right-radius', '0px');
  await expect(fill).toHaveCSS('border-bottom-right-radius', '0px');
  await expect(wsl.getByRole('meter', { name: '/ usage' })).toHaveAttribute('aria-valuetext', '2 GB / 13 GB');
  await expect(wsl.getByRole('meter', { name: '/mnt/data usage' })).toHaveAttribute('aria-valuetext', '1.3 TB / 2.0 TB');
  await expect(host.getByRole('meter', { name: 'C:\\ usage' })).toHaveAttribute('aria-valuetext', '999 B / 1 KB');
  await expect(host.getByRole('meter', { name: 'D:\\ usage' })).toHaveAttribute('aria-valuetext', '1 MB / 1 GB');
});

test('draws mirrored primary-server gauges and averages only the trailing five minutes', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const controls = await installFixture(page, false, { metrics: metricsSample(10, 20, 90, 80) });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  const selector = page.getByRole('button', { name: /^Switch server/u });
  const beforeGauge = await selector.boundingBox();
  expect(beforeGauge).not.toBeNull();
  // establish the first received sample at the frozen clock boundary
  await enableMonitoring(page, controls);
  await expect(selector.locator('.server-selector-resource-gauges')).toBeVisible();
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(10);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(20);
  await expect(selector).toHaveAttribute('aria-description', /5-minute CPU average: 10%/u);
  await expect(selector).toHaveAttribute('aria-description', /5-minute memory average: 20%/u);

  // inspect painted geometry in screen space against the actual button edge
  const decoration = await selector.evaluate(button => {
    const buttonRect = button.getBoundingClientRect();
    const svg = button.querySelector<SVGSVGElement>('.server-selector-resource-gauges')!;
    const svgRect = svg.getBoundingClientRect();
    const svgStyle = getComputedStyle(svg);
    const transform = svgStyle.transform === 'none' ? new DOMMatrix() : new DOMMatrix(svgStyle.transform);
    const screen = svg.getScreenCTM()!;
    // project exact endpoint coordinates into painted screen space
    const project = (x: number, y: number) => {
      const painted = new DOMPoint(x, y).matrixTransform(screen);
      return { x: painted.x, y: painted.y };
    };
    const paths = [...svg.querySelectorAll<SVGPathElement>('.server-selector-gauge-fill')].map(path => {
      const length = path.getTotalLength();
      // project one normalized path point into painted screen coordinates
      const point = (offset: number) => {
        const local = path.getPointAtLength(offset);
        return project(local.x, local.y);
      };
      return { resource: path.dataset.resource, start: point(0), middle: point(length / 2), end: point(length), pathLength: path.getAttribute('pathLength'), filter: getComputedStyle(path).filter };
    });
    const endpoints = svg.querySelector<SVGPathElement>('.server-selector-gauge-endpoints')!;
    const endpointStyle = getComputedStyle(endpoints);
    // sample the centers from the painted path itself
    const endpointPoint = (offset: number) => {
      const local = endpoints.getPointAtLength(offset);
      return project(local.x, local.y);
    };
    return {
      button: { left: buttonRect.left, right: buttonRect.right, top: buttonRect.top, bottom: buttonRect.bottom, width: buttonRect.width, height: buttonRect.height },
      svg: { left: svgRect.left, right: svgRect.right, top: svgRect.top, bottom: svgRect.bottom, width: svgRect.width, height: svgRect.height },
      buttonOverflow: getComputedStyle(button).overflow,
      svgOverflow: svgStyle.overflow,
      pointerEvents: svgStyle.pointerEvents,
      transform: { a: transform.a, b: transform.b, c: transform.c, d: transform.d },
      paths,
      endpoints: {
        d: endpoints.getAttribute('d'),
        length: endpoints.getTotalLength(),
        topCenter: endpointPoint(2),
        bottomCenter: endpointPoint(6),
        stroke: endpointStyle.stroke,
        strokeWidth: endpointStyle.strokeWidth,
        vectorEffect: endpointStyle.vectorEffect,
        strokeLinecap: endpointStyle.strokeLinecap,
        filter: endpointStyle.filter
      },
      paintOrder: [...svg.children].map(child => `${child.tagName.toLowerCase()}.${child.getAttribute('class') ?? ''}`)
    };
  });
  const afterGauge = await selector.boundingBox();
  expect(afterGauge).not.toBeNull();
  expect(afterGauge).toEqual(beforeGauge);
  expect(decoration.paths.map(path => path.resource)).toEqual(['cpu', 'memory']);
  expect(decoration.buttonOverflow).toBe('visible');
  expect(decoration.svgOverflow).toBe('visible');
  expect(decoration.pointerEvents).toBe('none');
  expect(decoration.transform).toEqual({ a: 1, b: 0, c: 0, d: 1 });
  expect(decoration.paintOrder).toEqual(['g.', 'g.', 'path.server-selector-gauge-endpoints']);
  expect(decoration.endpoints.d).toBe('M 20 -2 V 2 M 20 38 V 42');
  expect(decoration.endpoints.length).toBe(8);
  expect(decoration.endpoints.stroke).toBe('rgb(0, 0, 0)');
  expect(decoration.endpoints.strokeWidth).toBe('1px');
  expect(decoration.endpoints.vectorEffect).toBe('non-scaling-stroke');
  expect(decoration.endpoints.strokeLinecap).toBe('butt');
  expect(decoration.endpoints.filter).toBe('none');
  await expect(selector.locator('img')).toBeVisible();
  await expect(selector.locator('.server-switcher-attention')).toBeAttached();
  await selector.focus();
  await expect(selector).toBeFocused();
  const edgeTolerance = 0.75;
  expect(Math.abs(decoration.svg.left - decoration.button.left)).toBeLessThanOrEqual(edgeTolerance);
  expect(Math.abs(decoration.svg.right - decoration.button.right)).toBeLessThanOrEqual(edgeTolerance);
  expect(Math.abs(decoration.svg.top - decoration.button.top)).toBeLessThanOrEqual(edgeTolerance);
  expect(Math.abs(decoration.svg.bottom - decoration.button.bottom)).toBeLessThanOrEqual(edgeTolerance);
  const centerX = decoration.button.left + decoration.button.width / 2;
  expect(Math.abs(decoration.endpoints.topCenter.x - centerX)).toBeLessThanOrEqual(edgeTolerance);
  expect(Math.abs(decoration.endpoints.topCenter.y - decoration.button.top)).toBeLessThanOrEqual(edgeTolerance);
  expect(Math.abs(decoration.endpoints.bottomCenter.x - centerX)).toBeLessThanOrEqual(edgeTolerance);
  expect(Math.abs(decoration.endpoints.bottomCenter.y - decoration.button.bottom)).toBeLessThanOrEqual(edgeTolerance);
  // compare each painted route rather than its source string
  for (const path of decoration.paths) {
    const centerY = decoration.button.top + decoration.button.height / 2;
    expect(path.pathLength).toBe('100');
    expect(Math.abs(path.start.x - centerX)).toBeLessThanOrEqual(edgeTolerance);
    expect(Math.abs(path.start.y - decoration.button.bottom)).toBeLessThanOrEqual(edgeTolerance);
    expect(Math.abs(path.end.x - centerX)).toBeLessThanOrEqual(edgeTolerance);
    expect(Math.abs(path.end.y - decoration.button.top)).toBeLessThanOrEqual(edgeTolerance);
    expect(Math.abs(path.middle.y - centerY)).toBeLessThanOrEqual(edgeTolerance);
    expect(Math.abs(path.middle.x - (path.resource === 'cpu' ? decoration.button.left : decoration.button.right))).toBeLessThanOrEqual(edgeTolerance);
    expect(path.filter.match(/drop-shadow/gu)).toHaveLength(2);
  }

  // add four normal one-minute samples to the rolling window
  for (const [minute, cpu, memory] of [[1, 30, 40], [2, 50, 60], [3, 70, 80], [4, 90, 100]] as const) {
    await controls.respond('metrics', metricsSample(cpu, memory, 1, 1));
    await page.clock.fastForward(60_000);
    await expectSummary(controls, 'metrics', { requests: minute + 1, aborts: 0, active: 0, maxActive: 1 });
  }
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(50);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(60);

  // the first sample remains through the final millisecond before expiry
  await controls.hold('metrics', true);
  await page.clock.fastForward(60_000 - 1);
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(50);
  // exactly five minutes old is outside the rolling window
  await page.clock.fastForward(1);
  await expectSummary(controls, 'metrics', { requests: 6, aborts: 0, active: 1, maxActive: 1 });
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(60);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(70);

  // the fifth newer sample keeps the window bounded to five readings
  await controls.respond('metrics', metricsSample(100, 100, 1, 1));
  await controls.release('metrics');
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(68);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(76);

  // a confirmed host-only boundary resets WSL history instead of averaging namespaces
  const hostOnly = metricsSample(1, 1, 44, 25);
  await controls.hold('metrics', false);
  await controls.respond('metrics', { sampledAt: hostOnly.sampledAt, host: hostOnly.host });
  await page.clock.fastForward(60_000);
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(44);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(25);
});

// retain endpoint hairlines across zero and full readings only while gauges exist
test('keeps endpoint hairlines at zero and full usage', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const controls = await installFixture(page, false, { metrics: metricsSample(100, 100) });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  const selector = page.getByRole('button', { name: /^Switch server/u });
  const endpoints = selector.locator('.server-selector-gauge-endpoints');
  await expect(endpoints).toHaveCount(0);
  await enableMonitoring(page, controls);
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(100);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(100);
  await expect(endpoints).toHaveCount(1);

  const button = await selector.boundingBox();
  expect(button).not.toBeNull();
  // include the two-pixel overhang around the actual control
  await page.screenshot({
    path: testInfo.outputPath('server-resource-gauge-endpoints-100.png'),
    clip: { x: Math.max(0, button!.x - 8), y: Math.max(0, button!.y - 8), width: button!.width + 16, height: button!.height + 16 }
  });

  // reset the average while retaining one zero and one full reading
  const split = metricsSample(1, 1, 0, 100);
  await controls.respond('metrics', { sampledAt: split.sampledAt, host: split.host });
  await page.clock.fastForward(60_000);
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBeUndefined();
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(100);
  await expect(selector).toHaveAttribute('aria-description', /5-minute CPU average: 0%/u);
  await expect(endpoints).toHaveCount(1);

  // remove the decoration once the active namespace has no gauge readings
  const unavailable = metricsSample(null, 1);
  await controls.respond('metrics', { sampledAt: unavailable.sampledAt, host: unavailable.host, wsl: { ...unavailable.wsl, memory: null } });
  await page.clock.fastForward(60_000);
  await expect(selector.locator('.server-selector-resource-gauges')).toHaveCount(0);
  await expect(endpoints).toHaveCount(0);
});

test('omits unavailable gauge fills, preserves a zero track, and shares disk status colors', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const controls = await installFixture(page, false, { metrics: metricsSample(null, 85, 95, 95), disks: thresholdDisks(95, 85) });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  // establish both optional caches after the clock is frozen
  await enableMonitoring(page, controls);
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect(selector.locator('.server-selector-resource-gauges')).toBeVisible();
  await expect(selector.locator('.server-selector-gauge-fill[data-resource="cpu"]')).toHaveCount(0);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(85);
  const orange = await themeColor(page, '--peach');
  const critical = await themeColor(page, '--red');
  await expect.poll(() => selector.locator('.server-selector-gauge-fill[data-resource="memory"]').evaluate(path => getComputedStyle(path).stroke)).toBe(orange);
  await expect.poll(() => selector.locator('.server-selector-gauge-fill[data-resource="memory"]').evaluate(path => getComputedStyle(path).filter.match(/drop-shadow/gu)?.length)).toBe(2);

  const resources = await openResources(page);
  const wsl = resources.getByRole('group', { name: 'WSL resources' });
  const host = resources.getByRole('group', { name: 'Host resources' });
  await expect.poll(() => wsl.getByRole('meter', { name: 'Memory usage' }).locator('.server-resource-bar-fill').evaluate(fill => getComputedStyle(fill).backgroundColor)).toBe(orange);
  await expect.poll(() => wsl.getByRole('meter', { name: '/ usage' }).locator('.server-resource-bar-fill').evaluate(fill => getComputedStyle(fill).backgroundColor)).toBe(critical);
  await expect.poll(() => host.getByRole('meter', { name: 'C:\\ usage' }).locator('.server-resource-bar-fill').evaluate(fill => getComputedStyle(fill).backgroundColor)).toBe(orange);
  await expect.poll(() => host.getByRole('meter', { name: 'CPU usage' }).locator('.server-resource-bar-fill').evaluate(fill => getComputedStyle(fill).backgroundColor)).toBe(critical);

  // measured zero shows an opaque gray track but no active stroke
  await controls.respond('metrics', metricsSample(0, 85, 95, 95));
  await page.clock.fastForward(60_000);
  await expect(selector.locator('.server-selector-resource-gauges > g')).toHaveCount(2);
  const zeroTrack = selector.locator('.server-selector-resource-gauges > g').first().locator('.server-selector-gauge-track');
  await expect(zeroTrack).toHaveCSS('stroke', await themeColor(page, '--overlay-2'));
  await expect(selector.locator('.server-selector-gauge-fill[data-resource="cpu"]')).toHaveCount(0);
  await expect(selector).toHaveAttribute('aria-description', /5-minute CPU average: 0%/u);

  // a later normal reading creates only the available side's active stroke
  await controls.respond('metrics', metricsSample(40, 85, 95, 95));
  await page.clock.fastForward(60_000);
  const normal = await themeColor(page, '--teal');
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(20);
  await expect.poll(() => selector.locator('.server-selector-gauge-fill[data-resource="cpu"]').evaluate(path => getComputedStyle(path).stroke)).toBe(normal);
  await expect.poll(() => selector.locator('.server-selector-gauge-fill[data-resource="cpu"]').evaluate(path => getComputedStyle(path).filter.match(/drop-shadow/gu)?.length)).toBe(2);

  // a confirmed critical host boundary uses the same red glowing border
  const criticalHost = metricsSample(1, 1, 95, 95);
  await controls.respond('metrics', { sampledAt: criticalHost.sampledAt, host: criticalHost.host });
  await page.clock.fastForward(60_000);
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(95);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(95);
  await expect.poll(() => selector.locator('.server-selector-gauge-fill[data-resource="cpu"]').evaluate(path => getComputedStyle(path).stroke)).toBe(critical);
  await expect.poll(() => selector.locator('.server-selector-gauge-fill[data-resource="memory"]').evaluate(path => getComputedStyle(path).stroke)).toBe(critical);
});

// verify shared colors at and just above each usage cutoff
test('uses strict yellow, orange, and red thresholds for bars and button borders', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const disks = diskSample();
  const diskThresholds = [50, 50.1, 75, 75.1] as const;
  // cover every lower boundary across the four disk bars
  for (const [disk, value] of [...disks.wsl.disks, ...disks.host.disks].map((disk, index) => [disk, diskThresholds[index]] as const)) {
    disk.usedBytes = disk.totalBytes * value / 100;
  }
  const controls = await installFixture(page, false, { metrics: metricsSample(50, 50.1), disks });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await enableMonitoring(page, controls);
  const selector = page.getByRole('button', { name: /^Switch server/u });
  const normal = await themeColor(page, '--teal');
  const yellow = await themeColor(page, '--yellow');
  const orange = await themeColor(page, '--peach');
  const red = await themeColor(page, '--red');
  const cpuGauge = selector.locator('.server-selector-gauge-fill[data-resource="cpu"]');
  const memoryGauge = selector.locator('.server-selector-gauge-fill[data-resource="memory"]');
  await expect.poll(() => cpuGauge.evaluate(path => getComputedStyle(path).stroke)).toBe(normal);
  await expect.poll(() => memoryGauge.evaluate(path => getComputedStyle(path).stroke)).toBe(yellow);

  // switching namespace resets the gauge average at the exact orange boundary
  const hostThresholds = metricsSample(1, 1, 75, 75.1);
  await controls.respond('metrics', { sampledAt: hostThresholds.sampledAt, host: hostThresholds.host });
  await page.clock.fastForward(60_000);
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(75);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(75.1);
  await expect.poll(() => cpuGauge.evaluate(path => getComputedStyle(path).stroke)).toBe(yellow);
  await expect.poll(() => memoryGauge.evaluate(path => getComputedStyle(path).stroke)).toBe(orange);

  // switching back resets the gauge average at the exact red boundary
  await controls.respond('metrics', metricsSample(90, 90.1));
  await page.clock.fastForward(60_000);
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(90);
  await expect.poll(() => gaugeValue(selector, 'memory')).toBe(90.1);
  await expect.poll(() => cpuGauge.evaluate(path => getComputedStyle(path).stroke)).toBe(orange);
  await expect.poll(() => memoryGauge.evaluate(path => getComputedStyle(path).stroke)).toBe(red);

  const resources = await openResources(page);
  const wsl = resources.getByRole('group', { name: 'WSL resources' });
  const host = resources.getByRole('group', { name: 'Host resources' });
  // read each rendered fill through its meter
  const barColor = (meter: Locator) => meter.locator('.server-resource-bar-fill').evaluate(fill => getComputedStyle(fill).backgroundColor);
  await expect.poll(() => wsl.getByRole('meter', { name: 'CPU usage' }).getAttribute('aria-valuenow')).toBe('90');
  await expect.poll(() => barColor(wsl.getByRole('meter', { name: 'CPU usage' }))).toBe(orange);
  await expect.poll(() => barColor(wsl.getByRole('meter', { name: 'Memory usage' }))).toBe(red);
  await expect.poll(() => barColor(wsl.getByRole('meter', { name: '/ usage' }))).toBe(normal);
  await expect.poll(() => barColor(wsl.getByRole('meter', { name: '/mnt/data usage' }))).toBe(yellow);
  await expect.poll(() => barColor(host.getByRole('meter', { name: 'C:\\ usage' }))).toBe(yellow);
  await expect.poll(() => barColor(host.getByRole('meter', { name: 'D:\\ usage' }))).toBe(orange);
});

test('keeps disk-proven WSL separate when its first metric sample is only partially available', async ({ page }) => {
  const sample = metricsSample(10, 20, 37.5, 50);
  const partial = { sampledAt: sample.sampledAt, host: sample.host, errors: ['WSL resource monitoring is unavailable.'] };
  await installFixture(page, true, { metrics: partial });
  const selector = page.getByRole('button', { name: /^Switch server/u });
  // an uncertain WSL boundary must not substitute Windows readings in the button
  await expect(selector.locator('.server-selector-resource-gauges')).toHaveCount(0);

  const resources = await openResources(page);
  const groups = resources.locator('.server-resource-group');
  await expect.poll(() => groups.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['WSL resources', 'Host resources']);
  const wsl = resources.getByRole('group', { name: 'WSL resources' });
  const host = resources.getByRole('group', { name: 'Host resources' });
  await expect(wsl.getByRole('meter', { name: '/ usage' })).toHaveAttribute('aria-valuetext', '86 GB / 172 GB');
  await expect(wsl.getByRole('meter', { name: 'CPU usage' })).toHaveCount(0);
  await expect(host.locator('.server-resource-group-title')).toHaveText('Host');
  await expect(host.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '37.5');
  await expect(resources.getByRole('status').filter({ hasText: 'CPU or memory refresh failed. Showing last available readings.' })).toBeVisible();
});

test('retains cached values through failed metric refreshes and aborts pending work on disable', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-17T20:00:00Z') });
  const controls = await installFixture(page, false);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  // establish both optional caches after the clock is frozen
  await enableMonitoring(page, controls);
  const selector = page.getByRole('button', { name: /^Switch server/u });
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(12.25);
  const resources = await openResources(page);
  await expect(resources.getByRole('group', { name: 'WSL resources' }).getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '12.25');

  // a failed scheduled response leaves both the button and flyout cache visible
  await controls.respond('metrics', { error: 'Resource inspection unavailable' }, 503);
  await page.clock.fastForward(60_000);
  await expectSummary(controls, 'metrics', { requests: 2, aborts: 0, active: 0, maxActive: 1 });
  await expect.poll(() => gaugeValue(selector, 'cpu')).toBe(12.25);
  await expect(resources.getByRole('group', { name: 'WSL resources' }).getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '12.25');
  await expect(resources.getByRole('status').filter({ hasText: 'CPU or memory refresh failed. Showing last available readings.' })).toBeVisible();

  // disabling cancels both owners and suppresses late held responses
  await controls.respond('metrics', metricsSample(99, 99, 99, 99));
  await controls.hold('metrics', true);
  await controls.hold('disks', true);
  await page.clock.fastForward(60_000);
  await page.keyboard.press('Escape');
  await openResources(page);
  await expectSummary(controls, 'metrics', { requests: 3, aborts: 0, active: 1, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 3, aborts: 0, active: 1, maxActive: 1 });
  await disableMonitoring(page, controls);
  await expect(page.getByRole('region', { name: 'Server resource monitoring' })).toHaveCount(0);
  await expectSummary(controls, 'metrics', { requests: 3, aborts: 1, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 3, aborts: 1, active: 0, maxActive: 1 });
  await controls.release('metrics');
  await controls.release('disks');
  await page.clock.fastForward(20 * 60_000);
  await expectSummary(controls, 'metrics', { requests: 3, aborts: 1, active: 0, maxActive: 1 });
  await expectSummary(controls, 'disks', { requests: 3, aborts: 1, active: 0, maxActive: 1 });
  await expect(selector.locator('.server-selector-resource-gauges')).toHaveCount(0);
});

test('keeps cached disks visible while a flyout refresh is pending or fails', async ({ page }) => {
  const controls = await installFixture(page, true);
  await openResources(page);
  await expect(page.getByRole('meter', { name: 'C:\\ usage' })).toHaveAttribute('aria-valuetext', '108 GB / 215 GB');
  await page.keyboard.press('Escape');

  // hold the next open refresh and configure it to fail
  await controls.hold('disks', true);
  await controls.respond('disks', { error: 'Disk usage unavailable' }, 503);
  const resources = await openResources(page);
  await expectSummary(controls, 'disks', { requests: 3, aborts: 0, active: 1, maxActive: 1 });
  await expect(resources.getByRole('meter', { name: 'C:\\ usage' })).toHaveAttribute('aria-valuetext', '108 GB / 215 GB');

  // a failed refresh must retain the previous successful capacities
  await controls.release('disks');
  await expectSummary(controls, 'disks', { requests: 3, aborts: 0, active: 0, maxActive: 1 });
  await expect(resources.getByRole('meter', { name: 'C:\\ usage' })).toHaveAttribute('aria-valuetext', '108 GB / 215 GB');
  await expect(resources).not.toContainText('Disk usage unavailable.');
  await expect(resources.getByRole('status').filter({ hasText: 'Disk refresh failed. Showing last available readings.' })).toBeVisible();
});
