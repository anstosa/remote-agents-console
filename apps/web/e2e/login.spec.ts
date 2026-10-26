import { expect, test } from '@playwright/test';
// require an explicit homepage action before exposing credential entry
test('opens the protected console login from the public homepage', async ({ page }) => { await page.goto('/'); await expect(page).toHaveTitle('Remote Agent Console'); await expect(page.getByRole('heading', { name: 'Remote Agent Console', exact: true })).toBeVisible(); await expect(page.getByLabel('Password')).toHaveCount(0); await page.getByRole('button', { name: 'Log in', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Console access' })).toBeVisible(); await expect(page.getByLabel('Password')).toBeVisible(); });

test('shows the controlling device and prompts an unnamed device before takeover', async ({ page }) => {
  let takeover: unknown;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: false, controllingDeviceName: 'Studio Mac' } });
    if (url.pathname === '/api/auth/take-control') {
      takeover = route.request().postDataJSON();
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Kitchen iPad', controllingDeviceName: 'Kitchen iPad' } });
    }
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { agents: [], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const controller = page.getByText('Studio Mac is active', { exact: true });
  await expect(controller).toBeVisible();
  await expect(controller).toHaveCSS('text-align', 'center');
  const name = page.getByLabel('Device name');
  await expect(name).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeDisabled();
  await name.fill('Kitchen iPad');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect.poll(() => takeover).toEqual({ deviceName: 'Kitchen iPad' });
});

test('lets a named device take control without asking for its name again', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: false, deviceName: 'Kitchen iPad', controllingDeviceName: 'Studio Mac' } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByText('Studio Mac is active', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Device name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Take control', exact: true })).toBeEnabled();
});

// keep an inactive named client behind explicit takeover
test('does not take control automatically after focus refreshes or reloads', async ({ page }) => {
  let sessionRequests = 0;
  let takeoverRequests = 0;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // model an expired owner without erasing this client identity
    if (url.pathname === '/api/auth/session') {
      sessionRequests += 1;
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: false, deviceName: 'Kitchen iPad' } });
    }
    // activate only after the visible control is selected
    if (url.pathname === '/api/auth/take-control') {
      takeoverRequests += 1;
      return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Kitchen iPad', controllingDeviceName: 'Kitchen iPad' } });
    }
    // expose the normal console after explicit takeover
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [] } });
    // suppress unrelated notification setup
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const takeControl = page.getByRole('button', { name: 'Take control', exact: true });
  await expect(takeControl).toBeEnabled();
  await expect(page.getByText(/is active$/)).toHaveCount(0);
  await expect(page.getByLabel('Device name')).toHaveCount(0);
  expect(takeoverRequests).toBe(0);

  const beforeFocus = sessionRequests;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => sessionRequests).toBeGreaterThan(beforeFocus);
  await expect(takeControl).toBeVisible();
  expect(takeoverRequests).toBe(0);

  const beforeReload = sessionRequests;
  await page.reload();
  await expect.poll(() => sessionRequests).toBeGreaterThan(beforeReload);
  await expect(takeControl).toBeVisible();
  expect(takeoverRequests).toBe(0);

  await takeControl.click();
  await expect.poll(() => takeoverRequests).toBe(1);
  await expect(page.getByRole('heading', { name: 'No sessions' })).toBeVisible();
});

test('prompts the first active device for a name before opening the console', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await expect(page.getByText('Name this device.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Device name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save device name', exact: true })).toBeDisabled();
});
