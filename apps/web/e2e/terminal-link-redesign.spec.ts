import { expect, test, type Page } from '@playwright/test';
import { resolveTerminalLinks } from '../src/terminal-link-resolver.js';
import type { LinkSnapshot } from '../src/terminal-link-metadata.js';
import { installPaneMock, pushBytes, seedPaneSize } from './pane-stream-mock.js';

type LinkClipboardWindow = typeof window & { __terminalLinkClipboard: string[] };

test.describe.configure({ timeout: 120_000 });

// mount one isolated real-xterm scenario
const mountScenario = async (page: Page, output: string, options: { columns?: number; rows?: number; scrollback?: number; fileCapability?: boolean; missingOscLookup?: boolean; missingCellMetadata?: boolean } = {}) => {
  await page.goto('/');
  await page.setContent('<div id="terminal-link-redesign"></div>');
  await page.evaluate(async ({ output, options }) => {
    const { renderTerminalLinkScenario } = await import('/e2e/terminal-link-redesign-fixture.ts');
    const container = document.querySelector<HTMLElement>('#terminal-link-redesign');
    // require the isolated host
    if (container === null) throw new Error('terminal link redesign fixture is unavailable');
    await renderTerminalLinkScenario(container, output, options);
  }, { output, options });
  await expect(page.locator('#terminal-link-redesign')).toHaveAttribute('data-ready', 'true');
};

