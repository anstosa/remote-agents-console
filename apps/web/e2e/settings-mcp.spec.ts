import { expect, test, type Locator, type Page } from '@playwright/test';
import { applicationSettingsSchema } from '../../server/src/settings/schema.js';
import { mcpPermissionGroups } from '../../server/src/integrations/mcp/permission-groups.js';
import { mcpPermissionCapabilities } from '../../server/src/integrations/mcp/permissions.js';
import { applyPatch } from '../../server/src/settings/patches.js';
import type { SettingsPatch } from '../src/settings/contracts.js';
import { mockAccountSocket } from './account-fixture.js';

type Transaction = { changes: Array<{ sourceId: string; patches?: SettingsPatch[] }> };
type SetupOptions = {
  writable?: boolean;
  permissions?: unknown;
  voicePermissions?: unknown;
  conductorPermissions?: unknown;
  conductor?: 'enabled' | 'disabled' | 'absent';
  invalidPath?: string[];
  observerFirst?: boolean;
  reconnectDenied?: boolean;
};

// mount the real settings schema with an isolated in-memory configuration
async function setup(page: Page, options: SetupOptions = {}) {
  await mockAccountSocket(page);
  const conductor = options.conductor === 'absent' ? undefined : {
    enabled: options.conductor !== 'disabled',
    kind: 'pi',
    project: 'fixture',
    model: 'fixture/model',
    ...(options.conductorPermissions === undefined ? {} : { permissions: options.conductorPermissions })
  };
  const value = {
    name: 'Fixture',
    integrations: {
      mcp: options.permissions === undefined ? {} : { permissions: options.permissions },
      realtime: { enabled: false, ...(options.voicePermissions === undefined ? {} : { permissions: options.voicePermissions }) }
    },
    ...(conductor === undefined ? {} : { conductor })
  };
  const source = { id: 'app', label: 'Application config', format: 'json', exists: true, writable: options.writable ?? true, protected: false, tracked: false, revisionId: 'app-r1', apply: 'rac-restart', value: value as unknown, content: JSON.stringify(value), schema: applicationSettingsSchema() };
  const validations: Transaction[] = [];
  const saves: Transaction[] = [];
  let settingsReads = 0;
  let sessionReads = 0;
  // keep every settings request away from the host configuration
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // provide the normal authenticated application shell
    if (path === '/api/auth/session') {
      sessionReads += 1;
      return route.fulfill({ json: { csrfToken: 'fixture-csrf', active: !(options.reconnectDenied && sessionReads > 1), deviceName: 'Fixture', server: { name: 'Fixture', url: 'https://fixture.invalid', remotes: [] }, davo: { enabled: false, available: false, name: 'Davo', context: '' } } });
    }
    // keep the dashboard independent of developer services
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false } } });
    // provide only a synthetic socket ticket
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'fixture' } });
    // preserve the standard settings transaction metadata
    if (path === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    // load the current in-memory source including saved overrides
    if (path === '/api/settings' && request.method() === 'GET') {
      settingsReads += 1;
      const observer = options.observerFirst === true && settingsReads === 1;
      const snapshotSource = observer ? { ...source, writable: false } : source;
      return route.fulfill({ json: { version: 1, revisionId: source.revisionId, installationKind: 'compose', sources: [snapshotSource], status: { pending: false, targets: [], effective: 'known', restartAvailable: true } } });
    }
    // validate without ever mutating a source
    if (path === '/api/settings/validate') {
      validations.push(request.postDataJSON());
      return route.fulfill({ json: { valid: options.invalidPath === undefined, issues: options.invalidPath === undefined ? [] : [{ sourceId: 'app', path: options.invalidPath, code: 'fixture', message: 'Permission fixture issue.' }], warnings: [] } });
    }
    // save only the explicit application leaf patches
    if (path === '/api/settings' && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Transaction;
      saves.push(body);
      // apply the same patch semantics as the real settings service
      for (const change of body.changes) {
        // unrelated sources must never enter this fixture transaction
        if (change.sourceId !== 'app') throw new Error('unexpected source');
        // retain omitted defaults rather than materializing the catalog
        for (const patch of change.patches ?? []) source.value = applyPatch(source.value, patch);
      }
      source.revisionId = `app-r${saves.length + 1}`;
      source.content = JSON.stringify(source.value);
      return route.fulfill({ json: { version: 1, revisionId: source.revisionId, installationKind: 'compose', sources: [source], status: { pending: true, targets: ['rac'], effective: 'known', restartAvailable: true } } });
    }
    // unrelated optional integrations remain disabled
    if (path === '/api/settings/cloudflare/health') return route.fulfill({ json: { state: 'disabled', failures: 0, reconnecting: false, canReconnect: false } });
    // expose no connection configuration
    if (path === '/api/settings/cloudflare') return route.fulfill({ json: { supported: false, enabled: false, connected: false, tokenPresent: false } });
    // unavailable optional reads have no mutation effect
    return route.fulfill({ status: 404, json: { error: 'fixture_unavailable' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'MCP', exact: true }).click();
  await expect(settings.getByRole('heading', { name: 'MCP', level: 2 })).toBeVisible();
  return { settings, source, validations, saves, reads: () => ({ settings: settingsReads, session: sessionReads }) };
}

// locate one exact permission independently of its human-readable title
const permission = (settings: Locator, name: string, mode: 'read' | 'write', surface: 'mcp' | 'conductor' | 'voice' = 'mcp') => settings.locator(`[data-permission-surface="${surface}"] [data-mcp-group="${name}"]`).getByRole('checkbox', { name: new RegExp(`^${mode === 'read' ? 'Read' : 'Write'} `) });

// navigate through the same source list used by the production settings center
async function openSurface(settings: Locator, surface: 'MCP' | 'Conductor' | 'Voice') {
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: new RegExp(`^${surface}(?:\\s|$)`, 'u') }).click();
  await expect(settings.getByRole('heading', { name: surface, level: 2 })).toBeVisible();
}

