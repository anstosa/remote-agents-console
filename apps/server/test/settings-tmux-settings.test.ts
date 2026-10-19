import { describe, expect, it } from 'vitest';
import type { SettingsChange, SettingsPatch } from '../../web/src/settings/contracts.js';
import { isTmuxSettingsChange, tmuxEnvironmentKeys, tmuxEnvironmentKeysForInstallation } from '../../web/src/settings/tmux-settings.js';

// build one change with the real source identifiers
const change = (sourceId: 'app' | 'env' | 'installation' | 'wrapper' | 'icon-heart', patches?: SettingsPatch[]): SettingsChange => ({
  sourceId,
  revisionId: 'revision-1',
  ...(patches === undefined ? {} : { patches })
});

describe('tmux settings changes', () => {
  it('exports the complete tmux environment key set', () => {
    expect([...tmuxEnvironmentKeys]).toEqual([
      'RAC_TMUX_BIN',
      'RAC_HOST_TMUX_DIR',
      'RAC_HOST_TMUX_SOURCE',
      'RAC_HOST_UNIX_SOCKETS',
      'HOST_TMUX_DIR',
      'HOST_TMUX_BIN'
    ]);
  });

  // expose host aliases only where the docker installation can use them
  it('selects visible tmux environment keys for the installation mode', () => {
    expect([...tmuxEnvironmentKeysForInstallation('compose')]).toEqual([...tmuxEnvironmentKeys]);
    expect([...tmuxEnvironmentKeysForInstallation('systemd')]).toEqual([
      'RAC_TMUX_BIN',
      'RAC_HOST_TMUX_DIR',
      'RAC_HOST_TMUX_SOURCE',
      'RAC_HOST_UNIX_SOCKETS'
    ]);
    expect([...tmuxEnvironmentKeysForInstallation()]).toEqual([
      'RAC_TMUX_BIN',
      'RAC_HOST_TMUX_DIR',
      'RAC_HOST_TMUX_SOURCE',
      'RAC_HOST_UNIX_SOCKETS'
    ]);
  });

  it('counts every wrapper change', () => {
    expect(isTmuxSettingsChange(change('wrapper'))).toBe(true);
    expect(isTmuxSettingsChange({ ...change('wrapper'), content: '' })).toBe(true);
    expect(isTmuxSettingsChange({ ...change('wrapper'), remove: true })).toBe(true);
  });

  it('counts only application patches rooted at tmux', () => {
    expect(isTmuxSettingsChange(change('app', [{ op: 'set', path: ['tmux'], value: {} }]))).toBe(true);
    expect(isTmuxSettingsChange(change('app', [{ op: 'remove', path: ['tmux', 'defaultCommand'] }]))).toBe(true);
    expect(isTmuxSettingsChange(change('app', [{ op: 'set', path: ['name'], value: 'RAC' }]))).toBe(false);
    expect(isTmuxSettingsChange(change('app', [{ op: 'set', path: ['nested', 'tmux'], value: true }]))).toBe(false);
    expect(isTmuxSettingsChange(change('app', [{ op: 'set', path: [], value: {} }]))).toBe(false);
  });

  it('counts only exact tmux environment keys', () => {
    // exercise every supported environment owner key
    for (const key of tmuxEnvironmentKeys) {
      expect(isTmuxSettingsChange(change('env', [{ op: 'set', path: [key], value: '/tmp/value' }]))).toBe(true);
    }
    expect(isTmuxSettingsChange(change('env', [{ op: 'set', path: ['RAC_TMUX_BIN_EXTRA'], value: '/bin/tmux' }]))).toBe(false);
    expect(isTmuxSettingsChange(change('env', [{ op: 'remove', path: ['TZ'] }]))).toBe(false);
    expect(isTmuxSettingsChange(change('env', [{ op: 'set', path: ['nested', 'RAC_TMUX_BIN'], value: '/bin/tmux' }]))).toBe(false);
  });

  it('counts the wrapper selector and replacing ancestor installation patches', () => {
    expect(isTmuxSettingsChange(change('installation', [{ op: 'set', path: ['sources', 'wrapper'], value: '/srv/rac/bin/host-tmux' }]))).toBe(true);
    expect(isTmuxSettingsChange(change('installation', [{ op: 'remove', path: ['sources', 'wrapper'] }]))).toBe(true);
    expect(isTmuxSettingsChange(change('installation', [{ op: 'set', path: ['sources'], value: { wrapper: '/srv/rac/bin/host-tmux' } }]))).toBe(true);
    expect(isTmuxSettingsChange(change('installation', [{ op: 'remove', path: ['sources'] }]))).toBe(true);
    expect(isTmuxSettingsChange(change('installation', [{ op: 'set', path: [], value: { sources: {} } }]))).toBe(true);
    expect(isTmuxSettingsChange(change('installation', [{ op: 'remove', path: [] }]))).toBe(true);
    expect(isTmuxSettingsChange(change('installation', [{ op: 'set', path: ['sources', 'icons', 'heart'], value: '/srv/rac/heart.svg' }]))).toBe(false);
    expect(isTmuxSettingsChange(change('installation', [{ op: 'set', path: ['native', 'unit'], value: 'rac.service' }]))).toBe(false);
    expect(isTmuxSettingsChange(change('installation', [{ op: 'insert', path: ['sources'], value: 'wrapper' }]))).toBe(false);
  });

  it('counts raw typed source changes conservatively without matching unrelated sources', () => {
    expect(isTmuxSettingsChange({ ...change('app'), content: '{}' })).toBe(true);
    expect(isTmuxSettingsChange({ ...change('env'), content: '' })).toBe(true);
    expect(isTmuxSettingsChange({ ...change('installation'), remove: true })).toBe(true);
    expect(isTmuxSettingsChange({ ...change('app'), remove: false })).toBe(false);
    expect(isTmuxSettingsChange({ ...change('icon-heart'), content: '<svg />' })).toBe(false);
    expect(isTmuxSettingsChange(change('icon-heart', [{ op: 'set', path: ['tmux'], value: true }]))).toBe(false);
  });
});
