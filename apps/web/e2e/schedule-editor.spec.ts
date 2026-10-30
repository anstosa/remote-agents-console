import { expect, test, type Page } from '@playwright/test';
import type { Schedule } from '../src/schedule-editor.js';

// pin the zone so the server-supplied instants render as fixed local sentences
test.use({ timezoneId: 'America/Los_Angeles' });

type Emitted = { type: string; body?: { cron: string; enabled: boolean; kind: string; target: unknown } };
const emitted = (page: Page) => page.evaluate(() => (window as unknown as { scheduleEmitted: Emitted[] }).scheduleEmitted);
const lastBody = async (page: Page) => (await emitted(page)).at(-1)?.body;

const mount = async (page: Page, initial?: Schedule) => {
  await page.goto('/');
  await page.evaluate(async initial => {
    const { renderScheduleEditor } = await import('/e2e/schedule-editor-fixture.tsx');
    const root = document.createElement('div');
    root.style.width = '100%';
    document.body.replaceChildren(root);
    renderScheduleEditor(root, initial);
  }, initial);
};

const editorOf = (page: Page) => page.getByRole('group', { name: 'Schedule', exact: true });

// the full slot walk, asserted identically at both viewports
const walk = async (page: Page) => {
  await mount(page);
  const editor = editorOf(page);

  // unscheduled state and hint
  await expect(editor).toContainText('Not scheduled.');
  await expect(editor).toContainText('Starts as every day at 9:00 AM on atlas · main worktree');

  // create → daily 9:00 AM sentence
  await editor.getByRole('button', { name: 'Schedule this note' }).click();
  await expect(editor.getByRole('switch', { name: 'Schedule enabled' })).toHaveText('● Runs');
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every day');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveText('9:00 AM');
  await expect(editor).toContainText('Claude');
  await expect(editor).toContainText('atlas · main worktree');
  await expect(editor).toContainText('Next Mon 7 Sep 9:00 AM');
  await expect(editor).toContainText('Not run yet');
  await expect(editor.getByRole('button', { name: 'Remove schedule' })).toBeVisible();
  expect(await emitted(page)).toEqual([{ type: 'set', body: { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true } }]);

  // cadence popover: preset, description and the server preview
  await editor.getByRole('button', { name: 'Cadence' }).click();
  const cadence = editor.getByRole('dialog', { name: 'Cadence' });
  await expect(cadence.getByRole('button', { name: 'Daily at' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cadence).toContainText('Every day at 9:00 AM');
  await expect(cadence).toContainText('Next Mon 7 Sep 9:00 AM · Tue 8 Sep 9:00 AM · Wed 9 Sep 9:00 AM');
  await page.keyboard.press('Escape');
  await expect(cadence).toHaveCount(0);

  // change the time → emits the new cron and updates the slot
  await editor.getByRole('button', { name: 'Time' }).click();
  await editor.getByLabel('Set time').fill('08:30');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveText('8:30 AM');
  expect(await lastBody(page)).toEqual({ cron: '30 8 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  await page.keyboard.press('Escape');

  // pause → the switch and footnote change
  await editor.getByRole('switch', { name: 'Schedule enabled' }).click();
  await expect(editor.getByRole('switch', { name: 'Schedule enabled' })).toHaveText('○ Paused');
  await expect(editor).toContainText('Paused · would next run Mon 7 Sep 9:00 AM');
  expect(await lastBody(page)).toEqual({ cron: '30 8 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: false });

  // remove → back to unscheduled
  await editor.getByRole('button', { name: 'Remove schedule' }).click();
  await expect(editor).toContainText('Not scheduled.');
  expect((await emitted(page)).at(-1)).toEqual({ type: 'remove' });
};

test('walks every Schedule slot at a desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await walk(page);
});

test('walks every Schedule slot at a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await walk(page);
});

// each cadence preset's emitted cron and rendered sentence, plus the raw-cron field
test('maps the weekdays, weekly, every-N and cron cadences', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page);
  const editor = editorOf(page);
  const base = { kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true };

  await editor.getByRole('button', { name: 'Schedule this note' }).click();
  await editor.getByRole('button', { name: 'Cadence' }).click();
  const cadence = editor.getByRole('dialog', { name: 'Cadence' });

  // weekdays: M H * * 1-5, keeps the trailing time slot
  await cadence.getByRole('button', { name: 'Weekdays at' }).click();
  expect(await lastBody(page)).toEqual({ ...base, cron: '0 9 * * 1-5' });
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every weekday');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveText('9:00 AM');

  // weekly: Sunday = 0, ascending; day chips add and remove days by name
  await cadence.getByRole('button', { name: 'Weekly on' }).click();
  expect(await lastBody(page)).toEqual({ ...base, cron: '0 9 * * 1' });
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every Mon');
  await cadence.getByRole('button', { name: 'Wednesday' }).click();
  await cadence.getByRole('button', { name: 'Friday' }).click();
  expect(await lastBody(page)).toEqual({ ...base, cron: '0 9 * * 1,3,5' });
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every Mon, Wed, Fri');
  await cadence.getByRole('button', { name: 'Monday' }).click();
  expect(await lastBody(page)).toEqual({ ...base, cron: '0 9 * * 3,5' });
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every Wed, Fri');

  // every N hours: 0 */N * * *, no time slot; a divisor reads "every N h"
  await cadence.getByRole('button', { name: 'Every N hours' }).click();
  expect(await lastBody(page)).toEqual({ ...base, cron: '0 */6 * * *' });
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every 6 h');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveCount(0);
  // a non-divisor spells out the hours it fires and notes the midnight restart
  await cadence.getByRole('button', { name: 'Fewer hours' }).click();
  expect(await lastBody(page)).toEqual({ ...base, cron: '0 */5 * * *' });
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('at 12:00 AM, 5:00 AM, 10:00 AM, 3:00 PM, 8:00 PM (restarts at midnight)');

  // raw cron: an invalid expression shows inline and keeps the previous value
  await cadence.getByRole('button', { name: 'Cron' }).click();
  const priorCount = (await emitted(page)).length;
  await editor.getByLabel('Cron expression').fill('nope');
  await editor.getByLabel('Cron expression').press('Enter');
  await expect(cadence.getByRole('alert')).toContainText('Invalid cron expression: nope');
  expect((await emitted(page)).length).toBe(priorCount);
  // a valid expression the presets cannot express emits and reads "on cron …"
  await editor.getByLabel('Cron expression').fill('0 9 1 * *');
  await editor.getByLabel('Cron expression').press('Enter');
  expect(await lastBody(page)).toEqual({ ...base, cron: '0 9 1 * *' });
  await expect(cadence.getByRole('alert')).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('on cron 0 9 1 * *');
});

// re-opening the popover restores the preset that reproduces a stored expression
test('restores a stored weekly expression as the weekly preset', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '30 7 * * 1,3,5', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every Mon, Wed, Fri');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveText('7:30 AM');
  await editor.getByRole('button', { name: 'Cadence' }).click();
  const cadence = editor.getByRole('dialog', { name: 'Cadence' });
  await expect(cadence.getByRole('button', { name: 'Weekly on' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cadence.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cadence.getByRole('button', { name: 'Wednesday' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cadence.getByRole('button', { name: 'Friday' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cadence.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'false');
});

// a stored weekdays expression restores the Weekdays preset and its time
test('restores a stored weekdays expression as the weekdays preset', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 6 * * 1-5', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every weekday');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveText('6:00 AM');
  await editor.getByRole('button', { name: 'Cadence' }).click();
  await expect(editor.getByRole('dialog', { name: 'Cadence' }).getByRole('button', { name: 'Weekdays at' })).toHaveAttribute('aria-pressed', 'true');
});

// a stored every-N expression restores the Every-N preset and its stepper value, with no time slot
test('restores a stored every-N expression as the every-N preset', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 */8 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every 8 h');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Cadence' }).click();
  const cadence = editor.getByRole('dialog', { name: 'Cadence' });
  await expect(cadence.getByRole('button', { name: 'Every N hours' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cadence.getByRole('group', { name: 'Hours between runs' })).toContainText('8 h');
});

// closing and reopening the popover clears a rejected raw-cron draft, even for a raw-stored schedule
test('reopening the cadence popover discards a rejected raw-cron draft', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 9 1 * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await editor.getByRole('button', { name: 'Cadence' }).click();
  const cadence = editor.getByRole('dialog', { name: 'Cadence' });
  await expect(editor.getByLabel('Cron expression')).toHaveValue('0 9 1 * *');
  await editor.getByLabel('Cron expression').fill('broken');
  await editor.getByLabel('Cron expression').press('Enter');
  await expect(cadence.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cadence).toHaveCount(0);
  // reopening re-derives from the stored expression with no stale draft or error
  await editor.getByRole('button', { name: 'Cadence' }).click();
  await expect(editor.getByLabel('Cron expression')).toHaveValue('0 9 1 * *');
  await expect(editor.getByRole('dialog', { name: 'Cadence' }).getByRole('alert')).toHaveCount(0);
});

// editing the time on a non-daily preset keeps that preset (it must not revert to Daily)
test('editing the time on a weekly schedule keeps it weekly', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 9 * * 1,3,5', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await editor.getByRole('button', { name: 'Time' }).click();
  await editor.getByLabel('Set time').fill('08:30');
  expect(await lastBody(page)).toEqual({ cron: '30 8 * * 1,3,5', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every Mon, Wed, Fri');
});

// entering raw Cron mode then closing without committing drops the mode and restores the sentence
test('leaving raw Cron mode without committing keeps the derived preset', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await editor.getByRole('button', { name: 'Cadence' }).click();
  await editor.getByRole('dialog', { name: 'Cadence' }).getByRole('button', { name: 'Cron' }).click();
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('on cron 0 9 * * *');
  await page.keyboard.press('Escape');
  // the sentence re-derives to Daily with its time slot back, and reopening shows Daily pressed
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every day');
  await expect(editor.getByRole('button', { name: 'Time' })).toHaveText('9:00 AM');
  await editor.getByRole('button', { name: 'Cadence' }).click();
  await expect(editor.getByRole('dialog', { name: 'Cadence' }).getByRole('button', { name: 'Daily at' })).toHaveAttribute('aria-pressed', 'true');
});

// weekly days emit ascending and de-duplicated no matter the tap order, and never empty
test('weekly day chips stay canonical and non-empty', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 9 * * 1', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await editor.getByRole('button', { name: 'Cadence' }).click();
  const cadence = editor.getByRole('dialog', { name: 'Cadence' });
  // tap Saturday before Wednesday — the emitted list is still ascending
  await cadence.getByRole('button', { name: 'Saturday' }).click();
  await cadence.getByRole('button', { name: 'Wednesday' }).click();
  expect(await lastBody(page)).toEqual({ cron: '0 9 * * 1,3,6', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every Mon, Wed, Sat');
  // deselect down to one day, then tapping the last remaining day is a no-op (never emits an empty list)
  await cadence.getByRole('button', { name: 'Wednesday' }).click();
  await cadence.getByRole('button', { name: 'Saturday' }).click();
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('every Mon');
  const beforeLast = (await emitted(page)).length;
  await cadence.getByRole('button', { name: 'Monday' }).click();
  expect((await emitted(page)).length).toBe(beforeLast);
  await expect(cadence.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
});

// switching to another preset clears a rejected raw draft even when the emitted cron is unchanged
test('switching away from raw Cron clears a rejected draft', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await editor.getByRole('button', { name: 'Cadence' }).click();
  const cadence = editor.getByRole('dialog', { name: 'Cadence' });
  await cadence.getByRole('button', { name: 'Cron' }).click();
  await editor.getByLabel('Cron expression').fill('bad');
  await editor.getByLabel('Cron expression').press('Enter');
  await expect(cadence.getByRole('alert')).toBeVisible();
  // Daily emits the same stored cron (no prop change), then Cron re-shows the field: it must be clean
  await cadence.getByRole('button', { name: 'Daily at' }).click();
  await cadence.getByRole('button', { name: 'Cron' }).click();
  await expect(editor.getByLabel('Cron expression')).toHaveValue('0 9 * * *');
  await expect(cadence.getByRole('alert')).toHaveCount(0);
});

// a parseable cron that never matches a date is refused inline, not committed
test('refuses a raw cron that never runs', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await editor.getByRole('button', { name: 'Cadence' }).click();
  const cadence = editor.getByRole('dialog', { name: 'Cadence' });
  await cadence.getByRole('button', { name: 'Cron' }).click();
  const priorCount = (await emitted(page)).length;
  await editor.getByLabel('Cron expression').fill('0 0 31 2 *');
  await editor.getByLabel('Cron expression').press('Enter');
  await expect(cadence.getByRole('alert')).toContainText('never runs');
  expect((await emitted(page)).length).toBe(priorCount);
});

// the Adapter and target pickers reuse the launcher rows; the Adapter follows the target until pinned
test('picks a target and an Adapter, the Adapter following the target until pinned', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page);
  const editor = editorOf(page);
  await editor.getByRole('button', { name: 'Schedule this note' }).click();
  // created on the prefill target (wt-main → Claude); both slots read the resolved sentence
  await expect(editor.getByRole('button', { name: 'Agent' })).toContainText('Claude');
  await expect(editor.getByRole('button', { name: 'Target' })).toHaveText('atlas · main worktree');

  // the target picker lists Scratch, both atlas worktrees (main marked) and the directory Project
  await editor.getByRole('button', { name: 'Target' }).click();
  const targetPop = editor.getByRole('dialog', { name: 'Target' });
  await expect(targetPop.getByRole('radio', { name: /Scratch/ })).toBeVisible();
  await expect(targetPop.getByRole('radio', { name: /main worktree/ })).toBeVisible();
  await expect(targetPop.getByRole('radio', { name: /feature/ })).toBeVisible();
  await expect(targetPop.getByRole('radio', { name: /notes.*directory/ })).toBeVisible();
  await expect(targetPop.getByRole('radio', { name: /main worktree/ })).toHaveAttribute('aria-checked', 'true');
  // rows are grouped under their Project heading, and an unavailable target is disabled with its reason
  await expect(targetPop.locator('.schedule-proj-head')).toHaveText(['atlas', 'notes']);
  await expect(targetPop.getByRole('radio', { name: /locked/ })).toBeDisabled();
  await expect(targetPop.getByRole('radio', { name: /locked/ })).toContainText('Worktree is locked');

  // pick the directory Project (→ Codex): not pinned, so the Adapter follows the target to Codex
  await targetPop.getByRole('radio', { name: /notes.*directory/ }).click();
  expect(await lastBody(page)).toEqual({ cron: '0 9 * * *', kind: 'codex', target: { projectId: 'notes-dir' }, enabled: true });
  await expect(editor.getByRole('button', { name: 'Agent' })).toContainText('Codex');
  await expect(editor.getByRole('button', { name: 'Target' })).toHaveText('notes · directory');

  // the Adapter picker reuses the launcher rows: an unconfigured kind is disabled with its reason
  await editor.getByRole('button', { name: 'Agent' }).click();
  const agentPop = editor.getByRole('dialog', { name: 'Agent' });
  await expect(agentPop.getByRole('radio', { name: /Pi/ })).toBeDisabled();
  // pin the Adapter to Claude explicitly
  await agentPop.getByRole('radio', { name: 'Claude' }).click();
  expect(await lastBody(page)).toEqual({ cron: '0 9 * * *', kind: 'claude', target: { projectId: 'notes-dir' }, enabled: true });

  // retargeting to Scratch (→ Codex) now keeps the pinned Claude
  await editor.getByRole('button', { name: 'Target' }).click();
  await editor.getByRole('dialog', { name: 'Target' }).getByRole('radio', { name: /Scratch/ }).click();
  expect(await lastBody(page)).toEqual({ cron: '0 9 * * *', kind: 'claude', target: { scratch: true }, enabled: true });
});

// a Schedule whose target has disappeared is kept and shown as unable to run, then recoverable
test('renders a Schedule with a vanished target as unable to run', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-removed' }, enabled: true });
  const editor = editorOf(page);
  const targetSlot = editor.getByRole('button', { name: 'Target' });
  await expect(targetSlot).toHaveText('a removed worktree');
  await expect(targetSlot).toHaveClass(/schedule-slot-bad/);
  await expect(editor).toContainText('Runs are skipped until you pick another target');
  await expect(editor.locator('.schedule-next')).toContainText('will be skipped');

  // the picker names the removed target and offers the live ones; picking one clears the skip state
  await targetSlot.click();
  const targetPop = editor.getByRole('dialog', { name: 'Target' });
  await expect(targetPop).toContainText('This target no longer exists');
  await targetPop.getByRole('radio', { name: /main worktree/ }).click();
  expect(await lastBody(page)).toEqual({ cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  await expect(editor.getByRole('button', { name: 'Target' })).toHaveText('atlas · main worktree');
  await expect(editor).not.toContainText('will be skipped');
});

// a stored kind that differs from its target's resolved kind is treated as pinned on mount, so
// the Adapter does not follow a later retarget (the record carries no explicit flag; it is inferred)
test('treats a stored kind unlike the resolved kind as a pin across retargets', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // wt-main resolves to Claude, so a stored Codex kind reads as a deliberate pin
  await mount(page, { cron: '0 9 * * *', kind: 'codex', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await expect(editor.getByRole('button', { name: 'Agent' })).toContainText('Codex');
  // retarget to feature (resolves to Claude): the pin holds, so the kind stays Codex
  await editor.getByRole('button', { name: 'Target' }).click();
  await editor.getByRole('dialog', { name: 'Target' }).getByRole('radio', { name: /feature/ }).click();
  expect(await lastBody(page)).toEqual({ cron: '0 9 * * *', kind: 'codex', target: { worktreeId: 'wt-feature' }, enabled: true });
});

// a vanished directory-Project target reads as a project, not a worktree
test('labels a gone directory-Project target honestly', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 9 * * *', kind: 'codex', target: { projectId: 'gone-dir' }, enabled: true });
  const editor = editorOf(page);
  await expect(editor.getByRole('button', { name: 'Target' })).toHaveText('an unavailable project');
  await expect(editor.locator('.schedule-next')).toContainText('will be skipped');
});

// a stored expression the server can no longer parse renders as unable to run
test('shows a stored cron that no longer parses as invalid', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: 'nonsense', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true });
  const editor = editorOf(page);
  await expect(editor).toHaveClass(/schedule-invalid/);
  await expect(editor.locator('.schedule-invalid-note')).toBeVisible();
  await expect(editor).toContainText('invalid cron');
  await expect(editor.getByRole('button', { name: 'Cadence' })).toHaveText('on cron nonsense');
});

