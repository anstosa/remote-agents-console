import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseCodeReview, type CodeReview } from '../code-review/contracts.js';
import { parseReviewTour, type ReviewTour, type StoredReviewTour, type StoredReviewTourSummary } from './contracts.js';

type StoredReviews = Record<string, StoredReviewTour>;
// a completed Code review, kept beside (not inside) the tour record: it may finish before its tour
export type StoredCodeReview = { worktreeId: string; branch: string; review: CodeReview };
type StoredCodeReviews = Record<string, StoredCodeReview>;
type Mutation<T> = { value: T; changed: boolean; codeReviewsChanged?: boolean };
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

// the Code review joined to one stored tour: the same branch and Comparison fingerprint
function joinedCodeReview(record: StoredCodeReview | undefined, branch: string, fingerprint: string): CodeReview | undefined {
  return record !== undefined && record.branch === branch && record.review.fingerprint === fingerprint ? record.review : undefined;
}

// copy a safe dashboard summary, counting a joined Code review's findings
function summary(stored: StoredReviewTour, codeReview: CodeReview | undefined): StoredReviewTourSummary {
  return { worktreeId: stored.worktreeId, branch: stored.branch, savedAt: stored.savedAt, title: stored.tour.title, scope: stored.tour.scope, ...(stored.tour.commit === undefined ? {} : { commit: stored.tour.commit }), includeTests: stored.tour.includeTests, includeDocs: stored.tour.includeDocs, fingerprint: stored.tour.fingerprint, ...(codeReview === undefined ? {} : { codeReview: 'ready' as const, findings: codeReview.findings.length + codeReview.general.length }) };
}

// the Code review file beside the tour file, so the tour file keeps its format
function codeReviewFileFor(file: string): string {
  return file.endsWith('.json') ? `${file.slice(0, -'.json'.length)}.code-reviews.json` : `${file}.code-reviews`;
}

export class ReviewTourStore {
  private mutation = Promise.resolve();
  private readonly generations = new Map<string, number>();
  private readonly generationBranches = new Map<string, string>();
  private readonly codeReviewGenerations = new Map<string, number>();
  // the Code reviews as last read or written; this store is the file's only writer
  private codeReviews?: StoredCodeReviews;

  constructor(private readonly file = process.env.RAC_REVIEW_TOURS_FILE ?? '.data/review-tours.json', private readonly codeReviewFile = codeReviewFileFor(file)) {}

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
    return await this.mutate((stored, codeReviews) => {
      const generation = (this.generations.get(worktreeId) ?? 0) + 1;
      this.generations.set(worktreeId, generation);
      // bind pending persistence to its observed branch
      if (branch === undefined) this.generationBranches.delete(worktreeId);
      else this.generationBranches.set(worktreeId, branch);
      const changed = stored[worktreeId] !== undefined;
      // remove the artifact invalidated by this generation
      if (changed) delete stored[worktreeId];
      return { value: generation, changed, codeReviewsChanged: this.clearCodeReview(codeReviews, worktreeId) };
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
    return await this.mutate(stored => {
      // preserve a newer generation
      if (this.generations.get(worktreeId) !== generation) return { value: false, changed: false };
      this.generations.set(worktreeId, generation + 1);
      this.generationBranches.delete(worktreeId);
      const changed = stored[worktreeId] !== undefined;
      if (changed) delete stored[worktreeId];
      return { value: true, changed };
    }, false);
  }

  // read only a review from the current branch
  async current(worktreeId: string, branch: string | undefined): Promise<StoredReviewTour | undefined> {
    if (!validWorktreeId(worktreeId) || branch === undefined || !validBranch(branch)) return undefined;
    return await this.mutate((stored, codeReviews) => {
      const review = stored[worktreeId];
      const generationBranch = this.generationBranches.get(worktreeId);
      // drop a Code review left on another branch
      const codeReviewsChanged = codeReviews[worktreeId] !== undefined && codeReviews[worktreeId].branch !== branch && this.clearCodeReview(codeReviews, worktreeId);
      // return a current branch match
      if ((generationBranch === undefined || generationBranch === branch) && (review === undefined || review.branch === branch)) return { value: review, changed: false, codeReviewsChanged };
      // invalidate pending and durable reviews after branch changes
      this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1);
      this.generationBranches.set(worktreeId, branch);
      const changed = review !== undefined;
      if (changed) delete stored[worktreeId];
      return { value: undefined, changed, codeReviewsChanged };
    });
  }

  // expose current-branch summaries and prune branch changes
  async summaries(bindings: BranchBinding[]): Promise<StoredReviewTourSummary[]> {
    const branches = new Map(bindings.filter(binding => validWorktreeId(binding.worktreeId) && binding.branch !== undefined && validBranch(binding.branch)).map(binding => [binding.worktreeId, binding.branch!]));
    return await this.mutate((stored, codeReviews) => {
      let changed = false;
      let codeReviewsChanged = false;
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
      // prune Code reviews left on another branch
      for (const [worktreeId, record] of Object.entries(codeReviews)) {
        const branch = branches.get(worktreeId);
        if (branch !== undefined && branch !== record.branch) codeReviewsChanged = this.clearCodeReview(codeReviews, worktreeId) || codeReviewsChanged;
      }
      return { value: reviews, changed, codeReviewsChanged };
    });
  }

