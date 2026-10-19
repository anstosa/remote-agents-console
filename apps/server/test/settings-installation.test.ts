import { describe, expect, it } from 'vitest';
import { isSettingsSnapshot } from '../../web/src/settings/contracts.js';
import { installationSettingsPresentationSchema } from '../src/settings/schema.js';
import { validateInstallation } from '../src/settings/transport.js';
import { installationSettingsSchema } from '../src/settings/validation.js';

const snapshot = { version: 1, revisionId: 'installation-snapshot', sources: [], status: { pending: false, targets: [], effective: 'known', restartAvailable: false } };

describe('installation mode snapshot metadata', () => {
  // retain compatible snapshots while accepting only installed mode identities
  it.each([undefined, 'compose', 'systemd'])('accepts the optional %s installation kind', installationKind => {
    expect(isSettingsSnapshot({ ...snapshot, ...(installationKind === undefined ? {} : { installationKind }) })).toBe(true);
  });

  // reject malformed or display-only mode aliases at the API boundary
  it.each(['docker', 'native', '', null, 1, {}])('rejects the invalid %s installation kind', installationKind => {
    expect(isSettingsSnapshot({ ...snapshot, installationKind })).toBe(false);
  });
});

describe('Compose option settings', () => {
  const compose = { projectDirectory: '/srv/rac', projectName: 'rac', files: ['/srv/rac/compose.yaml'], envFiles: ['/srv/rac/.env'], profiles: [], options: { compatibility: false } };

  // accept only Docker's unlimited sentinel or bounded positive limits
  it.each([-1, 1, 64])('accepts the parallel limit %s', parallel => {
    expect(installationSettingsSchema.safeParse({ version: 1, compose: { ...compose, options: { ...compose.options, parallel } } }).success).toBe(true);
  });

  // reject invalid numeric limits at the editable source boundary
  it.each([0, -2, 1.5, 65])('rejects the parallel limit %s', parallel => {
    expect(installationSettingsSchema.safeParse({ version: 1, compose: { ...compose, options: { ...compose.options, parallel } } }).success).toBe(false);
  });

  // publish permanent controls as presentation metadata only
  it('describes defaults without materializing them during validation', () => {
    const source = { version: 1, compose: { ...compose, options: undefined } };
    expect(installationSettingsSchema.parse(source)).toEqual(source);
    const options = installationSettingsPresentationSchema(installationSettingsSchema).properties?.compose?.properties?.options;
    expect(options).toMatchObject({ default: {} });
    expect(options?.properties?.parallel).toMatchObject({ type: 'number', default: -1, description: expect.stringContaining('does not limit RAC agents') });
    expect(options?.properties?.compatibility).toMatchObject({ type: 'boolean', default: false, description: expect.stringContaining('underscore-separated') });
  });

  // enforce the same limits on installed authority descriptors
  it.each([
    [-1, true],
    [0, false],
    [-2, false],
    [1.5, false],
    [65, false]
  ] as const)('validates descriptor parallel %s as %s', (parallel, accepted) => {
    const root = '/tmp/rac-compose-option-settings';
    const descriptor = {
      version: 1,
      installationId: 'compose-options-test-0001',
      generation: 1,
      uid: process.getuid(),
      gid: process.getgid(),
      kind: 'compose',
      hostControlRoot: `${root}/control`,
      hostCheckout: root,
      serverCheckout: '/workspace',
      allowedRoots: [root],
      sources: {},
      compose: { projectDirectory: root, projectName: 'rac', files: [`${root}/compose.yaml`], envFiles: [`${root}/.env`], profiles: [], options: { parallel, compatibility: false } }
    };
    // distinguish acceptance from the bounded descriptor error
    if (accepted) expect(() => validateInstallation(descriptor)).not.toThrow();
    else expect(() => validateInstallation(descriptor)).toThrowError('settings_installation_invalid');
  });
});
