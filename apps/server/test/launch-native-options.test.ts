import { describe, expect, it } from 'vitest';
import { compileNativeLaunch, nativeSecurityManifest, nativeSecurityProblem } from '../src/launch/native-options.js';
import type { LaunchInput } from '../src/adapters/types.js';

const fresh: LaunchInput = { mode: 'fresh', cwd: '/repo', sandboxed: false };

describe('native launch option compilation', () => {
  // an automatic approval preset is not dangerous bypass
  it('rejects a filesystem-only automatic-review override before compilation', () => {
    const security = { filesystem: 'read-only', approvals: 'inherit', bypass: 'inherit' };
    expect(nativeSecurityProblem('codex', ['--approve-for-me'], security)).toBeDefined();
    expect(() => compileNativeLaunch('codex', fresh, ['--approve-for-me'], { security }, { args: [] })).toThrowError('launch_option_unsupported');
    const explicit = compileNativeLaunch('codex', fresh, ['--approve-for-me'], { security: { approvals: 'on-request', filesystem: 'inherit' } }, { args: [] });
    expect(explicit.args).toEqual(['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']);
    expect(explicit.args).not.toContain('never');
  });

  // opaque shortcuts require an explicit replacement for both axes
  it('keeps opaque presets for model changes and refuses guessed partial mappings', () => {
    expect(compileNativeLaunch('codex', fresh, ['--full-auto'], { model: { model: 'allowed' } }, { args: [] }).args).toEqual(['--model', 'allowed', '--full-auto']);
    expect(nativeSecurityProblem('codex', ['--full-auto'], { filesystem: 'read-only' })).toBeDefined();
    expect(compileNativeLaunch('codex', fresh, ['--full-auto'], { security: { filesystem: 'read-only', approvals: 'on-request' } }, { args: [] }).args).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'on-request']);
  });

  // normalize model flags without changing configured security
  it('replaces only Codex model and Effort selectors for a model-only choice', () => {
    const compiled = compileNativeLaunch('codex', fresh, [
      '--sandbox', 'read-only', '--ask-for-approval', 'on-request', '-mold', '-cmodel_reasoning_effort=high', '--search'
    ], { model: { model: 'gpt-6.1', effort: 'medium' } }, { args: [] });

    expect(compiled.args).toEqual([
      '--model', 'gpt-6.1', '-c', 'model_reasoning_effort=medium',
      '--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--search'
    ]);
  });

  // preserve a configured coupled bypass during a model-only change
  it('does not claim security ownership for a model-only choice', () => {
    const compiled = compileNativeLaunch('codex', fresh, [
      '--dangerously-bypass-approvals-and-sandbox', '--model', 'old'
    ], { model: { model: 'gpt-6.1' }, security: { filesystem: 'inherit', approvals: 'inherit', bypass: 'inherit' } }, { args: [] });

    expect(compiled.args).toEqual(['--model', 'gpt-6.1', '--dangerously-bypass-approvals-and-sandbox']);
  });

  // split a configured coupled bypass into the untouched restrictive axes
  it('defeats a configured bypass while preserving its untouched approval behavior', () => {
    const compiled = compileNativeLaunch('codex', fresh, [
      '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-6'
    ], { security: { filesystem: 'read-only', approvals: 'inherit', bypass: 'inherit' } }, { args: [] });

    expect(compiled.args).toEqual([
      '--sandbox', 'read-only', '--ask-for-approval', 'never', '--model', 'gpt-6'
    ]);
  });

  // remove generic native security overrides owned by a restrictive selection
  it('normalizes generic Codex security overrides without touching literal tails', () => {
    const compiled = compileNativeLaunch('codex', fresh, [
      '-c', 'sandbox_mode="danger-full-access"', '--config=approval_policy=never', '--', '--sandbox', 'literal'
    ], { security: { filesystem: 'read-only', approvals: 'on-request', bypass: 'inherit' } }, { args: [] });

    expect(compiled.args).toEqual([
      '--sandbox', 'read-only', '--ask-for-approval', 'on-request', '--', '--sandbox', 'literal'
    ]);
  });

  // remove wrapper shortcuts and attached duplicates before resume positionals
  it('normalizes hostile OMX short forms in exact-resume grammar', () => {
    const input: LaunchInput = { mode: 'resume', conversationId: 'conversation-1', cwd: '/repo', sandboxed: false };
    const compiled = compileNativeLaunch('omx', input, [
      '--madmax', '--yolo', '-sold', '-aon-request', '-mold', '-cmodel=older', '--search'
    ], {
      model: { model: 'gpt-6.1', effort: 'high' },
      security: { filesystem: 'workspace-write', approvals: 'on-request', bypass: 'inherit' }
    }, { args: ['--direct', 'resume', 'conversation-1'] });

    expect(compiled.args).toEqual([
      '--direct', 'resume', '--model', 'gpt-6.1', '-c', 'model_reasoning_effort=high',
      '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', 'conversation-1', '--search'
    ]);
  });

  // retain Claude permission behavior during a model-only override
  it('keeps Claude permissions and settings while replacing model flags', () => {
    const input: LaunchInput = { mode: 'continue', cwd: '/repo', sandboxed: false };
    const compiled = compileNativeLaunch('claude', input, [
      '--permission-mode', 'acceptEdits', '--model=old', '--effort', 'low', '--verbose'
    ], { model: { model: 'opus', effort: 'high' }, security: { permissions: 'inherit' } }, { args: ['--continue', '--settings', '/tmp/hooks.json'] });

    expect(compiled.args).toEqual([
      '--continue', '--model', 'opus', '--effort', 'high', '--settings', '/tmp/hooks.json',
      '--permission-mode', 'acceptEdits', '--verbose'
    ]);
  });

  // advertise only controls proven by installed native help
  it('fails closed for unproven native security and keeps Pi sandbox-only', () => {
    expect(nativeSecurityManifest('codex')).toMatchObject({ status: 'unsupported', controls: [] });
    expect(nativeSecurityManifest('codex', { filesystem: true, approvals: true, bypass: true })).toMatchObject({
      status: 'ready',
      defaults: { filesystem: 'inherit', approvals: 'inherit', bypass: 'inherit' }
    });
    expect(nativeSecurityManifest('pi').controls.map(control => control.id)).toEqual(['sandbox']);
  });
});
