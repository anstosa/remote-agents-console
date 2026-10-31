import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockAccountSocket } from './account-fixture';

const jsonContent = '{"name":"RAC","count":1}';
const protectedMarker = `__RAC_PROTECTED_${'A'.repeat(43)}__`;
const disclosedSecret = 'fixture-code-editor-secret';
const yamlContent = `# preserve this comment
services:
  remote-agent-console:
    command: ["node", "server.js"]
    environment:
      RAC_TOKEN: "${protectedMarker}"
notes: |-
  first line
    indented line
`;
const cloudflaredContent = `# preserve tunnel comment
tunnel: demo-tunnel
ingress: [{hostname: console.example.test, service: "http://127.0.0.1:8787"}, {service: http_status:404}]
`;
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox='0 0 10 10' data-key="${protectedMarker}"><text xml:space="preserve">  RAC   label  </text><!-- preserve svg comment --><path id="shape" d="M0 0h10"/></svg>`;
const shellContent = `#!/usr/bin/env bash
# preserve shell comment
RAC_TOKEN='${protectedMarker}'
mode="${'${MODE:-safe}'}"
payload=$(curl https://format-should-not-run.invalid/value)
cat <<'EOF'
  keep   heredoc spacing
EOF
printf '%s\\n' "$mode" "$payload"
`;
const envContent = '# preserve env spacing\nRAC_PORT = 8787\n';
const bashRegressionContent = `#!/usr/bin/env bash
IMAGE=rac
url=https://example.invalid/value
exec docker run --rm --name "two words" "${'${IMAGE:-rac}'}" "$@"
curl --fail "$url" | jq --raw-output '.value'
printf '%s\\n' "$(printf "%s %s" alpha beta)" tail
items=(alpha "two words")
value=prefixalpha
trimmed=${'${value##prefix}'}
((mask = 1 << 2))
shifted=${'$((1 << 2))'}
((mask = ${'$((1 + 1))'} << 2))
((
  mask = 1 << 2
))
echo ok
printf '%s\\n' \\"literal
# actual escaped comment
((mask = 1 << 2)); cat <<'ARITH_EOF'
# arithmetic heredoc
ARITH_EOF
message="first line
# literal double quote
then remains text"
literal='first line
# literal single quote
done remains text'
if [[ ${'${#items[@]}'} -gt 0 ]];then
  case "${'${items[0]}'}" in
    alpha) printf '%s\\n' "${'${items[0]#a}'}" ;;
    *) printf '%s\\n' "fallback # text" ;;
  esac
fi
for item in "${'${items[@]}'}";do
  printf '%s\\n' "$item"