// preserve the exact historical ceiling without staging a configuration change
test('shows every capability and pre-branch defaults without dirtying settings', async ({ page }) => {
  const { settings, validations, saves } = await setup(page);
  await expect(settings.locator('[data-mcp-group]')).toHaveCount(12);
  await expect(settings.locator('[data-mcp-tool]')).toHaveCount(0);
  await expect(settings.locator('.settings-mcp > p')).toHaveCount(0);
  await expect(settings.getByRole('table', { name: 'MCP capabilities' }).locator('caption')).toHaveCount(0);
  await expect(settings.getByRole('table', { name: 'MCP capabilities' }).getByRole('checkbox')).toHaveCount(24);
  // compare grouped operations to their unchanged underlying defaults
  for (const group of mcpPermissionGroups) {
    // every supported read and write operation keeps its historical grants
    for (const mode of ['read', 'write'] as const) {
      const control = permission(settings, group.name, mode);
      const members = group[mode];
      // unavailable operations remain visibly disabled
      if (members.length === 0) { await expect(control).toBeDisabled(); await expect(control).not.toBeChecked(); continue; }
      const defaults = members.map(name => mcpPermissionCapabilities.find(capability => capability.name === name)!.defaultEnabled);
      await expect(control).toBeEnabled();
      await expect(control).toBeChecked({ checked: defaults.every(Boolean) });
    }
  }
  await expect(settings).toContainText('MCP, Conductor, and Voice');
  await expect(settings).not.toContainText('Checked permissions are an additional limit');
  await expect(settings).not.toContainText('Defaults preserve the MCP capabilities');
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  expect(validations).toEqual([]);
  expect(saves).toEqual([]);
});

