import { expect, test, type Locator } from '@playwright/test';

// track prompt sizing inputs
type PromptDimensions = { height: number; contentHeight: number; lineHeight: number; minHeight: number };

// measure the rendered box and unconstrained content
const readPromptDimensions = async (prompt: Locator): Promise<PromptDimensions> => await prompt.evaluate(input => {
  const style = getComputedStyle(input);
  const borderHeight = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
  const minHeight = Number.parseFloat(style.minHeight);
  const currentHeight = input.style.height;
  const currentMinHeight = input.style.minHeight;
  input.style.minHeight = '0';
  input.style.height = '0';
  const contentHeight = input.scrollHeight + borderHeight;
  input.style.minHeight = currentMinHeight;
  input.style.height = currentHeight;
  return { height: input.getBoundingClientRect().height, contentHeight, lineHeight: Number.parseFloat(style.lineHeight), minHeight };
});

// wait for the prompt to fit content without spare space
const expectPromptFitsContent = async (prompt: Locator): Promise<PromptDimensions> => {
  // allow browser subpixel rounding
  await expect.poll(async () => {
    const dimensions = await readPromptDimensions(prompt);
    return Math.abs(dimensions.height - Math.max(dimensions.minHeight, dimensions.contentHeight));
  }).toBeLessThanOrEqual(1);
  return await readPromptDimensions(prompt);
};

// cover explicit lines, edits, and soft wrapping
test('grows only when prompt content needs another line and shrinks again', async ({ page }) => {
  // mock prompt dependencies
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    // establish an active browser session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // render one idle agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    // disable optional push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // issue one log ticket
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // return no saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeVisible();
  const initial = await expectPromptFitsContent(prompt);

  // build explicit prompt lines
  const lines = Array.from({ length: 8 }, (_, index) => `Prompt line ${index + 1}`);
  await prompt.fill(lines.join('\n'));
  const filled = await expectPromptFitsContent(prompt);
  expect(filled.height).toBeGreaterThan(initial.height);

  await prompt.pressSequentially(' still on the last line');
  const sameLine = await expectPromptFitsContent(prompt);
  expect(sameLine.height).toBeCloseTo(filled.height, 0);

  await prompt.press('Shift+Enter');
  const grown = await expectPromptFitsContent(prompt);
  expect(grown.height - sameLine.height).toBeCloseTo(grown.lineHeight, 0);

  await prompt.press('Backspace');
  const shrunk = await expectPromptFitsContent(prompt);
  expect(shrunk.height).toBeCloseTo(sameLine.height, 0);

  const wrappedText = 'This prompt wraps naturally without any explicit newline. '.repeat(12);
  await prompt.fill(wrappedText);
  await expect(prompt).toHaveValue(wrappedText);
  const wrapped = await expectPromptFitsContent(prompt);
  expect(wrapped.contentHeight).toBeGreaterThan(wrapped.minHeight);

  await prompt.fill('Short prompt');
  const short = await expectPromptFitsContent(prompt);
  expect(short.height).toBeLessThan(wrapped.height);
  expect(short.height).toBeCloseTo(initial.height, 0);
});

test('caps the prompt at half the viewport and scrolls overflowing content', async ({ page }) => {
  await page.setViewportSize({ width: 1_000, height: 600 });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeVisible();
  await prompt.fill(Array.from({ length: 100 }, (_, index) => `Prompt line ${index + 1}`).join('\n'));

  const dimensions = await prompt.evaluate(input => ({
    height: input.getBoundingClientRect().height,
    scrollHeight: input.scrollHeight,
    overflowY: getComputedStyle(input).overflowY
  }));
  expect(dimensions.height).toBeLessThanOrEqual(300);
  expect(dimensions.height).toBeGreaterThan(299);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.height);
  expect(dimensions.overflowY).toBe('auto');
});

// preserve prompt ligature shaping
test('uses the upstream ligature font in the prompt composer', async ({ page }) => {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    // serve one controlled browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // serve one idle agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    // disable optional browser services
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');

  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toHaveCSS('font-family', /JetBrains Mono Prompt/u);
  await expect(prompt).toHaveCSS('font-variant-ligatures', 'contextual');
  await expect(prompt).toHaveCSS('font-feature-settings', '"calt"');
  await expect(prompt).toHaveCSS('text-rendering', 'optimizelegibility');
  const loadedFaces = await prompt.evaluate(async () => (await document.fonts.load('400 16px "JetBrains Mono Prompt"', '.. ... -> -> ')).length);
  expect(loadedFaces).toBe(1);
  const promptBounds = await prompt.boundingBox();
  expect(promptBounds).not.toBeNull();
  // require one visible prompt region
  if (promptBounds === null) throw new Error('prompt bounds unavailable');
  // compare shaping without unrelated border antialiasing
  const promptTextScreenshot = () => page.screenshot({ clip: { x: promptBounds.x + 4, y: promptBounds.y + 4, width: 160, height: 36 } });

  await prompt.pressSequentially('...');
  await prompt.evaluate(input => input.blur());
  const typedDots = await promptTextScreenshot();
  await prompt.fill('...');
  await prompt.evaluate(input => input.blur());
  const settledDots = await promptTextScreenshot();
  expect(typedDots.equals(settledDots)).toBe(true);

  await prompt.fill('');
  await prompt.pressSequentially('-> ');
  await prompt.evaluate(input => input.blur());
  const typedArrow = await promptTextScreenshot();
  await prompt.fill('-> ');
  await prompt.evaluate(input => input.blur());
  const settledArrow = await promptTextScreenshot();
  expect(typedArrow.equals(settledArrow)).toBe(true);
  await prompt.evaluate(input => { input.style.fontFeatureSettings = '"calt" 0'; });
  const unligatedArrow = await promptTextScreenshot();
  // prove the contextual arrow glyph is visible
  expect(settledArrow.equals(unligatedArrow)).toBe(false);
  await expect(prompt).toHaveValue('-> ');
});
