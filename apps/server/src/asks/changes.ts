import { randomBytes } from 'node:crypto';
import type { ComparisonScope } from '../git/comparison-service.js';
import type { ComparisonPatch } from '../git/comparison.js';
import type { ResolvedReviewTour } from '../review-runs/config.js';
import { askRunLabel } from '../review-runs/runner.js';
import { parseTourGuide, ReviewTourError, type TourGuide } from '../review-tour/contracts.js';
import type { StartedReviewJob } from '../review-tour/jobs.js';
import { maxWorktrees, SideRecords, sideFileFor, validBranch, validWorktreeId, writeRecords } from '../review-tour/store.js';
import { diffAskPrompt, diffSeedPrompt, guideAskPrompt, MAX_ASK_PENDING, linesAnchor, MAX_ASK_THREADS, MAX_ASK_TURNS, parseAskThread, type AskAnchor, type AskThread, type AskTurn, type ChangeAskRequest } from './contracts.js';
import { acceptedEffort, type AskJobs, type AskTarget, type ResolvedAsk } from './jobs.js';

// the most Comparisons of one Worktree whose threads are kept; asking about another forgets the oldest
const maxScopes = 20;

// how a scope is keyed: `working`, `pr` or `commit:<sha>`
const scopeKey = (scope: ComparisonScope): string => typeof scope === 'object' ? `commit:${scope.commit}` : scope;
const validScopeKey = (key: string) => key === 'working' || key === 'pr' || /^commit:[^\0\n]{1,200}$/u.test(key);
// how the panel names a scope, and its questions' runs
const scopeLabel = (scope: ComparisonScope): string => typeof scope === 'object' ? `Commit ${scope.commit.slice(0, 7)}` : scope === 'working' ? 'Working changes' : 'All PR changes';
// the collection of AskJobs a Code panel scope's threads are kept in
export const changeAskCollection = (scope: ComparisonScope): string => `changes:${scopeKey(scope)}`;

// One Comparison's threads, and the diff conversation its questions `started`, which later ones resume.
type ScopeAsks = { started?: TourGuide; threads: AskThread[] };
// one Worktree's Code panel threads, kept for the branch they were asked on, by scope, oldest first
type StoredChangeAsks = { worktreeId: string; branch: string; scopes: Record<string, ScopeAsks> };

function parseScopeAsks(value: unknown): ScopeAsks | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stored = value as { started?: unknown; threads?: unknown };
  const started = stored.started === undefined ? undefined : parseTourGuide(stored.started);
  if ((stored.started !== undefined && started === undefined) || !Array.isArray(stored.threads) || stored.threads.length > MAX_ASK_THREADS) return undefined;
  const threads = stored.threads.map(parseAskThread);
  return threads.every(thread => thread !== undefined) ? { ...(started === undefined ? {} : { started }), threads: threads as AskThread[] } : undefined;
}

function parseStoredChangeAsks(value: unknown, worktreeId: string): StoredChangeAsks | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stored = value as { worktreeId?: unknown; branch?: unknown; scopes?: unknown };
  if (stored.worktreeId !== worktreeId || typeof stored.branch !== 'string' || !validBranch(stored.branch) || stored.scopes === null || typeof stored.scopes !== 'object' || Array.isArray(stored.scopes)) return undefined;
  const entries = Object.entries(stored.scopes);
  if (entries.length > maxScopes) return undefined;
  const scopes: Record<string, ScopeAsks> = {};
  for (const [key, entry] of entries) {
    const parsed = validScopeKey(key) ? parseScopeAsks(entry) : undefined;
    if (parsed === undefined) return undefined;
    scopes[key] = parsed;
  }
  return { worktreeId, branch: stored.branch, scopes };
}

// Code panel Ask threads, kept per Worktree, branch and scope in one file beside the tour store, read
// once and cached; the store is the file's only writer. Threads asked on another branch read as none and are replaced by
// the next one kept. Every bound forgets the oldest: Worktrees, scopes and threads.
export class ChangeAskStore {
  private mutation = Promise.resolve();
  private readonly records: SideRecords<StoredChangeAsks>;

  constructor(file = sideFileFor(process.env.RAC_REVIEW_TOURS_FILE ?? '.data/review-tours.json', 'change-asks')) {
    this.records = new SideRecords(file, 'code panel ask', parseStoredChangeAsks);
  }

  // one scope's threads on the branch
  async threads(worktreeId: string, branch: string, scope: ComparisonScope): Promise<AskThread[]> {
    return (await this.scope(worktreeId, branch, scope))?.threads ?? [];
  }

