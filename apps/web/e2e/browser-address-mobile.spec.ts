import { expect, test, type Locator, type Page } from '@playwright/test';
import { installPaneMock, seedPaneSize } from './pane-stream-mock.js';

type ClipboardState = {
  text: string;
  denied: boolean;
  deferReads: boolean;
  clipboardPermission: PermissionState | 'unsupported';
  reads: number;
  pendingReads: number;
  releaseRead?: () => void;
};

type ClipboardWindow = typeof window & { __browserAddressClipboard: ClipboardState };

const homeUrl = 'https://preview.example.test/home';

// install one controllable clipboard reader before the app loads
async function installClipboardMock(page: Page, text = '', clipboardPermission: PermissionState | 'unsupported' = 'granted') {
  await page.addInitScript(({ initialText, initialPermission }) => {
    const state: ClipboardState = {
      text: initialText,
      denied: false,
      deferReads: false,
      clipboardPermission: initialPermission,
      reads: 0,
      pendingReads: 0
    };
    const clipboard = {
      // expose permission failure and delayed completion independently
      readText: async () => {
        state.reads += 1;
        // reject reads when the fixture denies permission
        if (state.denied) throw new DOMException('Clipboard read denied', 'NotAllowedError');
        // retain the read until the test releases it
        if (state.deferReads) return await new Promise<string>(resolve => {
          state.pendingReads += 1;
          state.releaseRead = () => {
            state.pendingReads -= 1;
            state.releaseRead = undefined;
            resolve(state.text);
          };
        });
        return state.text;
      }
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const nativePermissionQuery = navigator.permissions.query.bind(navigator.permissions);
    Object.defineProperty(navigator.permissions, 'query', {
      configurable: true,
      // preserve every permission query outside clipboard reads
      value: async (descriptor: PermissionDescriptor) => {
        const permissionName = (descriptor as { name: string }).name;
        // defer unrelated capabilities to the browser
        if (permissionName !== 'clipboard-read') return nativePermissionQuery(descriptor);
        // emulate browsers without clipboard permission descriptors
        if (state.clipboardPermission === 'unsupported') throw new TypeError('clipboard-read permission unsupported');
        const status = new EventTarget() as PermissionStatus;
        Object.defineProperties(status, {
          state: { configurable: true, get: () => state.clipboardPermission },
          onchange: { configurable: true, writable: true, value: null }
        });
        return status;
      }
    });
    Object.defineProperty(window, '__browserAddressClipboard', { configurable: true, value: state });
  }, { initialText: text, initialPermission: clipboardPermission });
}

// mount one direct preview through the normal workspace controls
async function openBrowser(page: Page) {
  await installPaneMock(page);
  // serve every direct preview location without external network access
  await page.route('https://preview.example.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<main>Direct browser preview</main>'
  }));
  // serve the minimum authenticated workspace fixture
  await page.route('**/api/**', route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    // publish an authenticated client
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'browser-address-csrf', active: true, deviceName: 'Test device' } });
    // publish one running direct-preview workspace
    if (path === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [{
        id: 'agent-browser-address',
        sessionId: 'socket:$1',
        home: '/worktrees/browser-address',
        placeId: 'browser-address',
        worktreeId: 'browser-address',
        worktreeLabel: 'Browser address',
        worktreeOrder: 0,
        title: 'Ready',
        projectUrl: homeUrl,
        projectProxied: false,
        stack: { actions: ['start'], running: true, tunnel: true }
      }],
      projects: []
    } });
    // serve the pane stream ticket
    if (path === '/api/agents/agent-browser-address/tickets') return route.fulfill({ json: { ticket: 'browser-address-ticket' } });
    // serve empty agent prompt collections
    if (/^\/api\/agents\/agent-browser-address\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(path)) return route.fulfill({ json: { prompts: [] } });
    // serve empty workspace notes
    if (path === '/api/worktrees/browser-address/notes') return route.fulfill({ json: { notes: [] } });
    // serve an unavailable push key
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // leave revision polling unsupported in this fixture
    if (path === '/api/server/revision') return route.fulfill({ status: 404, json: { error: 'not mocked' } });
    // serve no remote server statuses
    if (path === '/api/server-statuses') return route.fulfill({ json: { servers: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await seedPaneSize(page, 'agent-browser-address', 80, 24);
  const toolbar = page.getByRole('region', { name: 'Workspace toolbar' });
  const browserButton = toolbar.getByRole('button', { name: 'Browser', exact: true });
  // open the phone overflow only when the browser action is folded
  if (!await browserButton.isVisible()) await toolbar.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browser', exact: true });
  const address = browser.getByRole('textbox', { name: 'Browser address' });
  const frame = browser.locator('iframe[title="Project browser"]');
  await expect(frame).toHaveAttribute('src', homeUrl);
  return { browser, address, frame };
}

// read the deterministic clipboard fixture state
const clipboardState = (page: Page) => page.evaluate(() => (window as ClipboardWindow).__browserAddressClipboard);

// reproduce browsers that conceal an internal focus destination
async function redactNextFocusTarget(form: Locator) {
  await form.evaluate(element => {
    element.addEventListener('focusout', event => {
      Object.defineProperty(event, 'relatedTarget', { configurable: true, value: null });
    }, { capture: true, once: true });
  });
}

test.describe('mobile browser address navigation', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  // exercise native submission, ime suppression and the focused phone action
  test('submits safe addresses through the form, Enter and the focused Go control', async ({ page }) => {
    await installClipboardMock(page);
    const { browser, address, frame } = await openBrowser(page);
    const form = browser.getByRole('form', { name: 'Browser address navigation' });
    const go = browser.getByRole('button', { name: 'Go to address' });
    const composingTarget = 'https://preview.example.test/from-composition';
    const formTarget = 'https://preview.example.test/from-native-form?mode=phone#result';
    const enterTarget = 'https://preview.example.test/from-enter?mode=phone#result';
    const clickTarget = 'https://preview.example.test/from-button?mode=phone#result';

    await expect(form).toBeVisible();
    await expect(address).toHaveAttribute('type', 'text');
    await expect(address).toHaveAttribute('inputmode', 'url');
    await expect(address).toHaveAttribute('enterkeyhint', 'go');
    await expect(go).toBeHidden();

    await address.focus();
    await expect(go).toBeVisible();
    await expect(go.locator('svg')).toHaveCount(1);
    await address.fill(composingTarget);
    await address.dispatchEvent('compositionstart', { data: 'preview', bubbles: true, cancelable: true });
    await address.press('Enter');
    await expect(frame).toHaveAttribute('src', homeUrl);
    await address.dispatchEvent('compositionend', { data: 'preview', bubbles: true, cancelable: true });

    await address.fill(formTarget);
    await form.evaluate(element => (element as HTMLFormElement).requestSubmit());
    await expect(frame).toHaveAttribute('src', formTarget);

    await address.fill(enterTarget);
    await address.press('Enter');
    await expect(frame).toHaveAttribute('src', enterTarget);

    await address.fill(clickTarget);
    await go.click();
    await expect(frame).toHaveAttribute('src', clickTarget);

    await frame.focus();
    await expect(go).toBeHidden();
  });

  // retain the submit control through a privacy-redacted internal tap
  test('activates Go when an internal tap has a null relatedTarget', async ({ page }) => {
    const target = 'https://preview.example.test/null-target-go';
    await installClipboardMock(page);
    const { browser, address, frame } = await openBrowser(page);
    const form = browser.getByRole('form', { name: 'Browser address navigation' });
    const go = browser.getByRole('button', { name: 'Go to address' });

    await address.focus();
    await address.fill(target);
    await expect(go).toBeVisible();
    await redactNextFocusTarget(form);
    await go.tap();
    await expect(frame).toHaveAttribute('src', target);
  });

  // navigate only after choosing the captured safe clipboard target
  test('offers the full safe clipboard URL without navigating on focus', async ({ page }) => {
    const clipboardTarget = 'https://preview.example.test/from-clipboard?source=mobile#selected';
    const laterClipboardTarget = 'https://preview.example.test/changed-after-read';
    const refreshedClipboardTarget = 'https://preview.example.test/refreshed-after-navigation';
    const draftTarget = 'https://preview.example.test/unsent-suggestion-draft';
    await installClipboardMock(page, clipboardTarget);
    const { browser, address, frame } = await openBrowser(page);
    const go = browser.getByRole('button', { name: 'Go to address' });
    const suggestion = browser.getByRole('button', { name: 'Navigate to clipboard URL' });

    await address.focus();
    await expect(suggestion).toBeVisible();
    await expect(browser.getByRole('button', { name: 'Paste and go' })).toHaveCount(0);
    await expect(suggestion).toContainText(clipboardTarget);
    await expect(frame).toHaveAttribute('src', homeUrl);

    await address.fill(draftTarget);
    await suggestion.focus();
    await expect(frame).toHaveAttribute('src', homeUrl);
    await page.evaluate(next => { (window as ClipboardWindow).__browserAddressClipboard.text = next; }, laterClipboardTarget);
    await suggestion.press('Enter');
    await expect(frame).toHaveAttribute('src', clipboardTarget);

    await expect(address).toBeFocused();
    await expect(go).toBeVisible();
    await page.evaluate(next => { (window as ClipboardWindow).__browserAddressClipboard.text = next; }, refreshedClipboardTarget);
    await page.frameLocator('iframe[title="Project browser"]').getByText('Direct browser preview').click();
    const reads = (await clipboardState(page)).reads;
    await address.focus();
    await expect.poll(async () => (await clipboardState(page)).reads).toBeGreaterThan(reads);
    await expect(suggestion).toContainText(refreshedClipboardTarget);
  });

  // retain the clipboard choice through a privacy-redacted internal tap
  test('activates a clipboard suggestion when an internal tap has a null relatedTarget', async ({ page }) => {
    const target = 'https://preview.example.test/null-target-clipboard';
    await installClipboardMock(page, target);
    const { browser, address, frame } = await openBrowser(page);
    const form = browser.getByRole('form', { name: 'Browser address navigation' });
    const suggestion = browser.getByRole('button', { name: 'Navigate to clipboard URL' });

    await address.focus();
    await expect(suggestion).toContainText(target);
    await redactNextFocusTarget(form);
    await suggestion.tap();
    await expect(frame).toHaveAttribute('src', target);
  });

  // unavailable clipboard permission must not create a speculative navigation action
  for (const permission of ['prompt', 'denied', 'unsupported'] as const) {
    // retain ordinary address submission without reading or offering an unknown clipboard
    test(`hides clipboard actions when permission is ${permission}`, async ({ page }) => {
      await installClipboardMock(page, 'https://preview.example.test/unread-clipboard', permission);
      const { browser, address, frame } = await openBrowser(page);

      await address.focus();
      await expect(browser.getByRole('button', { name: 'Go to address' })).toBeVisible();
      await expect(browser.getByRole('button', { name: 'Navigate to clipboard URL' })).toHaveCount(0);
      await expect(browser.getByRole('button', { name: 'Paste and go' })).toHaveCount(0);
      expect((await clipboardState(page)).reads).toBe(0);
      await expect(frame).toHaveAttribute('src', homeUrl);

      const target = 'https://preview.example.test/manual-without-clipboard';
      await address.fill(target);
      await address.press('Enter');
      await expect(frame).toHaveAttribute('src', target);
    });
  }

  // filter unsafe content and tolerate missing clipboard capability
  test('does not offer invalid, denied or unavailable clipboard contents', async ({ page }) => {
    await installClipboardMock(page);
    const { browser, address, frame } = await openBrowser(page);
    const suggestion = browser.getByRole('button', { name: 'Navigate to clipboard URL' });
    const rejected = ['', 'plain clipboard text', '/relative/path', 'javascript:alert(1)', 'ftp://preview.example.test/file', 'https://user:secret@preview.example.test/private'];

    // reject every incomplete or unsafe clipboard shape after a fresh focus
    for (const text of rejected) {
      await page.evaluate(value => {
        const state = (window as ClipboardWindow).__browserAddressClipboard;
        state.text = value;
        state.denied = false;
      }, text);
      await frame.focus();
      const reads = (await clipboardState(page)).reads;
      await address.focus();
      await expect.poll(async () => (await clipboardState(page)).reads).toBeGreaterThan(reads);
      await expect(suggestion).toHaveCount(0);
      await expect(browser.getByRole('button', { name: 'Paste and go' })).toHaveCount(0);
      await expect(frame).toHaveAttribute('src', homeUrl);
    }

    await page.evaluate(() => {
      const state = (window as ClipboardWindow).__browserAddressClipboard;
      state.denied = true;
    });
    await frame.focus();
    const readsBeforeDenial = (await clipboardState(page)).reads;
    await address.focus();
    await expect.poll(async () => (await clipboardState(page)).reads).toBeGreaterThan(readsBeforeDenial);
    await expect(suggestion).toHaveCount(0);
    await expect(browser.getByRole('button', { name: 'Paste and go' })).toHaveCount(0);
    await expect(frame).toHaveAttribute('src', homeUrl);

    await frame.focus();
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
    await address.focus();
    await expect(suggestion).toHaveCount(0);
    await expect(browser.getByRole('button', { name: 'Paste and go' })).toHaveCount(0);
    await expect(frame).toHaveAttribute('src', homeUrl);

    const manualTarget = 'https://preview.example.test/manual-after-failure';
    await address.fill(manualTarget);
    await address.press('Enter');
    await expect(frame).toHaveAttribute('src', manualTarget);
  });

  // discard a delayed clipboard result after address focus leaves
  test('does not revive a stale clipboard suggestion after blur', async ({ page }) => {
    const staleTarget = 'https://preview.example.test/stale-clipboard';
    await installClipboardMock(page, staleTarget);
    const { browser, address, frame } = await openBrowser(page);
    const suggestion = browser.getByRole('button', { name: 'Navigate to clipboard URL' });

    await page.evaluate(() => { (window as ClipboardWindow).__browserAddressClipboard.deferReads = true; });
    await address.focus();
    await expect.poll(async () => (await clipboardState(page)).pendingReads).toBe(1);
    await expect(suggestion).toHaveCount(0);
    await expect(browser.getByRole('button', { name: 'Paste and go' })).toHaveCount(0);
    await frame.focus();
    await page.evaluate(() => { (window as ClipboardWindow).__browserAddressClipboard.releaseRead?.(); });
    await expect.poll(async () => (await clipboardState(page)).pendingReads).toBe(0);
    await expect(suggestion).toHaveCount(0);
    await expect(frame).toHaveAttribute('src', homeUrl);
  });

  // discard a detected clipboard URL after a private cross-origin focus transfer
  test('discards a pending clipboard suggestion after a null-relatedTarget preview blur', async ({ page }) => {
    const staleTarget = 'https://preview.example.test/stale-clipboard';
    await installClipboardMock(page, staleTarget);
    const { browser, address, frame } = await openBrowser(page);
    const form = browser.getByRole('form', { name: 'Browser address navigation' });
    const go = browser.getByRole('button', { name: 'Go to address' });
    const suggestion = browser.getByRole('button', { name: 'Navigate to clipboard URL' });

    await page.evaluate(() => { (window as ClipboardWindow).__browserAddressClipboard.deferReads = true; });
    await address.focus();
    await expect.poll(async () => (await clipboardState(page)).pendingReads).toBe(1);
    await expect(suggestion).toHaveCount(0);
    await expect(browser.getByRole('button', { name: 'Paste and go' })).toHaveCount(0);

    // model mobile cross-origin focus privacy while retaining the real transfer
    await form.evaluate(element => {
      element.addEventListener('focusout', event => {
        Object.defineProperty(event, 'relatedTarget', { configurable: true, value: null });
      }, { capture: true, once: true });
    });
    await page.frameLocator('iframe[title="Project browser"]').getByText('Direct browser preview').click();
    await expect(frame).toHaveAttribute('src', homeUrl);
    await expect(go).toBeHidden();
    await expect(suggestion).toHaveCount(0);

    await page.evaluate(() => { (window as ClipboardWindow).__browserAddressClipboard.releaseRead?.(); });
    await expect.poll(async () => (await clipboardState(page)).pendingReads).toBe(0);
    await expect(frame).toHaveAttribute('src', homeUrl);
    await expect(go).toBeHidden();
    await expect(suggestion).toHaveCount(0);
  });
});

// retain desktop enter navigation without phone-only actions
test('preserves desktop address submission without mobile clipboard controls', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const clipboardTarget = 'https://preview.example.test/desktop-clipboard';
  const typedTarget = 'https://preview.example.test/desktop-enter?preserved=true';
  await installClipboardMock(page, clipboardTarget);
  const { browser, address, frame } = await openBrowser(page);

  await address.focus();
  await expect(browser.getByRole('button', { name: 'Go to address' })).toHaveCount(0);
  await expect(browser.getByRole('button', { name: 'Navigate to clipboard URL' })).toHaveCount(0);
  await address.fill(typedTarget);
  await address.press('Enter');
  await expect(frame).toHaveAttribute('src', typedTarget);
});
