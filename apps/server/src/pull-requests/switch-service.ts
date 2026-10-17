import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { ValidatedConfig } from '../config/schema.js';
import type { DiscoveryService } from '../discovery/service.js';
import { run } from '../tmux/command.js';
import { cleanWorkingTree, type GitCommand } from '../git/worktree-state.js';
import { branchCommitSummary, type BranchCommitSummary } from '../git/comparison.js';
import { worktreeById, worktreeMatchesWorkspace } from '../workspaces/resolver.js';
import { agentAttentionState } from '../notifications.js';
import { PullRequestService, type PullRequestChoice } from './service.js';
import type { Worktree } from '../domain/models.js';

// bound the local-branch list folded into the availability payload
const maxSwitchableBranches = 200;
// bound local git history reads while enriching a large branch list
const branchSummaryConcurrency = 4;
// bound total optional history enrichment latency
const branchSummaryBudgetMs = 2_000;
// the switch path runs a network `git fetch` in-process; the old pane-driven flow let it run as
// long as it needed, so bound it generously rather than at run's 5s default. Local ops finish well
// under this; the ceiling only keeps a hung fetch from wedging the mutation lock indefinitely.
const gitCommandTimeoutMs = 120_000;
const runGit: GitCommand = (binary, args) => run(binary, args, undefined, gitCommandTimeoutMs);

export type PullRequestWorktree = { worktreeId: string; worktreeName: string; agentId?: string };
export type SwitchablePullRequest = PullRequestChoice & { checkoutBranch: string; checkedOut: boolean; openIn?: PullRequestWorktree };
export type SwitchableBranch = { branch: string; checkedOut: boolean; openIn?: PullRequestWorktree; commitSummary?: BranchCommitSummary };
export type PullRequestSwitchAvailability = { enabled: boolean; pullRequests: SwitchablePullRequest[]; otherPullRequests: SwitchablePullRequest[]; branches: SwitchableBranch[]; pullRequestsSupported: boolean };
export type PullRequestMoveResult = 'moved' | 'unavailable' | 'recovery-required' | 'busy';
// a branch/PR checkout outcome; 'busy' means an involved agent is working and, with job
// control gone, cannot be interrupted for the checkout; `error` explains any other refusal
export type BranchSwitchResult = 'switched' | 'busy' | { error: string };
type BranchSummaryOwner = { workspace: string; defaultBranch?: string };
const mutationInProgress = 'Another branch checkout or move is already running. Try again when it finishes.';
const switchingUnavailable = 'Branch switching is unavailable for this worktree.';
const uncommittedChanges = 'The worktree has uncommitted changes. Commit or stash them, then try again.';
const alreadyCheckedOut = (branch: string, openIn: PullRequestWorktree | undefined): string => `${branch} is already checked out in ${openIn?.worktreeName ?? 'another worktree'}.`;
// the first line of a failed git command's stderr, which names the cause; the full output goes to the server log
function gitFailure(workspace: string, action: string, result: { code: number; stderr?: string }): string | undefined {
  if (result.code === 0) return undefined;
  const stderr = result.stderr?.trim() ?? '';
  console.warn(`[branch-switch] ${workspace}: git ${action} exited ${result.code}${stderr === '' ? '' : `:\n${stderr}`}`);
  const first = stderr.split('\n')[0]?.replace(/^(fatal|error): /u, '').slice(0, 300);
  return first ? `git ${action} failed: ${first}` : `git ${action} failed.`;
}
type GitHead = { branch?: string; commit: string };

export class PullRequestSwitchService {
  private branchMutationInProgress = false;

  // switch and move run git in-process and never touch a pane, so the service takes no tmux
  // adapter: it is structurally unable to type into an agent's terminal.
  constructor(private readonly config: ValidatedConfig, private readonly discovery: DiscoveryService, private readonly pullRequests = new PullRequestService(), private readonly command: GitCommand = runGit) {}

