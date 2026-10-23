import { basename, dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Project, Worktree } from '../domain/models.js';
import { projectIdOf, worktreePathOf, worktreeWireId } from '../workspaces/resolver.js';

// the reserved Project id every Scratch Place id carries (`scratch:<realpath>`); config
// refuses a Project with this id, so a Scratch Place id never collides with a Project's
export const scratchProjectId = 'scratch';
// the label of the configured Scratch folder, as its launched Agents are labelled
export const scratchPlaceLabel = '~ Scratch';

export type PlaceKind = 'worktree' | 'directory' | 'scratch';

/**
 * Where a Workspace lives and what its panes belong to: a Worktree, a non-git directory
 * Project, or a Scratch folder. `id` is `<projectId>:<realpath of home>` for every kind
 * (a Worktree's is its existing wire id); `home` is the console-side folder, and
 * `hostPath` the host-side one under the Docker bridge. Built fresh from the discovered
 * Worktrees and config, never stored.
 */
export type Place = { id: string; kind: PlaceKind; projectId: string; label: string; home: string; hostPath?: string; adhoc?: true };

// the configured Places, in the order a tie between equally deep homes resolves: Worktrees,
// then directory Projects, then the configured Scratch folder
export function configuredPlaces(worktrees: readonly Worktree[], projects: readonly Project[], scratchHome: string): Place[] {
  const places: Place[] = worktrees.map(worktreePlace);
  for (const project of projects) {
    if (!project.available || project.mode !== 'directory') continue;
    places.push({ id: worktreeWireId(project.id, project.identity), kind: 'directory', projectId: project.id, label: project.label, home: project.identity, ...(project.hostPath === undefined ? {} : { hostPath: project.hostPath }) });
  }
  places.push({ id: worktreeWireId(scratchProjectId, scratchHome), kind: 'scratch', projectId: scratchProjectId, label: scratchPlaceLabel, home: scratchHome });
  return places;
}

// a Worktree as a Place: its wire id, its git identity as home, its bridge host path
export function worktreePlace(worktree: Worktree): Place {
  return { id: worktree.id, kind: 'worktree', projectId: worktree.projectId, label: worktree.label, home: worktree.identity, ...(worktree.hostPath === undefined ? {} : { hostPath: worktree.hostPath }) };
}

// the Scratch Place of a folder inside no configured Place, or opened below the configured Scratch
// folder, labelled with its basename; `adhoc` tells it from the configured Scratch folder, which
// alone has a launch of its own
export function adhocScratchPlace(root: string): Place {
  return { id: worktreeWireId(scratchProjectId, root), kind: 'scratch', projectId: scratchProjectId, label: basename(root) || root, home: root, adhoc: true };
}

// the Place folder as the launching host sees it: the bridge host path, else the home
export function placeHostRoot(place: Pick<Place, 'home' | 'hostPath'>): string {
  return place.hostPath ?? place.home;
}

// the length of the Place folder that contains `root` (itself or an ancestor), else -1
function containment(folder: string | undefined, root: string): number {
  if (folder === undefined) return -1;
  if (root === folder) return folder.length;
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  return root.startsWith(prefix) ? folder.length : -1;
}

// The Place a pane belongs to, from its root (git toplevel, else canonical cwd): the deepest
// Place whose home, or bridge host path, is the root or one of its ancestors, so a nested
// checkout joins the Worktree around it unless it is a deeper Place itself. A root inside
// no configured Place is its own Scratch Place. How discovery claims an unmarked tmux session
// once; a marked session's panes follow its mark (`markedPlace`), wherever they have `cd`'d.
export function placeForRoot(places: readonly Place[], root: string): Place {
  let nearest: Place | undefined;
  let depth = -1;
  for (const place of places) {
    const matched = Math.max(containment(place.home, root), containment(place.hostPath, root));
    // strictly deeper only, so the earlier Place wins a tie
    if (matched > depth) { nearest = place; depth = matched; }
  }
  return nearest ?? adhocScratchPlace(root);
}

// The Place a tmux session's `@rac_place` mark names: a configured Place by id, else the ad-hoc
// Scratch Place of a `scratch:<root>` whose root still lies in no configured Place, or only in the
// configured Scratch folder (a folder opened there, which a claim never marks). Undefined for
// a mark naming no Place now (a Worktree the snapshot has not caught up to, or one since removed):
// its session belongs nowhere until the mark resolves, and is never re-claimed.
export function markedPlace(places: readonly Place[], mark: string): Place | undefined {
  const configured = places.find(place => place.id === mark);
  if (configured !== undefined) return configured;
  const root = worktreePathOf(mark);
  if (projectIdOf(mark) !== scratchProjectId || root === undefined) return undefined;
  const place = placeForRoot(places, root);
  if (place.id === mark) return place;
  return place.kind === 'scratch' && place.adhoc !== true ? adhocScratchPlace(root) : undefined;
}

// The notes key of a folder that is no Worktree: `scratch_<hash>`, never the Place id, since a
// note key cannot hold `:`. An agent's notes are keyed by its pane root, which is the Place home
// for a console launch; a directory Project launches in its bridge host path when it has one.
export function folderNoteKey(folder: string): string {
  return `scratch_${createHash('sha256').update(folder).digest('base64url').slice(0, 40)}`;
}
// a Place's notes key: a Worktree's notes are Project-scoped (ADR 0003), any other Place's are
// keyed by the folder its console-launched Agent runs in
export function placeNoteKey(place: Pick<Place, 'kind' | 'projectId' | 'home' | 'hostPath'>): string {
  return place.kind === 'worktree' ? place.projectId : folderNoteKey(placeHostRoot(place));
}

// the launch-profile store key a Place's last-used kind lives under: a Worktree's own id, a
// directory Project's Project id (as its launches remember it), a Scratch Place's own id
export function placeLaunchScope(place: Pick<Place, 'id' | 'kind' | 'projectId'>): string {
  return place.kind === 'directory' ? place.projectId : place.id;
}

// the account home a launch exports as HOME: the parent of the bridged Project's host path
// under Docker (the Project named, else the first bridged one), else this process's HOME
export function accountHome(projects: readonly Project[], projectId?: string): string {
  const project = projectId === undefined
    ? projects.find(candidate => candidate.hostPath !== undefined)
    : projects.find(candidate => candidate.id === projectId);
  const hostPath = project?.hostPath;
  return hostPath === undefined ? process.env.HOME ?? '/' : dirname(hostPath);
}

// The configured Scratch folder's home: `scratchDirectory`, else the account home, realpath'd
// so pane roots (which are realpaths) compare equal. Unset, the account home is the Scratch
// home, so every stray pane under it that is outside a Project lands in that one Place.
export async function scratchHome(scratchDirectory: string | undefined, projects: readonly Project[]): Promise<string> {
  const folder = scratchDirectory ?? accountHome(projects);
  return await realpath(folder).catch(() => folder);
}
