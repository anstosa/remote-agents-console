import { access, readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const enabledDavo = { enabled: true, available: true, name: 'Davo', context: '' };

// provide the minimum authenticated dashboard surface
async function mockDashboard(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one authenticated browser
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'davo-csrf', active: true, deviceName: 'Test browser', davo: enabledDavo, server: { name: 'Framework', url: 'https://framework.example', remotes: [] } } });
    // expose an empty ordinary dashboard
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // page older retained history separately
    if (url.pathname === '/api/davo/conversation') {
      const older = url.searchParams.has('beforeSequence');
      return route.fulfill({ json: {
        conversationId: 'davo-conversation', generation: 4, revision: '33333333-3333-4333-8333-333333333333', retainedFrom: '2026-11-03T08:00:00.000Z', serverNow: '2026-11-05T22:00:00.000Z', retentionCutoffAt: '2026-11-06T11:00:00.000Z', nextSequence: 4, hasMore: !older,
        pendingChoices: older ? [] : [{ requestId: '44444444-4444-4444-8444-444444444444', choiceId: '55555555-5555-4555-8555-555555555555', kind: 'davo_continuation_choice', question: 'Should Davo resume after the current Agent chain?', options: ['Resume after the chain', 'Wait for another update'] }],
        messages: older
          ? [{ id: 'message-1', sequence: 1, kind: 'user', text: 'Earlier retained request', createdAt: '2026-11-03T18:00:00.000Z', expiresAt: '2026-11-06T11:00:00.000Z' }]
          : [{ id: 'message-2', sequence: 2, kind: 'user', text: 'Check the current work', createdAt: '2026-11-05T20:00:00.000Z', expiresAt: '2026-11-08T11:00:00.000Z' }, { id: 'message-3', sequence: 3, kind: 'assistant', text: 'The work remains in progress.', createdAt: '2026-11-05T20:01:00.000Z', expiresAt: '2026-11-08T11:00:00.000Z' }]
      } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
}

test('renders server-owned Davo history without a typed composer or telephone metaphor', async ({ page }) => {
  await mockDashboard(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open Davo' }).click();

  const dialog = page.getByRole('dialog', { name: 'Davo' });
  await expect(dialog.getByText('Check the current work')).toBeVisible();
  await expect(dialog.getByText('The work remains in progress.')).toBeVisible();
  await expect(dialog.getByText('Should Davo resume after the current Agent chain?')).toBeVisible();
  await expect(dialog.getByText('Resume after the chain')).toBeVisible();
  await expect(dialog.getByText('Wait for another update')).toBeVisible();
  await expect(dialog.getByText('Answer by voice while listening is open.')).toBeVisible();
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Resume after the chain' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Load older' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Load older' }).click();
  await expect(dialog.getByText('Earlier retained request')).toBeVisible();
  await expect(page.getByText(/call|calling|hang up|ringing/iu)).toHaveCount(0);
});

// open the persistent surface from generic notification links
test('opens retained chat from the davo notification deep link', async ({ page }) => {
  await mockDashboard(page);
  await page.goto('/#davo');
  await expect(page.getByRole('dialog', { name: 'Davo' })).toBeVisible();
  await expect(page.getByText('Check the current work')).toBeVisible();
});

test('ships no Davo ringing or disconnect audio assets', async () => {
  const voice = await readFile(new URL('../src/voice/voice-dialog.tsx', import.meta.url), 'utf8');
  expect(voice).not.toMatch(/davo-(?:ring|hangup)\.wav|Calling|Hang up/iu);
  await expect(access(new URL('../public/davo-ring.wav', import.meta.url))).rejects.toThrow();
  await expect(access(new URL('../public/davo-hangup.wav', import.meta.url))).rejects.toThrow();
});