// mount one production Agent output panel
const mountAgentScenario = async (page: Page) => {
  const agentId = 'agent-terminal-link-redesign';
  await installPaneMock(page);
  await page.addInitScript(() => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { writes.push(value); } } });
    Object.defineProperty(window, '__terminalLinkClipboard', { configurable: true, value: writes });
  });
  await page.context().route('https://target.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<main>controlled explicit target</main>' }));
  await page.route('**/api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // serve the authenticated shell
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'link-redesign-csrf', active: true, deviceName: 'Test device' } });
    // serve one live Agent
    if (path === '/api/dashboard') return route.fulfill({ json: {
      generation: 1,
      agents: [{ id: agentId, sessionId: 'socket:$9', home: '/worktrees/cora', worktreeId: 'cora', projectId: 'repo', worktreeLabel: 'Cora', title: 'Ready', queuedPromptCount: 0 }],
      projects: [{ id: 'repo', label: 'Repo', available: true, worktrees: [{ id: 'cora', projectId: 'repo', label: 'Cora', path: '/worktrees/cora', main: false, detached: false, locked: false, branch: 'main', available: true, pinned: true, order: 0 }] }]
    } });
    // issue one pane ticket
    if (path === `/api/agents/${agentId}/tickets`) return route.fulfill({ json: { ticket: 'pane-ticket' } });
    // keep empty Agent collections deterministic
    if (new RegExp(`^/api/agents/${agentId}/(?:saved-prompts|queued-prompts|prompt-history)$`, 'u').test(path)) return route.fulfill({ json: { prompts: [] } });
    // keep optional panels empty
    if (path.endsWith('/notes') && request.method() === 'GET') return route.fulfill({ json: { notes: [] } });
    // keep optional terminals empty
    if (path.endsWith('/panes') && request.method() === 'GET') return route.fulfill({ json: { panes: [] } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  await page.goto('/');
  await seedPaneSize(page, agentId, 72, 24);
  return agentId;
};

test('uses non-cyan underline continuity for an opaque hard-row target with unequal padding', async ({ page }) => {
  const first = 'https://example.com/runs/opaque-segment-';
  const last = 'alphaZ9v2/details?view=summary#step-7';
  const uri = first + last;
  const magentaUnderline = '\x1b[38;2;214;93;177m\x1b[4m';
  const reset = '\x1b[0m';
  await page.context().route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>controlled opaque target</main>' }));
  await mountScenario(page, `Result: ${magentaUnderline}${first}${reset}      \r\n             ${magentaUnderline}${last}${reset}`);

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  // verify both physical segments
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
  await expect(page.getByRole('link', { name: /^Preview /u })).toHaveCount(0);
  const popupPromise = page.waitForEvent('popup');
  await links.last().click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(uri);
  await expect(popup.getByText('controlled opaque target', { exact: true })).toBeVisible();
  await popup.close();
});

// keep same-styled file-like text attached when syntax bonds it to the URL path
test('continues a styled file-like segment after a trailing URL slash', async ({ page }) => {
  const first = 'https://example.com/assets/';
  const last = 'icons/logo.svg';
  const uri = first + last;
  const magentaUnderline = '\x1b[35;4m';
  await mountScenario(page, `prefix ${magentaUnderline}${first}\x1b[0m\r\n  ${magentaUnderline}${last}\x1b[0m`, { fileCapability: true });

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  // verify both styled physical segments resolve to the URL
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
  await expect(page.getByRole('link', { name: `Preview ${last}`, exact: true })).toHaveCount(0);
});

test('uses distinctive style to continue a fully alphabetic opaque segment', async ({ page }) => {
  const first = 'https://example.com/run/opaquealph';
  const last = 'abeticsegment';
  const uri = first + last;
  const violetUnderline = '\x1b[38;2;180;130;255m\x1b[4m';
  await mountScenario(page, `prefix ${violetUnderline}${first}\x1b[0m   \r\n       ${violetUnderline}${last}\x1b[0m`);

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  // verify both styled segments
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
});

test('preserves the synthetic long UUID route through styled hard rows', async ({ page }) => {
  const first = 'https://example.com/project/e9e7cc10-a174-49ed-95a2-5a011509c988/parameter/optimizer/889ea2fd-8dc3-496a-8528-68c8ba56bf71/trial/abad44dc-6180-4d3a-';
  const last = 'aac3-641b3af3a5c9/entity/protocol/0a7ce623-ed88-4325-b364-4fbb32fd0768/execution?protocol-tab=plate_maps';
  const uri = first + last;
  const greenUnderline = '\x1b[38;2;166;227;161m\x1b[4m';
  await mountScenario(page, `Protocol: ${greenUnderline}${first}\x1b[0m\r\n    ${greenUnderline}${last}\x1b[0m`, { columns: 160 });

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  // verify both physical segments
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
  await expect(page.getByRole('link', { name: /^Preview /u })).toHaveCount(0);
});

test('opens and copies the explicit OSC 8 target from the production Agent menu', async ({ page }) => {
  const target = 'https://target.example.test/real?source=osc8&copy=full';
  const label = 'https://decoy.example.test/visible-file.ts';
  const agentId = await mountAgentScenario(page);
  await pushBytes(page, agentId, `Result: \x1b]8;;${target}\x07${label}\x1b]8;;\x07`);

  const log = page.getByLabel('Live log', { exact: true });
  const link = log.getByRole('link', { name: `Open ${target}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', target);
  await expect(log.getByRole('link', { name: `Open ${label}`, exact: true })).toHaveCount(0);
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(target);
  await popup.close();

  await link.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Agent actions' });
  await menu.getByRole('menuitem', { name: 'Copy URL', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as LinkClipboardWindow).__terminalLinkClipboard)).toEqual([target]);
});

test('gives an explicit OSC 8 target precedence over its misleading URL-shaped label', async ({ page }) => {
  const target = 'https://target.example.test/real?source=osc8&row=1';
  const label = 'https://decoy.example.test/visible-file.ts';
  await page.context().route('https://target.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<main>controlled OSC target</main>' }));
  await mountScenario(page, `Target: \x1b]8;;${target}\x07${label}\x1b]8;;\x07`);

  const link = page.getByRole('link', { name: `Open ${target}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', target);
  await expect(page.getByRole('link', { name: `Open ${label}`, exact: true })).toHaveCount(0);
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(target);
  await popup.close();
});

test('reserves an OSC 8 label when its explicit target is unsafe', async ({ page }) => {
  const label = 'https://decoy.example.test/unsafe-visible';
  await mountScenario(page, `Unsafe: \x1b]8;;javascript:alert(1)\x07${label}\x1b]8;;\x07`);

  await expect(page.getByRole('link', { name: `Open ${label}`, exact: true })).toHaveCount(0);
  await expect(page.locator('.output-link-overlay')).toHaveCount(0);
});

test('reserves an OSC 8 label when the pinned lookup seam is unavailable', async ({ page }) => {
  const target = 'https://target.example.test/missing-lookup';
  const label = 'https://decoy.example.test/missing-lookup';
  await mountScenario(page, `Missing: \x1b]8;;${target}\x07${label}\x1b]8;;\x07`, { missingOscLookup: true });

  await expect(page.getByRole('link', { name: `Open ${target}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: `Open ${label}`, exact: true })).toHaveCount(0);
  await expect(page.locator('.output-link-overlay')).toHaveCount(0);
});

test('fails closed when the pinned cell metadata interface is unavailable', async ({ page }) => {
  const target = 'https://target.example.test/missing-cell-interface';
  const label = 'https://decoy.example.test/missing-cell-interface';
  await mountScenario(page, `Missing: \x1b]8;;${target}\x07${label}\x1b]8;;\x07`, { missingCellMetadata: true });

  await expect(page.getByRole('link')).toHaveCount(0);
  await expect(page.locator('.output-link-overlay')).toHaveCount(0);
});

test('resolves fragmented OSC input and reused textual ids to their own targets', async ({ page }) => {
  const first = 'https://target.example.test/fragmented';
  const second = 'https://target.example.test/reused-id';
  await mountScenario(page, '');
  await page.evaluate(async first => {
    const { writeTerminalBytesOnly } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalBytesOnly(`\x1b]8;id=shared;${first.slice(0, 22)}`);
  }, first);
  await expect(page.locator('.output-link-overlay')).toHaveCount(0);
  await page.evaluate(async ({ first, second }) => {
    const { writeTerminalLinkOutput } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalLinkOutput(`${first.slice(22)}\x1b\\fragmented label\x1b]8;;\x1b\\\r\n\x1b]8;id=shared;${second}\x07reused label\x1b]8;;\x07`);
  }, { first, second });

  await expect(page.getByRole('link', { name: `Open ${first}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Open ${second}`, exact: true })).toHaveCount(1);
});

test('maps an explicit wide and combining label that begins on a continuation row', async ({ page }) => {
  const target = 'https://target.example.test/wide-label';
  await mountScenario(page, `${'x'.repeat(20)}\x1b]8;;${target}\x07界élabel\x1b]8;;\x07`, { columns: 20 });

  const link = page.getByRole('link', { name: `Open ${target}`, exact: true });
  await expect(link).toHaveCount(1);
  const [linkBox, screenBox] = await Promise.all([link.boundingBox(), page.locator('#terminal-link-redesign .xterm-screen').boundingBox()]);
  expect(linkBox).not.toBeNull();
  expect(screenBox).not.toBeNull();
  expect(linkBox!.width / (screenBox!.width / 20)).toBeCloseTo(8, 1);
});

test('does not carry a stale OSC id into a matching styled ordinary URL', async ({ page }) => {
  const target = 'https://target.example.test/explicit';
  const label = 'linked-label';
  const ordinary = 'https://ordinary.example.test/unlinked';
  const style = '\x1b[38;2;137;180;250m\x1b[4m';
  await mountScenario(page, `${style}\x1b]8;;${target}\x07${label}\x1b]8;;\x07 ${ordinary}\x1b[0m`);

  await expect(page.getByRole('link', { name: `Open ${target}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Open ${ordinary}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Open ${target}`, exact: true })).toHaveAttribute('href', target);
  await expect(page.getByRole('link', { name: `Open ${ordinary}`, exact: true })).toHaveAttribute('href', ordinary);
});

test('keeps uniformly styled prose, file text, and adjacent URLs out of a prior target', async ({ page }) => {
  const first = 'https://example.com/complete';
  const second = 'https://second.example.test/neighbor';
  const style = '\x1b[38;5;45m\x1b[4m';
  await mountScenario(page, `${style}${first}\x1b[0m\r\n  ${style}NextTopic\x1b[0m\r\n  ${style}src/neighbor.ts\x1b[0m\r\n  ${style}${second}\x1b[0m`, { fileCapability: true });

  await expect(page.getByRole('link', { name: `Open ${first}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Open ${second}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Preview src/neighbor.ts', exact: true })).toHaveCount(1);
  await expect(page.locator('a[href*="completeNext"]')).toHaveCount(0);
  await expect(page.locator('a[href*="completesrc"]')).toHaveCount(0);
});

test('keeps an extensionless file path separate after a complete URL', async ({ page }) => {
  const uri = 'https://example.com/complete';
  await mountScenario(page, `${uri}\r\nconfig/schema`, { columns: uri.length, fileCapability: true });

  await expect(page.getByRole('link', { name: `Open ${uri}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Preview config/schema', exact: true })).toHaveCount(1);
  await expect(page.locator('a[href*="completeconfig"]')).toHaveCount(0);
});

// path punctuation cannot bond a following same-styled file to the URL
test('keeps a styled file path separate after a URL ending in sentence colon', async ({ page }) => {
  const uri = 'https://example.com/report';
  const file = 'src/report.ts';
  const style = '\x1b[35;4m';
  await mountScenario(page, `prefix ${style}${uri}:\x1b[0m\r\n  ${style}${file}\x1b[0m`, { fileCapability: true });

  await expect(page.getByRole('link', { name: `Open ${uri}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Preview ${file}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Open ${uri}:${file}`, exact: true })).toHaveCount(0);
});

test('does not append same-styled numeric prose after an exact-edge URL', async ({ page }) => {
  const uri = 'https://example.com/complete';
  const style = '\x1b[38;5;45m\x1b[4m';
  await mountScenario(page, `${style}${uri}\x1b[0m\r\n${style}2026 results are ready\x1b[0m`, { columns: uri.length });

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
  await expect(page.locator('a[href*="complete2026"]')).toHaveCount(0);
});

test('does not fall back to a fabricated prefix when a continued port is invalid', async ({ page }) => {
  const first = 'https://example.com:';
  const last = '999999';
  await mountScenario(page, `${first}\r\n${last}`, { columns: first.length });

  await expect(page.locator('.output-link-overlay')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open https://example.com', exact: true })).toHaveCount(0);
});

test('does not invent away real internal whitespace at a native row boundary', async ({ page }) => {
  const uri = 'https://example.com/path';
  const output = `${'x'.repeat(14)}${uri}  continued`;
  await mountScenario(page, output, { columns: 32 });

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  // preserve the target across its native wrap
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
  await expect(page.locator('a[href*="pathcontinued"]')).toHaveCount(0);
});

test('switches explicit targets with the normal and alternate xterm buffers', async ({ page }) => {
  const normal = 'https://normal.example.test/original';
  const alternate = 'https://alternate.example.test/current';
  await mountScenario(page, `\x1b]8;;${normal}\x07normal label\x1b]8;;\x07`);
  await expect(page.getByRole('link', { name: `Open ${normal}`, exact: true })).toHaveCount(1);

  await page.evaluate(async alternate => {
    const { writeTerminalLinkOutput } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalLinkOutput(`\x1b[?1049h\x1b]8;;${alternate}\x07alternate label\x1b]8;;\x07`);
  }, alternate);
  await expect(page.getByRole('link', { name: `Open ${alternate}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Open ${normal}`, exact: true })).toHaveCount(0);

  await page.evaluate(async () => {
    const { writeTerminalLinkOutput } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalLinkOutput('\x1b[?1049l');
  });
  await expect(page.getByRole('link', { name: `Open ${normal}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Open ${alternate}`, exact: true })).toHaveCount(0);
});

test('replaces normal and alternate OSC identities across streamed reseeds', async ({ page }) => {
  const normal = 'https://normal.example.test/seed';
  const alternate = 'https://alternate.example.test/seed';
  await page.goto('/');
  await page.setContent('<div id="streamed-seed" style="width:640px;height:240px"></div>');
  await page.evaluate(async () => {
    const { renderStreamedTerminal, pushSize } = await import('/e2e/streamed-terminal-fixture.ts');
    const container = document.querySelector<HTMLElement>('#streamed-seed');
    // require the production terminal host
    if (container === null) throw new Error('streamed seed fixture is unavailable');
    await renderStreamedTerminal(container);
    pushSize(40, 6);
  });
  await page.evaluate(async normal => {
    const { pushBytes } = await import('/e2e/streamed-terminal-fixture.ts');
    pushBytes(`\x1b]8;;${normal}\x07normal seed\x1b]8;;\x07`);
  }, normal);
  await expect(page.getByRole('link', { name: `Open ${normal}`, exact: true })).toHaveCount(1);

  await page.evaluate(async alternate => {
    const { pushReseed, pushBytes } = await import('/e2e/streamed-terminal-fixture.ts');
    pushReseed();
    pushBytes(`\x1b[?1049h\x1b]8;;${alternate}\x07alternate seed\x1b]8;;\x07`);
  }, alternate);
  await expect(page.getByRole('link', { name: `Open ${normal}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: `Open ${alternate}`, exact: true })).toHaveCount(1);

  await page.evaluate(async normal => {
    const { pushReseed, pushBytes } = await import('/e2e/streamed-terminal-fixture.ts');
    pushReseed();
    pushBytes(`\x1b]8;;${normal}\x07normal replacement\x1b]8;;\x07`);
  }, normal);
  await expect(page.getByRole('link', { name: `Open ${alternate}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: `Open ${normal}`, exact: true })).toHaveCount(1);
});

test('invalidates an overwritten target before a stale anchor can navigate', async ({ page }) => {
  const stale = 'https://stale.example.test/old';
  const fresh = 'https://fresh.example.test/new';
  await mountScenario(page, stale);
  const staleHandle = await page.getByRole('link', { name: `Open ${stale}`, exact: true }).elementHandle();
  expect(staleHandle).not.toBeNull();
  await page.evaluate(async fresh => {
    const { writeTerminalBytesOnly } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalBytesOnly(`\r\x1b[2K${fresh}`);
  }, fresh);

  let popupOpened = false;
  page.once('popup', popup => { popupOpened = true; void popup.close(); });
  await staleHandle!.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  await page.waitForTimeout(100);
  expect(popupOpened).toBe(false);
  await expect(page.getByRole('link', { name: `Open ${stale}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: `Open ${fresh}`, exact: true })).toHaveCount(1);
});

test('rejects a stale URL before an ancestor capture handler can copy it', async ({ page }) => {
  const stale = 'https://stale.example.test/capture';
  const fresh = 'https://fresh.example.test/capture';
  await mountScenario(page, stale);
  await page.evaluate(async () => {
    const { currentOutputLinkUrl } = await import('/src/output-links.ts');
    document.querySelector('#terminal-link-redesign')?.addEventListener('contextmenu', event => {
      document.body.dataset.capturedUrl = currentOutputLinkUrl(event.target) ?? 'none';
    }, { capture: true });
  });
  const staleHandle = await page.getByRole('link', { name: `Open ${stale}`, exact: true }).elementHandle();
  expect(staleHandle).not.toBeNull();
  await page.evaluate(async fresh => {
    const { writeTerminalBytesOnly } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalBytesOnly(`\r\x1b[2K${fresh}`);
  }, fresh);

  await staleHandle!.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })));
  await expect(page.locator('body')).toHaveAttribute('data-captured-url', 'none');
  await expect(page.getByRole('link', { name: `Open ${fresh}`, exact: true })).toHaveCount(1);
});

