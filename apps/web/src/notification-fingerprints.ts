type UpdateFingerprintRecord = {
  version: 1;
  scope: string;
  agents: Record<string, string>;
  rac?: string;
};

const storageKey = 'rac.notification-update-fingerprints.v1';
const maxStorageLength = 4_096;
const safeFingerprint = /^[A-Za-z0-9.+:@_>/-]{1,256}$/u;
const safeScope = /^[^\u0000-\u001f\u007f]{1,512}$/u;
let memoryRecord: UpdateFingerprintRecord = { version: 1, scope: '', agents: {} };
const maxPendingFingerprints = 128;
let pendingSequence = 0;
const pendingFingerprints = new Map<string, { fingerprint: string; token: number }>();

export type UpdateFingerprintReservation = { slot: string; fingerprint: string; token: number };

// validate one fixed-kind fingerprint record
const parseRecord = (encoded: string, agentKinds: readonly string[]): UpdateFingerprintRecord | undefined => {
  // reject oversized storage before parsing
  if (encoded.length > maxStorageLength) return undefined;
  try {
    const value: unknown = JSON.parse(encoded);
    // require the versioned record shape
    if (value === null || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return undefined;
    const agents = (value as { agents?: unknown }).agents;
    const rac = (value as { rac?: unknown }).rac;
    const scope = (value as { scope?: unknown }).scope;
    // accept only fixed agent keys and bounded fingerprints
    if (typeof scope !== 'string' || !safeScope.test(scope) || agents === null || typeof agents !== 'object' || Array.isArray(agents)) return undefined;
    const entries = Object.entries(agents);
    // reject unknown or malformed agent fields
    if (entries.some(([kind, fingerprint]) => !agentKinds.includes(kind) || typeof fingerprint !== 'string' || !safeFingerprint.test(fingerprint))) return undefined;
    // reject malformed rac fields
    if (rac !== undefined && (typeof rac !== 'string' || !safeFingerprint.test(rac))) return undefined;
    return { version: 1, scope, agents: Object.fromEntries(entries), ...(rac === undefined ? {} : { rac }) };
  } catch { return undefined; }
};

// read a valid record or reset corrupt storage
const readRecord = (scope: string, agentKinds: readonly string[]): UpdateFingerprintRecord => {
  const empty: UpdateFingerprintRecord = { version: 1, scope, agents: {} };
  // refuse an unsafe server scope
  if (!safeScope.test(scope)) return empty;
  try {
    const encoded = localStorage.getItem(storageKey);
    // initialize empty storage from the in-memory fallback
    if (encoded === null) return memoryRecord.scope === scope ? memoryRecord : empty;
    const parsed = parseRecord(encoded, agentKinds);
    // reset corrupt storage without suppressing a new update
    if (parsed === undefined) { localStorage.removeItem(storageKey); memoryRecord = empty; return memoryRecord; }
    // isolate announcements across configured server identities
    if (parsed.scope !== scope) { memoryRecord = empty; return memoryRecord; }
    memoryRecord = parsed;
  } catch { /* retain in-memory behavior when storage is unavailable */ }
  return memoryRecord;
};

// persist one bounded record while retaining memory on failure
const writeRecord = (record: UpdateFingerprintRecord): void => {
  memoryRecord = record;
  try {
    const encoded = JSON.stringify(record);
    // never write an unbounded record
    if (encoded.length <= maxStorageLength) localStorage.setItem(storageKey, encoded);
  } catch { /* retain in-memory behavior when storage is unavailable */ }
};

// reserve one changed fingerprint without durable commitment
const reserveFingerprint = (slot: string, fingerprint: string): UpdateFingerprintReservation | undefined => {
  const pending = pendingFingerprints.get(slot);
  // coalesce concurrent discovery of one target
  if (pending?.fingerprint === fingerprint) return undefined;
  pendingSequence += 1;
  const reservation = { slot, fingerprint, token: pendingSequence };
  // move a replaced slot to the newest bounded position
  pendingFingerprints.delete(slot);
  pendingFingerprints.set(slot, reservation);
  // retain a bounded set when displays stall indefinitely
  while (pendingFingerprints.size > maxPendingFingerprints) {
    const oldest = pendingFingerprints.keys().next().value as string | undefined;
    // stop if the map unexpectedly has no first key
    if (oldest === undefined) break;
    pendingFingerprints.delete(oldest);
  }
  return reservation;
};

// release only the exact still-current reservation
export const releaseUpdateFingerprint = (reservation: UpdateFingerprintReservation): void => {
  const pending = pendingFingerprints.get(reservation.slot);
  // preserve a newer concurrent target
  if (pending?.token !== reservation.token || pending.fingerprint !== reservation.fingerprint) return;
  pendingFingerprints.delete(reservation.slot);
};

// reserve one changed agent update fingerprint
export const reserveAgentUpdateFingerprint = (scope: string, kind: string, fingerprint: string, agentKinds: readonly string[]): UpdateFingerprintReservation | undefined => {
  // ignore unknown kinds or malformed targets
  if (!safeScope.test(scope) || !agentKinds.includes(kind) || !safeFingerprint.test(fingerprint)) return undefined;
  const record = readRecord(scope, agentKinds);
  // suppress an unchanged target across reloads
  if (record.agents[kind] === fingerprint) return undefined;
  return reserveFingerprint(`agent\u0000${scope}\u0000${kind}`, fingerprint);
};

// commit one successfully displayed agent fingerprint
export const commitAgentUpdateFingerprint = (scope: string, kind: string, reservation: UpdateFingerprintReservation, agentKinds: readonly string[]): boolean => {
  const pending = pendingFingerprints.get(reservation.slot);
  // refuse a stale or evicted display result
  if (pending?.token !== reservation.token || pending.fingerprint !== reservation.fingerprint) return false;
  const record = readRecord(scope, agentKinds);
  writeRecord({ ...record, agents: { ...record.agents, [kind]: reservation.fingerprint } });
  pendingFingerprints.delete(reservation.slot);
  return true;
};

// clear one resolved agent update fingerprint
export const clearAgentUpdateFingerprint = (scope: string, kind: string, agentKinds: readonly string[]): void => {
  pendingFingerprints.delete(`agent\u0000${scope}\u0000${kind}`);
  const record = readRecord(scope, agentKinds);
  // skip unchanged storage
  if (!(kind in record.agents)) return;
  const agents = { ...record.agents };
  delete agents[kind];
  writeRecord({ ...record, agents });
};

// reserve one changed rac update fingerprint
export const reserveRacUpdateFingerprint = (scope: string, fingerprint: string, agentKinds: readonly string[]): UpdateFingerprintReservation | undefined => {
  // ignore malformed targets
  if (!safeScope.test(scope) || !safeFingerprint.test(fingerprint)) return undefined;
  const record = readRecord(scope, agentKinds);
  // suppress an unchanged target across reloads
  if (record.rac === fingerprint) return undefined;
  return reserveFingerprint(`rac\u0000${scope}`, fingerprint);
};

// commit one successfully displayed rac fingerprint
export const commitRacUpdateFingerprint = (scope: string, reservation: UpdateFingerprintReservation, agentKinds: readonly string[]): boolean => {
  const pending = pendingFingerprints.get(reservation.slot);
  // refuse a stale or evicted display result
  if (pending?.token !== reservation.token || pending.fingerprint !== reservation.fingerprint) return false;
  const record = readRecord(scope, agentKinds);
  writeRecord({ ...record, rac: reservation.fingerprint });
  pendingFingerprints.delete(reservation.slot);
  return true;
};

// clear the resolved rac update fingerprint
export const clearRacUpdateFingerprint = (scope: string, agentKinds: readonly string[]): void => {
  pendingFingerprints.delete(`rac\u0000${scope}`);
  const record = readRecord(scope, agentKinds);
  // skip unchanged storage
  if (record.rac === undefined) return;
  const { rac: _rac, ...rest } = record;
  writeRecord(rest);
};
