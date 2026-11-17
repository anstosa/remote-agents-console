import { expect, test, type Locator } from '@playwright/test';

// paste one browser-named image into the composer
const pasteImage = async (prompt: Locator, bytes: number[]) => await prompt.evaluate((element, payload) => {
  const clipboard = new DataTransfer();
  clipboard.items.add(new File([new Uint8Array(payload)], 'image.png', { type: 'image/png' }));
  return element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
}, bytes);

test('converts images pasted into the prompt into queued attachments', async ({ page }) => {
  let queued: unknown;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queued = request.postDataJSON();
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Describe this screenshot.');
  const defaultAllowed = await prompt.evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'clipboard.png', { type: 'image/png' }));
    return element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });

  expect(defaultAllowed).toBe(false);
  await expect(prompt).toHaveValue('Describe this screenshot.');
  await expect(page.getByLabel('Selected attachments')).toContainText('clipboard.png');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();

  await expect.poll(() => queued).toEqual({
    prompt: 'Describe this screenshot.',
    attachments: [{ name: 'clipboard.png', data: 'iVBORw==' }]
  });
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});

// keep repeated browser filenames queueable across separate paste events
test('queues separately pasted images that share the browser filename', async ({ page }) => {
  let queued: unknown;
  let attempts = 0;
  // emulate the composer boundary and strict attachment validation
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // keep the terminal fixture inert
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // start without saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // capture queue submissions
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { attachments?: Array<{ name: string }> };
      attempts += 1;
      // exercise attachment restoration before a successful retry
      if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'temporary failure' } });
      queued = payload;
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Compare these screenshots.');
  expect(await pasteImage(prompt, [1, 2, 3])).toBe(false);
  expect(await pasteImage(prompt, [4, 5, 6])).toBe(false);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(prompt).toHaveValue('Compare these screenshots.');
  await expect(page.getByLabel('Selected attachments')).toContainText('image.png');
  await expect(page.getByLabel('Selected attachments')).toContainText('image-2.png');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();

  await expect.poll(() => queued).toEqual({
    prompt: 'Compare these screenshots.',
    attachments: [
      { name: 'image.png', data: 'AQID' },
      { name: 'image-2.png', data: 'BAUG' }
    ]
  });
  await expect(prompt).toHaveValue('');
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});

// preserve picker order while skipping names claimed earlier in one batch
test('uniquifies a picker batch in selection order within the filename limit', async ({ page }) => {
  let queued: unknown;
  // emulate the composer boundary and strict attachment validation
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // keep the terminal fixture inert
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // start without saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // capture queue submissions
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      const payload = request.postDataJSON() as { attachments?: Array<{ name: string }> };
      queued = payload;
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep every selected image.');
  const longName = `${'a'.repeat(236)}.png`;
  await page.locator('.prompt input[type="file"]').setInputFiles([
    { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from([1]) },
    { name: 'image-2.png', mimeType: 'image/png', buffer: Buffer.from([2]) },
    { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from([3]) },
    { name: ' image.png ', mimeType: 'image/png', buffer: Buffer.from([4]) },
    { name: longName, mimeType: 'image/png', buffer: Buffer.from([5]) },
    { name: longName, mimeType: 'image/png', buffer: Buffer.from([6]) }
  ]);
  const expectedNames = [
    'image.png',
    'image-2.png',
    'image-3.png',
    'image-4.png',
    longName,
    `${'a'.repeat(234)}-2.png`
  ];
  const attachmentChips = page.getByLabel('Selected attachments').locator('span');
  await expect(attachmentChips).toHaveCount(expectedNames.length);
  // compare every rendered filename in selection order
  expect(await attachmentChips.evaluateAll(elements => elements.map(element => element.getAttribute('title')))).toEqual(expectedNames);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();

  await expect.poll(() => (queued as { attachments?: Array<{ name: string }> } | undefined)?.attachments?.map(attachment => attachment.name)).toEqual(expectedNames);
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});

// keep surrogate pairs intact while allocating repeated maximum-length names
test('uniquifies maximum-length Unicode filenames across picker events', async ({ page }) => {
  let queued: unknown;
  // emulate one active composer and capture its queue request
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the fixture
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one active agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // keep the terminal fixture inert
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // start without saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // capture queue submissions
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      queued = request.postDataJSON();
      return route.fulfill({ status: 202, json: { queued: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep every Unicode image.');
  const originalName = `${'a'.repeat(233)}😀x.png`;
  const payloads = [[17, 18], [33, 34], [49, 50]];
  const picker = page.locator('.prompt input[type="file"]');
  // select the same valid name through three independent picker events
  for (const bytes of payloads) await picker.setInputFiles({ name: originalName, mimeType: 'image/png', buffer: Buffer.from(bytes) });
  const expectedNames = [originalName, `${'a'.repeat(233)}-2.png`, `${'a'.repeat(233)}-3.png`];
  const attachmentChips = page.getByLabel('Selected attachments').locator('span');
  await expect(attachmentChips).toHaveCount(expectedNames.length);
  // reject browser-repaired surrogate fragments and overlong results
  const renderedNames = await attachmentChips.evaluateAll(elements => elements.map(element => element.getAttribute('title') ?? ''));
  expect(renderedNames).toEqual(expectedNames);
  expect(renderedNames.every(name => !name.includes('\uFFFD') && name.length <= 240)).toBe(true);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();

  await expect.poll(() => queued).toEqual({
    prompt: 'Keep every Unicode image.',
    attachments: expectedNames.map((name, index) => ({ name, data: Buffer.from(payloads[index]!).toString('base64') }))
  });
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});
