import { describe, expect, it } from 'vitest';
import { credentialValues, redactEditorSource, restoreEditorSource } from '../src/settings/editor-source.js';

const revision = 'r'.repeat(43);

describe('settings redacted editor sources', () => {
  // pretty-print JSON while masking credential values and retaining advanced controls
  it('redacts only credential leaves in JSON and restores unchanged markers', () => {
    const original = JSON.stringify({ command: 'echo visible', privateKey: 'private credential sentinel', privateKeyPath: '/safe/key.pem', nested: { token: 'token credential sentinel' } });
    const redacted = redactEditorSource(original, 'json', revision);

    expect(redacted.hasProtectedContent).toBe(true);
    expect(redacted.content).toContain('\n  "command": "echo visible"');
    expect(redacted.content).toContain('"privateKeyPath": "/safe/key.pem"');
    expect(redacted.content).not.toContain('private credential sentinel');
    expect(redacted.content).not.toContain('token credential sentinel');

    const edited = redacted.content.replace('echo visible', 'echo changed');
    expect(JSON.parse(restoreEditorSource(edited, original, 'json', revision))).toEqual({ command: 'echo changed', privateKey: 'private credential sentinel', privateKeyPath: '/safe/key.pem', nested: { token: 'token credential sentinel' } });
  });

  // leave empty and null credential leaves visible without manufacturing protected content
  it('preserves JSON bytes when every credential leaf is unset', () => {
    const json = `${JSON.stringify({ command: 'echo visible', privateKey: '', nested: { token: null } }, null, 2)}\n`;
    const credentials = `${JSON.stringify({ AccountTag: 'account-visible', TunnelSecret: '', SecondarySecret: null, TunnelID: 'tunnel-visible' }, null, 2)}\n`;

    expect(redactEditorSource(json, 'json', revision)).toEqual({ content: json, hasProtectedContent: false });
    expect(redactEditorSource(credentials, 'credentials', revision)).toEqual({ content: credentials, hasProtectedContent: false });
    expect(restoreEditorSource(json, json, 'json', revision)).toBe(json);
    expect(restoreEditorSource(credentials, credentials, 'credentials', revision)).toBe(credentials);
  });

  // protect nonempty values while retaining adjacent unset leaves and literal restoration
  it('redacts mixed JSON credentials without hiding empty or null siblings', () => {
    const secret = 'mixed credential sentinel';
    const original = `${JSON.stringify({ command: 'echo visible', privateKey: null, nested: { emptyToken: '', token: secret }, mirror: secret }, null, 2)}\n`;
    const protectedValues = credentialValues(original, 'json');
    const redacted = redactEditorSource(original, 'json', revision, protectedValues);

    expect(redacted.hasProtectedContent).toBe(true);
    expect(redacted.content).toContain('"privateKey": null');
    expect(redacted.content).toContain('"emptyToken": ""');
    expect(redacted.content).not.toContain(secret);
    const edited = redacted.content.replace('echo visible', 'echo changed');
    expect(JSON.parse(restoreEditorSource(edited, original, 'json', revision, protectedValues))).toEqual({ command: 'echo changed', privateKey: null, nested: { emptyToken: '', token: secret }, mirror: secret });
  });

  // expose Cloudflare public identity fields while protecting its tunnel secret
  it('masks TunnelSecret but leaves AccountTag and TunnelID visible', () => {
    const original = `${JSON.stringify({ AccountTag: 'account-visible', TunnelSecret: 'tunnel credential sentinel', TunnelID: 'tunnel-visible' })}\n`;
    const redacted = redactEditorSource(original, 'credentials', revision);

    expect(redacted.content).toContain('account-visible');
    expect(redacted.content).toContain('tunnel-visible');
    expect(redacted.content).not.toContain('tunnel credential sentinel');
    expect(JSON.parse(restoreEditorSource(redacted.content, original, 'credentials', revision))).toMatchObject({ TunnelSecret: 'tunnel credential sentinel' });
  });

  // mask a credential again when another source embeds its value under an ordinary name
  it('redacts known credentials across JSON and code source boundaries', () => {
    const credential = 'shared-cross-source-credential';
    const json = '{"command":"curl shared-cross-source-credential","label":"visible"}\n';
    const wrapper = 'run --label visible shared-cross-source-credential\n';
    const redactedJson = redactEditorSource(json, 'json', revision, [credential]);
    const redactedWrapper = redactEditorSource(wrapper, 'wrapper', revision, [credential]);

    expect(redactedJson.content).not.toContain(credential);
    expect(redactedWrapper.content).not.toContain(credential);
    expect(restoreEditorSource(redactedJson.content.replace('curl ', 'fetch '), json, 'json', revision, [credential])).toContain(`fetch ${credential}`);
    expect(restoreEditorSource(redactedWrapper.content.replace('run ', 'exec '), wrapper, 'wrapper', revision, [credential])).toContain(`exec --label visible ${credential}`);
  });

  // discover embedded credentials inside ordinary valid JSON strings
  it('redacts header and URL credentials from valid JSON commands', () => {
    const original = JSON.stringify({ command: 'curl -H "Authorization: Bearer header~secret" https://user:url-secret@example.test', label: 'visible' });
    const protectedValues = credentialValues(original, 'json');
    const redacted = redactEditorSource(original, 'json', revision, protectedValues);

    expect(protectedValues).toEqual(expect.arrayContaining(['header~secret', 'url-secret']));
    expect(redacted.content).toContain('Authorization: Bearer ');
    expect(redacted.content).toContain('https://user:');
    expect(redacted.content).not.toMatch(/header~secret|url-secret/u);
    expect(restoreEditorSource(redacted.content, original, 'json', revision, protectedValues)).toContain('header~secret');
  });

  // preserve dotenv comments and multiline credential bytes behind one opaque marker
  it('keeps ordinary environment settings visible and round-trips multiline credentials', () => {
    const original = "SAFE_COMMAND='echo visible'\nRAC_SESSION_SECRET='first credential line\nsecond credential line'\nCUSTOM_PRIVATE_KEY_PATH=/safe/key.pem\n";
    const redacted = redactEditorSource(original, 'env', revision);

    expect(redacted.content).toContain("SAFE_COMMAND='echo visible'");
    expect(redacted.content).toContain('CUSTOM_PRIVATE_KEY_PATH=/safe/key.pem');
    expect(redacted.content).not.toContain('credential line');
    expect(restoreEditorSource(redacted.content.replace('echo visible', 'echo changed'), original, 'env', revision)).toBe(original.replace('echo visible', 'echo changed'));
  });

  // mask YAML blocks, shell options, headers, URL passwords, and PEM key material only
  it('redacts credential values in YAML and wrapper code without hiding commands', () => {
    const original = [
      'command: echo visible',
      'token: |',
      '  yaml credential sentinel',
      'privateKeyPath: /safe/key.pem',
      'curl --api-key cli-credential https://user:url-credential@example.test -H "Authorization: Bearer header-credential"',
      '-----BEGIN PRIVATE KEY-----',
      'pem-credential',
      '-----END PRIVATE KEY-----',
      ''
    ].join('\n');
    const redacted = redactEditorSource(original, 'wrapper', revision);

    expect(redacted.content).toContain('command: echo visible');
    expect(redacted.content).toContain('privateKeyPath: /safe/key.pem');
    expect(redacted.content).not.toMatch(/yaml credential|cli-credential|url-credential|header-credential|pem-credential/u);
    expect(restoreEditorSource(redacted.content.replace('echo visible', 'echo changed'), original, 'wrapper', revision)).toBe(original.replace('echo visible', 'echo changed'));
  });

  // accept the complete token68 alphabet and one-byte header credentials
  it('redacts and restores complete inline authorization header values', () => {
    const original = 'curl -H "Authorization: Bearer abcdef~still-secret" -H "X-Api-Key: x" https://example.test\n';
    const redacted = redactEditorSource(original, 'wrapper', revision);

    expect(redacted.content).toContain('curl -H "Authorization: Bearer ');
    expect(redacted.content).not.toMatch(/abcdef|still-secret|X-Api-Key: x/u);
    expect(restoreEditorSource(redacted.content, original, 'wrapper', revision)).toBe(original);
  });

  // protect arbitrary authorization schemes through the quoted header boundary
  it('redacts token, Digest, and AWS authorization credential portions', () => {
    const original = [
      'curl -H "Authorization: token ghp_secret" https://example.test',
      'curl -H "Authorization: Digest username=u,response=digest-secret" https://example.test',
      'curl -H "Authorization: AWS4-HMAC-SHA256 Credential=access,Signature=aws-secret" https://example.test',
      ''
    ].join('\n');
    const redacted = redactEditorSource(original, 'wrapper', revision);

    expect(redacted.content).toMatch(/Authorization: token __RAC_PROTECTED_/u);
    expect(redacted.content).toMatch(/Authorization: Digest __RAC_PROTECTED_/u);
    expect(redacted.content).toMatch(/Authorization: AWS4-HMAC-SHA256 __RAC_PROTECTED_/u);
    expect(redacted.content).not.toMatch(/ghp_secret|digest-secret|aws-secret|Credential=access/u);
    expect(restoreEditorSource(redacted.content, original, 'wrapper', revision)).toBe(original);
  });

  // protect credential assignments embedded after common wrapper command tokens
  it('redacts inline env, docker, and quoted command assignments', () => {
    const original = [
      'env RAC_OPENAI_API_KEY=env-secret command',
      'docker run -e RAC_OPENAI_API_KEY=docker-secret image',
      'command RAC_SESSION_SECRET="actual secret"',
      ''
    ].join('\n');
    const redacted = redactEditorSource(original, 'wrapper', revision);

    expect(redacted.content).toContain('env RAC_OPENAI_API_KEY=');
    expect(redacted.content).toContain('docker run -e RAC_OPENAI_API_KEY=');
    expect(redacted.content).not.toMatch(/env-secret|docker-secret|actual secret/u);
    expect(restoreEditorSource(redacted.content, original, 'wrapper', revision)).toBe(original);
  });

  // retain Compose scalar quotes while protecting their credential assignment values
  it('redacts and restores single- and double-quoted Compose environment-list assignments', () => {
    const original = [
      'environment:',
      '  - "RAC_OPENAI_API_KEY=double-secret"',
      "  - 'RAC_SESSION_SECRET=single-secret'",
      '  - "SAFE_COMMAND=echo visible"',
      ''
    ].join('\n');
    const redacted = redactEditorSource(original, 'wrapper', revision);

    expect(redacted.content).toContain('SAFE_COMMAND=echo visible');
    expect(redacted.content).not.toMatch(/double-secret|single-secret/u);
    expect(restoreEditorSource(redacted.content, original, 'wrapper', revision)).toBe(original);
  });

  // fail closed around credential properties in invalid JSON and YAML flow mappings
  it('redacts and restores inline credential mappings outside valid structured JSON', () => {
    const invalidJson = '{"token":"secret-value","broken":}\n';
    const yamlFlow = 'environment: {RAC_OPENAI_API_KEY: "flow-secret", SAFE_COMMAND: "echo visible"}\n';
    const redactedJson = redactEditorSource(invalidJson, 'json', revision);
    const redactedYaml = redactEditorSource(yamlFlow, 'wrapper', revision);

    expect(redactedJson.content).not.toContain('secret-value');
    expect(redactedYaml.content).not.toContain('flow-secret');
    expect(redactedYaml.content).toContain('SAFE_COMMAND: "echo visible"');
    expect(restoreEditorSource(redactedJson.content, invalidJson, 'json', revision)).toBe(invalidJson);
    expect(restoreEditorSource(redactedYaml.content, yamlFlow, 'wrapper', revision)).toBe(yamlFlow);
  });

  // reject missing, altered, duplicated, relocated, and unknown editor placeholders
  it('fails closed when a protected placeholder is tampered with', () => {
    const original = '{"token":"credential sentinel","command":"visible"}\n';
    const redacted = redactEditorSource(original, 'json', revision).content;
    const marker = /__RAC_PROTECTED_[A-Za-z0-9_-]{43}__/u.exec(redacted)![0];

    expect(() => restoreEditorSource(redacted.replace(marker, `${marker}x`), original, 'json', revision)).toThrowError('settings_protected_content_changed');
    expect(() => restoreEditorSource(redacted.replace('"command": "visible"', `"command": "${marker}"`), original, 'json', revision)).toThrowError('settings_protected_content_changed');
    expect(() => restoreEditorSource(redacted.replace(`"token": "${marker}"`, '"token": "changed"'), original, 'json', revision)).toThrowError('settings_protected_content_changed');
  });

  // leave credential-free SVG source text byte-for-byte visible and editable
  it('passes credential-free SVG through unchanged', () => {
    const original = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>\n';
    const redacted = redactEditorSource(original, 'svg', revision);

    expect(redacted).toEqual({ content: original, hasProtectedContent: false });
    expect(restoreEditorSource(redacted.content.replace('M0 0', 'M1 1'), original, 'svg', revision)).toContain('M1 1');
  });
});