  // the diff conversation one scope's questions started on the branch
  async started(worktreeId: string, branch: string, scope: ComparisonScope): Promise<TourGuide | undefined> {
    return (await this.scope(worktreeId, branch, scope))?.started;
  }

  // Add one settled turn to its thread, starting the thread with it, and record `started` as the
  // scope's diff conversation in place of any earlier one. Only a thread's latest turns are kept.
  async saveTurn(worktreeId: string, branch: string, scope: ComparisonScope, thread: Omit<AskThread, 'turns'>, turn: AskTurn, started?: TourGuide): Promise<boolean> {
    if (!validWorktreeId(worktreeId) || !validBranch(branch) || !validScopeKey(scopeKey(scope)) || parseAskThread({ ...thread, turns: [turn] }) === undefined) return false;
    return await this.mutate(records => {
      const record = records[worktreeId]?.branch === branch ? records[worktreeId] : { worktreeId, branch, scopes: {} };
      const key = scopeKey(scope);
      const current = record.scopes[key] ?? { threads: [] };
      const existing = current.threads.find(candidate => candidate.id === thread.id);
      const updated = { ...thread, turns: [...existing?.turns ?? [], turn].slice(-MAX_ASK_TURNS) };
      const threads = existing === undefined ? [...current.threads, updated].slice(-MAX_ASK_THREADS) : current.threads.map(candidate => candidate === existing ? updated : candidate);
      const conversation = started ?? current.started;
      // the scope asked about last is kept last, so the oldest goes first
      const { [key]: _replaced, ...others } = record.scopes;
      const scopes = Object.fromEntries([...Object.entries(others), [key, { ...(conversation === undefined ? {} : { started: conversation }), threads }] as const].slice(-maxScopes));
      const { [worktreeId]: _previous, ...rest } = records;
      return Object.fromEntries([...Object.entries(rest), [worktreeId, { ...record, scopes }] as const].slice(-maxWorktrees));
    });
  }

  // forget a removed Worktree's threads
  async forget(worktreeId: string): Promise<void> {
    await this.mutate(records => {
      if (records[worktreeId] === undefined) return undefined;
      const { [worktreeId]: _forgotten, ...rest } = records;
      return rest;
    });
  }

  private async scope(worktreeId: string, branch: string, scope: ComparisonScope): Promise<ScopeAsks | undefined> {
    await this.mutation;
    const record = (await this.records.read())[worktreeId];
    return record?.branch === branch ? record.scopes[scopeKey(scope)] : undefined;
  }

