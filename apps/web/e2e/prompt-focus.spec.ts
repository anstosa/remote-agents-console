import { expect, test, type Locator } from '@playwright/test';
import { expectProgressBorder } from './progress-border-assertions.js';

// capture the submit palette without relying on screenshot pixels
const queueAppearance = (button: Locator) => button.evaluate(element => {
  const style = getComputedStyle(element);
  const icon = element.querySelector('svg');
  const iconStyle = icon === null ? null : getComputedStyle(icon);
  const probe = document.createElement('span');
  probe.style.color = 'var(--blue)';
  element.append(probe);
  const blue = getComputedStyle(probe).color;
  probe.style.color = 'var(--sky)';
  const sky = getComputedStyle(probe).color;
  probe.remove();
  return {
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
    blue,
    borderStyle: style.borderStyle,
    borderWidth: Number.parseFloat(style.borderWidth),
    color: style.color,
    filter: style.filter,
    iconColor: iconStyle?.color,
    iconStroke: iconStyle?.stroke,
    outlineColor: style.outlineColor,
    outlineStyle: style.outlineStyle,
    outlineWidth: Number.parseFloat(style.outlineWidth),
    sky
  };
});

// require the send control to rely on shape and fill instead of a fixed border
const expectQueueWithoutFixedBorder = async (button: Locator) => {
  await expect.poll(async () => {
    const appearance = await queueAppearance(button);
    return {
      borderStyle: appearance.borderStyle,
      borderWidth: appearance.borderWidth
    };
  }).toEqual({ borderStyle: 'none', borderWidth: 0 });
};

// preserve composer focus while proving the submit palette across its pending lifecycle
test('focusing and submitting the prompt keeps keyboard input in the composer', async ({ page }, testInfo) => {
  let finishPromptRequest: (() => void) | undefined;
  const promptRequestFinished = new Promise<void>(resolve => { finishPromptRequest = resolve; });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Ready' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'terminal-ticket' } });
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      await promptRequestFinished;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const output = page.getByLabel('Live log');
  const outputPanel = page.locator('.log-output');
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const queue = page.getByRole('button', { name: 'Queue', exact: true });
  await expect(output).toBeVisible();
  await expect(queue).toBeDisabled();
  await expectQueueWithoutFixedBorder(queue);

  // the output panel's own ring reads sky only while the pane holds keyboard input
  const ring = () => outputPanel.evaluate(element => {
    const probe = document.createElement('span');
    document.body.append(probe);
    probe.style.color = 'var(--sky)';
    const sky = getComputedStyle(probe).color;
    probe.remove();
    return { border: getComputedStyle(element, '::after').borderTopColor, sky };
  });
  expect((await ring()).border).not.toBe((await ring()).sky);
  await output.click();
  await expect(outputPanel).toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1);
  const focused = await ring();
  expect(focused.border).toBe(focused.sky);

  await prompt.focus();
  await expect(prompt).toBeFocused();
  await expect(outputPanel).not.toHaveClass(/input-active/u);
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
  await prompt.fill('Keep this prompt');
  await prompt.press('Control+c');
  await expect(prompt).toHaveValue('Keep this prompt');

  await prompt.fill('Queue this prompt');
  await expect(queue).toBeEnabled();
  // wait for the idle palette to settle
  await expect.poll(async () => (await queueAppearance(queue)).backgroundImage).toContain('linear-gradient');
  await expect.poll(async () => (await queueAppearance(queue)).filter).toBe('none');
  await expectQueueWithoutFixedBorder(queue);
  const idleScreenshot = '/tmp/remoteagents-prompt-submit-idle.png';
  await page.screenshot({ path: idleScreenshot });
  await testInfo.attach('prompt-submit-idle', { path: idleScreenshot, contentType: 'image/png' });
  await queue.hover();
  await expect.poll(async () => (await queueAppearance(queue)).filter).toBe('brightness(1.08)');
  await expectQueueWithoutFixedBorder(queue);
  await page.mouse.move(0, 0);
  await prompt.focus();
  await page.keyboard.press('Tab');
  // focus the submit target while retaining keyboard focus-visible modality
  await queue.focus();
  await expect(queue).toBeFocused();
  // preserve the global keyboard outline independently of the removed border
  await expect.poll(async () => {
    const appearance = await queueAppearance(queue);
    return {
      outlineIsSky: appearance.outlineColor === appearance.sky,
      outlineStyle: appearance.outlineStyle,
      outlineWidth: appearance.outlineWidth
    };
  }).toEqual({
    outlineIsSky: true,
    outlineStyle: 'solid',
    outlineWidth: 2
  });
  await prompt.focus();
  await prompt.press('Enter');
  const queueing = page.getByRole('button', { name: 'Queueing', exact: true });
  await expect(queueing).toBeDisabled();
  await expectProgressBorder(queueing, 'blue');
  await expectQueueWithoutFixedBorder(queueing);
  // wait for the pending palette transition to settle
  await expect.poll(async () => {
    const appearance = await queueAppearance(queueing);
    return {
      backgroundColor: appearance.backgroundColor,
      backgroundImage: appearance.backgroundImage,
      borderStyle: appearance.borderStyle,
      borderWidth: appearance.borderWidth,
      colorBlue: appearance.color === appearance.blue,
      iconColorBlue: appearance.iconColor === appearance.blue,
      iconStrokeBlue: appearance.iconStroke === appearance.blue
    };
  }).toEqual({
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    borderStyle: 'none',
    borderWidth: 0,
    colorBlue: true,
    iconColorBlue: true,
    iconStrokeBlue: true
  });
  const pendingScreenshot = '/tmp/remoteagents-prompt-submit-pending.png';
  await page.screenshot({ path: pendingScreenshot });
  await testInfo.attach('prompt-submit-pending', { path: pendingScreenshot, contentType: 'image/png' });
  await expect(prompt).toHaveValue('');
  await expect(prompt).toBeFocused();
  await prompt.fill('Start the next prompt immediately');
  finishPromptRequest?.();
  await expect(prompt).toHaveValue('Start the next prompt immediately');
  await expect(prompt).toBeFocused();
  await expect(queue).toBeEnabled();
  await expect(queue).not.toHaveAttribute('aria-busy', 'true');
  // wait for the restored idle palette to settle
  await expect.poll(async () => (await queueAppearance(queue)).backgroundImage).toContain('linear-gradient');
  await expect.poll(async () => (await queueAppearance(queue)).filter).toBe('none');
  await expectQueueWithoutFixedBorder(queue);
});