  // dismiss one durable review
  async dismiss(worktreeId: string): Promise<boolean> {
    if (!validWorktreeId(worktreeId)) return false;
    return await this.mutate((stored, codeReviews) => {
      const existed = stored[worktreeId] !== undefined;
      // invalidate pending generation even without an artifact
      this.generations.set(worktreeId, (this.generations.get(worktreeId) ?? 0) + 1);
      this.generationBranches.delete(worktreeId);
      // remove only an existing record
      if (existed) delete stored[worktreeId];
      return { value: existed, changed: existed, codeReviewsChanged: this.clearCodeReview(codeReviews, worktreeId) };
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
    return await this.mutate<StoredCodeReview | false | undefined>((_stored, codeReviews) => {
      // reject a superseded review inside the serialized mutation
      if ((this.codeReviewGenerations.get(worktreeId) ?? 0) !== generation) return { value: false, changed: false };
      // cap distinct configured worktrees
      if (codeReviews[worktreeId] === undefined && Object.keys(codeReviews).length >= maxWorktrees) return { value: undefined, changed: false };
      const record = { worktreeId, branch, review };
      codeReviews[worktreeId] = record;
      return { value: record, changed: false, codeReviewsChanged: true };
    });
  }

  // read the Code review of one stored tour: the same branch and Comparison fingerprint
  async codeReview(worktreeId: string, branch: string, fingerprint: string): Promise<CodeReview | undefined> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch)) return undefined;
    return await this.mutate((_stored, codeReviews) => ({ value: joinedCodeReview(codeReviews[worktreeId], branch, fingerprint), changed: false }));
  }

  // forget one worktree's Code review and refuse saves already running for it
  private clearCodeReview(codeReviews: StoredCodeReviews, worktreeId: string): boolean {
    this.codeReviewGenerations.set(worktreeId, (this.codeReviewGenerations.get(worktreeId) ?? 0) + 1);
    const existed = codeReviews[worktreeId] !== undefined;
    if (existed) delete codeReviews[worktreeId];
    return existed;
  }

  // Serialize all file mutations. A change that leaves the Code reviews alone (`withCodeReviews`
  // false) gets an empty record it must not modify. The others get a copy of the cached Code
  // reviews (a change only adds, replaces or deletes whole records), cached again once written.
  private async mutate<T>(change: (stored: StoredReviews, codeReviews: StoredCodeReviews) => Mutation<T>, withCodeReviews = true): Promise<T> {
    const operation = this.mutation.then(async () => {
      const [stored, cached] = await Promise.all([this.read(), withCodeReviews ? this.cachedCodeReviews() : {}]);
      const codeReviews = { ...cached };
      const result = change(stored, codeReviews);
      // avoid writes for pure reads
      if (result.changed) await this.write(this.file, stored);
      if (withCodeReviews && result.codeReviewsChanged === true) { await this.write(this.codeReviewFile, codeReviews); this.codeReviews = codeReviews; }
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

  // the Code reviews, read from the file once; an unreadable or corrupt file reads as empty, with a
  // warning, so it never breaks the tour operations sharing the store
  private async cachedCodeReviews(): Promise<StoredCodeReviews> {
    if (this.codeReviews !== undefined) return this.codeReviews;
    this.codeReviews = await this.readCodeReviews().catch((error: unknown) => {
      console.warn(`[review] ignoring the unreadable Code reviews file ${this.codeReviewFile}: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    });
    return this.codeReviews;
  }

  // read and validate the durable Code reviews, rejecting a corrupt file as a whole
  private async readCodeReviews(): Promise<StoredCodeReviews> {
    let serialized: string;
    try { serialized = await readFile(this.codeReviewFile, 'utf8'); }
    catch (error) {
      // treat a missing store as empty
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    // reject oversized durable state
    if (Buffer.byteLength(serialized) > maxStoredBytes) throw new Error('code review store exceeds storage limits');
    const raw = JSON.parse(serialized) as unknown;
    // require a plain record within the worktree limit
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > maxWorktrees) throw new Error('invalid code review store');
    const stored: StoredCodeReviews = {};
    // validate every stored worktree
    for (const [worktreeId, value] of Object.entries(raw)) {
      const review = validWorktreeId(worktreeId) ? parseStoredCodeReview(value, worktreeId) : undefined;
      // reject corrupt state
      if (review === undefined) throw new Error('invalid code review store');
      stored[worktreeId] = review;
    }
    return stored;
  }

  // atomically replace one durable file
  private async write(file: string, value: StoredReviews | StoredCodeReviews): Promise<void> {
    const serialized = JSON.stringify(value);
    // enforce the aggregate storage boundary
    if (Buffer.byteLength(serialized) > maxStoredBytes) throw new Error('review tour store exceeds storage limits');
    await mkdir(dirname(file), { recursive: true });
    const next = `${file}.next`;
    await writeFile(next, serialized, { mode: 0o600 });
    await rename(next, file);
  }
}
