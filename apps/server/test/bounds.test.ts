import { describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import { AuthService } from '../src/auth/service.js';
import { TicketStore } from '../src/auth/tickets.js';

describe('bounded ephemeral authorization state', () => {
  it('prunes expired and caps pre-authentication CSRF tokens', async () => {
    let now = 0;
    const auth = new AuthService(await argon2.hash('synthetic-password', { type: argon2.argon2id }), Buffer.alloc(32, 1).toString('base64url'), () => now);
    for (let index = 0; index < 1_025; index++) auth.bootstrap();
    const preauth = (auth as unknown as { preauth: Map<string, number> }).preauth;
    expect(preauth.size).toBe(1_024);
    now = 300_001; auth.bootstrap();
    expect(preauth.size).toBe(1);
  }, 15_000);
  it('prunes expired and caps one-time WebSocket tickets', () => {
    let now = 0; const tickets = new TicketStore(() => now);
    for (let index = 0; index < 2_049; index++) tickets.mint('session', 'panes', 'target');
    const values = (tickets as unknown as { tickets: Map<string, unknown> }).tickets;
    expect(values.size).toBe(2_048);
    now = 30_001; tickets.mint('session', 'panes', 'target');
    expect(values.size).toBe(1);
  });
});
