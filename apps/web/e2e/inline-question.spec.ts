import { expect, test, type Page } from '@playwright/test';
import { installPaneMock, seedPaneSize, pushBytes, pushQuestion } from './pane-stream-mock.js';

// The server derive reports the viewed pane's inline question on the pane socket's
// `question` frame; the web renders what it is given and never parses pane text. This
// spec drives those frames through the shared pane mock and answers through the one
// question endpoint, exactly as the operator does.

const strictQuestion = {
  id: 'question-strict',
  text: 'Which strict-mode end state should govern this cleanup?',
  field: { kind: 'choice', choices: [
    'Global strict only (Recommended)   Set the UI project to strict.',
    'Keep targeted checker              Enable global strict with a targeted checker.',
    'Markers only',
    'None of the above                  Optionally type a different answer.'
  ] },
  source: 'parsed'
};
const deployQuestion = {
  id: 'question-deploy',
  text: 'Which deployment environment should receive this release?',
  field: { kind: 'choice', choices: ['Staging', 'Production', 'Cancel'] },
  source: 'parsed'
};
const modelQuestion = {
  id: 'question-model',
  text: 'Select Model and Effort',
  field: { kind: 'choice', choices: [
    'gpt-6-astra (current)  Our most capable model for complex, demanding work.',
    'gpt-5.6-sol            Reliable agentic workhorse for everyday tasks.',
    'gpt-5.6-terra          Balanced agentic coding model for everyday work.',
    'gpt-5.6-luna           Fast and affordable agentic coding model.',
    'gpt-5.5                Proven previous-generation model for coding and general work.',
    'gpt-5.4-mini           Small, fast, and cost-efficient model for simpler coding tasks.',
    'gpt-5.3-codex-spark    Ultra-fast coding model.'
  ] },
  source: 'parsed'
};
const hookApprovalQuestion = {
  id: 'question-hook-approval',
  text: 'Hooks need review 2 hooks are new or changed. Hooks can run outside the sandbox after you trust them.',
  field: { kind: 'choice', choices: ['Review hooks', 'Trust all and continue', "Continue without trusting (hooks won't run)"] },
  source: 'parsed'
};
const folderTrustQuestion = {
  id: 'question-folder-trust',
  text: 'Do you trust /worktrees/cora?',
  detail: "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.\n\nClaude Code'll be able to read, edit, and execute files here.",
  permission: true,
  field: { kind: 'choice', choices: ['No, exit', 'Yes, I trust this folder'] },
  source: 'parsed'
};
const codexFolderTrustQuestion = {
  id: 'question-codex-folder-trust-cora',
  text: 'Do you trust /worktrees/cora?',
  detail: 'Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.',
  permission: true,
  field: { kind: 'choice', choices: ['Trust and continue', 'Quit'] },
  source: 'parsed'
};
const structuredPermissionQuestion = {
  id: 'question-structured-permission',
  text: 'Allow access to the deployment tool?',
  permission: true,
  field: { kind: 'choice', choices: ['Allow once', 'Deny'] },
  source: 'structured'
};
type ApprovalState = {
  reject: boolean;
  questionPosts: Array<{ questionId: string; index: number }>;
  promptPosts: unknown[];
};
type ApprovalMockOptions = { kind: 'codex' | 'claude'; title: string; attention: 'question' | 'finished' };

// serve one isolated native approval question
async function installApprovalMock(page: Page, state: ApprovalState, options: ApprovalMockOptions = { kind: 'codex', title: 'Hooks need review', attention: 'question' }) {
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the mocked console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one agent waiting for explicit approval
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', kind: options.kind, sessionId: 'socket:$1', home: '/worktrees/cora', title: options.title, attention: options.attention, queuedPromptCount: 0 }], projects: [] } });
    // mint the mocked pane socket
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    // keep prompt sources empty
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // capture forbidden prompt fallback
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      state.promptPosts.push(request.postDataJSON());
      return route.fulfill({ status: 204 });
    }
    // capture the only approval write
    if (url.pathname === '/api/agents/agent-1/question' && request.method() === 'POST') {
      state.questionPosts.push(request.postDataJSON() as { questionId: string; index: number });
      // preserve the question after one conflict
      if (state.reject) return route.fulfill({ status: 409, json: { error: 'question unavailable' } });
      return route.fulfill({ status: 204 });
    }
    // disable unrelated push setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // contain every remaining api read
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

const hookApprovalViewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 }
] as const;

// cover hook approval on desktop and phone
for (const viewport of hookApprovalViewports) {
  // verify one explicit approval flow
  test(`answers a hook approval question explicitly on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const state: ApprovalState = { reject: true, questionPosts: [], promptPosts: [] };
    await installApprovalMock(page, state);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushQuestion(page, 'agent-1', hookApprovalQuestion);

    const question = page.getByRole('region', { name: 'Agent question' });
    await expect(question).toBeVisible();
    await expect(question.getByText(hookApprovalQuestion.text, { exact: true })).toBeVisible();
    const choices = question.getByRole('button', { name: 'Review hooks', exact: true })
      .or(question.getByRole('button', { name: 'Trust all and continue', exact: true }))
      .or(question.getByRole('button', { name: "Continue without trusting (hooks won't run)", exact: true }));
    await expect(choices).toHaveText(['1Review hooks', '2Trust all and continue', "3Continue without trusting (hooks won't run)"]);
    await expect(choices.nth(0)).toBeVisible();
    await expect(choices.nth(1)).toBeVisible();
    await expect(choices.nth(2)).toBeVisible();

    // the approval holds the turn, so no normal prompt is offered to queue behind it
    await expect(page.getByRole('button', { name: 'Switch to normal prompt mode' })).toHaveCount(0);
    expect(state.questionPosts).toEqual([]);
    expect(state.promptPosts).toEqual([]);

    // a failed explicit answer remains retryable
    await choices.nth(1).click();
    await expect(page.getByRole('alert')).toContainText('Unable to send this answer.');
    await expect(question).toBeVisible();
    expect(state.questionPosts).toEqual([{ questionId: hookApprovalQuestion.id, index: 1 }]);
    expect(state.promptPosts).toEqual([]);

    // a successful retry dismisses the stale frame
    state.reject = false;
    await choices.nth(1).click();
    await expect(question).toHaveCount(0);
    expect(state.questionPosts).toEqual([
      { questionId: hookApprovalQuestion.id, index: 1 },
      { questionId: hookApprovalQuestion.id, index: 1 }
    ]);
    expect(state.promptPosts).toEqual([]);
    await pushQuestion(page, 'agent-1', hookApprovalQuestion);
    await expect(question).toHaveCount(0);
  });
}

const folderTrustScenarios = [
  { name: 'Claude', agent: { kind: 'claude', title: 'Claude Code', attention: 'finished' }, question: folderTrustQuestion },
  { name: 'Codex', agent: { kind: 'codex', title: 'Folder access', attention: 'finished' }, question: codexFolderTrustQuestion }
] as const;

// preserve each provider's consent and refusal across desktop and phone viewports
for (const scenario of folderTrustScenarios) for (const viewport of hookApprovalViewports) for (const [index, label] of scenario.question.field.choices.entries()) {
  test(`answers ${scenario.name} folder trust with ${label} explicitly on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const state: ApprovalState = { reject: true, questionPosts: [], promptPosts: [] };
    await installApprovalMock(page, state, scenario.agent);
    await page.goto('/');
    await seedPaneSize(page, 'agent-1', 80, 24);
    await pushQuestion(page, 'agent-1', scenario.question);

    const question = page.getByRole('region', { name: 'Agent question' });
    await expect(question).toBeVisible();
    await expect(question.getByText('Permission request', { exact: true })).toBeVisible();
    await expect(question.getByText(scenario.question.text, { exact: true })).toBeVisible();
    await expect(question.locator('.question-detail')).toHaveText(scenario.question.detail);
    const choices = question.getByRole('button', { name: scenario.question.field.choices[0], exact: true })
      .or(question.getByRole('button', { name: scenario.question.field.choices[1], exact: true }));
    // retain native choice order and exact provider labels
    await expect(choices).toHaveText(scenario.question.field.choices.map((label, index) => `${index + 1}${label}`));
    await expect(page.getByRole('button', { name: 'Switch to normal prompt mode' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveCount(0);
    await expect(question.getByRole('button', { name: 'Reply in your own words' })).toHaveCount(0);
    await expect(question.getByRole('textbox', { name: 'Reply' })).toHaveCount(0);
    await expect(question.getByRole('button', { name: 'Send reply' })).toHaveCount(0);
    expect(state.questionPosts).toEqual([]);
    expect(state.promptPosts).toEqual([]);

    // neutral enter must not accept codex's highlighted native default
    if (scenario.agent.kind === 'codex') {
      await page.keyboard.press('Enter');
      await expect(question).toBeVisible();
      expect(state.questionPosts).toEqual([]);
      expect(state.promptPosts).toEqual([]);
    }

    // keep failed consent visible and retryable
    await question.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Unable to send this answer.');
    await expect(question).toBeVisible();
    expect(state.questionPosts).toEqual([{ questionId: scenario.question.id, index }]);
    expect(state.promptPosts).toEqual([]);

    // dismiss only after the explicit native answer succeeds
    state.reject = false;
    await question.getByRole('button', { name: label, exact: true }).click();
    await expect(question).toHaveCount(0);
    expect(state.questionPosts).toEqual([
      { questionId: scenario.question.id, index },
      { questionId: scenario.question.id, index }
    ]);
    expect(state.promptPosts).toEqual([]);
  });
}

test('keeps free-text denial available for a structured permission', async ({ page }) => {
  const state: ApprovalState = { reject: false, questionPosts: [], promptPosts: [] };
  await installApprovalMock(page, state, { kind: 'claude', title: 'Claude Code', attention: 'question' });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushQuestion(page, 'agent-1', structuredPermissionQuestion);

  const question = page.getByRole('region', { name: 'Agent question' });
  const reply = question.getByRole('button', { name: 'Reply in your own words' });
  await expect(reply).toBeVisible();
  await reply.click();
  await expect(question.getByRole('textbox', { name: 'Reply' })).toBeVisible();
  await expect(question.getByRole('button', { name: 'Send reply' })).toBeVisible();
  expect(state.questionPosts).toEqual([]);
  expect(state.promptPosts).toEqual([]);
});

test('renders inline questions from the pane stream and answers through one endpoint', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  let selectedIndex: number | undefined;
  let selectedQuestionId: string | undefined;
  let answerCount = 0;
  const textAnswers: Array<{ questionId: string; text: string }> = [];
  let rejectTextAnswer = true;
  const submittedPrompts: Array<{ prompt: string; attachments: unknown[] }> = [];
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Action required', attention: 'finished' }, { id: 'agent-2', sessionId: 'socket:$2', home: '/worktrees/owen', title: 'Ready', attention: 'finished' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (/^\/api\/agents\/agent-[12]\/saved-prompts$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (/^\/api\/agents\/agent-[12]\/prompt-history$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    // capture notes and false-positive prompts
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST') {
      submittedPrompts.push(request.postDataJSON() as { prompt: string; attachments: unknown[] });
      return route.fulfill({ status: 204 });
    }
    if (url.pathname === '/api/agents/agent-1/question' && request.method() === 'POST') {
      const body = request.postDataJSON() as { index: number; questionId: string; text?: string };
      // refuse the first text answer without falling back to the prompt queue
      if (body.text !== undefined) {
        if (rejectTextAnswer) return route.fulfill({ status: 409, json: { error: 'question unavailable' } });
        textAnswers.push({ questionId: body.questionId, text: body.text });
        return route.fulfill({ status: 204 });
      }
      selectedIndex = body.index;
      selectedQuestionId = body.questionId;
      answerCount += 1;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  // The panel streams agent-1's pane; the derive reports the current question on a frame.
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushBytes(page, 'agent-1', 'Action required\r\n');
  await pushQuestion(page, 'agent-1', strictQuestion);

  await expect(page.getByText('Agent question')).toBeVisible();
  // the answer layout lives inside the agent panel, below its floating header
  const panel = page.locator('.agent-panel');
  const question = panel.getByRole('region', { name: 'Agent question' });
  await expect(question).toBeVisible();
  const [panelBounds, questionBounds, headerBounds] = await Promise.all([panel.boundingBox(), question.boundingBox(), panel.locator('.panel-header-actions').boundingBox()]);
  expect(questionBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height);
  expect(questionBounds!.y + questionBounds!.height).toBeLessThanOrEqual(panelBounds!.y + panelBounds!.height + 1);
  await expect(page.locator('.question-copy')).toContainText('Which strict-mode end state should govern this cleanup?');
  const choices = page.locator('.question-choice');
  await expect(choices).toHaveCount(4);
  await expect(choices).toHaveText([
    '1Global strict only (Recommended)   Set the UI project to strict.',
    '2Keep targeted checker              Enable global strict with a targeted checker.',
    '3Markers only',
    '4None of the above                  Optionally type a different answer.'
  ]);
  // the numbered-choice layout is unchanged: numbers pinned, answers centered
  await expect(choices.nth(0)).toHaveCSS('display', 'grid');
  const numberBounds = await choices.nth(0).locator('b').boundingBox();
  expect(numberBounds!.width).toBeGreaterThanOrEqual(22);
  const layout = await choices.evaluateAll(buttons => buttons.map(button => {
    const buttonBounds = button.getBoundingClientRect();
    const numberBounds = button.querySelector('b')!.getBoundingClientRect();
    const answerBounds = button.querySelector('span')!.getBoundingClientRect();
    return {
      height: buttonBounds.height,
      numberTop: numberBounds.top - buttonBounds.top,
      numberLeft: numberBounds.left - buttonBounds.left,
      answerCenter: answerBounds.top + answerBounds.height / 2 - buttonBounds.top - buttonBounds.height / 2
    };
  }));
  expect(layout[1]!.height).toBeGreaterThan(layout[2]!.height);
  for (const choice of layout) {
    expect(choice.numberTop).toBeCloseTo(layout[0]!.numberTop, 1);
    expect(choice.numberLeft).toBeCloseTo(layout[0]!.numberLeft, 1);
    expect(choice.answerCenter).toBeCloseTo(0, 1);
  }

  // text answers stay attached to the active question rather than queueing a turn
  const notesToggle = page.getByRole('button', { name: 'Reply in your own words' });
  await expect(notesToggle).toHaveAttribute('aria-expanded', 'false');
  await notesToggle.click();
  const notes = page.getByRole('textbox', { name: 'Reply' });
  await expect(notes).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide reply' })).toHaveAttribute('aria-expanded', 'true');
  await notes.fill('Keep the cleanup scoped to the selected option.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to send this answer.');
  await expect(notes).toHaveValue('Keep the cleanup scoped to the selected option.');
  await expect(page.getByRole('region', { name: 'Agent question' })).toBeVisible();
  expect(submittedPrompts).toEqual([]);
  expect(textAnswers).toEqual([]);

  // a successful retry delivers text directly and clears the accepted draft
  rejectTextAnswer = false;
  await page.getByRole('button', { name: 'Send reply' }).click();
  await expect.poll(() => textAnswers).toEqual([{ questionId: strictQuestion.id, text: 'Keep the cleanup scoped to the selected option.' }]);
  await expect(page.getByRole('region', { name: 'Agent question' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue('');
  expect(submittedPrompts).toEqual([]);
  await pushQuestion(page, 'agent-1', strictQuestion);
  await expect(page.getByRole('region', { name: 'Agent question' })).toHaveCount(0);
  await pushQuestion(page, 'agent-1', null);
  await pushQuestion(page, 'agent-1', strictQuestion);
  await expect(page.getByRole('button', { name: 'Switch to normal prompt mode' })).toBeVisible();

  // normal mode remains available when detection is a false positive
  await page.getByRole('button', { name: 'Switch to normal prompt mode' }).click();
  await expect(page.getByRole('button', { name: 'Switch to answer mode' })).toBeVisible();
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Treat the detected question as ordinary output.');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect.poll(() => submittedPrompts.length).toBe(1);
  expect(submittedPrompts[0]).toEqual({ prompt: 'Treat the detected question as ordinary output.', attachments: [] });
  await page.getByRole('button', { name: 'Switch to answer mode' }).click();
  await expect(page.getByRole('button', { name: 'Switch to normal prompt mode' })).toBeVisible();

  // answering posts the question id and the chosen index through the one endpoint
  await choices.nth(1).click();
  await expect.poll(() => selectedIndex).toBe(1);
  expect(selectedQuestionId).toBe(strictQuestion.id);
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // the optimistic dismissal holds while the derive still reports the same question
  await pushQuestion(page, 'agent-1', strictQuestion);
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // and survives a tab remount, switching away and back through the phone's Workspace sheet
  const currentTab = page.getByRole('tab', { selected: true });
  const workspaces = page.getByRole('dialog', { name: 'Workspaces' }).getByRole('button');
  await currentTab.click();
  await workspaces.nth(1).click();
  await expect(currentTab).toHaveAttribute('id', 'tab-1');
  await currentTab.click();
  await workspaces.nth(0).click();
  await expect(currentTab).toHaveAttribute('id', 'tab-0');
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // a frame carrying no question clears the dismissal
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushQuestion(page, 'agent-1', null);
  await expect(page.getByText('Agent question')).toHaveCount(0);
  // re-reporting the just-answered question now shows it again — the null released the
  // dismissal (a stale dismissal would keep it hidden on its own id)
  await pushQuestion(page, 'agent-1', strictQuestion);
  await expect(page.locator('.question-copy')).toContainText('Which strict-mode end state should govern this cleanup?');
  await pushQuestion(page, 'agent-1', null);
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // extracted controls must not shrink their source viewport
  const liveLog = page.getByLabel('Live log');
  const normalLogHeight = await liveLog.evaluate(element => element.getBoundingClientRect().height);
  await pushQuestion(page, 'agent-1', modelQuestion);
  await expect(page.getByRole('region', { name: 'Agent question' })).toContainText('Select Model and Effort');
  await expect(choices).toHaveCount(7);
  const modelLogHeight = await liveLog.evaluate(element => element.getBoundingClientRect().height);
  expect(modelLogHeight).toBeGreaterThanOrEqual(normalLogHeight);
  selectedIndex = undefined;
  await choices.nth(1).click();
  await expect.poll(() => selectedIndex).toBe(1);
  expect(selectedQuestionId).toBe(modelQuestion.id);
  await expect(page.getByText('Agent question')).toHaveCount(0);

  // a new question (a different id) is shown promptly and answered on its own id
  await pushQuestion(page, 'agent-1', deployQuestion);
  await expect(page.locator('.question-copy')).toContainText('Which deployment environment should receive this release?');
  await expect(choices).toHaveText(['1Staging', '2Production', '3Cancel']);
  selectedIndex = undefined;
  await choices.nth(2).click();
  await expect.poll(() => selectedIndex).toBe(2);
  expect(selectedQuestionId).toBe(deployQuestion.id);
  await expect.poll(() => answerCount).toBe(3);
  await expect(page.getByText('Agent question')).toHaveCount(0);
});

test('shows reported option descriptions and offers no normal prompt while the question holds the turn', async ({ page }) => {
  await installPaneMock(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/worktrees/cora', title: 'Action required', attention: 'question', kind: 'claude' }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (/^\/api\/agents\/agent-1\/(saved-prompts|prompt-history)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await seedPaneSize(page, 'agent-1', 80, 24);
  await pushQuestion(page, 'agent-1', { id: 'question-fruit', text: 'Which fruit?', field: { kind: 'choice', choices: ['Apple', 'Banana'], descriptions: ['A crisp red fruit', ''] }, source: 'structured' });

  const choices = page.locator('.question-choice');
  await expect(choices.nth(0).locator('small')).toHaveText('A crisp red fruit');
  await expect(choices.nth(1).locator('small')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch to normal prompt mode' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reply in your own words' })).toBeVisible();
});
