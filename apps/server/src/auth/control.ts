import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { serverCheckout } from '../workspaces/server-checkout.js';
import { isSessionId } from './session-id.js';

type StoredControl = { version: 1; ownerSessionId: string | null };

// recognize only the supported ownership record without extra fields
const isStoredControl = (value: unknown): value is StoredControl => {
  // reject non-record values before inspecting fields
  if (value === null || typeof value !== 'object') return false;
  // retain the exact persisted schema
  if (Object.keys(value).sort().join(',') !== 'ownerSessionId,version') return false;
  // narrow the version and owner fields before validating the identity
  if (!('version' in value) || value.version !== 1 || !('ownerSessionId' in value)) return false;
  return value.ownerSessionId === null || isSessionId(value.ownerSessionId);
};

// reserve browser ownership independently of its live connection lease
export class ControlService {
  private owner?: { sessionId: string; expires: number; generation: string };
  private file?: string;
  private mutation = Promise.resolve();

  // allow deterministic lease checks
  constructor(private readonly now: () => number = Date.now, private readonly leaseMs = 15_000) {}

  // restore ownership without restoring a live connection or integration authority
  static async persisted(file = join(serverCheckout(), '.data/control-owner.json'), now: () => number = Date.now, leaseMs = 15_000): Promise<ControlService> {
    const control = new ControlService(now, leaseMs);
    control.file = file;
    const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
      // only a missing record represents an unowned console
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    // a new installation still requires sign-in or explicit takeover
    if (handle === undefined) return control;
    try {
      const info = await handle.stat();
      // reject corrupt or oversized records instead of forgetting the owner
      if (!info.isFile() || info.size > 1_024) throw new Error('Invalid console control state');
      const stored: unknown = JSON.parse(await handle.readFile('utf8'));
      // accept only the supported ownership record
      if (!isStoredControl(stored)) throw new Error('Invalid console control state');
      // a restored owner must reconnect before using a live lease
      if (stored.ownerSessionId !== null) control.owner = { sessionId: stored.ownerSessionId, expires: 0, generation: randomUUID() };
      return control;
    } finally {
      await handle.close();
    }
  }

  // reconnect only the reserved owner without writing connection heartbeats
  connect(sessionId: string): boolean {
    // passive restores never acquire unowned or displaced control
    if (this.owner?.sessionId !== sessionId) return false;
    this.owner.expires = this.now() + this.leaseMs;
    return true;
  }

  // admit a signed-in browser only while ownership is unclaimed
  async claimInitial(sessionId: string): Promise<boolean> {
    return await this.mutate(async () => {
      // serialize first admission with takeovers and logout
      if (this.owner === undefined) {
        await this.write(sessionId);
        this.owner = { sessionId, expires: 0, generation: randomUUID() };
      }
      return this.connect(sessionId);
    });
  }

  // acknowledge explicit handoffs only after durable ownership is replaced
  async take(sessionId: string): Promise<void> {
    await this.mutate(async () => {
      // retain only the unchanged reservation's oauth authority
      const generation = this.owner?.sessionId === sessionId ? this.owner.generation : randomUUID();
      // unchanged ownership needs only a fresh connection lease
      if (this.owner?.sessionId !== sessionId) await this.write(sessionId);
      this.owner = { sessionId, expires: this.now() + this.leaseMs, generation };
    });
  }

  // bind oauth transactions to the reservation rather than its short live lease
  reservationGeneration(sessionId: string): string | undefined { return this.owner?.sessionId === sessionId ? this.owner.generation : undefined; }

  // restore only the unchanged reserved owner without permitting takeover
  renewReservation(sessionId: string, generation: string): boolean {
    // reject retired or displaced reservations even after later lease expiry
    if (this.owner?.sessionId !== sessionId || this.owner.generation !== generation) return false;
    return this.connect(sessionId);
  }

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
  async release(sessionId: string): Promise<void> {
    await this.mutate(async () => {
      // a displaced browser cannot release another owner's reservation
      if (this.owner?.sessionId !== sessionId) return;
      await this.write(null);
      this.owner = undefined;
    });
  }

  // retain request ordering even when a previous ownership write fails
  private mutate<T>(change: () => Promise<T>): Promise<T> {
    const operation = this.mutation.then(change);
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  // atomically replace the private owner record before publishing a handoff
  private async write(ownerSessionId: string | null): Promise<void> {
    // isolated app fixtures do not share persistent state
    if (this.file === undefined) return;
    // reject identities that could not be restored safely
    if (ownerSessionId !== null && !isSessionId(ownerSessionId)) throw new Error('Invalid console control owner');
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const next = `${this.file}.next-${randomUUID()}`;
    try {
      await writeFile(next, JSON.stringify({ version: 1, ownerSessionId }), { mode: 0o600, flag: 'wx' });
      await rename(next, this.file);
    } finally {
      await rm(next, { force: true }).catch(() => undefined);
    }
  }
}
