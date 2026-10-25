import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { createSessionId } from './session-id.js';
export type Session = { id: string; csrf: string };
const token = () => randomBytes(32).toString('base64url');
export class AuthService {
  private preauth = new Map<string, number>();
  constructor(private readonly passwordHash: string, private readonly secret: string, private readonly now: () => number = Date.now) {
    if (!passwordHash.startsWith('$argon2id$')) throw new Error('RAC_PASSWORD_HASH must be an Argon2id hash');
    if (Buffer.from(secret, 'base64url').length < 32) throw new Error('RAC_SESSION_SECRET must contain at least 32 bytes');
  }
  private prunePreauth(): void { const now = this.now(); for (const [value, expires] of this.preauth) if (expires < now) this.preauth.delete(value); while (this.preauth.size >= 1_024) this.preauth.delete(this.preauth.keys().next().value!); }
  bootstrap(): string { this.prunePreauth(); const value = token(); this.preauth.set(value, this.now() + 300_000); return value; }
  // issue browser identities from the same contract used by durable ownership
  async login(password: string, preauth: string): Promise<Session | undefined> { const expiry = this.preauth.get(preauth); this.preauth.delete(preauth); if (!expiry || expiry < this.now()) return undefined; const ok = await argon2.verify(this.passwordHash, password).catch(() => false); return ok ? { id: createSessionId(), csrf: token() } : undefined; }
  get(session: Session | undefined): Session | undefined { return session; }
  logout(_id?: string): void { /* persistent signed sessions are cleared by the browser cookie */ }
  sign(session: Session): string { const payload = `${session.id}.${session.csrf}`; const mac = createHmac('sha256', this.secret).update(payload).digest('base64url'); return `${payload}.${mac}`; }
  unsign(value?: string): Session | undefined { if (!value) return undefined; const [id, csrf, mac, ...extra] = value.split('.'); if (!id || !csrf || !mac || extra.length) return undefined; const payload = `${id}.${csrf}`; const expected = createHmac('sha256', this.secret).update(payload).digest('base64url'); if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return undefined; return { id, csrf }; }
  csrf(session: Session, candidate?: string): boolean { return !!candidate && candidate.length === session.csrf.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(session.csrf)); }
}
