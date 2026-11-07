const names = ['generation_advances', 'expired_requests', 'provider_hangups', 'provider_quarantines', 'privacy_faults', 'readiness_checks', 'admitted_inputs', 'stale_events_rejected', 'capability_replays', 'external_divergence', 'publication_unknown', 'choices', 'remote_receipts', 'remote_rebinds', 'remote_rejections', 'receipt_resigns', 'outbox_attempts', 'outbox_ambiguous', 'seed_fallbacks', 'compactions'] as const;
export type DavoMetric = typeof names[number];

// retain content-free process-local counters with a closed key set
export class DavoMetrics {
  private readonly counts = Object.fromEntries(names.map(name => [name, 0])) as Record<DavoMetric, number>;

  // saturate bounded aggregate counts without accepting metadata
  count(name: DavoMetric, amount = 1): void {
    // ignore malformed quantities rather than storing arbitrary values
    if (!Number.isSafeInteger(amount) || amount < 0) return;
    this.counts[name] = Math.min(Number.MAX_SAFE_INTEGER, this.counts[name] + amount);
  }

  // expose a detached aggregate projection only
  snapshot(): Record<DavoMetric, number> { return { ...this.counts }; }
}
