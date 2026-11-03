import type { Dashboard, Worktree } from '../domain/models.js';
import type { DiscoveryService } from '../discovery/service.js';

// a Worktree as a review sees it: its checkout, the branch its stored tour is filed under, and the
// merge target the dashboard resolved for it
export type ResolvedWorkspace = { worktree: Worktree; workspace: string; branch?: string; prBase?: string };

// whether a folder is exactly this Worktree — the console path (`identity`), or the host path
// (`hostPath`) under the bridge — never a prefix. An Agent's `home` is already its Place's
// folder (discovery applies the nearest-Place rule, places/places.ts), so an exact match
// finds the Worktree an Agent belongs to
export function worktreeMatchesWorkspace(worktree: Pick<Worktree, 'identity' | 'hostPath'>, workspace: string): boolean {
  return workspace === worktree.identity || workspace === worktree.hostPath;
}

// the Worktree wire id `<projectId>:<realpath>` (ADR 0003) — the single derivation
// discovery and the Add flow share, so a hand-built id can never drift from discovery's
export function worktreeWireId(projectId: string, realpath: string): string {
  return `${projectId}:${realpath}`;
}

// the Project id embedded in a Worktree wire id `<projectId>:<realpath>` (ADR 0003); a
// key with no `:` (a bare `<projectId>` or the `scratch` group) is returned unchanged
export function projectIdOf(worktreeKey: string): string {
  const colon = worktreeKey.indexOf(':');
  return colon === -1 ? worktreeKey : worktreeKey.slice(0, colon);
}

// the realpath embedded in a Worktree wire id `<projectId>:<realpath>` (ADR 0003), or
// undefined for a key with no `:` (a bare `<projectId>` scope or the `scratch` group). The
// counterpart to `projectIdOf`, so the wire-id format stays owned by this module.
export function worktreePathOf(worktreeKey: string): string | undefined {
  const colon = worktreeKey.indexOf(':');
  return colon === -1 ? undefined : worktreeKey.slice(colon + 1);
}

// one discovered Worktree by its wire id `<projectId>:<realpath>` — the single by-id
// resolver every service shares over the current `discovery.worktreesNow()` snapshot
export function worktreeById(worktrees: readonly Worktree[], id: string): Worktree | undefined {
  return worktrees.find(worktree => worktree.id === id);
}

// the worktree root as the launching/command host sees it: the bridge host path when
// the worktree is mounted from the host, else the console's own git toplevel
export function worktreeHostRoot(worktree: Pick<Worktree, 'identity' | 'hostPath'>): string {
  return worktree.hostPath ?? worktree.identity;
}

// A console-side path as the launching/command host sees it: one inside the Worktree's
// checkout is moved onto its host root. One outside it needs no moving where the console and the
// host see the checkout at the same path; a bridged checkout seen elsewhere gives no host path
// for it. A Linked worktree carries no host path, since the console manages Linked worktrees only
// where it sees their Project at its host path (ADR 0003).
export function worktreeHostPath(worktree: Pick<Worktree, 'identity' | 'hostPath'>, path: string): string | undefined {
  const host = worktreeHostRoot(worktree);
  if (path === worktree.identity || path.startsWith(`${worktree.identity}/`)) return `${host}${path.slice(worktree.identity.length)}`;
  return host === worktree.identity ? path : undefined;
}

// the merge target the dashboard already resolved for one Worktree — from its live Agent when it has
// one, else from the idle Worktree view — so a worktree-scoped consumer's All PR base equals what the
// dashboard flyout shows. The single place that reads a worktree's resolved PR base off the dashboard.
// null preserves an unavailable PR base instead of enabling unrelated fallbacks
export function worktreePrBase(dashboard: Dashboard, worktreeId: string): string | null | undefined {
  const agent = dashboard.agents.find(candidate => candidate.worktreeId === worktreeId && (candidate.gitPrStatus !== undefined || candidate.pullRequest !== undefined));
  // prefer the live workspace's resolved or unavailable PR base
  if (agent !== undefined) return agent.gitPrStatus?.base ?? null;
  // inspect idle workspaces when no live metadata is available
  for (const project of dashboard.projects) {
    const view = project.worktrees.find(candidate => candidate.id === worktreeId);
    // retain a known PR even when its base could not resolve
    if (view?.gitPrStatus !== undefined || view?.pullRequest !== undefined) return view.gitPrStatus?.base ?? null;
  }
  return undefined;
}

// resolve one unambiguous configured workspace
export function configuredWorktreeForWorkspace(worktrees: Worktree[], workspace: string): Worktree | undefined {
  const matches = worktrees.filter(candidate => worktreeMatchesWorkspace(candidate, workspace));
  return matches.length === 1 ? matches[0] : undefined;
}

// the branch a Worktree is on: its live Agent's, else the idle Worktree view's
export function worktreeBranch(dashboard: Dashboard, worktreeId: string): string | undefined {
  return dashboard.agents.find(agent => agent.worktreeId === worktreeId)?.branch ?? dashboard.projects.flatMap(project => project.worktrees).find(worktree => worktree.id === worktreeId)?.branch;
}

// resolve one discovered Worktree by id, enriched with the dashboard's branch and merge target.
// Worktrees come from discovery, which owns `git worktree list` (ADR 0003).
export async function resolveConfiguredWorkspace(discovery: DiscoveryService, worktreeId: string): Promise<ResolvedWorkspace | undefined> {
  const worktree = worktreeById(discovery.worktreesNow(), worktreeId);
  if (worktree === undefined) return undefined;
  const dashboard = await discovery.dashboard();
  const branch = worktreeBranch(dashboard, worktree.id);
  const prBase = worktreePrBase(dashboard, worktree.id) ?? undefined;
  return { worktree, workspace: worktree.identity, ...(branch === undefined ? {} : { branch }), ...(prBase === undefined ? {} : { prBase }) };
}

// whether the Worktree is still discovered at the same checkout, before publishing
export function sameConfiguredWorkspace(discovery: DiscoveryService, expected: ResolvedWorkspace): boolean {
  return worktreeById(discovery.worktreesNow(), expected.worktree.id)?.identity === expected.workspace;
}
