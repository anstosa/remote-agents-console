import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MAX_ASK_THREADS, MAX_ASK_TURNS, parseAskThread, type AskThread, type AskTurn } from '../asks/contracts.js';
import { parseCodeReview, type CodeReview } from '../code-review/contracts.js';
import { parseReviewTour, type ReviewTour, type StoredReviewTour, type StoredReviewTourSummary } from './contracts.js';

type StoredReviews = Record<string, StoredReviewTour>;
// a completed Code review, kept beside (not inside) the tour record: it may finish before its tour
export type StoredCodeReview = { worktreeId: string; branch: string; review: CodeReview };
type StoredCodeReviews = Record<string, StoredCodeReview>;
// a tour's Ask threads, kept beside the tour record for the branch and Comparison they were asked about
export type StoredAsks = { worktreeId: string; branch: string; fingerprint: string; threads: AskThread[] };
type StoredAskRecords = Record<string, StoredAsks>;
// the records kept in their own files beside the tours
type Sides = { codeReviews: StoredCodeReviews; asks: StoredAskRecords };
type Mutation<T> = { value: T; changed: boolean; codeReviewsChanged?: boolean; asksChanged?: boolean };
type BranchBinding = { worktreeId: string; branch?: string };

const maxWorktrees = 100;
const maxBranchLength = 1_024;
const maxStoredBytes = 100 * 1024 * 1024;
// keyed by the Worktree wire id `<projectId>:<realpath>` (ADR 0003), so accept the `:`
// and `/` the path carries — bounded, single-line, no NUL — not just the old bare id
const validWorktreeId = (value: string) => value.length >= 1 && value.length <= 4096 && !/[\0\n\r]/u.test(value);
const validBranch = (value: string) => value.length > 0 && value.length <= maxBranchLength && !value.includes('\0');

// validate one durable review record
function parseStoredReview(value: unknown, expectedWorktreeId: string): StoredReviewTour | undefined {
  // require a plain object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stored = value as { worktreeId?: unknown; branch?: unknown; savedAt?: unknown; tour?: unknown };
  // validate durable identity fields
  if (stored.worktreeId !== expectedWorktreeId || typeof stored.branch !== 'string' || !validBranch(stored.branch) || typeof stored.savedAt !== 'string' || !Number.isFinite(Date.parse(stored.savedAt))) return undefined;
  const tour = parseReviewTour(stored.tour);
  return tour === undefined ? undefined : { worktreeId: expectedWorktreeId, branch: stored.branch, savedAt: stored.savedAt, tour };
}

// validate one durable Code review record
function parseStoredCodeReview(value: unknown, expectedWorktreeId: string): StoredCodeReview | undefined {
  // require a plain object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stored = value as { worktreeId?: unknown; branch?: unknown; review?: unknown };
  // validate durable identity fields
  if (stored.worktreeId !== expectedWorktreeId || typeof stored.branch !== 'string' || !validBranch(stored.branch)) return undefined;
  const review = parseCodeReview(stored.review);
  return review === undefined ? undefined : { worktreeId: expectedWorktreeId, branch: stored.branch, review };
}

// validate one durable record of a tour's Ask threads
function parseStoredAsks(value: unknown, expectedWorktreeId: string): StoredAsks | undefined {
  // require a plain object
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stored = value as { worktreeId?: unknown; branch?: unknown; fingerprint?: unknown; threads?: unknown };
  if (stored.worktreeId !== expectedWorktreeId || typeof stored.branch !== 'string' || !validBranch(stored.branch) || typeof stored.fingerprint !== 'string' || !Array.isArray(stored.threads) || stored.threads.length > MAX_ASK_THREADS) return undefined;
  const threads = stored.threads.map(parseAskThread);
  return threads.every(thread => thread !== undefined) ? { worktreeId: expectedWorktreeId, branch: stored.branch, fingerprint: stored.fingerprint, threads: threads as AskThread[] } : undefined;
}

