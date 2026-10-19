import { describe, expect, it } from 'vitest';
import { isSettingsSnapshot } from '../../web/src/settings/contracts.js';

// isolate omission metadata from authored environment values
const snapshot = (fallback?: unknown, protectedValue = false): unknown => ({
  version: 1,
  revisionId: 'snapshot',
  sources: [{ id: 'env', label: 'Environment & keys', format: 'env', exists: true, writable: true, protected: false, tracked: false, revisionId: 'source', apply: 'rac-restart', fields: [{ key: 'RAC_TMUX_BIN', protected: protectedValue, present: false, apply: 'rac-restart', ...(fallback === undefined ? {} : { fallback }) }] }],
  status: { pending: false, targets: [], effective: 'known', restartAvailable: true }
});

describe('environment omission metadata contract', () => {
  // preserve older snapshots without fallback hints
  it('accepts existing snapshots and safe omission metadata', () => {
    expect(isSettingsSnapshot(snapshot())).toBe(true);
    for (const kind of ['literal', 'derived', 'compose']) expect(isSettingsSnapshot(snapshot({ value: '/usr/bin/tmux', kind }))).toBe(true);
    expect(isSettingsSnapshot(snapshot({ value: 'Uses RAC_SESSION_SECRET', kind: 'derived' }, true))).toBe(true);
  });

  // refuse malformed fallback values before rendering their copy
  it.each([null, false, 'tmux', {}, { value: 1, kind: 'literal' }, { value: '', kind: 'literal' }, { value: ' ', kind: 'derived' }, { value: '/usr/bin/tmux', kind: 'unknown' }])('rejects invalid fallback metadata %j', fallback => {
    expect(isSettingsSnapshot(snapshot(fallback))).toBe(false);
  });

  // secret-bearing fields may expose only symbolic dependency guidance
  it.each(['literal', 'compose'])('rejects concrete %s values for protected fields', kind => {
    expect(isSettingsSnapshot(snapshot({ value: 'never-expose-this', kind }, true))).toBe(false);
  });
});