done
payload=$(curl https://bash-format-execution.invalid/value)
cat <<'EOF' > >(sed 's/^/item: /')
# heredoc bytes stay literal
EOF
cat <<E"OF"
payload # literal
EOF
command --after alpha beta
cat <<$'ANSI_EOF'
ansi # literal
ANSI_EOF
command --ansi alpha beta
cat <<$"LOCALE_EOF"
locale # literal
LOCALE_EOF
command --locale alpha beta
# actual comment
`;
const formattedExecCommand = [
  'exec \\',
  '  docker \\',
  '  run \\',
  '  --rm \\',
  '  --name "two words" \\',
  `  "${'${IMAGE:-rac}'}" \\`,
  '  "$@"',
].join('\n');
const formattedPipelineCommand = [
  'curl \\',
  '  --fail "$url" | jq \\',
  "  --raw-output '.value'",
].join('\n');
const formattedNestedCommand = [
  'printf \\',
  "  '%s\\n' \\",
  '  "$(printf \\',
  '    "%s %s" \\',
  '    alpha \\',
  '    beta)" \\',
  '  tail',
].join('\n');
const controlPrefixContent = `case $x in a|b) command --one alpha beta ;; *) printf '%s' fallback ;; esac
if true; then command --if value; fi
while false; do command --loop value; done
demo() { command --fn value; }
`;
const optionGroupingContent = `command --name "two words" --retry -3 --flag --next=value --image "${'${IMAGE:-rac}'}" --stdin - -- alpha beta
command -n short --long value
`;
const formattedOptionGrouping = [
  'command \\',
  '  --name "two words" \\',
  '  --retry -3 \\',
  '  --flag \\',
  '  --next=value \\',
  `  --image "${'${IMAGE:-rac}'}" \\`,
  '  --stdin - \\',
  '  -- \\',
  '  alpha \\',
  '  beta',
  'command \\',
  '  -n \\',
  '  short \\',
  '  --long value',
].join('\n') + '\n';

// mount redacted editor sources across every formatting boundary
async function setupCodeEditors(
  page: Page,
  { interceptShellWorker = true, wrapperContent = shellContent }: { interceptShellWorker?: boolean; wrapperContent?: string } = {},
) {
  await mockAccountSocket(page);
  // exercise the built page with the same strict policy as the production server
  if (process.env.RAC_E2E_PRODUCTION_POLICY === '1')
    await page.route(/^https?:\/\/[^/]+\/$/u, async route => {
      const response = await route.fetch();
      const requestUrl = new URL(route.request().url());
      const websocketOrigin = `${requestUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${requestUrl.host}`;
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          'content-security-policy': `default-src 'self'; connect-src 'self' ${websocketOrigin}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
        },
      });
    });
  // reproduce the worker-only production permission for local WebAssembly compilation
  if (interceptShellWorker)
    await page.route(/\/(?:src\/settings\/shell-format-worker\.ts|assets\/shell-format-worker-[\w-]+\.js)(?:\?.*)?$/u, async route => {
      const response = await route.fetch();
      const requestUrl = new URL(route.request().url());
      const websocketOrigin = `${requestUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${requestUrl.host}`;
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          'content-security-policy': `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ${websocketOrigin}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
        },
      });
    });
  const state = { saves: 0, validations: 0, reveals: 0, remasks: 0 };
  const sources = [
    {
      id: 'app', label: 'Application config', path: '/checkout/config/config.json', format: 'json', exists: true, writable: true, protected: false, tracked: false, revisionId: 'app-r1', apply: 'rac-restart',
      value: { name: 'RAC', count: 1 }, content: jsonContent, hasProtectedContent: false,
      schema: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'number' } } }
    },
    {
      id: 'compose', label: 'Base Compose', path: '/checkout/compose.yaml', format: 'compose', exists: true, writable: false, protected: true, tracked: true, revisionId: 'compose-base-r1', apply: 'rac-restart', content: `services:\n  remote-agent-console:\n    environment:\n      RAC_TOKEN: "${protectedMarker}"\n`, hasProtectedContent: true
    },
    {
      id: 'compose-override', label: 'Docker', path: '/checkout/compose.override.yaml', format: 'compose', exists: true, writable: true, protected: false, tracked: false, revisionId: 'compose-override-r1', apply: 'rac-restart', content: yamlContent, hasProtectedContent: true
    },
    {
      id: 'cloudflared', label: 'Cloudflare tunnel', path: '/checkout/config/cloudflared.yaml', format: 'cloudflared', exists: true, writable: true, protected: false, tracked: false, revisionId: 'cloudflared-r1', apply: 'cloudflared-recreate', content: cloudflaredContent, hasProtectedContent: false
    },
    {
      id: 'wrapper', label: 'Installation wrapper', path: '/checkout/config/start.sh', format: 'wrapper', exists: true, writable: true, protected: false, tracked: false, revisionId: 'wrapper-r1', apply: 'rac-restart', content: wrapperContent, hasProtectedContent: true
    },
    {
      id: 'svg', label: 'Brand mark', path: '/checkout/config/brand.svg', format: 'svg', exists: true, writable: true, protected: false, tracked: false, revisionId: 'svg-r1', apply: 'rac-restart', content: svgContent, hasProtectedContent: true
    },
    {
      id: 'env', label: 'Environment file', path: '/checkout/.env', format: 'env', exists: true, writable: true, protected: false, tracked: false, revisionId: 'env-r1', apply: 'rac-restart', content: envContent, hasProtectedContent: false, fields: []
    }
  ];
  // isolate the editor fixture from live authentication and configuration
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // provide the authenticated shell
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'editor-csrf', active: true, deviceName: 'Editor test', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] }, davo: { enabled: false, available: true, name: 'Davo', context: '' } } });
    // provide an empty dashboard
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, adapters: {}, agents: [], projects: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    // provide dashboard admission
    if (path === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'editor-ticket' } });
    // disable update notices
    if (path === '/api/agents/updates') return route.fulfill({ json: { agents: [] } });
    // disable push registration
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    // disable server updates
    if (path === '/api/server/update-available') return route.fulfill({ json: { available: false } });
    // report stable runtime settings
    if (path === '/api/settings/status') return route.fulfill({ json: { pending: false, targets: [], effective: 'known', restartAvailable: true } });
    // keep background tunnel monitoring inside the fixture
    if (path === '/api/settings/cloudflare/health' && request.method() === 'GET') return route.fulfill({ json: { state: 'disabled', failures: 0, reconnecting: false, canReconnect: false } });
    // keep background calendar status inside the fixture
    if (path === '/api/settings/google-calendar' && request.method() === 'GET') return route.fulfill({ json: { enabled: false, available: false, connected: false, status: 'disabled', calendars: [], setup: { clientId: false, clientSecret: false, tokenKey: false, redirectUri: 'http://127.0.0.1:4173/api/settings/google-calendar/callback' }, counts: { pending: 0, delivered: 0, failed: 0, suppressed: 0 } } });
    // expose the file-managed tunnel without opening its setup guide
    if (path === '/api/settings/cloudflare' && request.method() === 'GET') return route.fulfill({ json: { supported: true, mode: 'local', enabled: true, connected: true, tokenPresent: false, endpoint: 'https://console.example.test', hostname: 'console.example.test', serviceUrl: 'http://127.0.0.1:9876' } });
    // publish the editor sources
    if (path === '/api/settings' && request.method() === 'GET') return route.fulfill({ json: { version: 1, revisionId: 'editor-snapshot-r1', sources, status: { pending: false, targets: [], effective: 'known', restartAvailable: true } } });
    // disclose one whole source only after the explicit editor action
    if (path === '/api/settings/reveal' && request.method() === 'POST') {
      const body = request.postDataJSON() as { sourceId: string; revisionId: string };
      const source = sources.find(candidate => candidate.id === body.sourceId);
      state.reveals += 1;
      return route.fulfill({ json: { value: source?.content?.replaceAll(protectedMarker, disclosedSecret) ?? '', revisionId: body.revisionId, leaseId: `editor-lease-${state.reveals}`, expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    }
    // record explicit disclosure revocation without touching any saved bytes
    if (path === '/api/settings/remask' && request.method() === 'POST') { state.remasks += 1; return route.fulfill({ status: 204, body: '' }); }
    // record unexpected validation without running it
    if (path === '/api/settings/validate') { state.validations += 1; return route.fulfill({ status: 500, json: { error: 'The editor fixture never validates.' } }); }
    // record unexpected persistence without applying it
    if (path === '/api/settings' && request.method() === 'PATCH') { state.saves += 1; return route.fulfill({ status: 500, json: { error: 'The editor fixture never saves.' } }); }
    return route.fulfill({ status: 404, json: { error: `not mocked: ${path}` } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Global settings' }).first().click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Application', exact: true }).click();
  await settings.getByRole('button', { name: 'Edit base file' }).click();
  return { settings, state };
}

// select one file-backed source from the shared Settings navigation
async function selectSource(settings: Locator, label: string) {
  // cloudflare files now live in the page's advanced editor
  if (label === 'Cloudflare tunnel') {
    await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: 'Cloudflare', exact: true }).click();
    await settings.getByText('Configuration files', { exact: true }).click();
    return;
  }
  const visibleLabel = label === 'Application config' ? 'Application' : label;
  const escapedLabel = visibleLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  await settings.getByRole('navigation', { name: 'Settings sources' }).getByRole('button', { name: new RegExp(`^${escapedLabel}(?: Unsaved changes)?$`, 'u') }).click();
}

// cross the whole-source disclosure boundary before editing saved protected bytes
async function revealRawSource(settings: Locator) {
  await settings.getByRole('button', { name: 'Reveal keys', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Mask keys', exact: true })).toHaveAttribute('aria-pressed', 'true');
}

// return protected placeholders in their original order
function protectedMarkers(value: string) {
  return value.match(/__RAC_PROTECTED_[A-Za-z0-9_-]{43}__/g) ?? [];
}

// wait for one asynchronous formatter to settle
async function prettyFormat(editor: Locator) {
  await editor.getByRole('button', { name: 'Format' }).click();
  await expect(editor.getByRole('button', { name: 'Format' })).toBeEnabled();
}

// omit format prose while retaining one concise action label or tooltip
async function expectCompactFormatControl(editor: Locator) {
  await expect(editor.locator('.settings-code-editor-format-note')).toHaveCount(0);
  const title = await editor
    .getByRole('button', { name: 'Format', exact: true })
    .getAttribute('title');
  expect([null, 'Format']).toContain(title);
}

// read overlay and native textarea geometry after synchronized scrolling
async function editorGeometry(editor: Locator) {
  return editor.evaluate(element => {
    const textarea = element.querySelector('textarea');
    const presentation = element.querySelector<HTMLPreElement>('.syntax-highlight-presentation');
    const content = element.querySelector<HTMLElement>('.syntax-line-content');
    // require the complete editor fixture
    if (textarea === null || presentation === null || content === null) throw new Error('Editor layers are missing');
    const textareaStyle = getComputedStyle(textarea);
    const contentStyle = getComputedStyle(content);
    const textareaRect = textarea.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      textareaLeft: textareaRect.left + Number.parseFloat(textareaStyle.paddingLeft) - textarea.scrollLeft,
      presentationLeft: contentRect.left + Number.parseFloat(contentStyle.paddingLeft),
      textareaLineHeight: Number.parseFloat(textareaStyle.lineHeight),
      presentationLineHeight: content.getBoundingClientRect().height,
      textareaScrollLeft: textarea.scrollLeft,
      presentationScrollLeft: presentation.scrollLeft,
      textareaScrollTop: textarea.scrollTop,
      presentationScrollTop: presentation.scrollTop
    };
  });
}

// compare the content rows with their editing surface and full-height gutter
async function naturalEditorGeometry(editor: Locator) {
  return editor.evaluate(element => {
    const surface = element.querySelector<HTMLElement>('.settings-code-editor-surface');
    const textarea = element.querySelector('textarea');
    const presentation = element.querySelector<HTMLElement>('.syntax-highlight-presentation');
    const number = element.querySelector<HTMLElement>('.syntax-line-number');
    // require every layer before measuring content and unnumbered padding
    if (surface === null || textarea === null || presentation === null || number === null) throw new Error('Editor geometry is incomplete');
    const surfaceStyle = getComputedStyle(surface);
    const textareaStyle = getComputedStyle(textarea);
    const gutter = getComputedStyle(surface, '::before');
    const lineHeight = Number.parseFloat(textareaStyle.lineHeight);
    const lineCount = element.querySelectorAll('.syntax-line').length;
    const border = Number.parseFloat(surfaceStyle.borderTopWidth) + Number.parseFloat(surfaceStyle.borderBottomWidth);
    const padding = Number.parseFloat(textareaStyle.paddingTop) + Number.parseFloat(textareaStyle.paddingBottom);
    const scrollbar = textarea.offsetHeight - textarea.clientHeight;
    return {
      surfaceHeight: surface.getBoundingClientRect().height,
      naturalHeight: lineCount * lineHeight + padding + border + scrollbar,
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
      lineHeight,
      lineCount,
      gutterContent: gutter.content,
      gutterHeight: Number.parseFloat(gutter.height),
      gutterWidth: Number.parseFloat(gutter.width),
      gutterRight: surface.getBoundingClientRect().left + Number.parseFloat(surfaceStyle.borderLeftWidth) + Number.parseFloat(gutter.width),
      gutterTop: gutter.top,
      gutterBottom: gutter.bottom,
      gutterBackground: gutter.backgroundColor,
      gutterBorder: gutter.borderRightWidth,
      numberBackground: getComputedStyle(number).backgroundColor,
      numberWidth: number.getBoundingClientRect().width,
      numberRight: number.getBoundingClientRect().right,
      numberLeft: number.getBoundingClientRect().left - surface.getBoundingClientRect().left,
      surfaceClientHeight: surface.clientHeight
    };
  });
}

// fit saved sources to their actual rows at both desktop and phone widths
for (const width of [1440, 390]) {
  test(`uses natural code height and a continuous gutter at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { settings, state } = await setupCodeEditors(page);
    await page.setViewportSize({ width, height: 900 });
    const editor = settings.locator('.settings-code-editor');
    const input = editor.getByRole('textbox', { name: 'Application config source content' });
    const initial = await naturalEditorGeometry(editor);
    expect(initial.lineCount).toBe(1);
    expect(Math.abs(initial.surfaceHeight - initial.naturalHeight)).toBeLessThanOrEqual(2);
    // align the full-height background with the number cells' right border
    expect(Math.abs(initial.gutterRight - initial.numberRight)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width, height: 1400 });
    const tallerViewport = await naturalEditorGeometry(editor);
    expect(Math.abs(tallerViewport.surfaceHeight - initial.surfaceHeight)).toBeLessThanOrEqual(1);
    await input.fill('first\n\nthird');
    const multiline = await naturalEditorGeometry(editor);
    expect(multiline.lineCount).toBe(3);
    expect(Math.abs(multiline.surfaceHeight - multiline.naturalHeight)).toBeLessThanOrEqual(2);
    expect(Math.abs(multiline.surfaceHeight - initial.surfaceHeight - initial.lineHeight * 2)).toBeLessThanOrEqual(2);
    await input.fill('');
    const empty = await naturalEditorGeometry(editor);
    expect(empty.lineCount).toBe(1);
    expect(Math.abs(empty.surfaceHeight - initial.surfaceHeight)).toBeLessThanOrEqual(1);

    // reserve scrollbar space only when a source actually overflows horizontally
    await input.fill('horizontal-value-'.repeat(100));
    const horizontal = await naturalEditorGeometry(editor);
    expect(Math.abs(horizontal.surfaceHeight - horizontal.naturalHeight)).toBeLessThanOrEqual(2);
    expect(horizontal.scrollHeight).toBeLessThanOrEqual(horizontal.clientHeight + 1);
    await input.evaluate(textarea => { textarea.scrollLeft = 180; textarea.dispatchEvent(new Event('scroll')); });
    const scrolled = await naturalEditorGeometry(editor);
    expect(scrolled.numberLeft).toBeGreaterThanOrEqual(0);
    expect(scrolled.numberLeft).toBeLessThanOrEqual(2);
    const aligned = await editorGeometry(editor);
    expect(Math.abs(aligned.presentationLeft - aligned.textareaLeft)).toBeLessThanOrEqual(1);

    // keep the ruler aligned when larger line counts widen the number column
    await input.fill(Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n'));
    const threeDigits = await naturalEditorGeometry(editor);
    expect(threeDigits.lineCount).toBe(100);
    expect(threeDigits.numberWidth).toBeGreaterThan(initial.numberWidth);
    expect(Math.abs(threeDigits.gutterRight - threeDigits.numberRight)).toBeLessThanOrEqual(1);

    // extend the ruler through padding and extra blank space after manual resizing
    await input.fill(jsonContent);
    await editor.locator('.settings-code-editor-surface').evaluate(surface => { (surface as HTMLElement).style.height = '180px'; });
    const resized = await naturalEditorGeometry(editor);
    expect(resized.gutterContent).not.toBe('none');
    expect(Math.abs(resized.gutterHeight - resized.surfaceClientHeight)).toBeLessThanOrEqual(1);
    expect(resized.gutterTop).toBe('0px');
    expect(resized.gutterBottom).toBe('0px');
    expect(resized.gutterBackground).toBe(resized.numberBackground);
    expect(resized.gutterBorder).toBe('1px');
    expect(Math.abs(resized.gutterRight - resized.numberRight)).toBeLessThanOrEqual(1);
    await editor.scrollIntoViewIfNeeded();
    await editor.screenshot({ path: `/tmp/remoteagents-settings-natural-editor-gutter-${width}.png` });

    await editor.locator('.settings-code-editor-surface').evaluate(surface => { (surface as HTMLElement).style.removeProperty('height'); });
    const restored = await naturalEditorGeometry(editor);
    expect(Math.abs(restored.surfaceHeight - initial.surfaceHeight)).toBeLessThanOrEqual(1);
    await editor.screenshot({ path: `/tmp/remoteagents-settings-natural-editor-one-line-${width}.png` });
    expect(state.saves).toBe(0);
    expect(state.validations).toBe(0);
  });
}

