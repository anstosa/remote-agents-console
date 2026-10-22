// reserve browser ownership independently of its live connection lease
export class ControlService {
  private owner?: { sessionId: string; expires: number };

  // allow deterministic lease checks
  constructor(private readonly now: () => number = Date.now, private readonly leaseMs = 15_000) {}

  // optionally admit the first browser or reconnect the reserved owner
  connect(sessionId: string, allowInitial = false): boolean {
    // passive restores must not claim an unowned console
    if (this.owner === undefined && !allowInitial) return false;
    // another browser requires explicit takeover even after inactivity
    if (this.owner !== undefined && this.owner.sessionId !== sessionId) return false;
    this.take(sessionId);
    return true;
  }

  // replace ownership only through an explicit handoff or initial admission
  take(sessionId: string): void { this.owner = { sessionId, expires: this.now() + this.leaseMs }; }

  // expired reservations never grant settings or integration authority
  ownerSessionId(): string | undefined { return this.owner !== undefined && this.owner.expires > this.now() ? this.owner.sessionId : undefined; }

  // renew only a live lease without reviving an expired connection
  active(sessionId: string): boolean {
    // deny displaced and expired connections
    if (this.owner === undefined || this.owner.sessionId !== sessionId || this.owner.expires <= this.now()) return false;
    this.owner.expires = this.now() + this.leaseMs;
    return true;
  }

  // explicit owner logout clears even an expired reservation
  release(sessionId: string): void {
    // a displaced browser cannot release another owner's reservation
    if (this.owner?.sessionId === sessionId) this.owner = undefined;
  }
}
