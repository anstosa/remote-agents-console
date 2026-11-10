type NotificationJournalStage = 'worker_received' | 'show_started' | 'show_succeeded' | 'show_failed' | 'page_resumed' | 'reconciled';

type NotificationJournalRecord = {
  id: string;
  stage: NotificationJournalStage;
  at: number;
  eventId?: string;
  eventEpoch?: string;
  eventSequence?: number;
  kind?: string;
  endpointFingerprint?: string;
  status?: string;
  attempt?: number;
};

type JournalRequest = (url: string, init?: RequestInit) => Promise<Response>;

const databaseName = 'rac-notification-diagnostics';
const storeName = 'events';
const databaseVersion = 1;
const maxRecords = 200;
const maxAgeMs = 7 * 24 * 60 * 60 * 1_000;
const safeValue = /^[A-Za-z0-9._:@-]{1,128}$/u;
const stages = new Set<NotificationJournalStage>(['worker_received', 'show_started', 'show_succeeded', 'show_failed', 'page_resumed', 'reconciled']);
const journalKeys = new Set(['id', 'stage', 'at', 'eventId', 'eventEpoch', 'eventSequence', 'kind', 'endpointFingerprint', 'status', 'attempt']);
let fallbackId = 0;

// open the bounded browser journal
const openJournal = async (): Promise<IDBDatabase | undefined> => {
  // degrade without blocking notifications
  if (!('indexedDB' in window)) return undefined;
  return await new Promise(resolve => {
    const request = indexedDB.open(databaseName, databaseVersion);
    // create the fixed v1 store once
    request.onupgradeneeded = () => {
      // avoid replacing an existing store during retries
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
};

// await one indexeddb request without surfacing storage errors
const idbResult = async <T>(request: IDBRequest<T>): Promise<T | undefined> => await new Promise(resolve => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => resolve(undefined);
});

// await one transaction without surfacing storage errors
const transactionDone = async (transaction: IDBTransaction): Promise<boolean> => await new Promise(resolve => {
  transaction.oncomplete = () => resolve(true);
  transaction.onabort = () => resolve(false);
  transaction.onerror = () => resolve(false);
});

// create a content-free bounded record id
const journalId = (): string => {
  // prefer collision-resistant browser ids
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  fallbackId += 1;
  return `page-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
};

// retain only allowlisted bounded diagnostic fields
const journalRecord = (stage: NotificationJournalStage, fields: Omit<NotificationJournalRecord, 'id' | 'stage' | 'at'>): NotificationJournalRecord => {
  const record: NotificationJournalRecord = { id: journalId(), stage, at: Date.now() };
  // copy only safe opaque strings
  for (const key of ['eventId', 'eventEpoch', 'kind', 'endpointFingerprint', 'status'] as const) {
    const value = fields[key];
    // discard absent or content-bearing values
    if (typeof value === 'string' && safeValue.test(value)) record[key] = value;
  }
  // retain only positive safe event ordering
  if (Number.isSafeInteger(fields.eventSequence) && (fields.eventSequence ?? 0) > 0) record.eventSequence = fields.eventSequence;
  // retain only positive bounded attempts
  if (Number.isSafeInteger(fields.attempt) && (fields.attempt ?? 0) > 0 && (fields.attempt ?? 0) <= 3) record.attempt = fields.attempt;
  return record;
};

// validate and strip one journal record before upload
const validatedJournalRecord = (value: unknown): NotificationJournalRecord | undefined => {
  // require one exact allowlisted record shape
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !journalKeys.has(key))) return undefined;
  const record = value as Partial<NotificationJournalRecord>;
  // require bounded identity and stage fields
  if (typeof record.id !== 'string' || !safeValue.test(record.id) || typeof record.stage !== 'string' || !stages.has(record.stage as NotificationJournalStage) || !Number.isSafeInteger(record.at) || (record.at ?? 0) <= 0) return undefined;
  // reject malformed optional strings
  for (const key of ['eventId', 'eventEpoch', 'kind', 'endpointFingerprint', 'status'] as const) {
    const field = record[key];
    // keep absent strings optional
    if (field !== undefined && (typeof field !== 'string' || !safeValue.test(field))) return undefined;
  }
  // reject malformed optional ordering and attempts
  if (record.eventSequence !== undefined && (!Number.isSafeInteger(record.eventSequence) || record.eventSequence <= 0)) return undefined;
  if (record.attempt !== undefined && (!Number.isSafeInteger(record.attempt) || record.attempt <= 0 || record.attempt > 3)) return undefined;
  return record as NotificationJournalRecord;
};

// append one page diagnostic without gating visible behavior
export const recordNotificationJournal = async (stage: NotificationJournalStage, fields: Omit<NotificationJournalRecord, 'id' | 'stage' | 'at'> = {}): Promise<void> => {
  try {
    const database = await openJournal();
    // ignore unavailable private storage
    if (database === undefined) return;
    const transaction = database.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const existing = await idbResult(store.getAll()) as NotificationJournalRecord[] | undefined;
    const cutoff = Date.now() - maxAgeMs;
    const retained = (existing ?? []).filter(record => Number.isSafeInteger(record.at) && record.at >= cutoff).sort((left, right) => left.at - right.at);
    const overflowIds = new Set(retained.slice(0, Math.max(0, retained.length - maxRecords + 1)).map(record => record.id));
    // prune expired records and the oldest retained overflow
    for (const record of existing ?? []) {
      const expired = !Number.isSafeInteger(record.at) || record.at < cutoff;
      // delete only records selected by retention
      if (expired || overflowIds.has(record.id)) store.delete(record.id);
    }
    store.put(journalRecord(stage, fields));
    await transactionDone(transaction);
    database.close();
  } catch { /* diagnostics never gate notification behavior */ }
};

// flush one bounded journal batch after authentication
export const flushNotificationJournal = async (request: JournalRequest): Promise<void> => {
  try {
    const database = await openJournal();
    // retain records when storage is unavailable
    if (database === undefined) return;
    const readTransaction = database.transaction(storeName, 'readonly');
    const records = await idbResult(readTransaction.objectStore(storeName).getAll()) as NotificationJournalRecord[] | undefined;
    await transactionDone(readTransaction);
    const batch = (records ?? []).map(validatedJournalRecord).filter((record): record is NotificationJournalRecord => record !== undefined && record.at >= Date.now() - maxAgeMs).sort((left, right) => left.at - right.at).slice(0, 100);
    // avoid an empty receipt mutation
    if (batch.length === 0) { database.close(); return; }
    const response = await request('/api/push/receipts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: batch }) });
    // retain the exact batch after any rejected upload
    if (!response.ok) { database.close(); return; }
    const deleteTransaction = database.transaction(storeName, 'readwrite');
    const store = deleteTransaction.objectStore(storeName);
    // delete only ids accepted in this request
    for (const record of batch) store.delete(record.id);
    await transactionDone(deleteTransaction);
    database.close();
  } catch { /* upload errors leave the bounded journal intact */ }
};