test('aims a Schedule at the Conductor, and shows a Run it was delivered as a quiet outcome', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page);
  const editor = editorOf(page);
  await editor.getByRole('button', { name: 'Schedule this note' }).click();
  await editor.getByRole('button', { name: 'Target' }).click();
  await editor.getByRole('dialog', { name: 'Target' }).getByRole('radio', { name: /Conductor/ }).click();
  expect(await lastBody(page)).toEqual({ cron: '0 9 * * *', kind: 'pi', target: { conductor: true }, enabled: true });
  await expect(editor.getByRole('button', { name: 'Target' })).toHaveText('Conductor');

  await mount(page, { cron: '0 9 * * *', kind: 'pi', target: { conductor: true }, enabled: true, lastRun: { at: '2026-09-06T09:00:00-07:00', status: 'delivered', agentId: 'conductor-1' } });
  const last = editorOf(page).locator('.schedule-last');
  await expect(last).toContainText('delivered');
  await expect(last).not.toHaveClass(/bad/u);
});

test('offers a model and Effort for a Schedule, but none for one aimed at the Conductor, which runs on its own', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mount(page, { cron: '0 9 * * *', kind: 'pi', target: { worktreeId: 'wt-main' }, enabled: true });
  await editorOf(page).getByRole('button', { name: 'Agent' }).click();
  await expect(editorOf(page).getByRole('radiogroup', { name: 'Model' })).toBeVisible();

  await mount(page, { cron: '0 9 * * *', kind: 'pi', target: { conductor: true }, enabled: true });
  await editorOf(page).getByRole('button', { name: 'Agent' }).click();
  await expect(editorOf(page).getByRole('dialog', { name: 'Agent' })).toBeVisible();
  await expect(editorOf(page).getByRole('radiogroup', { name: 'Model' })).toHaveCount(0);
  await expect(editorOf(page).getByLabel('Effort')).toHaveCount(0);
});