// the Code review joined to one stored tour: the same branch and Comparison fingerprint
function joinedCodeReview(record: StoredCodeReview | undefined, branch: string, fingerprint: string): CodeReview | undefined {
  return record !== undefined && record.branch === branch && record.review.fingerprint === fingerprint ? record.review : undefined;
}

// Whether a tour's thread still applies: it must be on the one conversation its target asks, the
// Code review's for a reviewer thread. A thread on any other belongs to a replaced run.
function threadApplies(thread: Pick<AskThread, 'target' | 'conversation'>, review: CodeReview | undefined): boolean {
  const conversation = review?.conversation;
  return conversation !== undefined && thread.conversation === conversation;
}

// copy a safe dashboard summary, counting a joined Code review's findings
function summary(stored: StoredReviewTour, codeReview: CodeReview | undefined): StoredReviewTourSummary {
  return { worktreeId: stored.worktreeId, branch: stored.branch, savedAt: stored.savedAt, title: stored.tour.title, scope: stored.tour.scope, ...(stored.tour.commit === undefined ? {} : { commit: stored.tour.commit }), includeTests: stored.tour.includeTests, includeDocs: stored.tour.includeDocs, fingerprint: stored.tour.fingerprint, ...(codeReview === undefined ? {} : { codeReview: 'ready' as const, findings: codeReview.findings.length + codeReview.general.length }) };
}

// a file beside the tour file, so the tour file keeps its format
function sideFileFor(file: string, name: string): string {
  return file.endsWith('.json') ? `${file.slice(0, -'.json'.length)}.${name}.json` : `${file}.${name}`;
}

// The records of one kind kept in their own file beside the tours, one per Worktree, read once and
// cached; the store is the file's only writer. An unreadable or corrupt file reads as empty, with a
// warning, so it never breaks the tour operations sharing the store; a corrupt file is rejected as
// a whole.
class SideRecords<T> {
  private cached?: Record<string, T>;

  constructor(readonly file: string, private readonly label: string, private readonly parse: (value: unknown, worktreeId: string) => T | undefined) {}

