import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ReplySuggestionSource } from './types.js';

export type ReplySuggestionReason = 'admitted' | 'denied' | 'generation_failed' | 'source_unavailable' | 'selection_unavailable' | 'auth_unavailable' | 'capability_unavailable' | 'reroute' | 'stale' | 'capacity' | 'timeout' | 'invalid_output' | 'cleanup_failure' | 'success';
type Kind = ReplySuggestionSource['kind'] | 'unknown';
type Transport = ReplySuggestionSource['transport'] | 'unknown';
type Observation = { correlation: string; kind: Kind; transport: Transport; reason: ReplySuggestionReason };
const reasons = new Set<ReplySuggestionReason>(['admitted', 'denied', 'generation_failed', 'source_unavailable', 'selection_unavailable', 'auth_unavailable', 'capability_unavailable', 'reroute', 'stale', 'capacity', 'timeout', 'invalid_output', 'cleanup_failure', 'success']);

// retain bounded process-local content-free diagnostics rather than raw native failures
export class ReplySuggestionDiagnostics {
  private readonly counters = new Map<string, number>();
  private readonly recent: Observation[] = [];
  private readonly correlations = new AsyncLocalStorage<string>();

  // one private admission context follows asynchronous lifecycle events without source ids
  request<T>(work: () => Promise<T>): Promise<T> {
    return this.correlations.run(randomUUID(), work);
  }

  // accept only closed labels and create correlation independently of source identifiers
  record(reason: ReplySuggestionReason, source?: Pick<ReplySuggestionSource, 'kind' | 'transport'>): void {
    if (!reasons.has(reason)) return;
    const kind: Kind = source !== undefined && ['pi', 'codex', 'omx', 'claude'].includes(source.kind) ? source.kind : 'unknown';
    const transport: Transport = source !== undefined && ['tmux', 'structured'].includes(source.transport) ? source.transport : 'unknown';
    const key = `${kind}:${transport}:${reason}`;
    this.counters.set(key, Math.min(Number.MAX_SAFE_INTEGER, (this.counters.get(key) ?? 0) + 1));
    this.recent.push({ correlation: this.correlations.getStore() ?? randomUUID(), kind, transport, reason });
    this.recent.splice(0, Math.max(0, this.recent.length - 64));
  }

  // return detached safe labels only for private diagnostics and verification
  snapshot(): { counters: Record<string, number>; recent: Observation[] } {
    return { counters: Object.fromEntries(this.counters), recent: this.recent.map(item => ({ ...item })) };
  }
}

export const replySuggestionDiagnostics = new ReplySuggestionDiagnostics();

// classify only fixed worker codes without retaining any raw diagnostic value
export function nativeFailureReason(code: string | undefined): ReplySuggestionReason {
  if (['claude_account_changed_before_inference', 'claude_account_mismatch', 'claude_postflight_failed', 'codex_account_changed_before_inference', 'codex_account_or_provider_mismatch', 'native_auth_link_mismatch', 'native_credential_scope_invalid'].includes(code ?? '')) return 'auth_unavailable';
  if (['claude_helper_cleanup_failed', 'codex_helper_cleanup_failed'].includes(code ?? '')) return 'cleanup_failure';
  if (['native_socket_timeout', 'native_timeout_or_cancelled', 'codex_protocol_cancelled'].includes(code ?? '')) return 'timeout';
  if (['codex_model_rerouted', 'claude_model_or_tool_mismatch', 'claude_model_usage_mismatch'].includes(code ?? '')) return 'reroute';
  if (['native_scope_changed', 'native_cross_kind_route'].includes(code ?? '')) return 'stale';
  if (['codex_model_selection_unavailable', 'native_selection_invalid'].includes(code ?? '')) return 'selection_unavailable';
  if (['native_version_mismatch', 'codex_catalog_unavailable', 'codex_feature_inventory_mismatch', 'claude_init_policy_mismatch'].includes(code ?? '')) return 'capability_unavailable';
  return 'invalid_output';
}