// save explicit grants and revocations without serializing inherited defaults
test('persists only toggled read and write permissions through the shared save flow', async ({ page }) => {
  const { settings, source, saves } = await setup(page);
  await permission(settings, 'agents', 'read').uncheck();
  await permission(settings, 'agents', 'write').uncheck();
  await permission(settings, 'davo', 'write').check();
  await expect(settings.getByRole('navigation').getByRole('button', { name: /^MCP(?:\s|$)/u }).locator('[aria-label="Unsaved changes"]')).toHaveCount(1);
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  const patches = saves[0]!.changes.flatMap(change => change.patches ?? []);
  const agents = mcpPermissionGroups.find(group => group.name === 'agents')!;
  const davo = mcpPermissionGroups.find(group => group.name === 'davo')!;
  const expected = [
    ...agents.read.map(name => ({ path: ['integrations', 'mcp', 'permissions', name, 'read'], value: false })),
    ...agents.write.map(name => ({ path: ['integrations', 'mcp', 'permissions', name, 'write'], value: false })),
    ...davo.write.map(name => ({ path: ['integrations', 'mcp', 'permissions', name, 'write'], value: true }))
  ];
  expect(patches).toHaveLength(expected.length);
  expect(patches.map(patch => ({ path: patch.path, value: patch.value }))).toEqual(expected);
  expect(source.value).toMatchObject({ integrations: { mcp: { permissions: { list_agents: { read: false }, queue_prompt: { write: false }, delegate_request: { write: true } } } } });
  await expect(permission(settings, 'davo', 'write')).toBeChecked();
  await expect(permission(settings, 'agents', 'read')).not.toBeChecked();
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

// preserve authored overrides while inheriting unrelated defaults
test('renders partial overrides and keeps read-only sources immutable', async ({ page }) => {
  const { settings, saves } = await setup(page, { writable: false, permissions: { list_agents: { read: false }, delegate_request: { write: true } } });
  expect(await permission(settings, 'agents', 'read').evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(true);
  expect(await permission(settings, 'davo', 'write').evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(true);
  await expect(settings.getByRole('table').locator('input:enabled')).toHaveCount(0);
  for (const surface of ['Conductor', 'Voice'] as const) {
    await openSurface(settings, surface);
    await expect(settings.getByRole('table', { name: `${surface} capabilities` }).locator('input:enabled')).toHaveCount(0);
  }
  expect(saves).toEqual([]);
});

// route validation feedback to the checkbox and the MCP page marker
test('shows permission validation errors without saving invalid changes', async ({ page }) => {
  const { settings, saves } = await setup(page, { invalidPath: ['integrations', 'mcp', 'permissions', 'list_agents', 'read'] });
  await permission(settings, 'agents', 'read').uncheck();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect(settings.getByRole('alert').filter({ hasText: 'Permission fixture issue.' })).toBeVisible();
  await expect(settings.getByRole('navigation').getByRole('button', { name: /^MCP(?:\s|$)/u })).toHaveAttribute('data-has-issues', 'true');
  expect(saves).toEqual([]);
});

// use the existing settings search instead of duplicating a capability catalog
test('routes capability search to MCP and omits duplicate application controls', async ({ page }) => {
  const { settings } = await setup(page);
  const search = settings.getByRole('searchbox', { name: 'Search settings', exact: true });
  await search.fill('list_agents');
  const results = page.getByRole('listbox', { name: 'Settings search results', exact: true });
  const readResult = results.getByRole('option').filter({ hasText: 'Read' });
  await expect(readResult).toHaveCount(3);
  await readResult.filter({ hasText: 'MCP' }).click();
  await expect(settings.getByRole('heading', { name: 'MCP', level: 2 })).toBeVisible();
  await expect(settings.locator('[data-settings-path="integrations.mcp.capabilities.agents.read"]')).toBeFocused();
  await expect(settings.locator('[data-settings-path="integrations.mcp.capabilities.agents.read"]')).toHaveAttribute('data-settings-search-highlight', 'true');
  await search.fill('');
  await settings.getByRole('navigation').getByRole('button', { name: 'Application', exact: true }).click();
  await expect(settings.locator('[data-settings-path="integrations.mcp"]')).toHaveCount(0);
});

// retain the shared source lock instead of allowing raw and structured edits together
test('disables capability editing while the application raw editor owns the source', async ({ page }) => {
  const { settings } = await setup(page);
  const nav = settings.getByRole('navigation');
  await nav.getByRole('button', { name: 'Application', exact: true }).click();
  await settings.getByRole('button', { name: 'Edit base file' }).click();
  for (const surface of ['MCP', 'Conductor', 'Voice'] as const) {
    await openSurface(settings, surface);
    await expect(settings.getByRole('table', { name: `${surface} capabilities` }).locator('input:enabled')).toHaveCount(0);
  }
});

// recover a stale observer snapshot without granting authority on the client
test('refreshes read-only capability metadata after proving the controller reconnected', async ({ page }) => {
  const { settings, saves, reads } = await setup(page, { observerFirst: true });
  await expect(permission(settings, 'agents', 'read')).toBeEnabled();
  await expect.poll(() => reads().settings).toBe(2);
  expect(reads().session).toBe(2);
  expect(saves).toEqual([]);
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

// a displaced browser cannot promote its cached observer catalog
test('keeps capabilities locked when controller revalidation is denied', async ({ page }) => {
  const { settings, saves, reads } = await setup(page, { observerFirst: true, reconnectDenied: true });
  await expect.poll(() => reads().session).toBe(2);
  await expect(permission(settings, 'agents', 'read')).toBeDisabled();
  expect(reads().settings).toBe(1);
  expect(saves).toEqual([]);
});

// express note access as one read and one write permission
test('groups note listing and contents under Read and note edits under Write', async ({ page }) => {
  const { settings, saves } = await setup(page);
  const notes = settings.locator('[data-mcp-group="notes"]');
  await expect(notes).toHaveCount(1);
  const read = notes.getByRole('checkbox', { name: 'Read Notes', exact: true });
  const write = notes.getByRole('checkbox', { name: 'Write Notes', exact: true });
  await expect(read).toBeEnabled();
  await expect(write).toBeEnabled();
  await read.uncheck();
  await write.uncheck();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  const patches = saves[0]!.changes.flatMap(change => change.patches ?? []);
  expect(patches).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['integrations', 'mcp', 'permissions', 'list_notes', 'read'], value: false }),
    expect.objectContaining({ path: ['integrations', 'mcp', 'permissions', 'get_note', 'read'], value: false }),
    expect.objectContaining({ path: ['integrations', 'mcp', 'permissions', 'update_note', 'write'], value: false }),
    expect.objectContaining({ path: ['integrations', 'mcp', 'permissions', 'delete_note', 'write'], value: false })
  ]));
});

// preserve per-tool overrides until an explicit grouped operation changes them
test('shows mixed note permissions without rewriting them and changes only the selected group', async ({ page }) => {
  const { settings, source, saves } = await setup(page, { permissions: { get_note: { read: false }, update_note: { write: false } } });
  const read = permission(settings, 'notes', 'read');
  const write = permission(settings, 'notes', 'write');
  expect(await read.evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(true);
  expect(await write.evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(true);
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await permission(settings, 'files', 'read').uncheck();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  const files = mcpPermissionGroups.find(group => group.name === 'files')!;
  expect(saves[0]!.changes.flatMap(change => change.patches ?? []).map(patch => patch.path.at(-2))).toEqual([...files.read]);
  expect(source.value).toMatchObject({ integrations: { mcp: { permissions: { get_note: { read: false }, update_note: { write: false } } } } });
  expect(await read.evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(true);
  expect(await write.evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(true);
  await write.check();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(2);
  const notes = mcpPermissionGroups.find(group => group.name === 'notes')!;
  expect(saves[1]!.changes.flatMap(change => change.patches ?? []).map(patch => ({ path: patch.path, value: patch.value }))).toEqual(notes.write.map(name => ({ path: ['integrations', 'mcp', 'permissions', name, 'write'], value: true })));
  expect(await write.evaluate(input => (input as HTMLInputElement).indeterminate)).toBe(false);
  await expect(write).toBeChecked();
});

// render a real line break instead of relying on incidental text wrapping
test('renders read and write descriptions on separate lines', async ({ page }) => {
  const { settings } = await setup(page);
  const description = settings.locator('[data-mcp-group="notes"] small');
  await expect(description).toHaveCSS('white-space', 'pre-line');
  const lines = await description.evaluate(element => {
    const text = element.firstChild!;
    const value = text.textContent!;
    const writeStart = value.indexOf('Write ');
    const readRange = document.createRange();
    readRange.setStart(text, 0);
    readRange.setEnd(text, 4);
    const writeRange = document.createRange();
    writeRange.setStart(text, writeStart);
    writeRange.setEnd(text, writeStart + 5);
    return { explicitBreak: value.includes('\nWrite '), readTop: readRange.getBoundingClientRect().top, readLeft: readRange.getBoundingClientRect().left, writeTop: writeRange.getBoundingClientRect().top, writeLeft: writeRange.getBoundingClientRect().left };
  });
  expect(lines.explicitBreak).toBe(true);
  expect(lines.writeTop).toBeGreaterThan(lines.readTop);
  expect(Math.abs(lines.writeLeft - lines.readLeft)).toBeLessThan(1);
});

// reuse the same friendly capability model without materializing inherited child defaults
test('shows the same grouped permissions for MCP, Conductor, and Voice without dirtying settings', async ({ page }) => {
  const { settings, validations, saves } = await setup(page);
  for (const surface of ['MCP', 'Conductor', 'Voice'] as const) {
    await openSurface(settings, surface);
    await expect(settings.getByRole('table', { name: `${surface} capabilities` }).locator('[data-mcp-group]')).toHaveCount(12);
    await expect(settings.getByRole('table', { name: `${surface} capabilities` }).locator('input')).toHaveCount(24);
  }
  await expect(settings.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  expect(validations).toEqual([]);
  expect(saves).toEqual([]);
});

// apply staged parent changes immediately while retaining an explicit child reduction
test('masks child permissions with the live MCP draft and preserves child denials when restored', async ({ page }) => {
  const { settings } = await setup(page);
  await openSurface(settings, 'Conductor');
  await permission(settings, 'notes', 'read', 'conductor').uncheck();
  await openSurface(settings, 'MCP');
  await permission(settings, 'notes', 'read').uncheck();
  await openSurface(settings, 'Conductor');
  await expect(permission(settings, 'notes', 'read', 'conductor')).toBeDisabled();
  await expect(permission(settings, 'notes', 'read', 'conductor')).not.toBeChecked();
  await expect(permission(settings, 'notes', 'read', 'conductor')).toHaveAttribute('title', 'Disabled in MCP.');
  await openSurface(settings, 'MCP');
  await permission(settings, 'notes', 'read').check();
  await openSurface(settings, 'Conductor');
  await expect(permission(settings, 'notes', 'read', 'conductor')).toBeEnabled();
  await expect(permission(settings, 'notes', 'read', 'conductor')).not.toBeChecked();
});

// aggregate only the currently eligible subset and never grant a parent-denied leaf
test('handles partially enabled MCP groups without resurrecting denied child leaves', async ({ page }) => {
  const { settings, saves } = await setup(page, { permissions: { get_note: { read: false } } });
  await openSurface(settings, 'Voice');
  const read = permission(settings, 'notes', 'read', 'voice');
  await expect(read).toBeEnabled();
  await expect(read).toBeChecked();
  await read.uncheck();
  await read.check();
  await expect(settings.getByRole('navigation').getByRole('button', { name: /^Voice(?:\s|$)/u }).locator('[aria-label="Unsaved changes"]')).toHaveCount(1);
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect.poll(() => saves.length).toBe(1);
  const patches = saves[0]!.changes.flatMap(change => change.patches ?? []);
  expect(patches).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['integrations', 'realtime', 'permissions', 'get_note', 'read'], value: false }),
    expect.objectContaining({ path: ['integrations', 'realtime', 'permissions', 'list_notes', 'read'], value: true })
  ]));
  expect(patches).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ['integrations', 'realtime', 'permissions', 'get_note', 'read'], value: true })
  ]));
});

