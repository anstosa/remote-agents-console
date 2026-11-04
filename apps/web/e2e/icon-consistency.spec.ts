import { expect, test } from '@playwright/test';

// lock the line-icon scale across the main control families
test('keeps action icons at one size and stroke width', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <nav class="tabs"><button class="server-switcher-settings"><svg viewBox="0 0 24 24"></svg></button><button class="server-switcher-voice"><svg viewBox="0 0 24 24"></svg></button><button class="new-agent-tab"><svg viewBox="0 0 24 24"></svg></button><span class="tab-place-mark"><svg viewBox="0 0 24 24"></svg></span></nav>
    <svg class="agent-switcher-chevron" viewBox="0 0 24 24"></svg>
    <span class="note-schedule-badge"><svg viewBox="0 0 24 24"></svg></span>
    <div class="note-picker-menu"><svg class="note-picker-scheduled" viewBox="0 0 24 24"></svg></div>
    <button class="code-pane-files-open"><svg viewBox="0 0 24 24"></svg></button>
    <button class="code-pane-file-collapse"><svg viewBox="0 0 24 24"></svg></button>
    <section class="agent-composer-column"><button class="queue"><svg viewBox="0 0 24 24"></svg></button></section>
    <section class="workspace-toolbar-actions"><button class="toolbar-button terminal-picker-toggle"><svg viewBox="0 0 24 24"></svg></button><svg class="git-branch-icon" viewBox="0 0 24 24"></svg><button class="more icon-button"><svg viewBox="0 0 24 24"></svg></button><button class="project-stack-trigger project-stack-toggle toolbar-button"><svg class="project-stack-server-icon" viewBox="0 0 24 24"></svg></button></section>
    <button class="panel-header-action"><svg viewBox="0 0 24 24"></svg></button>
    <svg class="more-menu-icon" viewBox="0 0 24 24"></svg>
    <svg class="launch-chevron-icon" viewBox="0 0 24 24"></svg>
    <span class="launcher-single"><svg class="launcher-icon-glyph" viewBox="0 0 24 24"></svg></span>
    <span class="launcher-shells"><svg class="launcher-icon-glyph" viewBox="0 0 24 24"></svg></span>
    <svg class="launch-lock" viewBox="0 0 24 24"></svg>
    <div class="upstream-rebase-notification"><svg viewBox="0 0 24 24"></svg></div>
  `);
  const selectors = [
    '.server-switcher-settings svg', '.server-switcher-voice svg', '.new-agent-tab svg', '.tab-place-mark svg',
    '.agent-switcher-chevron', '.note-schedule-badge svg', '.note-picker-scheduled',
    '.code-pane-files-open svg', '.code-pane-file-collapse svg', '.agent-composer-column .queue svg',
    '.terminal-picker-toggle svg', '.git-branch-icon', '.more.icon-button svg', '.project-stack-server-icon',
    '.panel-header-action svg', '.more-menu-icon', '.launch-chevron-icon', '.launcher-single .launcher-icon-glyph',
    '.launcher-shells .launcher-icon-glyph', '.launch-lock', '.upstream-rebase-notification > svg'
  ];
  // compare rendered metrics instead of individual stylesheet declarations
  for (const selector of selectors) {
    const paint = await page.locator(selector).evaluate(element => {
      const style = getComputedStyle(element);
      return { width: style.width, height: style.height, stroke: Number.parseFloat(style.strokeWidth) };
    });
    expect(paint, selector).toEqual({ width: '16px', height: '16px', stroke: 2 });
  }
});