  // list one worktree's switchable pull requests and local branches, whether or not an agent runs there
  async available(worktreeId: string, includeCommitSummaries = true): Promise<PullRequestSwitchAvailability | undefined> {
    const discoveredWorktrees = this.discovery.worktreesNow();
    const worktree = worktreeById(discoveredWorktrees, worktreeId);
    if (worktree === undefined) return undefined;
    // require one canonical repository identity, not merely a GitHub origin
    const repository = await this.repositoryIdentity(worktree.identity);
    if (repository === undefined) return undefined;
    const dashboard = await this.discovery.dashboard().catch(() => undefined);
    const checkedOut = new Map<string, PullRequestWorktree | undefined>();
    const branchOwners = new Map<string, BranchSummaryOwner>();
    const head = await this.command('/usr/bin/git', ['-C', worktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    const currentBranch = head.code === 0 ? head.stdout.trim() : '';
    // prefer the live destination branch over cached dashboard metadata
    if (currentBranch) checkedOut.set(currentBranch, { worktreeId: worktree.id, worktreeName: worktree.label });
    const agents = await Promise.all((dashboard?.agents ?? []).map(async agent => {
      const agentWorktree = discoveredWorktrees.find(candidate => worktreeMatchesWorkspace(candidate, agent.home));
      // skip agents in this worktree, whose live branch is read above, and branchless agents
      if (agentWorktree?.id === worktree.id || agent.branch === undefined) return undefined;
      const workspace = agentWorktree?.identity ?? agent.home;
      // keep only owners proven to share the target repository
      if (await this.repositoryIdentity(workspace) !== repository) return undefined;
      return { agent, branch: agent.branch, owner: { workspace, ...(agentWorktree?.defaultBranch === undefined ? {} : { defaultBranch: agentWorktree.defaultBranch }) } };
    }));
    // prioritize active agents in this repository
    for (const entry of agents) {
      // skip unavailable or already-owned entries
      if (entry === undefined || checkedOut.has(entry.branch)) continue;
      const { agent, branch, owner } = entry;
      branchOwners.set(branch, owner);
      const worktreeName = agent.worktreeId === undefined ? undefined : worktreeById(discoveredWorktrees, agent.worktreeId)?.label;
      checkedOut.set(branch, agent.worktreeId === undefined || worktreeName === undefined ? undefined : { agentId: agent.id, worktreeId: agent.worktreeId, worktreeName });
    }
    const worktrees = await Promise.all((dashboard?.projects.flatMap(project => project.worktrees) ?? []).map(async candidate => {
      // ignore branchless worktrees; every dashboard Worktree is a real discovered checkout
      if (candidate.branch === undefined) return undefined;
      const ownerWorktree = worktreeById(discoveredWorktrees, candidate.id);
      const workspace = ownerWorktree?.identity ?? candidate.path;
      // keep only worktrees proven to share the target repository
      if (await this.repositoryIdentity(workspace) !== repository) return undefined;
      return { candidate, branch: candidate.branch, owner: { workspace, ...(ownerWorktree?.defaultBranch === undefined ? {} : { defaultBranch: ownerWorktree.defaultBranch }) } };
    }));
    // fill inactive worktrees after active agents
    for (const entry of worktrees) {
      // skip unavailable or already-owned entries
      if (entry === undefined || checkedOut.has(entry.branch)) continue;
      const { candidate, branch, owner } = entry;
      branchOwners.set(branch, owner);
      checkedOut.set(branch, { worktreeId: candidate.id, worktreeName: candidate.label });
    }
    // list pull requests only for a supported GitHub origin
    const pullRequestsSupported = await this.pullRequests.supports(worktree.identity);
    // load slow remote metadata before taking the readiness snapshot
    const pullRequests = pullRequestsSupported ? await this.pullRequests.open(worktree.identity) : { own: [], others: [] };
    // apply worktree availability around each checkout branch
    const switchable = (choices: PullRequestChoice[]): SwitchablePullRequest[] => choices.map(pullRequest => {
      const branch = pullRequest.headOnOrigin ? pullRequest.branch : this.pullRequestBranch(pullRequest);
      return { ...pullRequest, checkoutBranch: branch, ...this.checkoutAnnotation(branch, checkedOut) };
    });
    const own = switchable(pullRequests.own);
    const others = switchable(pullRequests.others);
    const branches = await this.localBranches(
      worktree.identity,
      checkedOut,
      currentBranch,
      new Set([...own, ...others].map(pullRequest => pullRequest.checkoutBranch)),
      includeCommitSummaries,
      worktree.defaultBranch,
      branchOwners
    );
    // reflect git changes completed while remote and branch metadata were loading
    const enabled = await this.switchReady(worktree);
    return { enabled, pullRequests: own, otherPullRequests: others, branches, pullRequestsSupported };
  }

  // annotate one branch with the worktree that currently holds it
  private checkoutAnnotation(branch: string, checkedOut: Map<string, PullRequestWorktree | undefined>): { checkedOut: boolean; openIn?: PullRequestWorktree } {
    const openIn = checkedOut.get(branch);
    return { checkedOut: checkedOut.has(branch), ...(openIn === undefined ? {} : { openIn }) };
  }

  // list local branches outside the current branch and the shown pull requests, bounded for very large repositories
  private async localBranches(
    workspace: string,
    checkedOut: Map<string, PullRequestWorktree | undefined>,
    currentBranch: string,
    pullRequestBranches: Set<string>,
    includeCommitSummaries: boolean,
    defaultBranch: string | undefined,
    branchOwners: Map<string, BranchSummaryOwner>
  ): Promise<SwitchableBranch[]> {
    const listed = await this.command('/usr/bin/git', ['-C', workspace, 'for-each-ref', 'refs/heads', '--format=%(refname:short)']);
    // omit branches when the listing fails
    if (listed.code !== 0) return [];
    const branches: SwitchableBranch[] = [];
    for (const line of listed.stdout.split('\n')) {
      const branch = line.trim();
      // skip the current branch and any branch already offered as a pull request
      if (branch === '' || branch === currentBranch || pullRequestBranches.has(branch)) continue;
      branches.push({ branch, ...this.checkoutAnnotation(branch, checkedOut) });
      // cap the payload for repositories with very many local branches
      if (branches.length >= maxSwitchableBranches) break;
    }
    // keep mutation revalidation cheap while enriching display payloads in bounded batches
    if (!includeCommitSummaries) return branches;
    const deadline = Date.now() + branchSummaryBudgetMs;
    // bound concurrent history reads
    for (let index = 0; index < branches.length; index += branchSummaryConcurrency) {
      // stop scheduling batches once the shared budget expires
      if (Date.now() >= deadline) break;
      const batch = branches.slice(index, index + branchSummaryConcurrency);
      // resolve each branch independently
      const summaries = await Promise.all(batch.map(candidate => {
        const owner = branchOwners.get(candidate.branch);
        const summaryWorkspace = owner?.workspace ?? workspace;
        // read a checked-out branch in its own worktree so HEAD-reflog creation provenance remains available
        return branchCommitSummary(summaryWorkspace, candidate.branch, owner?.defaultBranch ?? defaultBranch, deadline).catch(error => {
          // report unexpected failures without dropping the branch
          console.warn(`[branch-switch] ${summaryWorkspace}: failed to summarize ${candidate.branch}`, error);
          return undefined;
        });
      }));
      // attach only resolved, positive commit summaries
      for (let offset = 0; offset < batch.length; offset += 1) {
        const summary = summaries[offset];
        // omit unavailable metadata without dropping the branch
        if (summary !== undefined) batch[offset]!.commitSummary = summary;
      }
    }
    return branches;
  }

  async actionsUrl(agentId: string): Promise<string | undefined> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return undefined;
    const worktree = this.worktree(target.agent.home);
    return await this.pullRequests.actionsUrl(worktree?.identity ?? target.agent.home);
  }

  // the Actions page of the GitHub repository checked out at one folder, with no Agent needed
  async actionsUrlAt(checkout: string): Promise<string | undefined> {
    return await this.pullRequests.actionsUrl(checkout);
  }

  async switch(worktreeId: string, number: number): Promise<BranchSwitchResult> {
    if (!Number.isInteger(number) || number < 1) return { error: 'That is not a valid pull request number.' };
    if (this.branchMutationInProgress) return { error: mutationInProgress };
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(worktreeId, false);
      if (available === undefined) return { error: switchingUnavailable };
      const pullRequest = available.pullRequests.find(candidate => candidate.number === number) ?? available.otherPullRequests.find(candidate => candidate.number === number);
      if (pullRequest === undefined) return { error: `Pull request #${number} is no longer open.` };
      if (pullRequest.checkedOut) return { error: alreadyCheckedOut(pullRequest.checkoutBranch, pullRequest.openIn) };
      if (!available.enabled) return { error: uncommittedChanges };
      return await this.runSwitch(worktreeId, pullRequest.checkoutBranch, workspace =>
        pullRequest.headOnOrigin ? this.switchBranchRef(workspace, pullRequest) : this.switchPullRequestRef(workspace, pullRequest));
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  // switch to one available local branch open in no other worktree
  async switchBranch(worktreeId: string, branch: string): Promise<BranchSwitchResult> {
    if (typeof branch !== 'string' || branch === '') return { error: 'No branch was named.' };
    if (this.branchMutationInProgress) return { error: mutationInProgress };
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(worktreeId, false);
      if (available === undefined) return { error: switchingUnavailable };
      // require the branch on the availability list, held by no other worktree
      const switchable = available.branches.find(candidate => candidate.branch === branch);
      if (switchable === undefined) return { error: `${branch} is not a local branch that can be checked out here.` };
      if (switchable.checkedOut) return { error: alreadyCheckedOut(branch, switchable.openIn) };
      if (!available.enabled) return { error: uncommittedChanges };
      return await this.runSwitch(worktreeId, branch, workspace => this.switchLocalBranch(workspace, branch));
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  // run one branch-changing git transaction in-process, gated on idle agents; perform returns an error message or undefined
  private async runSwitch(worktreeId: string, checkoutBranch: string, perform: (workspace: string) => Promise<string | undefined>): Promise<BranchSwitchResult> {
    const targetWorktree = worktreeById(this.discovery.worktreesNow(), worktreeId);
    if (targetWorktree === undefined) return { error: switchingUnavailable };
    // without job control a working agent cannot be interrupted for a checkout
    if (await this.busy(targetWorktree)) return 'busy';
    const currentBranch = await this.command('/usr/bin/git', ['-C', targetWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (currentBranch.code === 0 && currentBranch.stdout.trim() === checkoutBranch) return { error: `${checkoutBranch} is already checked out here.` };
    // a failed fetch or switch leaves the current branch untouched, so nothing to roll back
    const failure = await perform(targetWorktree.identity);
    if (failure !== undefined) return { error: failure };
    // verify HEAD reached the requested branch before reporting success
    const head = await this.command('/usr/bin/git', ['-C', targetWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    return head.code === 0 && head.stdout.trim() === checkoutBranch ? 'switched' : { error: `Git finished without checking out ${checkoutBranch}.` };
  }

  // move one occupied pull request into the requested worktree
  async move(worktreeId: string, number: number): Promise<PullRequestMoveResult> {
    // reject invalid or concurrent move requests
    if (!Number.isInteger(number) || number < 1 || this.branchMutationInProgress) return 'unavailable';
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(worktreeId, false);
      const pullRequest = [...(available?.pullRequests ?? []), ...(available?.otherPullRequests ?? [])].find(candidate => candidate.number === number);
      if (available === undefined || pullRequest === undefined) return 'unavailable';
      return await this.moveCheckedOutBranch(worktreeId, available.enabled, { branch: pullRequest.checkoutBranch, checkedOut: pullRequest.checkedOut, openIn: pullRequest.openIn });
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  // move one occupied local branch into the requested worktree
  async moveBranch(worktreeId: string, branch: string): Promise<PullRequestMoveResult> {
    // reject an empty or concurrent move request
    if (typeof branch !== 'string' || branch === '' || this.branchMutationInProgress) return 'unavailable';
    this.branchMutationInProgress = true;
    try {
      const available = await this.available(worktreeId, false);
      const switchable = available?.branches.find(candidate => candidate.branch === branch);
      if (available === undefined || switchable === undefined) return 'unavailable';
      return await this.moveCheckedOutBranch(worktreeId, available.enabled, switchable);
    } finally {
      this.branchMutationInProgress = false;
    }
  }

  private worktree(workspace: string): Worktree | undefined {
    return this.discovery.worktreesNow().find(worktree => worktreeMatchesWorkspace(worktree, workspace));
  }

  // whether any agent in the worktree is working; a worktree with no agent is never busy
  private async busy(worktree: Worktree): Promise<boolean> {
    return (await this.discovery.refresh()).some(agent => this.worktree(agent.home)?.id === worktree.id && agentAttentionState(agent) === 'working');
  }

  // switch/move readiness: a clean working tree, whether or not the branch is pushed
  private async switchReady(worktree: Worktree): Promise<boolean> {
    return await cleanWorkingTree(worktree.identity, this.command);
  }

  // resolve one linked-worktree repository identity
  private async repositoryIdentity(workspace: string): Promise<string | undefined> {
    const repository = await this.command('/usr/bin/git', ['-C', workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const path = repository.stdout.trim();
    // reject unreadable repository metadata
    if (repository.code !== 0 || !path.startsWith('/')) return undefined;
    try {
      const info = await stat(path, { bigint: true });
      return `inode:${info.dev}:${info.ino}`;
    } catch {
      // retain deterministic command-test identities
      return `path:${path}`;
    }
  }

  // transfer one checked-out branch and its working state, in-process, gated on idle agents
  private async moveCheckedOutBranch(worktreeId: string, enabled: boolean, movable: SwitchableBranch): Promise<PullRequestMoveResult> {
    const { branch: checkoutBranch, checkedOut, openIn } = movable;
    const targetWorktree = worktreeById(this.discovery.worktreesNow(), worktreeId);
    const sourceWorktree = openIn === undefined ? undefined : worktreeById(this.discovery.worktreesNow(), openIn.worktreeId);
    // require one ready destination and one resolvable source
    if (!enabled || !checkedOut || targetWorktree === undefined || sourceWorktree === undefined || sourceWorktree.id === targetWorktree.id) return 'unavailable';
    // without job control no agent in either worktree can be interrupted for a move
    if (await this.busy(targetWorktree) || await this.busy(sourceWorktree)) return 'busy';
    const sourceBranch = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    // revalidate the occupied branch immediately before mutation
    if (sourceBranch.code !== 0 || sourceBranch.stdout.trim() !== checkoutBranch) return 'unavailable';
    try {
      return await this.performMove(sourceWorktree, targetWorktree, checkoutBranch);
    } catch {
      return 'recovery-required';
    }
  }

  // execute the git transaction after both agents pause
  private async performMove(sourceWorktree: Worktree, targetWorktree: Worktree, checkoutBranch: string): Promise<PullRequestMoveResult> {
    const [sourceRepository, targetRepository] = await Promise.all([this.repositoryIdentity(sourceWorktree.identity), this.repositoryIdentity(targetWorktree.identity)]);
    // prevent branch-name collisions across repositories
    if (sourceRepository === undefined || sourceRepository !== targetRepository) return 'unavailable';
    const sourceBranch = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    // close the source branch race after suspension
    if (sourceBranch.code !== 0 || sourceBranch.stdout.trim() !== checkoutBranch) return 'unavailable';
    // close the destination readiness race after suspension
    if (!await this.switchReady(targetWorktree)) return 'unavailable';
    const targetHead = await this.gitHead(targetWorktree.identity);
    // preserve an exact destination rollback point
    if (targetHead === undefined) return 'unavailable';

    const sourceStatus = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'status', '--porcelain=v1', '--untracked-files=all']);
    // refuse unreadable source state
    if (sourceStatus.code !== 0) return 'unavailable';
    let stashOid: string | undefined;
    // capture all tracked and untracked source changes
    if (sourceStatus.stdout.trim()) {
      const stashMessage = `rac move ${randomUUID()} ${checkoutBranch}`;
      const stashed = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'stash', 'push', '--include-untracked', '--message', stashMessage]);
      if (stashed.code !== 0) return 'unavailable';
      const stashes = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'stash', 'list', '--format=%H%x09%gs']);
      const matching = stashes.stdout.split('\n').map(line => line.split('\t')).find(([, subject]) => subject?.endsWith(stashMessage));
      // identify only the uniquely named stash created by this move
      if (stashes.code !== 0 || matching === undefined || !/^[0-9a-f]{40}$/u.test(matching[0] ?? '')) {
        const afterStash = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'status', '--porcelain=v1', '--untracked-files=all']);
        // distinguish a no-op stash from hidden changes
        return afterStash.code === 0 && afterStash.stdout === sourceStatus.stdout ? 'unavailable' : 'recovery-required';
      }
      stashOid = matching[0];
      const cleanSource = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'status', '--porcelain=v1', '--untracked-files=all']);
      // restore the stash if unsupported source state remains
      if (cleanSource.code !== 0 || cleanSource.stdout.trim()) return await this.applyAndDropStash(sourceWorktree.identity, stashOid) ? 'unavailable' : 'recovery-required';
    }

    const detached = await this.command('/usr/bin/git', ['-C', sourceWorktree.identity, 'switch', '--detach']);
    // restore source changes when detaching fails
    if (detached.code !== 0) {
      if (stashOid === undefined) return 'unavailable';
      return await this.applyAndDropStash(sourceWorktree.identity, stashOid) ? 'unavailable' : 'recovery-required';
    }
    const switched = await this.command('/usr/bin/git', ['-C', targetWorktree.identity, 'switch', '--', checkoutBranch]);
    // roll back both worktrees when checkout fails
    if (switched.code !== 0) {
      return await this.rollbackMove(sourceWorktree, targetWorktree, checkoutBranch, targetHead, stashOid, false) ? 'unavailable' : 'recovery-required';
    }
    // recover the source index and working tree at the destination
    if (stashOid !== undefined && !await this.applyAndDropStash(targetWorktree.identity, stashOid)) {
      return await this.rollbackMove(sourceWorktree, targetWorktree, checkoutBranch, targetHead, stashOid, true) ? 'unavailable' : 'recovery-required';
    }
    return 'moved';
  }
  // capture one branch or detached rollback point
  private async gitHead(workspace: string): Promise<GitHead | undefined> {
    const branch = await this.command('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    const commit = await this.command('/usr/bin/git', ['-C', workspace, 'rev-parse', '--verify', 'HEAD^{commit}']);
    // require a concrete current commit
    if (commit.code !== 0 || !/^[0-9a-f]{40}$/u.test(commit.stdout.trim())) return undefined;
    return { ...(branch.code === 0 && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}), commit: commit.stdout.trim() };
  }