// retain an authored child preference behind the ceiling until the parent is restored
test('shows latent child grants as disabled until MCP allows them again', async ({ page }) => {
  const notes = mcpPermissionGroups.find(group => group.name === 'notes')!;
  const parentPermissions = Object.fromEntries(notes.read.map(name => [name, { read: false }]));
  const childPermissions = Object.fromEntries(notes.read.map(name => [name, { read: true }]));
  const { settings } = await setup(page, { permissions: parentPermissions, voicePermissions: childPermissions });
  await openSurface(settings, 'Voice');
  await expect(permission(settings, 'notes', 'read', 'voice')).toBeDisabled();
  await expect(permission(settings, 'notes', 'read', 'voice')).not.toBeChecked();
  await openSurface(settings, 'MCP');
  await permission(settings, 'notes', 'read').check();
  await openSurface(settings, 'Voice');
  await expect(permission(settings, 'notes', 'read', 'voice')).toBeEnabled();
  await expect(permission(settings, 'notes', 'read', 'voice')).toBeChecked();
});

// require an existing enabled Conductor before accepting principal-specific reductions
test('locks the Conductor permission grid while Conductor is absent or disabled', async ({ page }) => {
  const { settings, saves } = await setup(page, { conductor: 'absent' });
  await openSurface(settings, 'Conductor');
  await expect(settings.getByRole('table', { name: 'Conductor capabilities' }).locator('input:enabled')).toHaveCount(0);
  expect(saves).toEqual([]);
});

// route child validation issues to their owning page and exact grouped checkbox
test('routes Voice permission issues through the shared grouped control', async ({ page }) => {
  const { settings, saves } = await setup(page, { invalidPath: ['integrations', 'realtime', 'permissions', 'list_agents', 'read'] });
  await openSurface(settings, 'Voice');
  await permission(settings, 'agents', 'read', 'voice').uncheck();
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await expect(settings.getByRole('alert').filter({ hasText: 'Permission fixture issue.' })).toBeVisible();
  await expect(settings.getByRole('navigation').getByRole('button', { name: /^Voice(?:\s|$)/u })).toHaveAttribute('data-has-issues', 'true');
  expect(saves).toEqual([]);
});