test('edits highlighted numbered settings code and formats JSON locally', async ({ page }) => {
  test.setTimeout(60_000);
  const { settings, state } = await setupCodeEditors(page);
  const jsonEditor = settings.locator('.settings-code-editor');
  const jsonInput = jsonEditor.getByRole('textbox', { name: 'Application config source content' });

  // keep one native textbox over an aria-hidden presentation
  await expect(jsonEditor.getByRole('textbox')).toHaveCount(1);
  // keep formatting decorated and omit terminal launch when no editor is configured
  await expect(jsonEditor.getByRole('button', { name: 'Format' }).locator('svg')).toBeVisible();
  await expectCompactFormatControl(jsonEditor);
  await expect(jsonEditor.locator('.settings-code-editor-open')).toHaveCount(0);
  await expect(jsonEditor.locator('.syntax-highlight-presentation')).toHaveAttribute('aria-hidden', 'true');
  await expect(jsonEditor.locator('.syntax-line-number')).toHaveText(['1']);
  await expect(jsonEditor.locator('.syntax-string')).toHaveCount(3);
  await expect(jsonEditor.locator('.syntax-number')).toHaveText('1');

  // retain ordinary textarea editing while refreshing highlighted rows
  const compactJson = `{"long":"${'horizontal-value-'.repeat(24)}","count":2}`;
  await jsonInput.fill(compactJson);
  await expect(jsonInput).toHaveValue(compactJson);
  await expect(jsonEditor.locator('.syntax-number')).toHaveText('2');
  await jsonInput.evaluate(textarea => { textarea.scrollLeft = 180; textarea.dispatchEvent(new Event('scroll')); });
  const scrolled = await editorGeometry(jsonEditor);
  expect(scrolled.presentationScrollLeft).toBe(scrolled.textareaScrollLeft);
  expect(Math.abs(scrolled.presentationLeft - scrolled.textareaLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(scrolled.presentationLineHeight - scrolled.textareaLineHeight)).toBeLessThanOrEqual(1);

  // format valid JSON deterministically without saving it
  await jsonInput.fill('{"beta":2,"alpha":[true,false]}');
  await prettyFormat(jsonEditor);
  const formatted = '{\n  "beta": 2,\n  "alpha": [\n    true,\n    false\n  ]\n}';
  await expect(jsonInput).toHaveValue(formatted);
  await expect(jsonEditor.locator('.syntax-line-number')).toHaveText(['1', '2', '3', '4', '5', '6', '7']);
  expect(state.saves).toBe(0);

  // leave invalid JSON untouched and report the local error
  const invalidJson = '{"broken":';
  await jsonInput.fill(invalidJson);
  await jsonEditor.getByRole('button', { name: 'Format' }).click();
  await expect(jsonInput).toHaveValue(invalidJson);
  await expect(jsonEditor.getByRole('alert')).toHaveText('Enter valid JSON before formatting. The editor was not changed.');
  expect(state.saves).toBe(0);
  expect(state.validations).toBe(0);
});

// render saved protected bytes as an inert masked preview before disclosure
test('masks saved raw secrets with asterisks and an explicit reveal label', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', message => {
    // retain only browser failures
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const { settings, state } = await setupCodeEditors(page);
  await selectSource(settings, 'Docker');
  const editor = settings.locator('.settings-code-editor');
  const input = editor.getByRole('textbox', {
    name: 'Docker source content',
  });

  await expect(input).toHaveAttribute('readonly', '');
  await expect(input).toHaveValue(yamlContent.replace(protectedMarker, '********'));
  const disclosure = editor.locator('.settings-code-editor-field-action');
  await expect(disclosure).toContainText('Contains secrets, reveal to edit');
  await expect(disclosure.getByRole('button', { name: 'Reveal keys', exact: true })).toBeVisible();
  const format = editor.getByRole('button', { name: 'Format', exact: true });
  const disclosureBeforeFormat = await editor.locator('.settings-code-editor-toolbar').evaluate(toolbar => {
    const disclosure = toolbar.querySelector('.settings-code-editor-field-action');
    const format = [...toolbar.querySelectorAll('button')].find(button => button.textContent?.includes('Format'));
    return disclosure !== null && format !== undefined && Boolean(disclosure.compareDocumentPosition(format) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(disclosureBeforeFormat).toBe(true);
  await expect(format).toBeDisabled();
  await expect(editor).not.toContainText(protectedMarker);
  await expect(editor).not.toContainText(disclosedSecret);
  expect(await editor.evaluate((element, forbidden) => forbidden.some(value => element.innerHTML.includes(value)), [protectedMarker, disclosedSecret])).toBe(false);
  await editor.screenshot({ path: '/tmp/remoteagents-settings-masked-desktop.png' });
  await format.dispatchEvent('click');
  expect(page.workers().filter(worker => worker.url().includes('shell-format-worker'))).toHaveLength(0);

  // disclosure unlocks editing, while masking clears disclosure-derived drafts
  await revealRawSource(settings);
  await expect(input).not.toHaveAttribute('readonly');
  await expect(input).toHaveValue(yamlContent.replace(protectedMarker, disclosedSecret));
  await expect(format).toBeEnabled();
  await expect(disclosure).not.toContainText('Contains secrets, reveal to edit');
  await input.fill(`${yamlContent.replace(protectedMarker, disclosedSecret)}# disclosure draft\n`);
  await settings.getByRole('button', { name: 'Mask keys', exact: true }).click();
  await expect.poll(() => state.remasks).toBe(1);
  await expect(input).toHaveAttribute('readonly', '');
  await expect(input).toHaveValue(yamlContent.replace(protectedMarker, '********'));
  await expect(input).not.toHaveValue(/disclosure draft|fixture-code-editor-secret/u);
  await revealRawSource(settings);
  await expect.poll(() => state.reveals).toBe(2);
  await expect(input).toHaveValue(yamlContent.replace(protectedMarker, disclosedSecret));
  expect(state.saves).toBe(0);
  expect(state.validations).toBe(0);
  expect(consoleErrors).toEqual([]);
});

// guide masked surface clicks without crossing the disclosure boundary
test('pulses the reveal guidance and cancels it across editor boundaries', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', message => {
    // retain only browser failures
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const { settings, state } = await setupCodeEditors(page);
  await selectSource(settings, 'Docker');
  const editor = settings.locator('.settings-code-editor');
  const surface = editor.locator('.settings-code-editor-surface');
  const disclosure = editor.locator('.settings-code-editor-field-action');
  const input = editor.getByRole('textbox', {
    name: 'Docker source content',
  });

  await surface.click();
  await expect.poll(() => disclosure.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(1);
  const pulse = await disclosure.evaluate(element => {
    const animation = element.getAnimations().find(candidate => candidate.playState === 'running');
    const effect = animation?.effect as KeyframeEffect | null | undefined;
    return {
      endTime: effect?.getComputedTiming().endTime,
      opacity: effect?.getKeyframes().map(frame => Number(frame.opacity)).filter(Number.isFinite) ?? [],
    };
  });
  expect(pulse.endTime).toBe(1_000);
  expect(Math.min(...pulse.opacity)).toBeLessThan(1);
  expect(state.reveals).toBe(0);
  await expect(input).toHaveAttribute('readonly', '');
  await expect(input).toHaveValue(yamlContent.replace(protectedMarker, '********'));

  // a repeated click replaces rather than stacks the running pulse
  await disclosure.evaluate(element => {
    (window as typeof window & { __settingsMaskedPulse?: Animation }).__settingsMaskedPulse = element.getAnimations().find(animation => animation.playState === 'running');
  });
  await surface.click();
  const restarted = await disclosure.evaluate(element => {
    const previous = (window as typeof window & { __settingsMaskedPulse?: Animation }).__settingsMaskedPulse;
    const current = element.getAnimations().find(animation => animation.playState === 'running');
    return { replaced: previous !== undefined && current !== undefined && previous !== current, previousState: previous?.playState, running: element.getAnimations().filter(animation => animation.playState === 'running').length };
  });
  expect(restarted).toEqual({ replaced: true, previousState: 'idle', running: 1 });
  await expect.poll(() => disclosure.evaluate(element => ({ opacity: getComputedStyle(element).opacity, running: element.getAnimations().some(animation => animation.playState === 'running') })), { timeout: 2_000 }).toEqual({ opacity: '1', running: false });

  // navigation cancels a live pulse before its toolbar unmounts
  await surface.click();
  await disclosure.evaluate(element => {
    (window as typeof window & { __settingsMaskedPulse?: Animation }).__settingsMaskedPulse = element.getAnimations().find(animation => animation.playState === 'running');
  });
  await selectSource(settings, 'Application config');
  expect(await page.evaluate(() => (window as typeof window & { __settingsMaskedPulse?: Animation }).__settingsMaskedPulse?.playState)).toBe('idle');

  // security changes and explicit reveal both stop guidance immediately
  await selectSource(settings, 'Docker');
  await surface.click();
  await expect.poll(() => disclosure.evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => disclosure.evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
  await surface.click();
  await revealRawSource(settings);
  await expect.poll(() => disclosure.evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
  await surface.click();
  await page.waitForTimeout(100);
  expect(await disclosure.evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(false);
  expect(state.reveals).toBe(1);
  expect(state.saves).toBe(0);
  expect(state.validations).toBe(0);
  expect(consoleErrors).toEqual([]);
});

for (const reducedMotion of ['browser', 'os'] as const) {
  test(`uses a static masked-editor highlight for ${reducedMotion} reduced motion`, async ({ page }) => {
    // exercise the browser preference independently from the operating-system signal
    if (reducedMotion === 'browser')
      await page.addInitScript(() => localStorage.setItem('rac.reduced-motion', 'enabled'));
    else await page.emulateMedia({ reducedMotion: 'reduce' });
    const { settings, state } = await setupCodeEditors(page);
    await selectSource(settings, 'Docker');
    const editor = settings.locator('.settings-code-editor');
    const surface = editor.locator('.settings-code-editor-surface');
    const disclosure = editor.locator('.settings-code-editor-field-action');
    const baseline = await disclosure.evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }));

    await surface.click();
    await expect.poll(() => disclosure.evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }))).not.toEqual(baseline);
    expect(await disclosure.evaluate(element => element.getAnimations().some(animation => {
      const effect = animation.effect as KeyframeEffect | null;
      return effect?.getKeyframes().some(frame => frame.opacity !== undefined) === true;
    }))).toBe(false);
    expect(state.reveals).toBe(0);
    await expect(editor.getByRole('textbox')).toHaveAttribute('readonly', '');
    await expect.poll(() => disclosure.evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth })), { timeout: 2_000 }).toEqual(baseline);
  });
}

