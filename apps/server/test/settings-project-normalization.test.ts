import { describe, expect, it } from 'vitest';
import { applyAuthoredProjectPatch } from '../src/settings/project-normalization.js';

describe('authored Project patch normalization', () => {
  // retain real scalar values and unknown fields in a whole authored row
  it('preserves false, zero, unknown values, and required blanks', () => {
    const value = applyAuthoredProjectPatch({}, {
      op: 'set',
      path: ['projects'],
      value: [{ id: '', path: '', port: 0, customFlag: false, customCount: 0, label: '' }]
    });

    expect(value).toEqual({ projects: [{ id: '', path: '', port: 0, customFlag: false, customCount: 0 }] });
  });

  // prune only semantically empty optional containers from authored values
  it('keeps override command suppression and invalid process or unknown legacy objects explicit', () => {
    const value = applyAuthoredProjectPatch({}, {
      op: 'set',
      path: ['projects'],
      value: [{
        id: 'one',
        path: '/tmp/one',
        commands: { processes: {} },
        worktreeOrder: [],
        worktreeOverrides: [{ path: 'feature', commands: {} }],
        push: {}
      }]
    });

    expect(value).toEqual({ projects: [{
      id: 'one',
      path: '/tmp/one',
      commands: { processes: {} },
      worktreeOverrides: [{ path: 'feature', commands: {} }],
      push: {}
    }] });
  });

  // bypass project normalization for every non-project structured edit
  it('delegates non-Project patches unchanged', () => {
    expect(applyAuthoredProjectPatch({ name: '' }, { op: 'set', path: ['name'], value: '' })).toEqual({ name: '' });
  });

  // keep absent blank clears and removals from creating project ancestry
  it('treats missing blank fields and removals as exact no-ops', () => {
    const baseline = { projects: [{ id: 'one', path: '/tmp/one' }] };
    expect(applyAuthoredProjectPatch(baseline, { op: 'set', path: ['projects', '0', 'commands', 'start'], value: '' })).toEqual(baseline);
    expect(applyAuthoredProjectPatch(baseline, { op: 'remove', path: ['projects', '0', 'commands', 'start'] })).toEqual(baseline);
  });

  // reject forged rows before applying optional-field no-op semantics
  it('rejects missing, noncanonical, and out-of-bounds array selectors', () => {
    const baseline = { projects: [{ id: 'one', path: '/tmp/one' }] };
    expect(() => applyAuthoredProjectPatch({}, { op: 'set', path: ['projects', '0', 'label'], value: '' })).toThrow('invalid_settings_patch');
    expect(() => applyAuthoredProjectPatch(baseline, { op: 'remove', path: ['projects', '999', 'label'] })).toThrow('invalid_settings_patch');
    expect(() => applyAuthoredProjectPatch(baseline, { op: 'set', path: ['projects', '01', 'label'], value: '' })).toThrow('invalid_settings_patch');
    expect(() => applyAuthoredProjectPatch(baseline, { op: 'set', path: ['projects', '0', 'worktreeOverrides', '0', 'hostname'], value: '' })).toThrow('invalid_settings_patch');
  });

  // distinguish inherited override commands from explicit suppression
  it('does not create absent override commands and retains a cleared saved override', () => {
    const inherited = { projects: [{ id: 'one', path: '/tmp/one', worktreeOverrides: [{ path: 'feature' }] }] };
    const explicit = { projects: [{ id: 'one', path: '/tmp/one', worktreeOverrides: [{ path: 'feature', commands: { start: 'pnpm feature' } }] }] };
    const path = ['projects', '0', 'worktreeOverrides', '0', 'commands', 'start'];

    expect(applyAuthoredProjectPatch(inherited, { op: 'set', path, value: '' })).toEqual(inherited);
    expect(applyAuthoredProjectPatch(explicit, { op: 'set', path, value: '' })).toEqual({
      projects: [{ id: 'one', path: '/tmp/one', worktreeOverrides: [{ path: 'feature', commands: {} }] }]
    });
  });

  // distinguish explicit invalid process maps from deleting the final process
  it('preserves set processes objects but prunes a map emptied by child removal', () => {
    const baseline = { projects: [{ id: 'one', path: '/tmp/one' }] };
    expect(applyAuthoredProjectPatch(baseline, { op: 'set', path: ['projects', '0', 'commands', 'processes'], value: {} })).toEqual({
      projects: [{ id: 'one', path: '/tmp/one', commands: { processes: {} } }]
    });

    const project = { projects: [{ id: 'one', path: '/tmp/one', commands: { processes: { web: 'pnpm dev' } } }] };
    expect(applyAuthoredProjectPatch(project, { op: 'remove', path: ['projects', '0', 'commands', 'processes', 'web'] })).toEqual(baseline);

    const override = { projects: [{ id: 'one', path: '/tmp/one', worktreeOverrides: [{ path: 'feature', commands: { processes: { web: 'pnpm dev' } } }] }] };
    expect(applyAuthoredProjectPatch(override, { op: 'remove', path: ['projects', '0', 'worktreeOverrides', '0', 'commands', 'processes', 'web'] })).toEqual({
      projects: [{ id: 'one', path: '/tmp/one', worktreeOverrides: [{ path: 'feature', commands: {} }] }]
    });
  });

  // seed declared optional collections on insert and omit them after the last removal
  it('adds and removes rows in every initially absent project collection', () => {
    let value: unknown = {};
    value = applyAuthoredProjectPatch(value, { op: 'insert', path: ['projects'], value: { id: 'one', path: '/tmp/one', commands: { processes: { web: { command: 'pnpm dev' } } } } });
    value = applyAuthoredProjectPatch(value, { op: 'insert', path: ['projects', '0', 'worktreeOrder'], value: 'feature' });
    value = applyAuthoredProjectPatch(value, { op: 'insert', path: ['projects', '0', 'worktreeOverrides'], value: { path: 'feature' } });
    value = applyAuthoredProjectPatch(value, { op: 'insert', path: ['projects', '0', 'commands', 'processes', 'web', 'dependsOn'], value: 'api' });

    expect(value).toEqual({ projects: [{
      id: 'one',
      path: '/tmp/one',
      commands: { processes: { web: { command: 'pnpm dev', dependsOn: ['api'] } } },
      worktreeOrder: ['feature'],
      worktreeOverrides: [{ path: 'feature' }]
    }] });

    value = applyAuthoredProjectPatch(value, { op: 'remove', path: ['projects', '0', 'worktreeOrder', '0'] });
    value = applyAuthoredProjectPatch(value, { op: 'remove', path: ['projects', '0', 'worktreeOverrides', '0'] });
    value = applyAuthoredProjectPatch(value, { op: 'remove', path: ['projects', '0', 'commands', 'processes', 'web', 'dependsOn', '0'] });
    expect(value).toEqual({ projects: [{ id: 'one', path: '/tmp/one', commands: { processes: { web: { command: 'pnpm dev' } } } }] });

    value = applyAuthoredProjectPatch(value, { op: 'remove', path: ['projects', '0'] });
    expect(value).toEqual({});
  });

  // omit optional blank scalars while retaining explicit and required values
  it('removes a blank port without weakening required button fields or nullable overrides', () => {
    const baseline = { projects: [{
      id: 'one',
      path: '/tmp/one',
      port: 8787,
      buttons: { pullRequest: [{ text: 'Ship', icon: 'M1 1', color: 'mauve', style: 'solid', action: { agentPrompt: 'review' } }] },
      worktreeOverrides: [{ path: 'feature', port: 8788 }]
    }] };
    let value = applyAuthoredProjectPatch(baseline, { op: 'set', path: ['projects', '0', 'port'], value: '' });
    value = applyAuthoredProjectPatch(value, { op: 'set', path: ['projects', '0', 'buttons', 'pullRequest', '0', 'icon'], value: '' });
    value = applyAuthoredProjectPatch(value, { op: 'set', path: ['projects', '0', 'buttons', 'pullRequest', '0', 'action', 'agentPrompt'], value: '' });
    value = applyAuthoredProjectPatch(value, { op: 'set', path: ['projects', '0', 'worktreeOverrides', '0', 'port'], value: null });

    expect(value).toEqual({ projects: [{
      id: 'one',
      path: '/tmp/one',
      buttons: { pullRequest: [{ text: 'Ship', color: 'mauve', style: 'solid', action: { agentPrompt: '' } }] },
      worktreeOverrides: [{ path: 'feature', port: null }]
    }] });
  });

  // preserve the action variant selected by its unique owned key
  it('normalizes each button action branch and prunes the final project list', () => {
    const prompt = '  review\n    exactly\n';
    let value: unknown = { projects: [{ id: 'one', path: '/tmp/one', buttons: { pullRequest: [], splits: { files: [] } } }] };
    value = applyAuthoredProjectPatch(value, { op: 'insert', path: ['projects', '0', 'buttons', 'pullRequest'], value: { text: 'Ask', icon: '', color: 'mauve', style: 'outline', action: { agentPrompt: prompt } } });
    value = applyAuthoredProjectPatch(value, { op: 'insert', path: ['projects', '0', 'buttons', 'splits', 'files'], value: { text: 'Run', color: 'blue', style: 'solid', action: { shellCommand: '  pwd\n' } } });
    expect(value).toEqual({ projects: [{ id: 'one', path: '/tmp/one', buttons: {
      pullRequest: [{ text: 'Ask', color: 'mauve', style: 'outline', action: { agentPrompt: prompt } }],
      splits: { files: [{ text: 'Run', color: 'blue', style: 'solid', action: { shellCommand: '  pwd\n' } }] }
    } }] });
    value = applyAuthoredProjectPatch(value, { op: 'remove', path: ['projects', '0', 'buttons', 'pullRequest', '0'] });
    value = applyAuthoredProjectPatch(value, { op: 'remove', path: ['projects', '0', 'buttons', 'splits', 'files', '0'] });
    expect(value).toEqual({ projects: [{ id: 'one', path: '/tmp/one' }] });
  });

  // keep the optional comparison fallback editable without persisting blanks
  it('omits a blank default branch while preserving and replacing explicit values', () => {
    const baseline = { projects: [{ id: 'one', path: '/tmp/one', defaultBranch: 'release/stable' }] };
    const untouched = applyAuthoredProjectPatch(baseline, { op: 'set', path: ['projects', '0', 'label'], value: 'One' });
    const replaced = applyAuthoredProjectPatch(baseline, { op: 'set', path: ['projects', '0', 'defaultBranch'], value: 'release/next' });
    const cleared = applyAuthoredProjectPatch(baseline, { op: 'set', path: ['projects', '0', 'defaultBranch'], value: '' });

    expect(untouched).toEqual({ projects: [{ id: 'one', path: '/tmp/one', defaultBranch: 'release/stable', label: 'One' }] });
    expect(replaced).toEqual({ projects: [{ id: 'one', path: '/tmp/one', defaultBranch: 'release/next' }] });
    expect(cleared).toEqual({ projects: [{ id: 'one', path: '/tmp/one' }] });
  });

  // reject dangerous missing selectors before applying no-op semantics
  it('retains generic patch validation for missing project paths', () => {
    expect(() => applyAuthoredProjectPatch({}, { op: 'remove', path: ['projects', '__proto__', 'value'] })).toThrow('invalid_settings_patch');
  });
});
