import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { installPaneMock, pushBytes, pushQuestion, seedPaneSize } from './pane-stream-mock.js';

const questionText = 'The editable surface is unavailable at the merge base, so a same-scenario drag benchmark cannot run. May I use the first revision containing the editor as the benchmark baseline, clearly labeled in the review? I’ll continue the remaining validation work meanwhile.';
const optionContent = [
  'Use the first editor revision as the baseline Benchmark the complete editable surface at that revision and clearly label the substituted baseline in the review.',
  'Keep the strict merge-base requirement and stop before the review update Do not substitute another revision; finish the remaining review checks without publishing a benchmark.',
  'Choose a different baseline Provide the preferred revision, validation constraints, and any additional comparison details for the remaining review work.'
] as const;
const completeQuestion = {
  id: 'question-editor-benchmark',
  text: questionText,
  choices: [optionContent[0], optionContent[1], optionContent[2]],
  source: 'parsed'
};
const viewports = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'mobile', width: 360, height: 640 }
] as const;

// serve one codex panel through the same pane-stream contract as production
const routeApi = async (page: Page) => {
  // answer every app request without involving a real agent
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // establish the local authenticated session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one codex agent waiting for an answer
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', kind: 'codex', sessionId: 'socket:$1', home: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Action required', attention: 'question', queuedPromptCount: 0 }], projects: [] } });
    // allow the shared websocket mock to open the dashboard stream
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    // disable unrelated push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // mint the mocked pane connection
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    // keep saved prompt data empty
    if (url.pathname === '/api/agents/agent-1/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    // keep prompt history empty
    if (url.pathname === '/api/agents/agent-1/prompt-history') return route.fulfill({ json: { prompts: [] } });
    // keep queued prompts empty
    if (url.pathname === '/api/agents/agent-1/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    // expose no commands or named conversation
    if (url.pathname === '/api/agents/agent-1/commands') return route.fulfill({ json: { commands: [] } });
    // let the panel use its agent title
    if (url.pathname === '/api/agents/agent-1/conversation') return route.fulfill({ json: {} });
    // exclude additional panes from the focused question scenario
    if (url.pathname === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes: [] } });
    // keep worktree notes empty
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    // suppress unrelated update prompts with valid empty status responses
    if (url.pathname === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // report no pending server update
    if (url.pathname === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // report a settled settings state
    if (url.pathname === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// inspect visible geometry without scrolling on behalf of keyboard navigation
const expectFullyVisible = async (node: Locator, scroller: Locator) => {
  await expect(node).toBeVisible();
  await expect(node).toBeInViewport();
  // compare the content with its accessible region rather than private markup
  const nodeBounds = await node.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom };
  });
  // measure the region that owns the scrollable content
  const scrollBounds = await scroller.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom };
  });
  expect(nodeBounds.top).toBeGreaterThanOrEqual(scrollBounds.top - 1);
  expect(nodeBounds.bottom).toBeLessThanOrEqual(scrollBounds.bottom + 1);
};

// exercise complete question content at both supported responsive widths
for (const viewport of viewports) {
  // verify exact text, keyboard reachability, scrolling, and mode preservation
  test(`keeps the complete codex question and every answer reachable on ${viewport.name}`, async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    // retain browser console failures as regression evidence
    page.on('console', message => {
      // incomplete fixtures and application failures must both remain visible
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    // retain uncaught browser errors as regression evidence
    page.on('pageerror', error => pageErrors.push(error.message));
    await installPaneMock(page);
    await routeApi(page);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushBytes(page, 'agent-1', 'Complete question loaded\r\n');
    await pushQuestion(page, 'agent-1', completeQuestion);

    const question = page.getByRole('region', { name: 'Agent question' });
    const renderedQuestion = question.getByText(questionText, { exact: true });
    await expect(question).toBeVisible();
    await expect(renderedQuestion).toHaveText(questionText);
    expect(await renderedQuestion.textContent()).toBe(questionText);

    // preserve the complete payload across the normal-prompt escape hatch
    await question.getByRole('button', { name: 'Switch to normal prompt mode' }).click();
    await expect(question).toBeHidden();
    await page.getByRole('button', { name: 'Switch to answer mode' }).click();
    await expect(question).toBeVisible();
    await expect(renderedQuestion).toHaveText(questionText);
    expect(await renderedQuestion.textContent()).toBe(questionText);

    const overflow = await question.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    // the mobile card must expose its overflow instead of clipping later answers
    if (viewport.name === 'mobile') expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);

    await question.evaluate(element => { element.scrollTop = 0; });
    await expectFullyVisible(renderedQuestion, question);
    const topScreenshot = testInfo.outputPath(`complete-question-${viewport.name}-top.png`);
    await page.screenshot({ path: topScreenshot });
    await testInfo.attach(`complete-question-${viewport.name}-top`, { path: topScreenshot, contentType: 'image/png' });

    // begin immediately before the answers in the keyboard navigation order
    await question.getByRole('button', { name: 'Switch to normal prompt mode' }).focus();
    // verify complete answers and native focus scrolling through real tab navigation
    for (const option of optionContent) {
      const choice = question.getByRole('button', { name: option, exact: true });
      await expect(choice).toHaveAccessibleName(option);
      await page.keyboard.press('Tab');
      await expect(choice).toBeFocused();
      await expectFullyVisible(choice, question);
    }

    const bottomScreenshot = testInfo.outputPath(`complete-question-${viewport.name}-bottom.png`);
    await page.screenshot({ path: bottomScreenshot });
    await testInfo.attach(`complete-question-${viewport.name}-bottom`, { path: bottomScreenshot, contentType: 'image/png' });
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