test('formats disclosed YAML, SVG and shell without changing secrets or executing code', async ({ page }) => {
  test.setTimeout(90_000);
  let executionRequests = 0;
  const observedPolicies = new Map<string, string>();
  // record only the built document and formatter worker policies
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    // ignore unrelated assets and mocked APIs
    if (pathname !== '/' && !/^\/assets\/shell-format-worker-[\w-]+\.js$/u.test(pathname)) return;
    void response.headerValue('content-security-policy').then(policy => {
      // retain the exact browser-observed policy for the production-preview assertions
      if (policy !== null) observedPolicies.set(pathname, policy);
    });
  });
  // fail closed if formatting attempts to execute a command embedded in shell text
  await page.route('https://format-should-not-run.invalid/**', async route => { executionRequests += 1; await route.abort(); });
  const { settings, state } = await setupCodeEditors(page);

  // capture the page runtime before using any isolated formatter
  const pageRuntime = await page.evaluate(() => ['Go', 'fs', 'process', 'require'].map(key => typeof (globalThis as unknown as Record<string, unknown>)[key]));

  // format disclosed Compose YAML while preserving comments and block scalar bytes
  await selectSource(settings, 'Docker');
  await revealRawSource(settings);
  const yamlEditor = settings.locator('.settings-code-editor');
  const yamlInput = yamlEditor.getByRole('textbox', { name: 'Docker source content' });
  await expectCompactFormatControl(yamlEditor);
  const secretLine = `      RAC_TOKEN: "${disclosedSecret}"`;
  await expect(yamlEditor.locator('.syntax-comment')).toHaveText('# preserve this comment');
  await prettyFormat(yamlEditor);
  const formattedYaml = await yamlInput.inputValue();
  expect(formattedYaml).toContain('# preserve this comment');
  expect(formattedYaml).toContain(secretLine);
  expect(formattedYaml).toContain('notes: |-\n  first line\n    indented line');
  expect(protectedMarkers(formattedYaml)).toEqual([]);
  await prettyFormat(yamlEditor);
  await expect(yamlInput).toHaveValue(formattedYaml);

  // format Cloudflare YAML and reject an invalid replacement byte-for-byte
  await selectSource(settings, 'Cloudflare tunnel');
  const cloudflaredEditor = settings.locator('.settings-code-editor');
  const cloudflaredInput = cloudflaredEditor.getByRole('textbox', { name: 'Cloudflare tunnel source content' });
  await expectCompactFormatControl(cloudflaredEditor);
  await prettyFormat(cloudflaredEditor);
  const formattedCloudflared = await cloudflaredInput.inputValue();
  expect(formattedCloudflared).toContain('# preserve tunnel comment');
  expect(formattedCloudflared).toContain('console.example.test');
  await prettyFormat(cloudflaredEditor);
  await expect(cloudflaredInput).toHaveValue(formattedCloudflared);
  const invalidYaml = 'services:\n  broken: [unterminated\n';
  await cloudflaredInput.fill(invalidYaml);
  await cloudflaredEditor.getByRole('button', { name: 'Format' }).click();
  await expect(cloudflaredInput).toHaveValue(invalidYaml);
  await expect(cloudflaredEditor.getByRole('alert')).toHaveText('Unable to format YAML. Check its syntax and try again. The editor was not changed.');

  // preserve disclosed SVG text whitespace, comments and quote styles
  await selectSource(settings, 'Brand mark');
  await revealRawSource(settings);
  const svgEditor = settings.locator('.settings-code-editor');
  const svgInput = svgEditor.getByRole('textbox', { name: 'Brand mark source content' });
  await expectCompactFormatControl(svgEditor);
  await prettyFormat(svgEditor);
  const formattedSvg = await svgInput.inputValue();
  expect(formattedSvg).toContain('viewBox=\'0 0 10 10\'');
  expect(formattedSvg).toContain('>  RAC   label  </text>');
  expect(formattedSvg).toContain('<!-- preserve svg comment -->');
  expect(formattedSvg).toContain(disclosedSecret);
  expect(protectedMarkers(formattedSvg)).toEqual([]);
  await prettyFormat(svgEditor);
  await expect(svgInput).toHaveValue(formattedSvg);
  const invalidSvg = '<svg><text>private-invalid-value</svg>';
  await svgInput.fill(invalidSvg);
  await svgEditor.getByRole('button', { name: 'Format' }).click();
  await expect(svgInput).toHaveValue(invalidSvg);
  await expect(svgEditor.getByRole('alert')).toHaveText('Unable to format SVG. Check its syntax and try again. The editor was not changed.');

  // retain shell comments, expansions and heredoc bytes without evaluating commands
  await selectSource(settings, 'TMUX');
  const shellEditor = settings.locator('.settings-code-editor');
  const shellInput = shellEditor.getByRole('textbox', { name: 'Installation wrapper source content' });
  await expect(settings.getByText('Trusted code', { exact: true })).toHaveCount(0);
  await expect(settings.getByText('Source content', { exact: true })).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Remove source', exact: true })).toHaveCount(0);
  await expect(shellInput).toHaveAttribute('readonly', '');
  await expect(shellInput).toHaveValue(shellContent.replace(protectedMarker, '********'));
  await revealRawSource(settings);
  await expect(shellInput).not.toHaveAttribute('readonly');
  await expectCompactFormatControl(shellEditor);
  await prettyFormat(shellEditor);
  const formattedShell = await shellInput.inputValue();
  expect(formattedShell).toContain('# preserve shell comment');
  expect(formattedShell).toContain('${MODE:-safe}');
  expect(formattedShell).toContain('https://format-should-not-run.invalid/value');
  expect(formattedShell).toMatch(/cat << ?'EOF'\n  keep   heredoc spacing\nEOF/u);
  expect(formattedShell).toContain(disclosedSecret);
  expect(protectedMarkers(formattedShell)).toEqual([]);
  await prettyFormat(shellEditor);
  await expect(shellInput).toHaveValue(formattedShell);
  const invalidShell = "printf '%s\\n' 'unterminated\n";
  await shellInput.fill(invalidShell);
  await shellEditor.getByRole('button', { name: 'Format' }).click();
  await expect(shellInput).toHaveValue(invalidShell);
  await expect(shellEditor.getByRole('alert')).toHaveText('Unable to format shell. Check its syntax and try again. The editor was not changed.');
  // keep the shell shim's Node-like globals out of the application window
  expect(await page.evaluate(() => ['Go', 'fs', 'process', 'require'].map(key => typeof (globalThis as unknown as Record<string, unknown>)[key]))).toEqual(pageRuntime);

  // keep environment source bytes outside the formatter boundary
  await selectSource(settings, 'Environment file');
  await settings.getByRole('button', { name: 'Edit whole source' }).click();
  const envEditor = settings.locator('.settings-code-editor');
  const envInput = envEditor.getByRole('textbox', { name: 'Environment file source content' });
  await expect(envInput).toHaveValue(envContent);
  await expect(envEditor.getByRole('button', { name: 'Format' })).toBeDisabled();
  await expectCompactFormatControl(envEditor);

  expect(executionRequests).toBe(0);
  expect(state.saves).toBe(0);
  expect(state.validations).toBe(0);
  // prove that built assets run under the production page and worker permission split
  if (process.env.RAC_E2E_PRODUCTION_POLICY === '1') {
    await expect.poll(() => observedPolicies.get('/') ?? '').toContain("default-src 'self'");
    expect(observedPolicies.get('/')).not.toContain("'wasm-unsafe-eval'");
    await expect.poll(() => [...observedPolicies].find(([pathname]) => /^\/assets\/shell-format-worker-[\w-]+\.js$/u.test(pathname))?.[1] ?? '').toContain("script-src 'self' 'wasm-unsafe-eval'");
  }
});