  // serialize writes; `change` returns the records to write, or undefined to leave them
  private async mutate(change: (records: Record<string, StoredChangeAsks>) => Record<string, StoredChangeAsks> | undefined): Promise<boolean> {
    const operation = this.mutation.then(async () => {
      const next = change(await this.records.read());
      if (next === undefined) return false;
      await writeRecords(this.records.file, next);
      this.records.wrote(next);
      return true;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }
}

// Where a Code panel question is asked: its Worktree and branch (and the branch it is on by the time
// an answer is kept), the scope its Comparison is of, that Comparison as it is now, and the tour
// guide's conversation while the stored tour covers the Comparison and one of its files.
export type ChangesTarget = AskTarget & { scope: ComparisonScope; branchNow: () => Promise<string | undefined>; patch: () => Promise<ComparisonPatch | undefined>; guide: (file: string) => Promise<TourGuide | undefined> };

// Asks questions about a Code panel's Comparison (ADR 0013): of the tour guide while the stored tour
// covers the asked-about file, and otherwise in a diff conversation the scope's first question starts
// on the tour's agent and later ones resume. Threads are kept per Worktree, branch and scope.
export class ChangeAsks {
  constructor(private readonly jobs: AskJobs, private readonly store: ChangeAskStore, private readonly tour: () => Pick<ResolvedReviewTour, 'agent' | 'model' | 'effort'>) {}

  // one scope's threads
  async threads(target: Omit<AskTarget, 'workspace'> & { scope: ComparisonScope }): Promise<AskThread[]> {
    return await this.store.threads(target.worktreeId, target.branch, target.scope);
  }

  // the owner's questions about one scope still being answered
  pending(owner: string, worktreeId: string, scope: ComparisonScope): ReturnType<AskJobs['pending']> {
    return this.jobs.pending(owner, worktreeId, changeAskCollection(scope));
  }

  // Ask about new lines of the Comparison, refused when it moved since they were picked or does not
  // hold them, or on an existing thread, with its lines as they are now
  async ask(owner: string, target: ChangesTarget, request: ChangeAskRequest): Promise<{ job: StartedReviewJob; threadId: string; target: AskThread['target'] }> {
    // refuse a full Worktree before reading its Comparison
    if (this.jobs.waiting(target.worktreeId).length >= MAX_ASK_PENDING) throw new ReviewTourError('busy', true);
    const patch = await target.patch();
    if (patch === undefined) throw new ReviewTourError('target_unavailable', false);
    const resolved = 'lines' in request ? await this.resolveLines(target, patch, request) : await this.resolveThread(target, patch, request);
    return { ...await this.jobs.start(owner, target, resolved, request.question), target: resolved.thread.target };
  }

  // A new thread: to the guide while it covers the file, else in the scope's diff conversation, starting
  // it when there is none or it ran on another agent than the tour's now.
  private async resolveLines(target: ChangesTarget, patch: ComparisonPatch, request: Extract<ChangeAskRequest, { lines: unknown }>): Promise<ResolvedAsk> {
    if (patch.fingerprint !== request.fingerprint) throw new ReviewTourError('stale_during_generation', true);
    const anchor = currentAnchor(patch, request.lines);
    if (anchor === undefined) throw new ReviewTourError('target_unavailable', false);
    const id = `ask_${randomBytes(12).toString('base64url')}`;
    const guide = await target.guide(anchor.file);
    if (guide !== undefined) return this.resolved(target, { id, target: 'guide', kind: guide.agent, conversation: guide.conversation, anchor }, guide, guideAskPrompt(anchor, request.question));
    const { agent, model, effort } = this.tour();
    const started = await this.store.started(target.worktreeId, target.branch, target.scope);
    if (started?.agent === agent) return this.resolved(target, { id, target: 'diff', kind: started.agent, conversation: started.conversation, anchor }, started, diffAskPrompt(anchor, request.question));
    const starting = { agent, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
    const resolved = this.resolved(target, { id, target: 'diff', kind: agent, anchor }, starting, diffSeedPrompt({ label: scopeLabel(target.scope), patch }, anchor, request.question));
    return { ...resolved, save: async (thread, turn) => await this.keep(target, thread, turn, { ...starting, conversation: thread.conversation }) };
  }

  // a follow-up on a thread, in its own conversation, run as the guide or diff conversation it is still on
  private async resolveThread(target: ChangesTarget, patch: ComparisonPatch, request: Extract<ChangeAskRequest, { threadId: string }>): Promise<ResolvedAsk> {
    const existing = (await this.threads(target)).find(candidate => candidate.id === request.threadId);
    if (existing === undefined) throw new ReviewTourError('target_unavailable', false);
    const { turns: _turns, ...thread } = existing;
    const { findingId: _findingId, title: _title, excerpt: _excerpt, file: _file, ...lines } = thread.anchor;
    const current = currentAnchor(patch, lines);
    const known = thread.target === 'guide' ? await target.guide(thread.anchor.file) : await this.store.started(target.worktreeId, target.branch, target.scope);
    const runs = known?.agent === thread.kind && known.conversation === thread.conversation ? known : { agent: thread.kind };
    return this.resolved(target, thread, runs, thread.target === 'guide' ? guideAskPrompt(current ?? thread.anchor, request.question) : diffAskPrompt(current ?? thread.anchor, request.question, current !== undefined));
  }

  // a resolved question on a thread, run with `runs`' model and effort while its agent accepts them
  private resolved(target: ChangesTarget, thread: ResolvedAsk['thread'], runs: Pick<TourGuide, 'agent' | 'model' | 'effort'>, prompt: string): ResolvedAsk {
    const effort = acceptedEffort(runs.agent, runs.effort);
    return {
      on: changeAskCollection(target.scope), thread, prompt, label: askRunLabel(thread.target === 'guide' ? 'Tour guide' : scopeLabel(target.scope)),
      ...(runs.model === undefined ? {} : { model: runs.model }), ...(effort === undefined ? {} : { effort }),
      save: async (saved, turn) => await this.keep(target, saved, turn)
    };
  }

  // keep a settled turn while the Worktree is still on the branch it was asked on
  private async keep(target: ChangesTarget, thread: Omit<AskThread, 'turns'>, turn: AskTurn, started?: TourGuide): Promise<boolean> {
    if (await target.branchNow() !== target.branch) return false;
    return await this.store.saveTurn(target.worktreeId, target.branch, target.scope, thread, turn, started);
  }
}

// the anchor of some lines of a Comparison's file as it is now, when its patch still holds them
function currentAnchor(patch: ComparisonPatch, lines: Parameters<typeof linesAnchor>[0]): AskAnchor | undefined {
  const file = patch.files.find(candidate => candidate.change.path === lines.changeId);
  const anchor = file === undefined ? undefined : linesAnchor(lines, { id: file.change.path, file: file.change.path, patch: file.patch });
  return anchor?.excerpt === '' ? undefined : anchor;
}
