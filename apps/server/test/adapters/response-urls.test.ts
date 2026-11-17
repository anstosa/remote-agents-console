import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { responseUrlEnvironment, responseUrlSessionHookCommand, withCodexResponseUrlContext } from '../../src/adapters/response-urls.js';
import { compileNativeLaunch } from '../../src/launch/native-options.js';

const origin = 'https://app.example.test:8443';

// execute the actual fixed hook with only explicit test-owned context
function hook(event: string, responseOrigin?: string): string {
  return execFileSync('/bin/sh', ['-c', responseUrlSessionHookCommand], {
    input: JSON.stringify({ hook_event_name: event }),
    env: { PATH: process.env.PATH, ...responseUrlEnvironment(responseOrigin) },
    encoding: 'utf8'
  });
}

describe('persistent response URL context', () => {
  // supported lifecycle events add context without manufacturing a user message
  it.each(['SessionStart', 'SubagentStart'])('supplies additive %s context from the launch environment', event => {
    const result = JSON.parse(hook(event, origin));
    expect(result.hookSpecificOutput.hookEventName).toBe(event);
    expect(result.hookSpecificOutput.additionalContext).toContain(origin);
    expect(result.hookSpecificOutput.additionalContext).toContain('path, query, and fragment');
    expect(result.hookSpecificOutput.additionalContext).toContain('unrelated external URLs');
    expect(result).not.toHaveProperty('prompt');
  });

  // lifecycle hooks must not become a per-query injection mechanism
  it.each(['UserPromptSubmit', 'Stop'])('emits nothing for the %s event', event => {
    expect(hook(event, origin)).toBe('');
  });

  // an originless launch explicitly clears inherited workspace policy
  it('emits nothing without a tunnel and clears inherited context', () => {
    expect(hook('SessionStart')).toBe('');
    expect(responseUrlEnvironment()).toEqual({ RAC_RESPONSE_URL_INSTRUCTIONS: '' });
  });

  // changing the URL does not change native hook definitions or their trust fingerprints
  it('keeps hook commands stable across workspace origins', () => {
    const first = withCodexResponseUrlContext('codex', origin, { args: ['resume', '--last'] });
    const second = withCodexResponseUrlContext('codex', 'https://other.example.test', { args: ['resume', '--last'] });
    expect(first.args).toEqual(second.args);
    expect(first.env).not.toEqual(second.env);
    expect(first.args.join(' ')).not.toContain(origin);
    expect(first.args.join(' ')).not.toContain('trusted_hash');
  });

  // unrelated provider settings and literal native prompt tails retain their exact values
  it('preserves operator instructions and inserts hooks before a literal prompt tail', () => {
    const args = ['--direct', 'resume', '--last', '-c', 'model_instructions_file="/operator/instructions"', '-c', 'developer_instructions="keep operator guidance"', '--', 'literal prompt'];
    const launched = withCodexResponseUrlContext('omx', origin, { args, env: { EXISTING: 'retained' } });
    expect(launched.args.slice(0, 7)).toEqual(args.slice(0, 7));
    expect(launched.args.slice(-2)).toEqual(['--', 'literal prompt']);
    expect(launched.args.filter(argument => argument.startsWith('hooks.'))).toHaveLength(2);
    expect(launched.env?.EXISTING).toBe('retained');
  });

  // merge only the effective operator array and retain its original hook contents
  it.each(['-c', '--config=', '-c='])('adds to existing event arrays using %s', spelling => {
    const value = 'hooks.SessionStart=[{hooks=[{type="command",command="operator-hook"}]}]';
    const args = spelling === '-c' ? [spelling, value] : [`${spelling}${value}`];
    const launched = withCodexResponseUrlContext('codex', origin, { args });
    expect(launched.args.join(' ')).toContain('operator-hook');
    expect(launched.args.join(' ')).toContain('additionalContextLimit');
    expect(launched.args.join(' ')).not.toContain('developer_instructions');
    expect(launched.args.filter(argument => argument.includes('hooks.SessionStart='))).toHaveLength(1);
  });

  // unrelated operator hook events are independent configuration keys
  it('preserves unrelated event hooks', () => {
    const value = 'hooks.Stop=[{hooks=[{type="command",command="operator-stop"}]}]';
    expect(withCodexResponseUrlContext('codex', origin, { args: ['-c', value] }).args).toContain(value);
  });

  // opaque hook replacement is refused rather than silently clobbering operator policy
  it.each(['hooks={SessionStart=[]}', 'hooks.SessionStart="opaque"', 'hooks."SessionStart"=[]'])('refuses unsafe override %s', value => {
    expect(() => withCodexResponseUrlContext('codex', origin, { args: ['-c', value] })).toThrow(/Workspace URL context/u);
  });

  // launch-menu compilation happens before context, so model/security choices cannot drop it
  it.each(['codex', 'omx'] as const)('retains context after %s model and security choices', kind => {
    const compiled = compileNativeLaunch(kind, { mode: 'resume', conversationId: 'conversation' }, ['-c', 'model_instructions_file="/operator/base"'], { model: { model: 'model' }, security: { filesystem: 'read-only', approvals: 'on-request' } }, { args: kind === 'omx' ? ['--direct', 'resume', 'conversation'] : ['resume', 'conversation'] });
    const launched = withCodexResponseUrlContext(kind, origin, compiled);
    expect(launched.args).toContain('conversation');
    expect(launched.args).toContain('read-only');
    expect(launched.args).toContain('model_instructions_file="/operator/base"');
    expect(launched.args.filter(argument => argument.startsWith('hooks.'))).toHaveLength(2);
  });

  // unconfigured workspaces and other adapters retain their existing launch mechanisms
  it('leaves arguments untouched without a tunnel or for another adapter', () => {
    const spec = { args: ['resume', '--last'], env: { EXISTING: 'retained' } };
    expect(withCodexResponseUrlContext('codex', undefined, spec)).toBe(spec);
    expect(withCodexResponseUrlContext('claude', origin, spec)).toBe(spec);
  });
});