test('highlights Bash grammar without token bleed', async ({ page }) => {
  const { settings } = await setupCodeEditors(page);
  await selectSource(settings, 'TMUX');
  await revealRawSource(settings);
  const editor = settings.locator('.settings-code-editor');
  const input = editor.getByRole('textbox', {
    name: 'Installation wrapper source content',
  });
  await input.fill(bashRegressionContent);
  await editor.screenshot({
    path: '/tmp/remoteagents-settings-bash-highlight.png',
  });

  await expect(editor.locator('.syntax-keyword')).toHaveText([
    'if',
    'then',
    'case',
    'in',
    'esac',
    'fi',
    'for',
    'in',
    'do',
    'done',
  ]);
  await expect(editor.locator('.syntax-comment')).toHaveText([
    '#!/usr/bin/env bash',
    '# actual escaped comment',
    '# actual comment',
  ]);
  expect(await editor.locator('.syntax-command').allTextContents()).toEqual(
    expect.arrayContaining(['exec', 'curl', 'jq', 'command']),
  );
  expect(await editor.locator('.syntax-option').allTextContents()).toEqual(
    expect.arrayContaining(['--rm', '--name', '--fail', '--raw-output', '--after', '--ansi', '--locale']),
  );
  expect(await editor.locator('.syntax-property').allTextContents()).toEqual(
    expect.arrayContaining(['IMAGE', 'url']),
  );
  expect(await editor.locator('.syntax-operator').allTextContents()).toEqual(
    expect.arrayContaining(['=', '|']),
  );
  expect(await editor.locator('.syntax-string').allTextContents()).toEqual(
    expect.arrayContaining([
      '"${items[0]#a}"',
      '"fallback # text"',
      '# literal double quote',
      'then remains text"',
      '# literal single quote',
      "done remains text'",
    ]),
  );
  await expect(
    editor.locator('.syntax-string').filter({
      hasText: '# heredoc bytes stay literal',
    }),
  ).toHaveCount(1);
  await expect(
    editor.locator('.syntax-string').filter({
      hasText: '# arithmetic heredoc',
    }),
  ).toHaveCount(1);
  await expect(
    editor.locator('.syntax-string').filter({
      hasText: 'payload # literal',
    }),
  ).toHaveCount(1);
  await expect(
    editor.locator('.syntax-string').filter({
      hasText: 'ansi # literal',
    }),
  ).toHaveCount(1);
  await expect(
    editor.locator('.syntax-string').filter({
      hasText: 'locale # literal',
    }),
  ).toHaveCount(1);
  await expect(editor.locator('.syntax-line-content')).toHaveText(
    bashRegressionContent.split('\n'),
  );
  await expectCompactFormatControl(editor);
});