  // the records as last read or written
  async read(): Promise<Record<string, T>> {
    this.cached ??= await this.load().catch((error: unknown) => {
      console.warn(`[review] ignoring the unreadable ${this.label} file ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    });
    return this.cached;
  }

  // keep the records just written
  wrote(records: Record<string, T>): void { this.cached = records; }

  private async load(): Promise<Record<string, T>> {
    let serialized: string;
    try { serialized = await readFile(this.file, 'utf8'); }
    catch (error) {
      // treat a missing store as empty
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    // reject oversized durable state
    if (Buffer.byteLength(serialized) > maxStoredBytes) throw new Error(`${this.label} store exceeds storage limits`);
    const raw = JSON.parse(serialized) as unknown;
    // require a plain record within the worktree limit
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > maxWorktrees) throw new Error(`invalid ${this.label} store`);
    const records: Record<string, T> = {};
    for (const [worktreeId, value] of Object.entries(raw)) {
      const record = validWorktreeId(worktreeId) ? this.parse(value, worktreeId) : undefined;
      if (record === undefined) throw new Error(`invalid ${this.label} store`);
      records[worktreeId] = record;
    }
    return records;
  }
}

export class ReviewTourStore {
  private mutation = Promise.resolve();
  private readonly generations = new Map<string, number>();
  private readonly generationBranches = new Map<string, string>();
  private readonly codeReviewGenerations = new Map<string, number>();
  private readonly codeReviews: SideRecords<StoredCodeReview>;
  private readonly asks: SideRecords<StoredAsks>;

  constructor(private readonly file = process.env.RAC_REVIEW_TOURS_FILE ?? '.data/review-tours.json', codeReviewFile = sideFileFor(file, 'code-reviews'), askFile = sideFileFor(file, 'asks')) {
    this.codeReviews = new SideRecords(codeReviewFile, 'code review', parseStoredCodeReview);
    this.asks = new SideRecords(askFile, 'ask thread', parseStoredAsks);
  }

  // persist the latest tour for one branch
  async save(worktreeId: string, branch: string, tour: ReviewTour): Promise<StoredReviewTour | undefined> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch) || parseReviewTour(tour) === undefined) return undefined;
    return await this.mutate<StoredReviewTour | undefined>(stored => {
      // cap distinct configured worktrees
      if (stored[worktreeId] === undefined && Object.keys(stored).length >= maxWorktrees) return { value: undefined, changed: false };
      const review = { worktreeId, branch, savedAt: new Date().toISOString(), tour };
      stored[worktreeId] = review;
      return { value: review, changed: true };
    }, false);
  }

  // serialize one new generation identity
  async invalidate(worktreeId: string, branch?: string): Promise<number | undefined> {
    if (!validWorktreeId(worktreeId) || (branch !== undefined && !validBranch(branch))) return undefined;
    return await this.mutate((stored, sides) => {
      const generation = (this.generations.get(worktreeId) ?? 0) + 1;
      this.generations.set(worktreeId, generation);
      // bind pending persistence to its observed branch
      if (branch === undefined) this.generationBranches.delete(worktreeId);
      else this.generationBranches.set(worktreeId, branch);
      const changed = stored[worktreeId] !== undefined;
      // remove the artifact invalidated by this generation
      if (changed) delete stored[worktreeId];
      return { value: generation, changed, ...this.clearTour(sides, worktreeId) };
    });
  }

  // persist only while one generation remains current
  async saveIfCurrent(worktreeId: string, branch: string, tour: ReviewTour, generation: number): Promise<StoredReviewTour | false | undefined> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch) || parseReviewTour(tour) === undefined) return undefined;
    return await this.mutate<StoredReviewTour | false | undefined>(stored => {
      // reject superseded generation inside the serialized mutation
      if (this.generations.get(worktreeId) !== generation) return { value: false, changed: false };
      // reject a generation prepared on another branch
      if (this.generationBranches.get(worktreeId) !== branch) return { value: false, changed: false };
      // cap distinct configured worktrees
      if (stored[worktreeId] === undefined && Object.keys(stored).length >= maxWorktrees) return { value: undefined, changed: false };
      const review = { worktreeId, branch, savedAt: new Date().toISOString(), tour };
      stored[worktreeId] = review;
      return { value: review, changed: true };
    }, false);
  }

  // invalidate one still-current generation
  async invalidateIfCurrent(worktreeId: string, generation: number): Promise<boolean> {
    if (!validWorktreeId(worktreeId)) return false;
    return await this.mutate((stored, sides) => {
      // preserve a newer generation
      if (this.generations.get(worktreeId) !== generation) return { value: false, changed: false };
      this.generations.set(worktreeId, generation + 1);
      this.generationBranches.delete(worktreeId);
      const changed = stored[worktreeId] !== undefined;
      if (changed) delete stored[worktreeId];
      return { value: true, changed, asksChanged: this.clearAsks(sides.asks, worktreeId) };
    });
  }

  // read only a review from the current branch
  async current(worktreeId: string, branch: string | undefined): Promise<StoredReviewTour | undefined> {
    if (!validWorktreeId(worktreeId) || branch === undefined || !validBranch(branch)) return undefined;
    return await this.mutate((stored, sides) => {
      const review = stored[worktreeId];
      const generationBranch = this.generationBranches.get(worktreeId);
      // drop a Code review and Ask threads left on another branch
      const left = this.clearOtherBranch(sides, worktreeId, branch);
      // return a current branch match
      if ((generationBranch === undefined || generationBranch === branch) && (review === undefined || review.branch === branch)) return { value: review, changed: false, ...left };
      // invalidate pending and durable reviews after branch changes
      this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1);
      this.generationBranches.set(worktreeId, branch);
      const changed = review !== undefined;
      if (changed) delete stored[worktreeId];
      return { value: undefined, changed, ...left };
    });
  }

  // expose current-branch summaries and prune branch changes
  async summaries(bindings: BranchBinding[]): Promise<StoredReviewTourSummary[]> {
    const branches = new Map(bindings.filter(binding => validWorktreeId(binding.worktreeId) && binding.branch !== undefined && validBranch(binding.branch)).map(binding => [binding.worktreeId, binding.branch!]));
    return await this.mutate((stored, sides) => {
      const { codeReviews } = sides;
      let changed = false;
      let codeReviewsChanged = false;
      let asksChanged = false;
      const reviews: StoredReviewTourSummary[] = [];
      // invalidate pending generations observed on another branch
      for (const [worktreeId, branch] of branches) {
        const generationBranch = this.generationBranches.get(worktreeId);
        // retain generations without a pending branch binding
        if (generationBranch === undefined || generationBranch === branch) continue;
        this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1);
        this.generationBranches.set(worktreeId, branch);
      }
      // reconcile every stored review with its configured worktree branch
      for (const [worktreeId, review] of Object.entries(stored)) {
        const branch = branches.get(worktreeId);
        // retain records until their configured branch can be observed
        if (branch === undefined) continue;
        // permanently prune a branch mismatch
        if (branch !== review.branch) { delete stored[worktreeId]; this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1); this.generationBranches.set(worktreeId, branch); changed = true; continue; }
        reviews.push(summary(review, joinedCodeReview(codeReviews[worktreeId], branch, review.tour.fingerprint)));
      }
      // prune Code reviews and Ask threads left on another branch
      for (const [worktreeId, branch] of branches) {
        const left = this.clearOtherBranch(sides, worktreeId, branch);
        codeReviewsChanged ||= left.codeReviewsChanged;
        asksChanged ||= left.asksChanged;
      }
      return { value: reviews, changed, codeReviewsChanged, asksChanged };
    });
  }

  // dismiss one durable review
  async dismiss(worktreeId: string): Promise<boolean> {
    if (!validWorktreeId(worktreeId)) return false;
    return await this.mutate((stored, sides) => {
      const existed = stored[worktreeId] !== undefined;
      // invalidate pending generation even without an artifact
      this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1);
      this.generationBranches.delete(worktreeId);
      // remove only an existing record
      if (existed) delete stored[worktreeId];
      return { value: existed, changed: existed, ...this.clearTour(sides, worktreeId) };
    });
  }

  // the stored tour of one Worktree as it is, without the branch reconciliation `current` applies
  async storedTour(worktreeId: string): Promise<StoredReviewTour | undefined> {
    if (!validWorktreeId(worktreeId)) return undefined;
    return await this.mutate(stored => ({ value: stored[worktreeId], changed: false }), false);
  }

  // begin one Code review generation: a later begin, a new tour or a dismissal refuses its save
  beginCodeReview(worktreeId: string): number {
    const generation = (this.codeReviewGenerations.get(worktreeId) ?? 0) + 1;
    this.codeReviewGenerations.set(worktreeId, generation);
    return generation;
  }

  // persist a completed Code review only while its generation remains current; it joins the
  // tour stored for the same branch and fingerprint on read, whichever finishes first. Generation 0
  // is a review begun before this process: current while nothing has begun or cleared one since.
  async saveCodeReviewIfCurrent(worktreeId: string, branch: string, review: CodeReview, generation: number): Promise<StoredCodeReview | false | undefined> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch) || parseCodeReview(review) === undefined) return undefined;
    return await this.mutate<StoredCodeReview | false | undefined>((_stored, { codeReviews, asks }) => {
      // reject a superseded review inside the serialized mutation
      if ((this.codeReviewGenerations.get(worktreeId) ?? 0) !== generation) return { value: false, changed: false };
      // cap distinct configured worktrees
      if (codeReviews[worktreeId] === undefined && Object.keys(codeReviews).length >= maxWorktrees) return { value: undefined, changed: false };
      const record = { worktreeId, branch, review };
      codeReviews[worktreeId] = record;
      // threads asked of a replaced review's reviewer go with it
      return { value: record, changed: false, codeReviewsChanged: true, asksChanged: this.clearStrayThreads(asks, worktreeId, review) };
    });
  }

  // read the Code review of one stored tour: the same branch and Comparison fingerprint
  async codeReview(worktreeId: string, branch: string, fingerprint: string): Promise<CodeReview | undefined> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch)) return undefined;
    return await this.mutate((_stored, { codeReviews }) => ({ value: joinedCodeReview(codeReviews[worktreeId], branch, fingerprint), changed: false }));
  }

  // The Ask threads of one stored tour: those asked on its branch and Comparison that still apply.
  async askThreads(worktreeId: string, branch: string, fingerprint: string): Promise<AskThread[]> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch)) return [];
    return await this.mutate((stored, sides) => ({ value: this.joinedThreads(stored, sides, worktreeId, branch, fingerprint), changed: false }));
  }

  // Add one settled turn to its thread, starting the thread with it, while the stored tour is still
  // the one asked about and the thread still applies to it. Only the latest turns of a thread are
  // kept. Resolves whether the turn was kept.
  async saveAskTurn(worktreeId: string, branch: string, fingerprint: string, thread: Omit<AskThread, 'turns'>, turn: AskTurn): Promise<boolean> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch) || parseAskThread({ ...thread, turns: [turn] }) === undefined) return false;
    return await this.mutate((stored, sides) => {
      const tour = stored[worktreeId];
      const review = tour === undefined ? undefined : joinedCodeReview(sides.codeReviews[worktreeId], branch, fingerprint);
      if (tour?.branch !== branch || tour.tour.fingerprint !== fingerprint || !threadApplies(thread, review)) return { value: false, changed: false };
      const threads = this.joinedThreads(stored, sides, worktreeId, branch, fingerprint);
      const existing = threads.find(candidate => candidate.id === thread.id);
      if (existing === undefined && threads.length >= MAX_ASK_THREADS) return { value: false, changed: false };
      if (sides.asks[worktreeId] === undefined && Object.keys(sides.asks).length >= maxWorktrees) return { value: false, changed: false };
      const updated = { ...thread, turns: [...existing?.turns ?? [], turn].slice(-MAX_ASK_TURNS) };
      sides.asks[worktreeId] = { worktreeId, branch, fingerprint, threads: existing === undefined ? [...threads, updated] : threads.map(candidate => candidate === existing ? updated : candidate) };
      return { value: true, changed: false, asksChanged: true };
    });
  }

  // a tour's threads that still apply to it, as `askThreads` reads them
  private joinedThreads(stored: StoredReviews, sides: Sides, worktreeId: string, branch: string, fingerprint: string): AskThread[] {
    const record = sides.asks[worktreeId];
    const tour = stored[worktreeId];
    if (record === undefined || tour?.branch !== branch || tour.tour.fingerprint !== fingerprint || record.branch !== branch || record.fingerprint !== fingerprint) return [];
    const review = joinedCodeReview(sides.codeReviews[worktreeId], branch, fingerprint);
    return record.threads.filter(thread => threadApplies(thread, review));
  }

  // forget one worktree's Code review and refuse saves already running for it
  private clearCodeReview(codeReviews: StoredCodeReviews, worktreeId: string): boolean {
    this.codeReviewGenerations.set(worktreeId, (this.codeReviewGenerations.get(worktreeId) ?? 0) + 1);
    const existed = codeReviews[worktreeId] !== undefined;
    if (existed) delete codeReviews[worktreeId];
    return existed;
  }

  // forget everything kept beside one worktree's tour, as the tour goes
  private clearTour(sides: Sides, worktreeId: string): Pick<Mutation<unknown>, 'codeReviewsChanged' | 'asksChanged'> {
    return { codeReviewsChanged: this.clearCodeReview(sides.codeReviews, worktreeId), asksChanged: this.clearAsks(sides.asks, worktreeId) };
  }

  // forget the Code review and Ask threads one worktree left on a branch it is no longer on
  private clearOtherBranch(sides: Sides, worktreeId: string, branch: string): { codeReviewsChanged: boolean; asksChanged: boolean } {
    const codeReviewsChanged = sides.codeReviews[worktreeId] !== undefined && sides.codeReviews[worktreeId].branch !== branch && this.clearCodeReview(sides.codeReviews, worktreeId);
    const asksChanged = sides.asks[worktreeId] !== undefined && sides.asks[worktreeId].branch !== branch && this.clearAsks(sides.asks, worktreeId);
    return { codeReviewsChanged, asksChanged };
  }

  private clearAsks(asks: StoredAskRecords, worktreeId: string): boolean {
    const existed = asks[worktreeId] !== undefined;
    if (existed) delete asks[worktreeId];
    return existed;
  }

  // forget one worktree's threads that no longer apply now `review` is its Code review
  private clearStrayThreads(asks: StoredAskRecords, worktreeId: string, review: CodeReview): boolean {
    const record = asks[worktreeId];
    const kept = record?.threads.filter(thread => threadApplies(thread, review));
    if (record === undefined || kept!.length === record.threads.length) return false;
    asks[worktreeId] = { ...record, threads: kept! };
    return true;
  }

  // Serialize all file mutations. A change that leaves the side records alone (`withSides` false)
  // gets empty ones it must not modify. The others get copies of the cached side records (a change
  // only adds, replaces or deletes whole records), cached again once written.
  private async mutate<T>(change: (stored: StoredReviews, sides: Sides) => Mutation<T>, withSides = true): Promise<T> {
    const operation = this.mutation.then(async () => {
      const [stored, codeReviews, asks] = await Promise.all([this.read(), withSides ? this.codeReviews.read() : {}, withSides ? this.asks.read() : {}]);
      const sides = { codeReviews: { ...codeReviews }, asks: { ...asks } };
      const result = change(stored, sides);
      // avoid writes for pure reads
      if (result.changed) await this.write(this.file, stored);
      if (withSides && result.codeReviewsChanged === true) { await this.write(this.codeReviews.file, sides.codeReviews); this.codeReviews.wrote(sides.codeReviews); }
      if (withSides && result.asksChanged === true) { await this.write(this.asks.file, sides.asks); this.asks.wrote(sides.asks); }
      return result.value;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  // read and validate the durable store
  private async read(): Promise<StoredReviews> {
    let serialized: string;
    try { serialized = await readFile(this.file, 'utf8'); }
    catch (error) {
      // treat a missing store as empty
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    // reject oversized durable state
    if (Buffer.byteLength(serialized) > maxStoredBytes) throw new Error('review tour store exceeds storage limits');
    const raw = JSON.parse(serialized) as unknown;
    // require a plain record
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid review tour store');
    const entries = Object.entries(raw);
    // enforce worktree count limits
    if (entries.length > maxWorktrees) throw new Error('review tour store exceeds storage limits');
    const stored: StoredReviews = {};
    // validate every stored worktree
    for (const [worktreeId, value] of entries) {
      const review = validWorktreeId(worktreeId) ? parseStoredReview(value, worktreeId) : undefined;
      // fail closed on corrupt state
      if (review === undefined) throw new Error('invalid review tour store');
      stored[worktreeId] = review;
    }
    return stored;
  }

  // atomically replace one durable file
  private async write(file: string, value: StoredReviews | StoredCodeReviews | StoredAskRecords): Promise<void> {
    const serialized = JSON.stringify(value);
    // enforce the aggregate storage boundary
    if (Buffer.byteLength(serialized) > maxStoredBytes) throw new Error('review tour store exceeds storage limits');
    await mkdir(dirname(file), { recursive: true });
    const next = `${file}.next`;
    await writeFile(next, serialized, { mode: 0o600 });
    await rename(next, file);
  }
}
