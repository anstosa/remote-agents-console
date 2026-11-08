import { describe, expect, it } from 'vitest';
import { TicketStore } from '../src/auth/tickets.js';

// constrain download capabilities without changing existing stream tickets
describe('files download tickets', () => {
  // reject replay after a successful download authorization
  it('binds a single use to the preparing session and manifest', () => {
    const tickets = new TicketStore(() => 1_000);
    const ticket = tickets.mint('session', 'files-download', 'manifest');
    expect(ticket.expires).toBe(31_000);
    expect(tickets.consume(ticket.id, 'session', 'files-download', 'manifest')).toBe(true);
    expect(tickets.consume(ticket.id, 'session', 'files-download', 'manifest')).toBe(false);
  });

  // isolate ticket kinds and reject attempts from another session or target
  it('consumes invalid attempts without granting another scope', () => {
    const tickets = new TicketStore(() => 1_000);
    const wrongSession = tickets.mint('session', 'files-download', 'manifest');
    expect(tickets.consume(wrongSession.id, 'other', 'files-download', 'manifest')).toBe(false);
    expect(tickets.consume(wrongSession.id, 'session', 'files-download', 'manifest')).toBe(false);
    const wrongTarget = tickets.mint('session', 'files-download', 'manifest');
    expect(tickets.consume(wrongTarget.id, 'session', 'files-download', 'other')).toBe(false);
    const wrongKind = tickets.mint('session', 'panes', 'manifest');
    expect(tickets.consume(wrongKind.id, 'session', 'files-download', 'manifest')).toBe(false);
  });

  // enforce the thirty-second authorization window
  it('rejects expired tickets', () => {
    let now = 1_000;
    const tickets = new TicketStore(() => now);
    const ticket = tickets.mint('session', 'files-download', 'manifest');
    now = 31_001;
    expect(tickets.consume(ticket.id, 'session', 'files-download', 'manifest')).toBe(false);
  });
});