test('formats Bash grammar through the real worker', async ({ page }) => {
  test.setTimeout(90_000);
  const workerUrls: string[] = [];
  const requestUrls: string[] = [];
  let executionRequests = 0;
  // observe the browser-owned worker and WebAssembly asset without intercepting either
  page.on('worker', worker => workerUrls.push(worker.url()));
  page.on('request', request => requestUrls.push(request.url()));
  // fail closed if the formatter evaluates any command substitution
  await page.route('https://bash-format-execution.invalid/**', async route => {
    executionRequests += 1;
    await route.abort();
  });
  const consoleErrors: string[] = [];
  // retain browser diagnostics from the unmocked worker path
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  const { settings, state } = await setupCodeEditors(page, {
    interceptShellWorker: false,
  });
  await selectSource(settings, 'TMUX');
  await revealRawSource(settings);
  const editor = settings.locator('.settings-code-editor');
  const input = editor.getByRole('textbox', {
    name: 'Installation wrapper source content',
  });
  await input.fill(bashRegressionContent);
  await prettyFormat(editor);
  const formatted = await input.inputValue();
  expect(formatted).toContain(formattedExecCommand);
  expect(formatted).toContain(formattedPipelineCommand);
  expect(formatted).toContain(formattedNestedCommand);
  expect(formatted).toContain(`if [[ ${'${#items[@]}'} -gt 0 ]]; then`);
  expect(formatted).toContain(`for item in "${'${items[@]}'}"; do`);
  expect(formatted).toContain(`trimmed=${'${value##prefix}'}`);
  expect(formatted).toContain('((mask = 1 << 2))');
  expect(formatted).toContain(`shifted=${'$((1 << 2))'}`);
  expect(formatted).toContain(`((mask = ${'$((1 + 1))'} << 2))`);
  expect(formatted).toMatch(/\(\((?:\\\n|\n)\s*mask = 1 << 2\)\)\s*\necho \\\n  ok/u);
  expect(formatted).toContain(`printf \\\n  '%s\\n' \\\n  \\"literal
# actual escaped comment`);
  expect(formatted).toMatch(/\(\(mask = 1 << 2\)\)\s*(?:;\s*)?\ncat << ?'ARITH_EOF'\n# arithmetic heredoc\nARITH_EOF/u);
  expect(formatted).toContain('message="first line\n# literal double quote\nthen remains text"');
  expect(formatted).toContain("literal='first line\n# literal single quote\ndone remains text'");
  expect(formatted).toMatch(/cat << ?'EOF' > >\(sed \\\n\s+'s\/\^\/item: \/'\)/u);
  expect(formatted).toContain("# heredoc bytes stay literal\nEOF");
  expect(formatted).toContain('payload # literal\nEOF');
  expect(formatted).toMatch(/command \\\n\s+--after alpha \\\n\s+beta/u);
  expect(formatted).toContain('ansi # literal\nANSI_EOF');
  expect(formatted).toMatch(/command \\\n\s+--ansi alpha \\\n\s+beta/u);
  expect(formatted).toContain('locale # literal\nLOCALE_EOF');
  expect(formatted).toMatch(/command \\\n\s+--locale alpha \\\n\s+beta/u);
  expect(formatted).toContain('https://bash-format-execution.invalid/value');
  await expect(editor.locator('.syntax-line-content')).toHaveText(
    formatted.split('\n'),
  );
  expect(await editor.locator('.syntax-command').allTextContents()).toEqual(
    expect.arrayContaining(['exec', 'curl', 'jq', 'command']),
  );
  expect(await editor.locator('.syntax-option').allTextContents()).toEqual(
    expect.arrayContaining(['--rm', '--name', '--fail', '--raw-output', '--after', '--ansi', '--locale']),
  );
  expect(
    (await editor.locator('.syntax-operator').allTextContents()).filter(
      (token) => token === '\\',
    ).length,
  ).toBeGreaterThanOrEqual(11);
  // show the representative command and its formatted arguments in the evidence image
  await input.evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(async () => (await editorGeometry(editor)).presentationScrollTop).toBe(0);
  await editor.screenshot({
    path: '/tmp/remoteagents-settings-bash-formatted.png',
  });
  await prettyFormat(editor);
  await expect(input).toHaveValue(formatted);
  await input.fill(controlPrefixContent);
  await prettyFormat(editor);
  const formattedControls = await input.inputValue();
  expect(formattedControls).toContain('a | b) command');
  expect(formattedControls).toMatch(/command \\\n\s+--one alpha \\\n\s+beta/u);
  expect(formattedControls).toMatch(/command \\\n\s+--if value/u);
  expect(formattedControls).toMatch(/command \\\n\s+--loop value/u);
  expect(formattedControls).toMatch(/command \\\n\s+--fn value/u);
  await prettyFormat(editor);
  await expect(input).toHaveValue(formattedControls);
  await input.fill(optionGroupingContent);
  await prettyFormat(editor);
  await expect(input).toHaveValue(formattedOptionGrouping);
  expect(await editor.locator('.syntax-option').allTextContents()).toEqual(expect.arrayContaining([
    '--name',
    '--retry',
    '--flag',
    '--next=value',
    '--image',
    '--stdin',
    '-n',
    '--long',
  ]));
  await prettyFormat(editor);
  await expect(input).toHaveValue(formattedOptionGrouping);
  expect(workerUrls.filter(url => url.includes('shell-format-worker'))).toHaveLength(6);
  expect(requestUrls.some(url => /main(?:-[\w-]+)?\.wasm(?:\?|$)/u.test(url))).toBe(true);
  expect(executionRequests).toBe(0);
  expect(state.saves).toBe(0);
  expect(state.validations).toBe(0);
  expect(consoleErrors).toEqual([]);
});

test('fails closed instead of normalizing CRLF shell source', async ({ page }) => {
  test.setTimeout(90_000);
  const crlfSource = "printf '<%q>\\n' alpha beta\r\n";
  const { settings, state } = await setupCodeEditors(page, {
    interceptShellWorker: false,
    wrapperContent: crlfSource,
  });
  await selectSource(settings, 'TMUX');
  await revealRawSource(settings);
  const editor = settings.locator('.settings-code-editor');
  const input = editor.getByRole('textbox', {
    name: 'Installation wrapper source content',
  });
  const displayedSource = await input.inputValue();
  expect(displayedSource).toBe(crlfSource.replaceAll('\r\n', '\n'));
  await editor.getByRole('button', { name: 'Format' }).click();
  await expect(editor.getByRole('button', { name: 'Format' })).toBeEnabled();
  await expect(input).toHaveValue(displayedSource);
  await expect(editor.getByRole('alert')).toHaveText('Unable to format shell. Check its syntax and try again. The editor was not changed.');
  await expect(
    settings.getByRole('button', { name: 'Save changes', exact: true }),
  ).toHaveCount(0);
  expect(state.saves).toBe(0);
  expect(state.validations).toBe(0);
});

test('does not apply a delayed shell formatter after a newer edit and source navigation', async ({ page }) => {
  test.setTimeout(90_000);
  let releaseWasm = () => {};
  let reportWasmRequest = () => {};
  const wasmGate = new Promise<void>(resolve => { releaseWasm = resolve; });
  const wasmRequest = new Promise<void>(resolve => { reportWasmRequest = resolve; });
  // hold the local parser asset so the editor can change while formatting is pending
  await page.route(/main(?:-[\w-]+)?\.wasm(?:\?.*)?$/u, async route => {
    reportWasmRequest();
    await wasmGate;
    await route.continue();
  });
  const { settings, state } = await setupCodeEditors(page);
  await selectSource(settings, 'TMUX');
  await revealRawSource(settings);
  const shellEditor = settings.locator('.settings-code-editor');
  const shellInput = shellEditor.getByRole('textbox', { name: 'Installation wrapper source content' });
  await shellEditor.getByRole('button', { name: 'Format' }).click();
  await wasmRequest;
  await expect(shellEditor.getByRole('button', { name: 'Formatting…' })).toBeDisabled();

  // keep native editing responsive and unmount the pending editor
  const newerShell = '# newer draft\nprintf \'%s\\n\' "keep me"\n';
  await shellInput.fill(newerShell);
  await expect(shellInput).toHaveValue(newerShell);
  // retire the obsolete runtime before navigating or releasing its stalled asset
  await expect.poll(() => page.workers().filter(worker => worker.url().includes('shell-format-worker')).length).toBe(0);
  await selectSource(settings, 'Application config');
  releaseWasm();
  await selectSource(settings, 'TMUX');
  const restoredInput = settings.locator('.settings-code-editor').getByRole('textbox', { name: 'Installation wrapper source content' });
  // navigation hides the source and drops bytes derived from its disclosure
  await expect(restoredInput).toHaveAttribute('readonly', '');
  await expect(restoredInput).toHaveValue(shellContent.replace(protectedMarker, '********'));
  await revealRawSource(settings);
  await expect(restoredInput).toHaveValue(shellContent.replace(protectedMarker, disclosedSecret));
  await expect(restoredInput).not.toHaveValue(newerShell);
  await expect(settings.locator('.settings-code-editor').getByRole('button', { name: 'Format' })).toBeEnabled();
  expect(state.saves).toBe(0);
  expect(state.validations).toBe(0);
});

// exercise lifecycle invalidation without relying on a changed value or component unmount
test('cancels pending formatting on pagehide and permits a fresh request', async ({ page }) => {
  test.setTimeout(60_000);
  let releaseWasm = () => {};
  let reportWasmRequest = () => {};
  const wasmGate = new Promise<void>(resolve => { releaseWasm = resolve; });
  const wasmRequest = new Promise<void>(resolve => { reportWasmRequest = resolve; });
  // pause local runtime initialization until the security boundary has changed
  await page.route(/main(?:-[\w-]+)?\.wasm(?:\?.*)?$/u, async route => {
    reportWasmRequest();
    await wasmGate;
    await route.continue();
  });
  const { settings, state } = await setupCodeEditors(page);
  await selectSource(settings, 'TMUX');
  await revealRawSource(settings);
  const editor = settings.locator('.settings-code-editor');
  const input = editor.getByRole('textbox');
  const compact = 'if true;then echo unchanged;fi\n';
  await input.fill(compact);
  await editor.getByRole('button', { name: 'Format' }).click();
  await wasmRequest;
  await expect(editor.getByRole('button', { name: 'Formatting…' })).toBeDisabled();

  // revoke pending output and locally hide the sensitive draft at pagehide
  await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); });
  await expect(editor.getByRole('button', { name: 'Format' })).toBeDisabled();
  // discard the pending worker and its source memory at the lifecycle boundary
  await expect.poll(() => page.workers().filter(worker => worker.url().includes('shell-format-worker')).length).toBe(0);
  await expect(input).toHaveValue(shellContent.replace(protectedMarker, '********'));
  // explicit disclosure restores the saved source before a fresh local request
  await revealRawSource(settings);
  await expect(input).toHaveValue(shellContent.replace(protectedMarker, disclosedSecret));
  await input.fill(compact);
  await expect(editor.getByRole('button', { name: 'Format' })).toBeEnabled();

  // recover formatting under the new lifecycle epoch without saving anything
  await editor.getByRole('button', { name: 'Format' }).click();
  releaseWasm();
  await expect(input).toHaveValue('if true; then echo \\\n  unchanged; fi\n');
  await expect(editor.getByRole('button', { name: 'Format' })).toBeEnabled();
  expect(state.saves).toBe(0);
  expect(state.validations).toBe(0);
});
