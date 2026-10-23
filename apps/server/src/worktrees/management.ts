import { access, mkdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Project, Worktree } from '../domain/models.js';
import { PullRequestService } from '../pull-requests/service.js';
import { run } from '../tmux/command.js';

/**
 * The git subprocess seam for Worktree management, always spawning `/usr/bin/git`.
 * Returns `stderr` (unlike the discovery `GitRun`) because git's trimmed stderr is the
 * backstop error text a refused `worktree add` surfaces to the operator. Injected so
 * tests assert flag composition and stage refusals without a real repository.
 */
export type GitExec = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
const defaultGit: GitExec = (args, timeoutMs) => run('/usr/bin/git', args, undefined, timeoutMs);

// git `worktree add` may clone a large tree; the shared executor's default 5s is not enough
const addTimeoutMs = 120_000;

/**
 * One branch the Add dialog can offer. `ref` is the commit-ish that resolves it (a
 * remote-only branch resolves only through its remote), `remote` marks a remote-only ref,
 * and `checkedOut` marks a local branch a Worktree already holds: such a branch can base a
 * new one but cannot itself be checked out again.
 */
export type BranchOption = { name: string; ref: string; remote: boolean; checkedOut: boolean };
export type BranchesResult = { ok: true; branches: BranchOption[]; defaultBranch?: string } | { ok: false; status: number; error: string };
export type AddInput = { mode: 'new' | 'existing'; branch: string; base?: string };
export type AddResult = { ok: true; path: string } | { ok: false; status: number; error: string };

/**
 * The fresh facts the Remove dialog decides with (ADR 0003): the structural flags from
 * the discovered Worktree (`main`, `detached`, `locked`, `branch`) plus git state read
 * live at request time — `dirtyCount` counts untracked files, `pushed` is true when HEAD
 * is contained in an `origin/*` ref or its upstream is gone, `merged` when HEAD is an
 * ancestor of the Project's default branch, and `ahead`/`behind` come from the upstream.
 */
export type RemovalFacts = {
  main: boolean;
  detached: boolean;
  locked: boolean;
  lockedReason?: string;
  branch?: string;
  dirtyCount: number;
  pushed: boolean;
  merged: boolean;
  ahead?: number;
  behind?: number;
};
export type RemovalResult = { ok: true; facts: RemovalFacts } | { ok: false; status: number; error: string };
export type RemoveOutcome = { ok: true } | { ok: false; status: number; error: string };
export type BranchDeleteOutcome = { ok: true } | { ok: false; error: string };
export type BranchRemovalFacts = { branch: string; checkedOut: boolean; dirtyCount: number; pushed: boolean; merged: boolean; defaultBranch: boolean };
export type BranchRemovalResult = { ok: true; facts: BranchRemovalFacts } | { ok: false; status: number; error: string };
export type GuardedBranchDeleteResult = { ok: true } | { ok: false; status: number; error: string };
export type CleanupBranch = { projectId: string; projectLabel: string; branch: string; reason: 'merged' | 'closed' };
export type PruneOutcome = { ok: true } | { ok: false; status: number; error: string };

/**
 * Whether the console may create or remove Worktrees in this Project. A missing checkout
 * cannot be managed; a non-git `directory` Project has no Worktrees at all; under the
 * Docker bridge a Project whose container path differs from its host path is refused,
 * because git would otherwise write the container's paths into worktree metadata the host
 * cannot follow (ADR 0003).
 */
export function worktreeManagementAvailability(project: Project): { available: boolean; reason?: string } {
  if (!project.available) return { available: false, reason: project.unavailableReason ?? `project ${project.id} is unavailable` };
  // a non-git directory Project launches in place (like Scratch); it has no Worktrees
  if (project.mode === 'directory') return { available: false, reason: 'this project is not a git repository, so it has no worktrees to manage' };
  if (project.hostPath !== undefined && project.hostPath !== project.path) {
    return { available: false, reason: 'the container does not mount this project at its host path, so git cannot manage its worktrees' };
  }
  return { available: true };
}

