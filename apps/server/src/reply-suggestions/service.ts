import { createHash, randomUUID } from 'node:crypto';
import { messageAsksQuestion } from '../adapters/attention.js';
import type { ReplySuggestion } from '../domain/models.js';
import type { ReplySuggestionSource } from './types.js';
import { replySuggestionDiagnostics } from './diagnostics.js';

type Options = {
  source(id: string): Promise<ReplySuggestionSource | undefined>;
  validate?(source: ReplySuggestionSource, signal: AbortSignal): Promise<boolean>;
  routeFingerprint(source: ReplySuggestionSource): Promise<string | undefined>;
  generate(source: ReplySuggestionSource, signal: AbortSignal, routeFingerprint: string): Promise<ReplySuggestion[]>;
};
type Entry = {
  key: string;
  source: ReplySuggestionSource;
  route: string;
  result?: ReplySuggestion[];
  task?: Promise<ReplySuggestion[]>;
  controller?: AbortController;
  settle?: (result: ReplySuggestion[]) => void;
};
export type ReplySuggestionResult = { status: 'ready'; sourceKey: string; suggestions: ReplySuggestion[] } | { status: 'stale' } | { status: 'denied' };
const maximumAttemptReservations = 1_024;

// retain no conversation content in the semantic spend ledger
function attemptKey(id: string, entry: Entry): string {
  return createHash('sha256').update(JSON.stringify([id, entry.source.identity, entry.route])).digest('base64url');
}

// spend only on explicit demand for one current authorized source
export class ReplySuggestionService {
  private readonly entries = new Map<string, Entry>();
  private readonly epochs = new Map<string, symbol>();
  private readonly reads = new Map<string, Promise<string | undefined>>();
  private readonly attempts = new Map<string, { active: boolean }>();
  private running = 0;
  private stopped = false;

  // keep runtime and transport boundaries independently injectable
  constructor(private readonly options: Options) {}

  // observe source and account identity without starting inference
  observe(id: string): Promise<string | undefined> {
    // coalesce dashboard and request observations without retaining old reads
    if (this.stopped) return Promise.resolve(undefined);
    const pending = this.reads.get(id);
    // one source read serves simultaneous callers
    if (pending !== undefined) return pending;
    const epoch = this.epochs.get(id) ?? Symbol();
    this.epochs.set(id, epoch);
    const read = this.read(id, epoch).catch(() => {
      // a failed old read cannot clear a newer observation
      if (this.epochs.get(id) === epoch) this.invalidate(id);
      return undefined;
    }).finally(() => {
      // invalidation may already have installed a different read
      if (this.reads.get(id) === read) this.reads.delete(id);
    });
    this.reads.set(id, read);
    return read;
  }

  // reject snapshots that changed while the credential route was inspected
  private async read(id: string, epoch: symbol): Promise<string | undefined> {
    const source = await this.options.source(id);
    const latest = source?.messages.at(-1);
    const route = source?.agentId === id && latest?.role === 'assistant' && messageAsksQuestion(latest.text)
      ? await this.options.routeFingerprint(source)
      : undefined;
    const current = route === undefined ? undefined : await this.options.source(id);
    // retired reads and unready sources cannot resurrect a cached key
    if (this.stopped || this.epochs.get(id) !== epoch) return undefined;
    // empty or changed snapshots never expose a generation affordance
    if (source === undefined || !route || current?.identity !== source.identity) {
      replySuggestionDiagnostics.record(source === undefined ? 'source_unavailable' : route === undefined ? 'selection_unavailable' : 'stale', source);
      this.invalidate(id);
      return undefined;
    }
    const previous = this.entries.get(id);
    // polling the same exact source and login preserves its single attempt
    if (previous?.source.identity === source.identity && previous.route === route) return previous.key;
    this.retire(id);
    const key = randomUUID();
    this.entries.set(id, { key, source, route });
    return key;
  }

  // request results only after the caller proves current controller authority
  request(id: string, key: string, authorized: () => boolean): Promise<ReplySuggestionResult> {
    return replySuggestionDiagnostics.request(async () => {
      replySuggestionDiagnostics.record('admitted', this.entries.get(id)?.source);
      return await this.requestCurrent(id, key, authorized);
    });
  }

  // retain one request's safe correlation through dispatch and publication
  private async requestCurrent(id: string, key: string, authorized: () => boolean): Promise<ReplySuggestionResult> {
    // admission and cached reads require independent live authority checks
    if (!authorized()) { replySuggestionDiagnostics.record('denied', this.entries.get(id)?.source); return { status: 'denied' }; }
    const currentKey = await this.observe(id);
    // account and source resolution cannot extend a departed session
    if (!authorized()) { replySuggestionDiagnostics.record('denied', this.entries.get(id)?.source); return { status: 'denied' }; }
    const entry = this.entries.get(id);
    // opaque keys are locators rather than a right to run work
    if (currentKey !== key || entry?.key !== key) { replySuggestionDiagnostics.record('stale', entry?.source); return { status: 'stale' }; }
    const suggestions = await this.start(id, entry, authorized);
    // a completed provider request never renews or reacquires authority
    if (!authorized()) { replySuggestionDiagnostics.record('denied', entry.source); return { status: 'denied' }; }
    const publishedKey = await this.observe(id);
    // publication checks the session again after asynchronous source inspection
    if (!authorized()) { replySuggestionDiagnostics.record('denied', entry.source); return { status: 'denied' }; }
    // ignore late output from a model, conversation, process or account change
    if (publishedKey !== key || this.entries.get(id) !== entry) { replySuggestionDiagnostics.record('stale', entry.source); return { status: 'stale' }; }
    return { status: 'ready', sourceKey: key, suggestions };
  }