  // apply one exact stash and remove only its matching entry
  private async applyAndDropStash(workspace: string, oid: string): Promise<boolean> {
    const applied = await this.command('/usr/bin/git', ['-C', workspace, 'stash', 'apply', '--index', oid]);
    // retain the stash for manual recovery after conflicts
    if (applied.code !== 0) return false;
    const list = await this.command('/usr/bin/git', ['-C', workspace, 'stash', 'list', '--format=%gd%x09%H']);
    // keep successful recovery even if stash cleanup is unavailable
    if (list.code !== 0) return true;
    const matching = list.stdout.split('\n').map(line => line.split('\t')).find(([, hash]) => hash === oid)?.[0];
    // drop only the exact recovered stash
    if (matching !== undefined) await this.command('/usr/bin/git', ['-C', workspace, 'stash', 'drop', matching]);
    return true;
  }

  // restore both worktrees after a failed destination change
  private async rollbackMove(source: Worktree, target: Worktree, branch: string, targetHead: GitHead, stashOid: string | undefined, cleanTarget: boolean): Promise<boolean> {
    let recovered = true;
    // discard only changes introduced by a failed stash apply
    if (cleanTarget) {
      const reset = await this.command('/usr/bin/git', ['-C', target.identity, 'reset', '--hard', 'HEAD']);
      const cleaned = await this.command('/usr/bin/git', ['-C', target.identity, 'clean', '-fd']);
      recovered = reset.code === 0 && cleaned.code === 0;
    }
    const restoreTarget = targetHead.branch === undefined
      ? ['-C', target.identity, 'switch', '--detach', targetHead.commit]
      : ['-C', target.identity, 'switch', '--', targetHead.branch];
    const restoredTarget = await this.command('/usr/bin/git', restoreTarget);
    recovered = restoredTarget.code === 0 && recovered;
    const restoredSource = await this.command('/usr/bin/git', ['-C', source.identity, 'switch', '--', branch]);
    // recover source changes only after its branch returns
    recovered = restoredSource.code === 0 && recovered;
    if (restoredSource.code === 0 && stashOid !== undefined) recovered = await this.applyAndDropStash(source.identity, stashOid) && recovered;
    const currentTarget = await this.gitHead(target.identity);
    const currentSource = await this.command('/usr/bin/git', ['-C', source.identity, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    const targetStatus = await this.command('/usr/bin/git', ['-C', target.identity, 'status', '--porcelain=v1', '--untracked-files=all']);
    // verify both branch coordinates after best-effort rollback
    return recovered && currentTarget?.commit === targetHead.commit && currentTarget.branch === targetHead.branch && currentSource.code === 0 && currentSource.stdout.trim() === branch && targetStatus.code === 0 && !targetStatus.stdout.trim();
  }

  // derive one app-owned local branch
  private pullRequestBranch(pullRequest: PullRequestChoice): string { return `rac/pr/${pullRequest.number}/${pullRequest.headSha.slice(0, 12)}`; }

  // switch one existing local branch without touching origin
  private async switchLocalBranch(workspace: string, branch: string): Promise<string | undefined> {
    return gitFailure(workspace, 'switch', await this.command('/usr/bin/git', ['-C', workspace, 'switch', '--', branch]));
  }

  // fetch one SHA-pinned origin branch and check out its tracking local branch
  private async switchBranchRef(workspace: string, pullRequest: SwitchablePullRequest): Promise<string | undefined> {
    const fetchedRef = `refs/remotes/origin/${pullRequest.branch}`;
    return await this.fetchAndSwitch(workspace, pullRequest, `refs/heads/${pullRequest.branch}:${fetchedRef}`, fetchedRef, ['--track', fetchedRef]);
  }

  // fetch one SHA-pinned GitHub pull request ref and check out its local branch
  private async switchPullRequestRef(workspace: string, pullRequest: SwitchablePullRequest): Promise<string | undefined> {
    const fetchedRef = `refs/rac/pull/${pullRequest.number}`;
    return await this.fetchAndSwitch(workspace, pullRequest, `refs/pull/${pullRequest.number}/head:${fetchedRef}`, fetchedRef, ['--no-track', fetchedRef]);
  }

  // fetch a pinned ref, verify it is the reviewed head, then switch to its local branch, creating it when absent
  private async fetchAndSwitch(workspace: string, pullRequest: SwitchablePullRequest, fetchSpec: string, fetchedRef: string, createArgs: string[]): Promise<string | undefined> {
    const { headSha, checkoutBranch: localBranch } = pullRequest;
    const fetched = await this.command('/usr/bin/git', ['-C', workspace, 'fetch', 'origin', '--no-tags', '--force', fetchSpec]);
    const fetchFailure = gitFailure(workspace, 'fetch', fetched);
    if (fetchFailure !== undefined) return `Pull request #${pullRequest.number} could not be fetched from origin. ${fetchFailure}`;
    // require the fetched ref to pin the exact reviewed head before mutating the checkout
    if (!await this.commitMatches(workspace, `${fetchedRef}^{commit}`, headSha)) return `Pull request #${pullRequest.number} changed on GitHub after it was listed. Reopen the list and try again.`;
    const existing = await this.command('/usr/bin/git', ['-C', workspace, 'show-ref', '--verify', '--quiet', `refs/heads/${localBranch}`]);
    if (existing.code === 0) {
      // reuse an existing local branch only when it already matches the reviewed head
      if (!await this.commitMatches(workspace, `refs/heads/${localBranch}^{commit}`, headSha)) return `The local branch ${localBranch} differs from the pull request head. Update or delete it, then try again.`;
      return gitFailure(workspace, 'switch', await this.command('/usr/bin/git', ['-C', workspace, 'switch', '--', localBranch]));
    }
    return gitFailure(workspace, 'switch', await this.command('/usr/bin/git', ['-C', workspace, 'switch', '-c', localBranch, ...createArgs]));
  }

  // whether one revision resolves to the exact commit
  private async commitMatches(workspace: string, revision: string, sha: string): Promise<boolean> {
    const resolved = await this.command('/usr/bin/git', ['-C', workspace, 'rev-parse', '--verify', '--quiet', revision]);
    return resolved.code === 0 && resolved.stdout.trim() === sha;
  }
}
