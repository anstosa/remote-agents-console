import { randomBytes } from 'node:crypto';
export type TicketKind = 'dashboard'|'panes'|'files-download';
export type Ticket = { id: string; sessionId: string; kind: TicketKind; target: string; expires: number };

// hold bounded single-use capabilities for authenticated browser streams
export class TicketStore {
  private tickets = new Map<string, Ticket>();

  // allow deterministic expiry checks in tests
  constructor(private readonly now: () => number = Date.now) {}

  // expire capabilities and reserve room for the next ticket
  private prune(): void {
    const now = this.now();
    // discard expired tickets
    for (const [id, ticket] of this.tickets) {
      // retain tickets until their expiry boundary
      if (ticket.expires < now) this.tickets.delete(id);
    }
    // evict oldest capabilities at the registry bound
    while (this.tickets.size >= 2_048) this.tickets.delete(this.tickets.keys().next().value!);
  }

  // bind a short-lived capability to one session and target
  mint(sessionId: string, kind: TicketKind, target: string): Ticket {
    this.prune();
    const ticket = { id: randomBytes(24).toString('base64url'), sessionId, kind, target, expires: this.now() + 30_000 };
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  // consume even invalid attempts so capabilities cannot be replayed
  consume(id: string, sessionId: string, kind: TicketKind, target: string): boolean {
    this.prune();
    const ticket = this.tickets.get(id);
    this.tickets.delete(id);
    return !!ticket && ticket.expires >= this.now() && ticket.sessionId === sessionId && ticket.kind === kind && ticket.target === target;
  }
}