  // coalesce one bounded inference attempt and memoize even empty failures
  private start(id: string, entry: Entry, authorized: () => boolean): Promise<ReplySuggestion[]> {
    // completed and pending requests never trigger another paid attempt
    if (entry.result !== undefined) return Promise.resolve(entry.result);
    if (entry.task !== undefined) return entry.task;
    const identity = attemptKey(id, entry);
    const prior = this.attempts.get(identity);
    // source-read recovery never revives old pills or starts a hidden paid retry
    if (prior !== undefined) {
      this.attempts.delete(identity);
      this.attempts.set(identity, prior);
      entry.result = [];
      return Promise.resolve([]);
    }
    const reservation = { active: false };
    // reserve before capacity or any asynchronous selection/provider work
    this.attempts.set(identity, reservation);
    this.pruneAttempts();
    // rejected capacity is final for this source rather than a retry queue
    if (this.running >= 2) { replySuggestionDiagnostics.record('capacity', entry.source); entry.result = []; return Promise.resolve([]); }
    this.running += 1;
    reservation.active = true;
    const controller = new AbortController();
    entry.controller = controller;
    entry.task = new Promise(resolve => {
      // one terminal client result covers provider failure and invalidation
      entry.settle = result => {
        // late provider completion cannot replace a timeout or retired result
        if (entry.result !== undefined) return;
        entry.result = result;
        entry.settle = undefined;
        resolve(result);
      };
    });
    const timer = setTimeout(() => {
      replySuggestionDiagnostics.record('timeout', entry.source);
      controller.abort();
      entry.settle?.([]);
    }, 20_000);
    const work = Promise.resolve().then(async () => {
      // source retirement before dispatch must not spend another request
      if (controller.signal.aborted || this.entries.get(id) !== entry || !authorized()) return [];
      // native selection barriers run only after an authorized visible demand
      if (this.options.validate !== undefined && !await this.options.validate(entry.source, controller.signal)) { replySuggestionDiagnostics.record('stale', entry.source); return []; }
      // asynchronous observation cannot extend a departed source or controller
      if (controller.signal.aborted || this.entries.get(id) !== entry || !authorized()) return [];
      const result = await this.options.generate(entry.source, controller.signal, entry.route);
      // cancellation never starts a second observation or releases quarantined work early
      if (controller.signal.aborted || this.entries.get(id) !== entry || !authorized()) return [];
      // publication requires a fresh stable native model and input generation
      if (this.options.validate !== undefined && !await this.options.validate(entry.source, controller.signal)) { replySuggestionDiagnostics.record('stale', entry.source); return []; }
      replySuggestionDiagnostics.record(result.length === 0 ? 'invalid_output' : 'success', entry.source);
      return result;
    }).catch(() => { replySuggestionDiagnostics.record('generation_failed', entry.source); return [] as ReplySuggestion[]; });
    void work.then(result => {
      const publishable = !controller.signal.aborted && this.entries.get(id) === entry && authorized();
      entry.settle?.(publishable ? result : []);
    }).finally(() => {
      clearTimeout(timer);
      // keep an ignored-abort operation quarantined until it actually settles
      this.running -= 1;
      reservation.active = false;
      this.pruneAttempts();
      entry.controller = undefined;
    });
    return entry.task;
  }

  // bound settled reservations while retaining every unsettled operation
  private pruneAttempts(): void {
    let settled = 0;
    // active reservations remain pinned through ignored cancellation
    for (const reservation of this.attempts.values()) if (!reservation.active) settled += 1;
    // retire only the oldest settled keys beyond the bounded ledger
    for (const [key, reservation] of this.attempts) {
      if (settled <= maximumAttemptReservations) break;
      if (!reservation.active) { this.attempts.delete(key); settled -= 1; }
    }
  }

  // retire cached and pending work without interrupting the active Agent
  invalidate(id: string): void {
    this.epochs.delete(id);
    this.reads.delete(id);
    this.retire(id);
  }

  // abort only the isolated inference and release its waiting HTTP callers
  private retire(id: string): void {
    const previous = this.entries.get(id);
    this.entries.delete(id);
    previous?.controller?.abort();
    previous?.settle?.([]);
  }

  // structured events recheck cached sources without starting provider work
  refresh(): void {
    // each observation coalesces with any dashboard request already in flight
    for (const id of this.entries.keys()) void this.observe(id);
  }

  // application shutdown retires all retained source payloads
  stop(): void {
    this.stopped = true;
    // pending observations and jobs cannot publish after shutdown
    for (const id of this.epochs.keys()) this.invalidate(id);
    this.attempts.clear();
  }
}
