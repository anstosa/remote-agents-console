type GithubItemKind = 'pull' | 'issue';

export type GithubItemIdentity = {
  repositoryKey: string;
  kind: GithubItemKind;
  number: number;
};

type GithubDashboardWorktree = {
  id: string;
  projectId: string;
  label: string;
  available: boolean;
  main: boolean;
  detached?: boolean;
  locked?: boolean;
};

export type GithubDashboardProject = {
  id: string;
  label: string;
  github?: string;
  githubForkOf?: string;
  available: boolean;
  manageWorktrees?: boolean;
  manageWorktreesReason?: string;
  worktrees: GithubDashboardWorktree[];
};

export type GithubTarget = {
  project: GithubDashboardProject;
  worktree: GithubDashboardWorktree;
};

export type GithubItemContext = {
  identity: GithubItemIdentity;
  matchingProjects: GithubDashboardProject[];
  detailProject?: GithubDashboardProject;
  holder?: GithubTarget;
  owner?: GithubTarget;
  sameRepository: boolean;
  heldHere: boolean;
  existingTargets: GithubTarget[];
};

type GithubPullMutationContext = {
  identity: GithubItemIdentity & { kind: 'pull' };
  targetProjectId: string;
  targetWorktreeId?: string;
  expectedHolderWorktreeIds: string[];
  expectedSourceWorktreeId?: string;
};

export type GithubNewWorktreeContext = {
  identity: GithubItemIdentity;
  targetProjectId: string;
  expectedHolderWorktreeIds: string[];
  expectedSourceWorktreeId?: string;
};

// accept only canonical github owner/name shapes
export function normalizeGithubRepository(value: string | undefined): string | undefined {
  // require a value before normalization
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  // reject malformed or multi-segment names
  if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized)) return undefined;
  return normalized;
}

// build one identity at every list boundary
export function githubItemIdentity(repository: string, kind: GithubItemKind, number: number): GithubItemIdentity | undefined {
  const repositoryKey = normalizeGithubRepository(repository);
  // reject incomplete identities
  if (repositoryKey === undefined || !Number.isInteger(number) || number < 1) return undefined;
  return { repositoryKey, kind, number };
}

// keep every local association repository-aware
export const githubItemKey = (identity: GithubItemIdentity): string => `${identity.repositoryKey}\u0000${identity.kind}\u0000${identity.number}`;

// compare normalized identities without relying on object ownership
export const sameGithubItem = (left: GithubItemIdentity | undefined, right: GithubItemIdentity | undefined): boolean => left !== undefined && right !== undefined && githubItemKey(left) === githubItemKey(right);

type ItemDestination = { kind: 'worktree' | 'project'; worktreeId: string } | undefined;

// resolve one stable worktree id back to its exact project binding
export function githubTargetByWorktree(projects: readonly GithubDashboardProject[], worktreeId: string | undefined): GithubTarget | undefined {
  // skip missing destinations
  if (worktreeId === undefined) return undefined;
  // preserve dashboard order while finding an exact id
  for (const project of projects) {
    const worktree = project.worktrees.find(candidate => candidate.id === worktreeId && candidate.projectId === project.id);
    // bind the worktree to its owning project
    if (worktree !== undefined) return { project, worktree };
  }
  return undefined;
}

// fork hints make upstream targets visible; the server re-proves them before every mutation
export function projectMatchesGithubRepository(project: Pick<GithubDashboardProject, 'github' | 'githubForkOf'>, repository: string): boolean {
  const origin = normalizeGithubRepository(project.github);
  const wanted = normalizeGithubRepository(repository);
  // a parent hint without a real origin cannot identify a local repository
  if (origin === undefined || wanted === undefined) return false;
  return origin === wanted || normalizeGithubRepository(project.githubForkOf) === wanted;
}

// choose the exact project and destinations for one normalized item
export function resolveGithubItemContext({ identity, destination, projects, ownerProjectId, ownerWorktreeId }: { identity: GithubItemIdentity; destination?: ItemDestination; projects: readonly GithubDashboardProject[]; ownerProjectId?: string; ownerWorktreeId?: string }): GithubItemContext {
  const matchingProjects = projects.filter(project => projectMatchesGithubRepository(project, identity.repositoryKey));
  const matchingIds = new Set(matchingProjects.map(project => project.id));
  const ownerCandidate = githubTargetByWorktree(projects, ownerWorktreeId);
  const owner = ownerCandidate?.project.id === ownerProjectId ? ownerCandidate : undefined;
  const destinationTarget = githubTargetByWorktree(projects, destination?.worktreeId);
  const holder = destination?.kind === 'worktree' && destinationTarget !== undefined && matchingIds.has(destinationTarget.project.id) ? destinationTarget : undefined;
  const destinationProject = destinationTarget !== undefined && matchingIds.has(destinationTarget.project.id) ? destinationTarget.project : undefined;
  const ownerProject = matchingProjects.find(project => project.id === ownerProjectId);
  const detailProject = holder?.project
    ?? ownerProject
    ?? destinationProject
    ?? matchingProjects.find(project => project.available && project.manageWorktrees !== false)
    ?? matchingProjects.find(project => project.available)
    ?? matchingProjects[0];
  const existingTargets = matchingProjects.flatMap(project => project.worktrees.map(worktree => ({ project, worktree })));
  const sameRepository = owner !== undefined && projectMatchesGithubRepository(owner.project, identity.repositoryKey);
  const heldHere = holder !== undefined && owner !== undefined && holder.project.id === owner.project.id && holder.worktree.id === owner.worktree.id;
  return { identity, matchingProjects, detailProject, holder, owner, sameRepository, heldHere, existingTargets };
}

// construct the assertion sent with every unified-panel pull mutation
export function githubPullMutationContext(context: GithubItemContext, target: GithubTarget): GithubPullMutationContext {
  const identity = { ...context.identity, kind: 'pull' as const };
  const expectedHolderWorktreeIds = context.holder === undefined ? [] : [context.holder.worktree.id];
  return {
    identity,
    targetProjectId: target.project.id,
    targetWorktreeId: target.worktree.id,
    expectedHolderWorktreeIds,
    ...(context.holder === undefined ? {} : { expectedSourceWorktreeId: context.holder.worktree.id })
  };
}

// construct the exact project/source binding for the worktree dialog
export function githubNewWorktreeContext(context: GithubItemContext, project: GithubDashboardProject): GithubNewWorktreeContext {
  const expectedHolderWorktreeIds = context.holder === undefined ? [] : [context.holder.worktree.id];
  return {
    identity: context.identity,
    targetProjectId: project.id,
    expectedHolderWorktreeIds,
    ...(context.holder === undefined ? {} : { expectedSourceWorktreeId: context.holder.worktree.id })
  };
}
