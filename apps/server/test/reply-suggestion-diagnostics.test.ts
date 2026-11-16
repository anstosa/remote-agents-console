import { describe, expect, it } from 'vitest';
import { nativeFailureReason, ReplySuggestionDiagnostics } from '../src/reply-suggestions/diagnostics.js';

// diagnostics are deliberately incapable of retaining private source or native text
describe('reply suggestion private diagnostics', () => {
  // async lifecycle records share admission correlation without accepting caller ids
  it('correlates one request across asynchronous lifecycle records', async () => {
    const diagnostics = new ReplySuggestionDiagnostics();
    await diagnostics.request(async () => {
      diagnostics.record('admitted');
      await Promise.resolve();
      diagnostics.record('denied');
    });
    await diagnostics.request(async () => { diagnostics.record('admitted'); });
    const events = diagnostics.snapshot().recent;
    expect(events[0]!.correlation).toBe(events[1]!.correlation);
    expect(events[0]!.correlation).not.toBe(events[2]!.correlation);
    expect(Object.keys(events[0]!).sort()).toEqual(['correlation', 'kind', 'reason', 'transport']);
  });

  // extra input properties and unknown labels never cross the sink
  it('retains only bounded closed labels and independent correlations', () => {
    const diagnostics = new ReplySuggestionDiagnostics();
    const source = { kind: 'claude' as const, transport: 'tmux' as const, sourceKey: 'SECRET_SOURCE', text: 'SECRET_PROMPT', account: 'SECRET_ACCOUNT', path: '/SECRET_PATH', env: 'SECRET_ENV', argv: 'SECRET_ARGV' };
    // exercise retention beyond the bounded ring
    for (let index = 0; index < 100; index += 1) diagnostics.record('success', source);
    diagnostics.record('SECRET_REASON' as never, source);
    const snapshot = diagnostics.snapshot();
    expect(snapshot.recent).toHaveLength(64);
    expect(snapshot.counters).toEqual({ 'claude:tmux:success': 100 });
    expect(JSON.stringify(snapshot)).not.toContain('SECRET');
    expect(new Set(snapshot.recent.map(event => event.correlation)).size).toBe(64);
    snapshot.recent[0]!.reason = 'timeout';
    expect(diagnostics.snapshot().recent[0]!.reason).toBe('success');
  });

  // machine codes are classified without copying even unexpected raw errors
  it('classifies native failures without preserving raw values', () => {
    expect(nativeFailureReason('codex_model_rerouted')).toBe('reroute');
    expect(nativeFailureReason('native_credential_scope_invalid')).toBe('auth_unavailable');
    expect(nativeFailureReason('codex_helper_cleanup_failed')).toBe('cleanup_failure');
    expect(nativeFailureReason('native_timeout_or_cancelled')).toBe('timeout');
    expect(nativeFailureReason('/private/SECRET_TOKEN raw output')).toBe('invalid_output');
  });
});