test('tracks explicit cells through insert, delete, erase, and scroll trimming', async ({ page }) => {
  const first = 'https://target.example.test/moving';
  const second = 'https://target.example.test/trimmed';
  await mountScenario(page, `\x1b]8;;${first}\x07moving label\x1b]8;;\x07\r\ncursor`, { columns: 24, rows: 4, scrollback: 2 });
  await expect(page.getByRole('link', { name: `Open ${first}`, exact: true })).toHaveCount(1);

  await page.evaluate(async () => {
    const { writeTerminalLinkOutput } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalLinkOutput('\x1b[H\x1b[L');
  });
  await expect(page.getByRole('link', { name: `Open ${first}`, exact: true })).toHaveCount(1);
  await page.evaluate(async () => {
    const { writeTerminalLinkOutput } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalLinkOutput('\x1b[H\x1b[M');
  });
  await expect(page.getByRole('link', { name: `Open ${first}`, exact: true })).toHaveCount(1);
  await page.evaluate(async second => {
    const { writeTerminalLinkOutput } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalLinkOutput(`\x1b[H\x1b[2K\x1b]8;;${second}\x07trim label\x1b]8;;\x07`);
  }, second);
  await expect(page.getByRole('link', { name: `Open ${first}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: `Open ${second}`, exact: true })).toHaveCount(1);
  await page.evaluate(async () => {
    const { writeTerminalLinkOutput } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await writeTerminalLinkOutput('\r\none\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven');
  });
  await expect(page.getByRole('link', { name: `Open ${second}`, exact: true })).toHaveCount(0);
});

test('rebuilds explicit identity after reset and keeps a wrapped target through reflow', async ({ page }) => {
  const first = 'https://target.example.test/before-reset';
  const second = 'https://target.example.test/after-reset/with/a/long/path?view=details';
  await mountScenario(page, `\x1b]8;;${first}\x07before reset\x1b]8;;\x07`, { columns: 28 });
  await expect(page.getByRole('link', { name: `Open ${first}`, exact: true })).toHaveCount(1);

  await page.evaluate(async second => {
    const { resetTerminalLinkOutput, writeTerminalLinkOutput } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await resetTerminalLinkOutput();
    await writeTerminalLinkOutput(`${'x'.repeat(24)}\x1b]8;;${second}\x07wrapped explicit label\x1b]8;;\x07`);
  }, second);
  await expect(page.getByRole('link', { name: `Open ${first}`, exact: true })).toHaveCount(0);
  const narrow = page.getByRole('link', { name: `Open ${second}`, exact: true });
  await expect(narrow).toHaveCount(2);

  await page.evaluate(async () => {
    const { resizeTerminalLinkOutput } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await resizeTerminalLinkOutput(72);
  });
  const wide = page.getByRole('link', { name: `Open ${second}`, exact: true });
  const occupiedRows = await page.evaluate(async () => {
    const { terminalOccupiedRows } = await import('/e2e/terminal-link-redesign-fixture.ts');
    return terminalOccupiedRows();
  });
  await expect(wide).toHaveCount(occupiedRows.length);
  // keep each public occupied row on the same target
  for (const link of await wide.all()) await expect(link).toHaveAttribute('href', second);
});

test('keeps unchanged semantic anchors stable across model refreshes', async ({ page }) => {
  const target = 'https://target.example.test/stable';
  await mountScenario(page, `\x1b]8;;${target}\x07stable label\x1b]8;;\x07`);
  const link = page.getByRole('link', { name: `Open ${target}`, exact: true });
  const handle = await link.elementHandle();
  expect(handle).not.toBeNull();

  await page.evaluate(async () => {
    const { refreshTerminalLinks } = await import('/e2e/terminal-link-redesign-fixture.ts');
    await refreshTerminalLinks();
    await refreshTerminalLinks();
  });
  expect(await handle!.evaluate(element => element.isConnected)).toBe(true);
  await expect(link).toHaveCount(1);
});

test('does not expose a target cut by the hard-row search bound', async ({ page }) => {
  const style = '\x1b[38;5;39m\x1b[4m';
  const rows = [`${style}https://example.com/start-`];
  // cross the 32-row search budget
  for (let index = 0; index < 33; index += 1) rows.push(`${style}segment-${index}-`);
  rows.push(`${style}finish`);
  await mountScenario(page, rows.join('\x1b[0m\r\n') + '\x1b[0m', { columns: 96, rows: 40 });

  await expect(page.locator('.output-link-overlay')).toHaveCount(0);
});

test('does not expose a target cut by the character bound', () => {
  const text = `https://example.com/${'a'.repeat(8_200)}`;
  // build one over-budget immutable row
  const cells = [...text].map((character, column) => ({ column, text: character, width: 1, style: '0:0:false:false', accented: false }));
  const snapshot: LinkSnapshot = { rows: [{ line: 0, columns: text.length, wrapped: false, cells }], truncatedStart: false, truncatedEnd: false };

  expect(resolveTerminalLinks(snapshot)).toEqual([]);
});