// a branch name legal for the git checkout and safe as a single path leaf: no traversal,
// no control characters, and accepted by `git check-ref-format --branch`
function invalidBranchReason(branch: string): string | undefined {
  if (branch.length === 0 || branch.length > 255) return 'branch name is required';
  // `--branch` treats a leading `-` or `@{…}` specially; reject before it reaches git
  if (branch.startsWith('-') || branch.includes('..') || branch.includes('@{') || /[\0\n\r\t~^:?*[\\ ]/u.test(branch)) return `\`${branch}\` is not a valid branch name`;
  return undefined;
}

// the checkout path for a branch: its name with `/` flattened to `-`, under the Project's
// Worktrees directory. Returns undefined when the leaf would escape that directory.
function worktreePath(worktreesDirectory: string, branch: string): string | undefined {
  const leaf = branch.replaceAll('/', '-');
  const path = resolve(worktreesDirectory, leaf);
  return path === worktreesDirectory || !path.startsWith(worktreesDirectory + sep) ? undefined : path;
}

export class WorktreeManagementService {
  // one Add runs at a time per Project, so two concurrent creations never race on git's
  // worktree metadata or on the same leaf directory
  private readonly chains = new Map<string, Promise<unknown>>();

  // share exact-head PR evidence between suggestions and guarded deletion
  constructor(private readonly projects: () => readonly Project[], private readonly git: GitExec = defaultGit, private readonly pullRequests: Pick<PullRequestService, 'cleanupHead'> = new PullRequestService()) {}

  private project(projectId: string): Project | undefined {
    return this.projects().find(project => project.id === projectId);
  }

  // serialize an operation onto this Project's chain
  private serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.chains.set(projectId, next.then(() => undefined, () => undefined));
    return next;
  }

  // every branch the Add dialog can offer (local, marked when a Worktree holds it, plus
  // remote-only) and the resolved default branch (`origin/HEAD`, else the checkout's HEAD)
  async branches(projectId: string): Promise<BranchesResult> {
    const project = this.project(projectId);
    if (project === undefined) return { ok: false, status: 404, error: 'project unavailable' };
    const availability = worktreeManagementAvailability(project);
    if (!availability.available) return { ok: false, status: 409, error: availability.reason! };
    const listed = await this.git(['-C', project.path, 'for-each-ref', '--format', '%(refname)\t%(worktreepath)', 'refs/heads', 'refs/remotes']);
    if (listed.code !== 0) return { ok: false, status: 409, error: (listed.stderr.trim() || 'could not list branches') };
    const local: BranchOption[] = [];
    const localNames = new Set<string>();
    const remoteOnly = new Map<string, BranchOption>();
    for (const line of listed.stdout.split('\n')) {
      if (line === '') continue;
      const tab = line.indexOf('\t');
      const refname = tab === -1 ? line : line.slice(0, tab);
      const worktreepath = tab === -1 ? '' : line.slice(tab + 1);
      if (refname.startsWith('refs/heads/')) {
        const name = refname.slice('refs/heads/'.length);
        localNames.add(name);
        local.push({ name, ref: name, remote: false, checkedOut: worktreepath !== '' });
      } else if (refname.startsWith('refs/remotes/')) {
        const rest = refname.slice('refs/remotes/'.length);
        const slash = rest.indexOf('/');
        // skip a remote's symbolic HEAD (`refs/remotes/origin/HEAD`), never a real branch
        const name = slash === -1 ? '' : rest.slice(slash + 1);
        // the remote-qualified ref is what resolves: bare `hotfix` names no local branch
        if (name !== '' && name !== 'HEAD' && !remoteOnly.has(name)) remoteOnly.set(name, { name, ref: rest, remote: true, checkedOut: false });
      }
    }
    const branches = [...local, ...[...remoteOnly.values()].filter(option => !localNames.has(option.name))];
    const defaultBranch = await this.defaultBranch(project.path);
    return { ok: true, branches, ...(defaultBranch === undefined ? {} : { defaultBranch }) };
  }

  // `origin/HEAD` when the remote publishes one, else the checkout's own HEAD branch
  private async defaultBranch(path: string): Promise<string | undefined> {
    const origin = await this.git(['-C', path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (origin.code === 0) { const ref = origin.stdout.trim(); const slash = ref.indexOf('/'); if (ref !== '') return slash === -1 ? ref : ref.slice(slash + 1); }
    const head = await this.git(['-C', path, 'symbolic-ref', '--short', 'HEAD']);
    return head.code === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : undefined;
  }

  // create a Worktree for a new or existing branch, returning its realpath'd root. Every
  // refusal is a 409 raised before git runs; git's own failure carries its trimmed stderr.
  async add(projectId: string, input: AddInput): Promise<AddResult> {
    const project = this.project(projectId);
    if (project === undefined) return { ok: false, status: 404, error: 'project unavailable' };
    const availability = worktreeManagementAvailability(project);
    if (!availability.available) return { ok: false, status: 409, error: availability.reason! };
    if (input.mode !== 'new' && input.mode !== 'existing') return { ok: false, status: 400, error: 'invalid worktree mode' };
    const branchIssue = invalidBranchReason(input.branch);
    if (branchIssue !== undefined) return { ok: false, status: 409, error: branchIssue };
    const path = worktreePath(project.worktreesDirectory, input.branch);
    if (path === undefined) return { ok: false, status: 409, error: 'branch name does not map to a safe worktree path' };
    return await this.serialize(projectId, () => this.runAdd(project, input, path));
  }

  private async runAdd(project: Project, input: AddInput, path: string): Promise<AddResult> {
    if (!await this.refFormatValid(input.branch)) return { ok: false, status: 409, error: `\`${input.branch}\` is not a valid branch name` };
    if (input.mode === 'new') {
      if (await this.branchExists(project.path, input.branch)) return { ok: false, status: 409, error: `branch \`${input.branch}\` already exists` };
    } else if (await this.checkedOutElsewhere(project.path, input.branch)) {
      return { ok: false, status: 409, error: `branch \`${input.branch}\` is already checked out` };
    }
    let base: string | undefined;
    if (input.mode === 'new') {
      base = input.base ?? await this.defaultBranch(project.path);
      if (base === undefined || base.trim() === '') return { ok: false, status: 409, error: 'a base branch or commit is required' };
      // a leading `-` is never a valid commit-ish and would let git read the base as a flag
      if (base.startsWith('-')) return { ok: false, status: 409, error: `base \`${base}\` is not valid` };
      if (!await this.commitResolves(project.path, base)) return { ok: false, status: 409, error: `base \`${base}\` does not resolve to a commit` };
    }
    if (await this.pathExists(path)) return { ok: false, status: 409, error: 'the target worktree path already exists' };
    await mkdir(project.worktreesDirectory, { recursive: true });
    const args = input.mode === 'new'
      ? ['-C', project.path, 'worktree', 'add', '--no-track', '-b', input.branch, path, base!]
      : ['-C', project.path, 'worktree', 'add', path, input.branch];
    const created = await this.git(args, addTimeoutMs);
    if (created.code !== 0) return { ok: false, status: 409, error: (created.stderr.trim() || 'git worktree add failed') };
    return { ok: true, path: await realpath(path).catch(() => path) };
  }

  // the fresh Remove-dialog facts for one discovered Worktree: its structural flags plus
  // git state read live (never the discovery cache). A 404/409 mirrors add's guards.
  async removal(worktree: Worktree): Promise<RemovalResult> {
    const project = this.project(worktree.projectId);
    if (project === undefined) return { ok: false, status: 404, error: 'project unavailable' };
    const availability = worktreeManagementAvailability(project);
    if (!availability.available) return { ok: false, status: 409, error: availability.reason! };
    const [dirtyCount, pushed, merged, tracking] = await Promise.all([
      this.dirtyCount(worktree.path),
      this.pushed(worktree.path, worktree.branch),
      this.merged(worktree.path, project.path),
      this.aheadBehind(worktree.path)
    ]);
    const facts: RemovalFacts = {
      main: worktree.main, detached: worktree.detached, locked: worktree.locked,
      // the lock reason comes from the discovered record (git already parsed it); it is
      // structural and changes rarely, so it is sourced consistently with `locked` itself
      ...(worktree.lockedReason === undefined ? {} : { lockedReason: worktree.lockedReason }),
      ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
      dirtyCount, pushed, merged,
      ...(tracking === undefined ? {} : tracking)
    };
    return { ok: true, facts };
  }

  // run `git worktree remove [--force] <path>` from the Project's checkout. Refused on the
  // Main worktree and on a locked one (never `-f -f`); `--force` is the caller's decision,
  // set only when the operator ticked "Discard uncommitted changes". Serialized per Project
  // so it never races a concurrent add. git's trimmed stderr is the backstop error text.
  async removeCheckout(worktree: Worktree, options: { force: boolean }): Promise<RemoveOutcome> {
    const project = this.project(worktree.projectId);
    if (project === undefined) return { ok: false, status: 404, error: 'project unavailable' };
    const availability = worktreeManagementAvailability(project);
    if (!availability.available) return { ok: false, status: 409, error: availability.reason! };
    if (worktree.main) return { ok: false, status: 409, error: 'the main worktree cannot be removed' };
    if (worktree.locked) return { ok: false, status: 409, error: 'Locked worktrees cannot be removed' };
    return await this.serialize(project.id, async () => {
      const args = ['-C', project.path, 'worktree', 'remove', ...(options.force ? ['--force'] : []), worktree.path];
      const removed = await this.git(args);
      return removed.code !== 0 ? { ok: false as const, status: 409, error: (removed.stderr.trim() || 'git worktree remove failed') } : { ok: true as const };
    });
  }

  // force-delete the Worktree's branch after a successful removal, which the
  // operator asked for even when the branch is unpushed and unmerged (the dialog warns
  // first); its failure is reported and never undoes the removal, so it returns a plain
  // error string.
  async deleteBranch(worktree: Worktree, branch: string): Promise<BranchDeleteOutcome> {
    const project = this.project(worktree.projectId);
    if (project === undefined) return { ok: false, error: 'project unavailable' };
    // a name beginning with `-` would be read as a flag; a real branch name never does
    if (branch.startsWith('-')) return { ok: false, error: `\`${branch}\` is not a valid branch name` };
    return await this.serialize(project.id, async () => {
      const deleted = await this.git(['-C', project.path, 'branch', '-D', branch]);
      return deleted.code !== 0 ? { ok: false as const, error: (deleted.stderr.trim() || 'git branch delete failed') } : { ok: true as const };
    });
  }

  // suggest inactive local branches with merge or closed PR evidence
  async cleanupBranches(): Promise<CleanupBranch[]> {
    const byProject: CleanupBranch[][] = [];
    // share one request budget across projects using the same GitHub credentials
    for (const project of this.projects()) {
      const availability = worktreeManagementAvailability(project);
      // skip unmanaged repositories, and implicit ones the operator never opted into (ADR 0014)
      if (!availability.available || project.implicit === true) continue;
      const defaultBranch = await this.defaultBranch(project.path);
      // require one protected merge target
      if (defaultBranch === undefined) continue;
      const eligible = new Map<string, CleanupBranch>();
      // accept merges visible on either remote or local default
      for (const ref of [`origin/${defaultBranch}`, defaultBranch]) {
        const listed = await this.git(['-C', project.path, 'for-each-ref', `--merged=${ref}`, '--format=%(refname:strip=2)\t%(worktreepath)', 'refs/heads']);
        // tolerate a missing remote default
        if (listed.code !== 0) continue;
        // collect only deletable branch refs
        for (const line of listed.stdout.split('\n')) {
          const [branch = '', worktreePath = ''] = line.split('\t');
          // protect the default and every active checkout
          if (branch === '' || branch === defaultBranch || worktreePath !== '') continue;
          eligible.set(branch, { projectId: project.id, projectLabel: project.label, branch, reason: 'merged' });
        }
      }
      const listed = await this.git(['-C', project.path, 'for-each-ref', '--format=%(refname:strip=2)\t%(objectname)\t%(worktreepath)', 'refs/heads']);
      // preserve ancestry results if the remaining refs cannot be read
      if (listed.code !== 0) { byProject.push([...eligible.values()]); continue; }
      // only consult GitHub for inactive branches not already proven merged locally
      const candidates = listed.stdout.split('\n').map(line => {
        const [branch = '', head = '', checkout = ''] = line.split('\t');
        return { branch, head, checkout };
      }).filter(({ branch, head, checkout }) => branch !== '' && branch !== defaultBranch && checkout === '' && !eligible.has(branch) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head));
      // bound requests per repository instead of flooding GitHub for large branch lists
      for (let offset = 0; offset < candidates.length; offset += 4) {
        await Promise.all(candidates.slice(offset, offset + 4).map(async ({ branch, head }) => {
          const reason = await this.pullRequests.cleanupHead(project.path, branch, head).catch(() => undefined);
          // preserve the distinction between merged and closed-unmerged work
          if (reason !== undefined) eligible.set(branch, { projectId: project.id, projectLabel: project.label, branch, reason });
        }));
      }
      byProject.push([...eligible.values()]);
    }
    return byProject.flat().sort((left, right) => left.projectLabel.localeCompare(right.projectLabel) || left.branch.localeCompare(right.branch));
  }

  // read fresh loss-prevention facts for one local branch
  async branchRemoval(projectId: string, branch: string): Promise<BranchRemovalResult> {
    const project = this.project(projectId);
    // require one managed repository
    if (project === undefined) return { ok: false, status: 404, error: 'project unavailable' };
    const availability = worktreeManagementAvailability(project);
    // preserve the project management boundary
    if (!availability.available) return { ok: false, status: 409, error: availability.reason! };
    return await this.branchRemovalFacts(project, branch);
  }

  // delete one branch only after rechecking checkout and remote safety
  async deleteBranchGuarded(projectId: string, branch: string, discardUnpushed: boolean): Promise<GuardedBranchDeleteResult> {
    const project = this.project(projectId);
    // require one managed repository
    if (project === undefined) return { ok: false, status: 404, error: 'project unavailable' };
    const availability = worktreeManagementAvailability(project);
    // preserve the project management boundary
    if (!availability.available) return { ok: false, status: 409, error: availability.reason! };
    return await this.serialize(project.id, async () => {
      const branchIssue = invalidBranchReason(branch);
      // preserve validation responses before resolving the candidate commit
      if (branchIssue !== undefined || !await this.refFormatValid(branch)) return { ok: false as const, status: 409, error: branchIssue ?? `\`${branch}\` is not a valid branch name` };
      const head = await this.branchHead(project.path, branch);
      // refuse a missing candidate before remote verification
      if (head === undefined) return { ok: false as const, status: 404, error: 'branch unavailable' };
      const result = await this.branchRemovalFacts(project, branch, true, head);
      // retain lookup and validation failures
      if (!result.ok) return result;
      const facts = result.facts;
      // never remove the protected default branch
      if (facts.defaultBranch) return { ok: false as const, status: 409, error: 'the default branch cannot be deleted' };
      // a checked-out branch may own uncommitted work
      if (facts.checkedOut) return { ok: false as const, status: 409, error: facts.dirtyCount > 0 ? 'the branch is checked out with uncommitted changes; remove its worktree first' : 'the branch is checked out; remove its worktree first' };
      // require explicit acknowledgement when no recoverable copy is proven
      if (!facts.pushed && !facts.merged && !discardUnpushed) return { ok: false as const, status: 409, error: 'the branch is neither pushed nor merged; confirm deleting unpushed work' };
      // close the remote lookup window without bypassing git's checkout protection
      if (!await this.branchUnchanged(project, branch, head)) return { ok: false as const, status: 409, error: 'the branch changed or was checked out; refresh and try again' };
      return await this.forceDeleteBranch(project, branch);
    });
  }

  // revalidate a selected cleanup reason without expanding consent to discard work
  async deleteCleanupBranch(projectId: string, branch: string, reason: CleanupBranch['reason']): Promise<boolean> {
    const project = this.project(projectId);
    // reject stale project identities
    if (project === undefined || !worktreeManagementAvailability(project).available) return false;
    return await this.serialize(project.id, async () => {
      const head = await this.branchHead(project.path, branch);
      // bind evidence to one inactive tip and protect the default before remote lookup
      if (head === undefined || !await this.branchUnchanged(project, branch, head)) return false;
      const currentReason = await this.branchCleanupReason(project, branch, head, true);
      // a merged selection never authorizes discarding unmerged closed PR work
      if (currentReason === undefined || reason === 'merged' && currentReason !== 'merged') return false;
      // reject commits, checkouts or default-branch changes during GitHub lookup
      if (!await this.branchUnchanged(project, branch, head)) return false;
      return (await this.forceDeleteBranch(project, branch)).ok;
    });
  }

  // run `git worktree prune`, clearing git's prunable entries. The console's own orphaned
  // records are deleted by the caller (they are outside git). Serialized per Project.
  async prune(projectId: string): Promise<PruneOutcome> {
    const project = this.project(projectId);
    if (project === undefined) return { ok: false, status: 404, error: 'project unavailable' };
    const availability = worktreeManagementAvailability(project);
    if (!availability.available) return { ok: false, status: 409, error: availability.reason! };
    return await this.serialize(project.id, async () => {
      const pruned = await this.git(['-C', project.path, 'worktree', 'prune']);
      return pruned.code !== 0 ? { ok: false as const, status: 409, error: (pruned.stderr.trim() || 'git worktree prune failed') } : { ok: true as const };
    });
  }

  // the number of changed paths in the worktree, untracked included
  private async dirtyCount(path: string): Promise<number> {
    const status = await this.git(['-C', path, 'status', '--porcelain', '--untracked-files=all']);
    return status.code !== 0 ? 0 : status.stdout.split('\n').filter(line => line.trim() !== '').length;
  }

  // whether one ref is safely on the remote: contained in an `origin/*` ref, or the
  // branch's upstream is gone (deleted on the remote, as after a squash-merge)
  private async pushed(path: string, branch?: string, ref = 'HEAD'): Promise<boolean> {
    const contained = await this.git(['-C', path, 'branch', '-r', '--contains', ref, '--list', 'origin/*']);
    if (contained.code === 0 && contained.stdout.split('\n').some(line => line.trim() !== '' && !line.includes('->'))) return true;
    // a branch whose upstream was deleted on the remote (e.g. after a squash-merge) was still
    // pushed; git marks it `[gone]` in the upstream track field. `@{upstream}` itself no longer
    // resolves in that state, so read the branch's track field rather than rev-parse it.
    if (branch === undefined) return false;
    const track = await this.git(['-C', path, 'for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`]);
    return track.code === 0 && track.stdout.includes('[gone]');
  }

  // whether one ref is an ancestor of the Project's default branch — true when either the
  // remote or local default contains it
  private async merged(path: string, mainPath: string, candidateRef = 'HEAD'): Promise<boolean> {
    const branch = await this.defaultBranch(mainPath);
    if (branch === undefined) return false;
    for (const targetRef of [`origin/${branch}`, branch]) {
      // code 0 = contained; code 1 = ref resolved but HEAD not merged there; other = missing
      // ref. A missing-or-unmerged remote default still checks the local one before giving up.
      if ((await this.git(['-C', path, 'merge-base', '--is-ancestor', candidateRef, targetRef])).code === 0) return true;
    }
    return false;
  }

  // HEAD's divergence from its configured upstream, or undefined when there is none
  private async aheadBehind(path: string): Promise<{ ahead: number; behind: number } | undefined> {
    const counts = await this.git(['-C', path, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    const match = counts.code === 0 ? /^(\d+)\s+(\d+)$/u.exec(counts.stdout.trim()) : null;
    if (match === null) return undefined;
    const ahead = Number(match[1]); const behind = Number(match[2]);
    return Number.isSafeInteger(ahead) && Number.isSafeInteger(behind) ? { ahead, behind } : undefined;
  }

  // resolve branch facts from refs rather than whichever checkout owns HEAD
  private async branchRemovalFacts(project: Project, branch: string, fresh = false, expectedHead?: string): Promise<BranchRemovalResult> {
    const branchIssue = invalidBranchReason(branch);
    // reject flag-shaped and malformed refs before git sees them
    if (branchIssue !== undefined || !await this.refFormatValid(branch)) return { ok: false, status: 409, error: branchIssue ?? `\`${branch}\` is not a valid branch name` };
    // require the local branch to still exist
    if (!await this.branchExists(project.path, branch)) return { ok: false, status: 404, error: 'branch unavailable' };
    const head = expectedHead ?? await this.branchHead(project.path, branch);
    // require a concrete commit rather than proving a moving ref
    if (head === undefined) return { ok: false, status: 404, error: 'branch unavailable' };
    const defaultBranch = await this.defaultBranch(project.path);
    // require one protected merge target
    if (defaultBranch === undefined) return { ok: false, status: 409, error: 'the default branch could not be resolved' };
    const checkout = await this.git(['-C', project.path, 'for-each-ref', '--format=%(worktreepath)', `refs/heads/${branch}`]);
    // refuse uncertain checkout ownership
    if (checkout.code !== 0) return { ok: false, status: 409, error: (checkout.stderr.trim() || 'branch checkout state could not be read') };
    const worktreePath = checkout.stdout.trim();
    const checkedOut = worktreePath !== '';
    const [dirtyCount, pushed, merged] = await Promise.all([
      checkedOut ? this.dirtyCount(worktreePath) : Promise.resolve(0),
      this.pushed(project.path, branch, head),
      this.branchCleanupReason(project, branch, head, fresh).then(reason => reason === 'merged')
    ]);
    return { ok: true, facts: { branch, checkedOut, dirtyCount, pushed, merged, defaultBranch: branch === defaultBranch } };
  }

  // distinguish closed PR cleanup evidence from actual merge safety
  private async branchCleanupReason(project: Project, branch: string, head: string, fresh: boolean): Promise<CleanupBranch['reason'] | undefined> {
    // keep ordinary git-only repositories independent of GitHub availability
    if (await this.merged(project.path, project.path, head)) return 'merged';
    return await this.pullRequests.cleanupHead(project.path, branch, head, fresh).catch(() => undefined);
  }

  // resolve only a validated local branch name to an immutable commit
  private async branchHead(path: string, branch: string): Promise<string | undefined> {
    // reject revision expressions before passing a ref to git
    if (invalidBranchReason(branch) !== undefined) return undefined;
    const result = await this.git(['-C', path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    const head = result.stdout.trim();
    return result.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(head) ? head : undefined;
  }

  // recheck local guards after remote evidence and immediately before branch deletion
  private async branchUnchanged(project: Project, branch: string, head: string): Promise<boolean> {
    const defaultBranch = await this.defaultBranch(project.path);
    // an unresolved or newly protected default cannot be removed
    if (defaultBranch === undefined || branch === defaultBranch) return false;
    const result = await this.git(['-C', project.path, 'for-each-ref', '--format=%(objectname)\t%(worktreepath)', `refs/heads/${branch}`]);
    const [currentHead, checkout = ''] = result.stdout.split('\n')[0]!.split('\t');
    return result.code === 0 && currentHead === head && checkout === '';
  }

  // force-delete only after a caller has completed its safety checks
  private async forceDeleteBranch(project: Project, branch: string): Promise<GuardedBranchDeleteResult> {
    const deleted = await this.git(['-C', project.path, 'branch', '-D', branch]);
    return deleted.code !== 0 ? { ok: false, status: 409, error: (deleted.stderr.trim() || 'git branch delete failed') } : { ok: true };
  }

  private async refFormatValid(branch: string): Promise<boolean> {
    return (await this.git(['check-ref-format', '--branch', branch])).code === 0;
  }
  private async branchExists(path: string, branch: string): Promise<boolean> {
    return (await this.git(['-C', path, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  }
  private async commitResolves(path: string, base: string): Promise<boolean> {
    return (await this.git(['-C', path, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`])).code === 0;
  }
  private async checkedOutElsewhere(path: string, branch: string): Promise<boolean> {
    const listed = await this.git(['-C', path, 'for-each-ref', '--format', '%(worktreepath)', `refs/heads/${branch}`]);
    return listed.code === 0 && listed.stdout.trim() !== '';
  }
  private async pathExists(path: string): Promise<boolean> {
    return await access(path).then(() => true, () => false);
  }
}
