// retain only the latest observed signed lease for each bounded remote artifact owner
export class RemoteArtifactLeaseTracker {
  private readonly leases = new Map<string, { lease: string; issuedAt: number; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now, private readonly capacity = 64) {}

  // refuse out-of-order replacement proofs without reviving an older voice lease
  observe(owner: string, lease: string, issuedAt: number, expiresAt: number): boolean {
    this.prune();
    // only live finite signed issuance windows can fence a remote stream
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt <= issuedAt) return false;
    const previous = this.leases.get(owner);
    // equal-time conflicting leases are ambiguous and fail closed until a newer proof
    if (previous !== undefined && (issuedAt < previous.issuedAt || issuedAt === previous.issuedAt && lease !== previous.lease)) return false;
    // bounded admission never evicts another owner's live proof
    if (previous === undefined && this.leases.size >= this.capacity) return false;
    this.leases.set(owner, { lease, issuedAt, expiresAt: previous?.lease === lease ? Math.max(previous.expiresAt, expiresAt) : expiresAt });
    return true;
  }

  // a signed old lease cannot cancel or authorize a newer lease's private stage
  active(owner: string, lease: string | undefined): boolean {
    this.prune();
    return lease !== undefined && this.leases.get(owner)?.lease === lease;
  }

  // expire only dead proofs before admitting new owners
  private prune(): void {
    // preserve all unexpired proofs and their monotonic fencing evidence
    for (const [owner, proof] of this.leases) if (proof.expiresAt <= this.now()) this.leases.delete(owner);
  }
}
