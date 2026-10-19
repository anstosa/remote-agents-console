import { expect, test } from '@playwright/test';
import { prettyFormatSettingsCode, canPrettyFormatSettingsCode, SettingsCodeFormatError } from '../src/settings/code-format';
import { credentialValues, redactEditorSource, restoreEditorSource } from '../../server/src/settings/editor-source';

const revision = 'f'.repeat(43);

// exercise formatter and backend placeholder compatibility using synthetic credentials only
test('YAML formatting round-trips hidden credential values without rebasing their source lines', async () => {
  const original = [
    'services:',
    '  rac:',
    '    environment:',
    '      RAC_SESSION_SECRET: |-',
    '        synthetic credential first line',
    '        synthetic credential second line',
    '      SAFE_COMMAND: "echo visible"',
    '    labels: {visible: true}',
    ''
  ].join('\n');
  const redacted = redactEditorSource(original, 'compose', revision);
  const formatted = await prettyFormatSettingsCode(redacted.content, 'compose');
  const restored = restoreEditorSource(formatted, original, 'compose', revision);

  expect(formatted).not.toContain('synthetic credential');
  expect(restored).toContain('      RAC_SESSION_SECRET: |-\n        synthetic credential first line\n        synthetic credential second line');
  expect(restored).not.toContain('__RAC_PROTECTED_');
  expect(await prettyFormatSettingsCode(formatted, 'compose')).toBe(formatted);
});

// refuse changes whose hidden block indentation or scalar wrappers cannot be proven safe
test('YAML formatting refuses marker reindentation and flow mapping rewrites', async () => {
  const originals = [
    'environment:\n    RAC_SESSION_SECRET: |-\n        synthetic credential\n    SAFE_COMMAND: echo visible\n',
    'environment: {RAC_SESSION_SECRET: "synthetic credential", SAFE_COMMAND: "echo visible"}\n'
  ];
  // verify every unsafe protected context fails closed before persistence
  for (const original of originals) {
    const redacted = redactEditorSource(original, 'compose', revision);
    await expect(prettyFormatSettingsCode(redacted.content, 'compose')).rejects.toThrow(SettingsCodeFormatError);
    expect(restoreEditorSource(redacted.content, original, 'compose', revision)).toBe(original);
  }
});

// preserve opaque literal credentials embedded in ordinary SVG attributes
test('SVG formatting round-trips embedded protected literals without changing text whitespace', async () => {
  const original = '<svg xmlns="http://www.w3.org/2000/svg" data-key="synthetic credential" viewBox="0 0 100 100"><text xml:space="preserve"> A <tspan> B </tspan> C </text></svg>\n';
  const credentials = ['synthetic credential'];
  const redacted = redactEditorSource(original, 'svg', revision, credentials);
  const formatted = await prettyFormatSettingsCode(redacted.content, 'svg');
  const restored = restoreEditorSource(formatted, original, 'svg', revision, credentials);

  expect(formatted).not.toContain('synthetic credential');
  expect(restored).toContain('data-key="synthetic credential"');
  expect(restored).toContain('> A <tspan> B </tspan> C </text>');
  expect(await prettyFormatSettingsCode(formatted, 'svg')).toBe(formatted);
});

// retain credential leaves and embedded command markers across native JSON formatting
test('JSON formatting retains credential and command marker restoration', async () => {
  const original = JSON.stringify({ token: 'synthetic token', command: 'curl -H "Authorization: Bearer synthetic-header" https://example.test', publicKey: 'visible' });
  const credentials = credentialValues(original, 'json');
  const redacted = redactEditorSource(original, 'json', revision, credentials);
  const formatted = await prettyFormatSettingsCode(redacted.content, 'json');

  expect(JSON.parse(restoreEditorSource(formatted, original, 'json', revision, credentials))).toEqual(JSON.parse(original));
  expect(formatted).not.toMatch(/synthetic token|synthetic-header/u);
});

// avoid numeric coercion and key loss when formatting a config document
test('JSON formatting preserves numeric lexemes and duplicate keys', async () => {
  const original = '{"large":9007199254740993,"negativeZero":-0,"exponent":1e400,"repeated":1,"repeated":2}';
  const formatted = await prettyFormatSettingsCode(original, 'json');

  expect(formatted).toContain('"large": 9007199254740993');
  expect(formatted).toContain('"negativeZero": -0');
  expect(formatted).toContain('"exponent": 1e400');
  expect(formatted.match(/"repeated"/gu)).toHaveLength(2);
  expect(await prettyFormatSettingsCode(formatted, 'json')).toBe(formatted);
});

// enable each supported source family without pretending dotenv is a shell script
test('formatter availability matches the source contracts', async () => {
  // cover every parser-backed source identifier
  for (const format of ['json', 'installation', 'credentials', 'compose', 'cloudflared', 'wrapper', 'svg'] as const) expect(canPrettyFormatSettingsCode(format)).toBe(true);
  expect(canPrettyFormatSettingsCode(undefined)).toBe(false);
  expect(canPrettyFormatSettingsCode('env')).toBe(false);
  const environment = "# exact spacing\nSAFE_COMMAND = 'echo visible'\n";
  expect(await prettyFormatSettingsCode(environment, 'env')).toBe(environment);
});
