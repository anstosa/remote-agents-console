import { lstat, realpath, readFile, readdir } from 'node:fs/promises';
import { getuid } from 'node:process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { run } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { ProcInspector, type ProcessInspector } from './processes.js';
import { PullRequestService } from '../pull-requests/service.js';
import { messageAsksQuestion, parseReportedAttention, resolveAttention } from '../adapters/attention.js';
import { adapterCapabilities, adapterFor, adapters, paneExcluded } from '../adapters/registry.js';
import { projectIdOf, worktreeMatchesWorkspace, worktreePathOf, worktreeWireId } from '../workspaces/resolver.js';
import { gitCommonDir, listWorktrees, type WorktreeEntry } from '../git/worktrees.js';
import { worktreeManagementAvailability } from '../worktrees/management.js';
import type { WorktreeLaunchStore } from '../worktrees/store.js';
import type { Adapter, AdapterConfigs, AgentKind, AttentionState, Conversation, ConversationSummary, InlineQuestion } from '../adapters/types.js';
import type { Agent, Dashboard, DashboardPlace, DashboardProject, DashboardWorktree, GitComparisonSummary, GitStatusSummary, GitUpstreamSummary, Pane, Project, SocketRef, Worktree } from '../domain/models.js';
import { addUntrackedLineStats, comparisonAgainst, prComparisonCandidates, workingStatus } from '../git/comparison.js';
import { isUpdateAdvisorLabel } from '../update-advisor.js';
import { configuredPlaces, markedPlace, placeForRoot, scratchHome, scratchProjectId, type Place } from '../places/places.js';
import { implicitProject } from '../config/schema.js';

export interface SocketFinder { find(): Promise<SocketRef[]>; }
export class ProcSocketFinder implements SocketFinder {
  private async socket(path: string, uid: number): Promise<SocketRef | undefined> {
    try {
      const info = await lstat(path);
      if (!info.isSocket() || info.uid !== uid) return undefined;
      const canonical = await realpath(path).catch(() => path);
      const key = `${canonical}:${info.dev}:${info.ino}`;
      return { fingerprint: createHash('sha256').update(key).digest('base64url').slice(0, 22), path: canonical, device: Number(info.dev), inode: Number(info.ino) };
    } catch { return undefined; }
  }

  async find(): Promise<SocketRef[]> {
    const uid = getuid?.();
    if (uid === undefined) throw new Error('Linux UID is required');
    const mountedSocketRoot = process.env.RAC_HOST_TMUX_DIR;
    if (mountedSocketRoot !== undefined) {
      const entries = await readdir(mountedSocketRoot, { withFileTypes: true }).catch(() => []);
      const sockets = (await Promise.all(entries.map(entry => this.socket(join(mountedSocketRoot, entry.name), uid)))).filter((socket): socket is SocketRef => socket !== undefined);
      if (sockets.length > 0) return sockets;
    }

    const procRoot = process.env.RAC_HOST_PROC ?? '/proc';
    const hostUid = process.env.RAC_HOST_UID ?? String(uid);
    const hostSocketRoot = process.env.RAC_HOST_TMUX_SOURCE ?? `/tmp/tmux-${hostUid}`;
    const unixSockets = process.env.RAC_HOST_UNIX_SOCKETS ?? `${procRoot}/net/unix`;
    const text = await readFile(unixSockets, 'utf8');
    const sockets: SocketRef[] = [];
    const seen = new Set<string>();
    for (const row of text.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 8 && parts[7]?.startsWith('/'))) {
      const hostPath = row[7]!;
      // Probe only tmux's own socket directory. Other services' sockets accept
      // the connection but never answer the tmux handshake, so each one would
      // block list-panes until the command timeout.
      if (!hostPath.startsWith(`${hostSocketRoot}/`)) continue;
      const path = mountedSocketRoot !== undefined ? join(mountedSocketRoot, hostPath.slice(hostSocketRoot.length)) : hostPath;
      const socket = await this.socket(path, uid);
      if (socket === undefined) continue;
      const key = `${socket.path}:${socket.device}:${socket.inode}`;
      if (!seen.has(key)) { seen.add(key); sockets.push(socket); }
    }
    return sockets;
  }
}
// compare the working tree with its merge target
async function gitPrComparison(workspace: string, branch: string | undefined, working: GitStatusSummary | undefined, prBase?: string, defaultBranch?: string): Promise<GitComparisonSummary | undefined> {
  const candidates = await prComparisonCandidates(workspace, branch, prBase, defaultBranch);
  const untracked = working?.changes?.filter(change => change.code === '??') ?? [];
  return (await comparisonAgainst(workspace, candidates, untracked))?.comparison;
}
type GitCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;
// compare HEAD with the current branch's configured upstream
export async function gitUpstreamSummary(workspace: string, command: GitCommand = run): Promise<GitUpstreamSummary | undefined> {
  const upstream = await command('/usr/bin/git', ['-C', workspace, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const name = upstream.code === 0 ? upstream.stdout.trim() : '';
  // detached, untracked, and gone upstreams do not produce a rebase prompt
  if (!name || /[\u0000-\u001f\u007f]/u.test(name) || name.length > 512) return undefined;
  const counts = await command('/usr/bin/git', ['-C', workspace, 'rev-list', '--left-right', '--count', `HEAD...${name}`]);
  const match = counts.code === 0 ? /^(\d+)\s+(\d+)$/u.exec(counts.stdout.trim()) : undefined;
  if (match == null) return undefined;
  const ahead = Number(match[1]);
  const behind = Number(match[2]);
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return undefined;
  return { upstream: name, ahead, behind };
}
type GitMeta = { workspace: string; branch?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary };
// retain one pending or completed root lookup until expiry
type RootLookup = { expiresAt: number; value: Promise<string> };
// discovery requires both PR reads and checkout invalidation
type PullRequestLookup = Pick<PullRequestService, 'cachedPullRequest' | 'invalidateRepositories'>;
// resolve one pane path to its repository root
export async function workspaceRoot(path: string): Promise<string> {
  const canonical = await realpath(path).catch(() => path);
  const root = await run('/usr/bin/git', ['-C', canonical, 'rev-parse', '--show-toplevel']);
  return root.code === 0 ? root.stdout.trim() : canonical;
}
// collect branch metadata
async function gitMeta(path: string, rootKnown = false, defaultBranch?: string): Promise<GitMeta> {
  const workspace = rootKnown ? path : await workspaceRoot(path);
  const [symbolicBranch, gitStatus] = await Promise.all([
    run('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--short', 'HEAD']),
    workingStatus(workspace, { lineStats: true })
  ]);
  // enrich untracked line counts
  if (gitStatus !== undefined) await addUntrackedLineStats(workspace, gitStatus);
  const branch = symbolicBranch.code === 0 ? symbolicBranch.stdout.trim() : undefined;
  const [gitPrStatus, gitUpstream] = await Promise.all([
    gitPrComparison(workspace, branch, gitStatus, undefined, defaultBranch),
    branch === undefined ? Promise.resolve(undefined) : gitUpstreamSummary(workspace)
  ]);
  // return symbolic branches directly
  if (branch !== undefined) return { workspace, branch, ...(gitStatus === undefined ? {} : { gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(gitUpstream === undefined ? {} : { gitUpstream }) };
  const sha = await run('/usr/bin/git', ['-C', workspace, 'rev-parse', '--short', 'HEAD']);
  return { workspace, ...(sha.code === 0 ? { branch: sha.stdout.trim() } : {}), ...(gitStatus === undefined ? {} : { gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }) };
}
export class DiscoveryService {
  private generation = 0; private snapshot: Agent[] = [];
  private panePids = new Map<string, number>();
  // distinguish native agent replacement beneath an unchanged tmux shell
  private agentPids = new Map<string, number>();
  // raw `#{pane_current_path}` per agent id, so the Adapter can match a sandboxed
  // pane's rollout by its working directory without readlink-ing its descriptors
  private paneCwds = new Map<string, string>();
  // reported @rac_attention per agent id, so the dashboard re-resolves with the question
  private paneReported = new Map<string, AttentionState>();
  // the base64 reported Inline question payload (`@rac_question`) per agent id, kept
  // server-side so the dashboard and answer path can re-derive it; never published
  private paneQuestionPayloads = new Map<string, string>();
  // coalesce transcript reads without delaying live pane status scans
  private readonly messageQuestions = new Map<string, { identity: string; hasQuestion: boolean; pending: boolean; nextReadAt: number }>();
  // each tmux session's `@rac_place` mark, keyed like `Agent.sessionId`
  // (`${fingerprint}:${session}`); rediscovered every scan, then extended by the dashboard's claims
  private sessionMarks = new Map<string, string>();
  // the panes of every unmarked session the last scan saw, by session key, for the dashboard to claim
  private unmarkedSessions = new Map<string, Pane[]>();
  // the session key of every Console shell (a pane marked `@rac_role=shell`), so the dashboard
  // can count each Place's shells; rediscovered every scan, nothing persisted
  private consoleShellSessions: string[] = [];
  // the configured Scratch folder's realpath, resolved once
  private scratchHomeValue?: Promise<string>;
  private readonly serverStartedAt = Date.now();
  private refreshedAt = 0;
  private refreshInFlight?: Promise<Agent[]>;
  // pending scans and completed snapshots keep separate checkout generations
  private refreshEpoch = -1;
  private snapshotEpoch = -1;
  private socketSnapshot: SocketRef[] = [];
  private socketsRefreshedAt = 0;
  private socketRefreshInFlight?: Promise<SocketRef[]>;
  private dashboardSnapshot?: { refreshedAt: number; value: Dashboard };
  private dashboardRefreshInFlight?: Promise<Dashboard>;
  private worktreeSnapshot: Worktree[] = [];
  // the configured Projects followed by the implicit ones the last Worktree scan resolved
  private projectList?: readonly Project[];
  // the Prune-eligible checkout paths per Project (git's prunable entries plus console
  // records git lists nowhere), published atomically with the worktree snapshot (ADR 0003)
  private staleSnapshot = new Map<string, string[]>();
  // the pins read with the worktree snapshot, for the directory-Project and Scratch Places
  private pinSnapshot: Record<string, boolean> = {};
  // the directory-Project and Scratch Places the last built dashboard listed, by id
  private listedPlaces = new Map<string, Place>();
  private worktreesRefreshedAt = 0;
  private worktreesRefreshInFlight?: Promise<Worktree[]>;
  // bumped by invalidateWorktrees(); a scan that began under an older epoch read stale pins
  private worktreesEpoch = 0;
  private worktreesInFlightEpoch = -1;
  private readonly gitMetadata = new Map<string, { refreshedAt: number; value: GitMeta }>();
  private readonly gitMetadataInFlight = new Map<string, Promise<GitMeta>>();
  // cache canonical roots by raw pane cwd so symlink changes expire too
  private readonly workspaceRoots = new Map<string, RootLookup>();
  // expire PR comparisons with their metadata snapshot, including checkout invalidation
  private readonly gitPrComparisons = new WeakMap<GitMeta, Map<string, Promise<GitComparisonSummary | undefined>>>();
  // a workspace's common git dir (null = none), cached so a persistent Scratch pane does not
  // re-spawn `git rev-parse` on every poll; invalidateWorktrees() clears it
  private readonly commonDirCache = new Map<string, string | null>();
  private static readonly refreshCacheMs = 2_000;
  private static readonly gitMetadataCacheMs = 30_000;
  // accept only the PR operations used by discovery
  constructor(private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly tmux = new TmuxAdapter(), private readonly processes: ProcessInspector = new ProcInspector(), private readonly pullRequests: PullRequestLookup = new PullRequestService(), private readonly adapters: AdapterConfigs = {}, private readonly configuredProjects: readonly Project[] = [], private readonly pinStore?: Pick<WorktreeLaunchStore, 'pins'> & Partial<Pick<WorktreeLaunchStore, 'keys' | 'labels'>>, private readonly listWorktreesImpl: (path: string) => Promise<WorktreeEntry[] | undefined> = listWorktrees, private readonly scratchDirectory?: string) {}
  // every Project the console knows right now; the list may change between calls, so callers
  // read it each time rather than keeping it
  projectsNow(): readonly Project[] { return this.projectList ?? this.configuredProjects; }
  // every configured Place over this Worktree set: the Worktrees, the directory Projects and the Scratch folder
  private async places(worktrees: readonly Worktree[]): Promise<Place[]> {
    this.scratchHomeValue ??= scratchHome(this.scratchDirectory, this.configuredProjects);
    return configuredPlaces(worktrees, this.projectsNow(), await this.scratchHomeValue);
  }
  // the Place a discovered agent belongs to: its session's; a modal update advisor is never placed
  private placeOf(agent: Agent, places: readonly Place[]): Place | undefined {
    const mark = this.sessionMarks.get(agent.sessionId);
    return isUpdateAdvisorLabel(agent.displayLabel) || mark === undefined ? undefined : markedPlace(places, mark);
  }
  // Claim each unmarked session the last scan saw, once: a session the console did not create
  // (one running before marks, or the operator's own with an agent started by hand) is marked
  // with the nearest Place of its Agent, else its Console shell, else a console-managed pane.
  // A git checkout in no configured Place, or below the configured Scratch folder, is marked
  // with its own Worktree instead: its implicit Project's (ADR 0014).
  // It is never re-derived, so a shell that later `cd`s elsewhere stays in the Workspace. A
  // session with none of these (the operator's own shells, `rac-stack-*` runs) stays unmarked.
  // Only the dashboard claims, over its settled Worktree set: a claim against a Worktree list
  // not yet scanned would mark a Worktree's session as Scratch for good. Answers whether a claim
  // named a Worktree that set does not list yet, which the caller re-scans for.
  private async claimSessions(agents: readonly Agent[], places: readonly Place[]): Promise<boolean> {
    let unlisted = false;
    const agentHomes = new Map(agents.filter(agent => !isUpdateAdvisorLabel(agent.displayLabel)).map(agent => [agent.id, agent.home]));
    await Promise.all([...this.unmarkedSessions].map(async ([key, sessionPanes]) => {
      const agentHome = sessionPanes.map(pane => agentHomes.get(`${pane.socket.fingerprint}:${pane.paneId}`)).find(home => home !== undefined);
      const claimant = sessionPanes.find(pane => pane.role === 'shell') ?? sessionPanes.find(pane => pane.consoleManaged === true);
      const root = agentHome ?? (claimant === undefined ? undefined : await this.cachedWorkspaceRoot(claimant.path));
      if (root === undefined) return;
      const placeId = await this.rootPlaceId(root, places, false);
      if (projectIdOf(placeId) !== scratchProjectId && !places.some(place => place.id === placeId)) unlisted = true;
      const { socket, sessionId } = sessionPanes[0]!;
      // the claim holds until the next scan even if the write fails; that scan claims again
      await this.tmux.markSessionPlace(socket, sessionId, placeId).catch(() => false);
      this.sessionMarks.set(key, placeId);
      this.unmarkedSessions.delete(key);
    }));
    return unlisted;
  }
  // The Place id a root (git toplevel, else the folder) belongs to, the one rule claims and Open
  // folder share: the nearest configured Place holding it, except that a root in none, or below
  // the configured Scratch folder, is the Worktree of its git checkout (ADR 0014). A root that is
  // no checkout joins that Scratch folder for a claim, but is its own Place when `ownFolder`.
  private async rootPlaceId(root: string, places: readonly Place[], ownFolder: boolean): Promise<string> {
    const nearest = placeForRoot(places, root);
    if (nearest.adhoc !== true && (nearest.kind !== 'scratch' || nearest.home === root)) return nearest.id;
    return await this.checkoutWorktreeId(root) ?? (ownFolder ? worktreeWireId(scratchProjectId, root) : nearest.id);
  }
  // The Worktree id of a git checkout root no configured Place holds: the Worktree of the
  // configured Project managing its repository (one created since the last scan), else of its
  // implicit Project. Undefined when the root is no checkout git lists, such as a `.git` folder.
  private async checkoutWorktreeId(root: string): Promise<string | undefined> {
    const project = await implicitProject(root);
    if (project === undefined) return undefined;
    const entries = await this.listWorktreesImpl(root);
    const listed = await Promise.all((entries ?? []).filter(entry => !entry.bare).map(entry => realpath(entry.path).catch(() => entry.path)));
    if (!listed.includes(root)) return undefined;
    const configured = this.configuredProjects.find(candidate => candidate.available && candidate.identity === project.identity);
    return worktreeWireId((configured ?? project).id, root);
  }
  // The implicit Projects these Place ids name (ADR 0014): `<id>:<path>` whose id no configured
  // Project has, whose path is a git checkout deriving that same id, and whose repository no
  // configured Project manages. Rebuilt on every Worktree scan, so a Project that no session mark
  // or pin names any more drops out, taking its Worktrees with it.
  private async resolveImplicitProjects(placeIds: Iterable<string>): Promise<readonly Project[] | undefined> {
    const configuredIds = new Set(this.configuredProjects.map(project => project.id));
    const configuredIdentities = new Set(this.configuredProjects.filter(project => project.available).map(project => project.identity));
    const found = new Map<string, Project>();
    for (const placeId of new Set(placeIds)) {
      const id = projectIdOf(placeId);
      const path = worktreePathOf(placeId);
      if (path === undefined || id === scratchProjectId || configuredIds.has(id) || found.has(id)) continue;
      const project = await implicitProject(path);
      if (project?.id === id && !configuredIdentities.has(project.identity)) found.set(id, project);
    }
    return found.size === 0 ? undefined : [...this.configuredProjects, ...found.values()];
  }
  // reuse socket discovery across adjacent requests
  private async sockets(force = false): Promise<SocketRef[]> {
    // serve the recent socket snapshot
    if (!force && Date.now() - this.socketsRefreshedAt < DiscoveryService.refreshCacheMs) return this.socketSnapshot;
    // coalesce concurrent socket scans
    if (this.socketRefreshInFlight !== undefined) return this.socketRefreshInFlight;
    const refresh = this.finder.find().then(sockets => {
      this.socketSnapshot = sockets;
      this.socketsRefreshedAt = Date.now();
      return sockets;
    }).finally(() => {
      // release only the active scan
      if (this.socketRefreshInFlight === refresh) this.socketRefreshInFlight = undefined;
    });
    this.socketRefreshInFlight = refresh;
    return refresh;
  }
  // read agent state, optionally bypassing cache or forcing a separate scan
  async refresh(force = false, fresh = false): Promise<Agent[]> {
    // finish older scans before a forced or post-checkout read
    if (this.refreshInFlight && (force || this.refreshEpoch !== this.worktreesEpoch)) await this.refreshInFlight;
    // reuse only ordinary fresh snapshots
    if (!force && !fresh && this.snapshotEpoch === this.worktreesEpoch && Date.now() - this.refreshedAt < DiscoveryService.refreshCacheMs) return this.snapshot;
    // coalesce matching live scans
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshEpoch = this.worktreesEpoch;
    this.refreshInFlight = this.discover(force).finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }
  // share root resolution across panes without retaining stale checkout identities
  private cachedWorkspaceRoot(path: string): Promise<string> {
    const now = Date.now();
    const cached = this.workspaceRoots.get(path);
    // pending and settled lookups share the same promise
    if (cached !== undefined && cached.expiresAt > now) return cached.value;
    // discard expired paths when a pane visits a new or expired directory
    for (const [key, entry] of this.workspaceRoots) {
      // pending commands remain coalesced until they settle
      if (entry.expiresAt <= now) this.workspaceRoots.delete(key);
    }
    const entry: RootLookup = {
      expiresAt: Infinity,
      // the cache window starts when canonicalization and git finish
      value: workspaceRoot(path).then(root => {
        entry.expiresAt = Date.now() + DiscoveryService.gitMetadataCacheMs;
        return root;
      }).catch(error => {
        // a failed old generation must not delete a newer lookup
        if (this.workspaceRoots.get(path) === entry) this.workspaceRoots.delete(path);
        throw error;
      })
    };
    this.workspaceRoots.set(path, entry);
    return entry.value;
  }
  // discover agents while reusing sockets unless the caller forces discovery
  private async discover(force = false): Promise<Agent[]> {
    const epoch = this.worktreesEpoch;
    // lifecycle-sensitive reads still revalidate roots, once per forced scan
    if (force) this.workspaceRoots.clear();
    const sockets = await this.sockets(force);
    // dashboard command connections follow the discovered socket inventory
    this.tmux.retainSockets?.(sockets);
    const panes = (await Promise.all(sockets.map(async (socket) => (await this.tmux.listPanes(socket, { backoffMissingServer: !force })).map(pane => ({ ...pane, socket }))))).flat();
    const panePids = new Map<string, number>();
    const agentPids = new Map<string, number>();
    const paneCwds = new Map<string, string>();
    const paneReported = new Map<string, AttentionState>();
    const paneQuestionPayloads = new Map<string, string>();
    const places = await this.places(this.worktreeSnapshot);
    const discovered: Agent[] = (await Promise.all(panes.filter(pane => !paneExcluded(pane)).map(async (pane): Promise<Agent | undefined> => {
      // ordinary polling revalidates established lineages; lifecycle scans walk afresh
      const recognized = await this.processes.recognizeAgent(pane.pid, { reusePositive: !force });
      if (recognized === undefined) {
        // a pane whose agent is gone must not keep a stale report; nothing else clears it
        if (pane.reportedAttention !== undefined || pane.reportedSession !== undefined || pane.reportedSandboxed !== undefined || pane.reportedQuestion !== undefined) void this.tmux.unsetReportedState(pane.socket, pane.paneId).catch(() => {});
        return undefined;
      }
      const home = await this.cachedWorkspaceRoot(pane.path);
      const id = `${pane.socket.fingerprint}:${pane.paneId}`;
      panePids.set(id, pane.pid);
      agentPids.set(id, recognized.pid);
      paneCwds.set(id, pane.path);
      const reported = parseReportedAttention(pane.reportedAttention);
      if (reported !== undefined) paneReported.set(id, reported);
      if (pane.reportedQuestion !== undefined && pane.reportedQuestion.length > 0) paneQuestionPayloads.set(id, pane.reportedQuestion);
      const attention = resolveAttention({ kind: recognized.kind, title: pane.title, reported, hasQuestion: false });
      const conversationId = pane.reportedSession !== undefined && pane.reportedSession.length > 0 ? pane.reportedSession : undefined;
      const agent: Agent = { id, paneId: pane.paneId, sessionId: `${pane.socket.fingerprint}:${pane.sessionId}`, socketFingerprint: pane.socket.fingerprint, home, title: pane.title, kind: recognized.kind, attention, ...(pane.reportedSandboxed === '1' ? { sandboxed: true } : {}), ...(conversationId === undefined ? {} : { conversationId }), ...(pane.displayLabel === undefined ? {} : { displayLabel: pane.displayLabel }), ...(pane.paneMode === undefined ? {} : { paneMode: pane.paneMode }), ...(pane.reviewRun === undefined ? {} : { reviewRun: pane.reviewRun }) };
      return agent;
    }))).filter((agent): agent is Agent => agent !== undefined);
    const sessionKey = (pane: Pane) => `${pane.socket.fingerprint}:${pane.sessionId}`;
    this.sessionMarks = new Map();
    this.unmarkedSessions = new Map();
    for (const pane of panes) {
      if (pane.placeMark !== undefined) this.sessionMarks.set(sessionKey(pane), pane.placeMark);
      else if (!pane.sessionName?.startsWith('rac-stack-')) this.unmarkedSessions.set(sessionKey(pane), [...this.unmarkedSessions.get(sessionKey(pane)) ?? [], pane]);
    }
    // the Agent the server acts on keeps `home` as its pane root, the folder it runs in (a
    // teardown, attachments, file links and conversations all act there); only the dashboard
    // publishes its Place's home. The snapshot Place may trail a fresh Worktree scan by one tick,
    // and an Agent in a session not yet claimed has none until the next scan.
    const agents = discovered.map(agent => { const place = this.placeOf(agent, places); return place === undefined ? agent : { ...agent, placeId: place.id }; });
    this.consoleShellSessions = panes.filter(pane => pane.role === 'shell').map(sessionKey);
    this.snapshot = agents;
    this.panePids = panePids;
    this.agentPids = agentPids;
    this.paneCwds = paneCwds;
    this.paneReported = paneReported;
    this.paneQuestionPayloads = paneQuestionPayloads;
    // discard removed panes so late transcript reads cannot restore their state
    for (const id of this.messageQuestions.keys()) {
      // detach absent panes from both cached and in-flight reads
      if (!panePids.has(id)) this.invalidateMessageQuestion(id);
    }
    this.refreshedAt = Date.now();
    this.snapshotEpoch = epoch;
    this.generation++;
    return agents;
  }
  // resolve known panes without blocking on dashboard enrichment
  async target(id: string, force = false): Promise<{ agent: Agent; socket: SocketRef } | undefined> {
    // refresh launch-sensitive pane state on demand
    if (force) await this.refresh(true);
    // discover only targets absent from the runtime snapshot
    if (!this.snapshot.some(candidate => candidate.id === id)) await this.refresh(true);
    return await this.snapshotTarget(id);
  }
  // resolve a pane from the current snapshot only, for callers that must not wait on a scan
  async snapshotTarget(id: string): Promise<{ agent: Agent; socket: SocketRef } | undefined> {
    const agent = this.snapshot.find(candidate => candidate.id === id);
    if (agent === undefined) return undefined;
    const socket = (await this.sockets()).find(candidate => candidate.fingerprint === agent.socketFingerprint);
    return socket === undefined ? undefined : { agent, socket };
  }

  // the OS pid backing one discovered pane, for the Adapter's rollout reads
  paneProcessId(id: string): number | undefined {
    return this.panePids.get(id);
  }

  // expose the recognized native descendant rather than its persistent pane shell
  agentProcessId(id: string): number | undefined {
    return this.agentPids.get(id);
  }

  // the raw reported Inline question payload one pane carries, for the answer path
  reportedQuestionPayload(id: string): string | undefined {
    return this.paneQuestionPayloads.get(id);
  }

  // the pane's working directory, for the Adapter's privilege-free rollout match —
  // but only when no other discovered pane shares it, so a directory running two
  // agents fails closed to the TUI path rather than risk a sibling's rollout
  paneWorkingDirectory(id: string): string | undefined {
    const path = this.paneCwds.get(id);
    if (path === undefined) return undefined;
    let count = 0;
    for (const value of this.paneCwds.values()) if (value === path && (count += 1) > 1) return undefined;
    return path;
  }

  // the pane's own working directory, for reading a conversation already known by id (Claude
  // keys its transcripts by that folder). A sibling in the same folder is harmless here: the id
  // is exact, so unlike `paneWorkingDirectory` this does not fail closed when a folder is shared.
  paneDirectory(id: string): string | undefined {
    return this.paneCwds.get(id);
  }

  // resolve the selected pane, its Adapter, and the pane facts its conversation lives under
  private async conversationContext(id: string): Promise<{ agent: Agent; adapter: Adapter['conversations'] & {}; pane: { pid: number; cwd?: string } } | undefined> {
    const target = await this.target(id);
    if (target === undefined) return undefined;
    const conversations = adapterFor(target.agent.kind)?.conversations;
    const pid = this.panePids.get(target.agent.id);
    // require exact pane identity and an Adapter that resolves conversations
    if (conversations === undefined || pid === undefined) return undefined;
    // the unique working directory is the discover fallback for a confined service
    const cwd = this.paneWorkingDirectory(target.agent.id);
    return { agent: target.agent, adapter: conversations, pane: { pid, ...(cwd === undefined ? {} : { cwd }) } };
  }

  // the pane's own reported conversation id (`@rac_session`), when the Adapter accepts it
  private reportedConversationId(context: { agent: Agent; adapter: Adapter['conversations'] & {} }): string | undefined {
    const reported = context.agent.conversationId;
    return reported !== undefined && context.adapter.validId(reported) ? reported : undefined;
  }

  // the pane's current top-level conversation id: the reported `@rac_session`, else the Adapter's discovery
  async conversationId(id: string): Promise<string | undefined> {
    const context = await this.conversationContext(id);
    if (context === undefined) return undefined;
    return this.reportedConversationId(context) ?? (await context.adapter.discover?.(context.pane))?.id;
  }

  // the pane's current Conversation with its name (the id resolved and its store name read)
  async conversation(id: string): Promise<Conversation | undefined> {
    const context = await this.conversationContext(id);
    if (context === undefined) return undefined;
    const reported = this.reportedConversationId(context);
    // a reported id skips the fd-walk; its name is read by id (Codex) or by id and
    // the pane's working directory (Claude, whose transcript is keyed by cwd)
    if (reported !== undefined) {
      const name = await context.adapter.readName?.(reported, this.paneDirectory(context.agent.id));
      return { id: reported, ...(name === undefined ? {} : { title: name }) };
    }
    // the fd-walk fallback takes `discover`'s message-derived title, not the store
    // name — no reported id means no cheap by-id `readName` read
    return await context.adapter.discover?.(context.pane);
  }

  // The Named conversations under these directories across every registered kind that
  // lists, each row tagged with its kind. A per-kind read failure contributes no rows for
  // that kind rather than failing the whole union — the console only reads the agents'
  // stores, never writes them, so a locked or absent store degrades to "nothing listed".
  async conversations(directories: readonly string[]): Promise<Array<ConversationSummary & { kind: AgentKind }>> {
    // codex and omx carry one rollout reader by reference (ADR 0005); run each distinct
    // reader once so a shared rollout yields a single row, never one per sharing kind. The
    // row is tagged with the first (registry-order) kind that owns the reader; the console
    // re-attributes a codex-family row to the Worktree's remembered Launch kind.
    const seen = new Set<unknown>();
    const listers = adapters.filter(adapter => {
      const list = adapter.conversations?.list;
      if (list === undefined || seen.has(list)) return false;
      seen.add(list);
      return true;
    });
    const perKind = await Promise.all(listers
      .map(async adapter => (await adapter.conversations!.list!(directories).catch(() => []))
        .map(summary => ({ ...summary, kind: adapter.kind }))));
    return perKind.flat();
  }
  // the Worktrees discovered from every available Project (bare and stale entries
  // excluded), pins folded in, cached with the 30s git-metadata window until a console
  // mutation invalidates it. Ordered config → Main first → Linked by branch (detached last).
  async worktrees(force = false): Promise<Worktree[]> {
    if (!force && Date.now() - this.worktreesRefreshedAt < DiscoveryService.gitMetadataCacheMs) return this.worktreeSnapshot;
    // coalesce only onto an in-flight scan begun since the last invalidation; a forced read
    // (a just-added worktree) or a post-invalidation read (a pin toggle) always scans fresh,
    // so a scan that started under the old pins can never satisfy it
    if (!force && this.worktreesRefreshInFlight !== undefined && this.worktreesInFlightEpoch === this.worktreesEpoch) return this.worktreesRefreshInFlight;
    const epoch = this.worktreesEpoch;
    const refresh = this.discoverWorktrees().then(({ worktrees, stale, pins, projects }) => {
      // publish only when this is still the newest scan and no invalidation raced it, so a
      // stale scan's completion never re-stamps the cache over a fresher pin/worktree set
      if (this.worktreesRefreshInFlight === refresh && this.worktreesEpoch === epoch) {
        this.worktreeSnapshot = worktrees;
        this.staleSnapshot = stale;
        this.pinSnapshot = pins;
        this.projectList = projects;
        this.worktreesRefreshedAt = Date.now();
      }
      return worktrees;
    }).finally(() => { if (this.worktreesRefreshInFlight === refresh) this.worktreesRefreshInFlight = undefined; });
    this.worktreesRefreshInFlight = refresh;
    this.worktreesInFlightEpoch = epoch;
    return refresh;
  }

  // the last discovered Worktree set, for the synchronous scope resolution the prompt
  // queue and its siblings run while handling a request
  // the current snapshot, replaced wholesale on refresh and never mutated — consumers
  // (the ProjectProxy target map) memoize by array identity, so keep it that way
  worktreesNow(): Worktree[] { return this.worktreeSnapshot; }

  // drop the Worktree and dashboard caches so the next read re-runs `git worktree list` and
  // rebuilds — called after a console add/remove and after a pin toggle. The epoch bump makes
  // any scan already in flight (which read the old pins) stale, so it cannot re-stamp the cache.
  // also drops checkout roots, origins and git metadata after branch or status changes
  invalidateWorktrees(): void {
    this.worktreesRefreshedAt = 0;
    this.worktreesEpoch += 1;
    this.refreshedAt = 0;
    this.dashboardSnapshot = undefined;
    this.dashboardRefreshInFlight = undefined;
    this.gitMetadata.clear();
    this.gitMetadataInFlight.clear();
    this.workspaceRoots.clear();
    this.commonDirCache.clear();
    this.pullRequests.invalidateRepositories();
  }

  private async discoverWorktrees(): Promise<{ worktrees: Worktree[]; stale: Map<string, string[]>; pins: Record<string, boolean>; projects: readonly Project[] | undefined }> {
    const pins = (await this.pinStore?.pins()) ?? {};
    const labels = (await this.pinStore?.labels?.()) ?? {};
    // every stored key, so a worktree key git lists nowhere counts as an orphaned record
    const storeKeys = (await this.pinStore?.keys?.()) ?? [];
    const projects = await this.resolveImplicitProjects([...this.sessionMarks.values(), ...Object.keys(pins).filter(id => pins[id] === true)]);
    const worktrees: Worktree[] = [];
    const stale = new Map<string, string[]>();
    for (const project of projects ?? this.configuredProjects) {
      if (!project.available) continue;
      const entries = await this.listWorktreesImpl(project.path);
      if (entries === undefined) continue;
      // git lists the Main worktree first; a bare repository lists its bare entry first
      const mainPath = entries[0] !== undefined && !entries[0].bare ? await realpath(entries[0].path).catch(() => entries[0]!.path) : undefined;
      // every path git lists (prunable included), so a record matching a prunable checkout
      // is counted once (as a prunable entry) rather than again as an orphaned record
      const listedPaths = new Set(await Promise.all(entries.filter(entry => !entry.bare).map(entry => realpath(entry.path).catch(() => entry.path))));
      const stalePaths = [...await Promise.all(entries.filter(entry => !entry.bare && entry.prunable).map(entry => realpath(entry.path).catch(() => entry.path)))];
      for (const key of storeKeys) {
        if (projectIdOf(key) !== project.id) continue;
        const recordPath = worktreePathOf(key);
        if (recordPath !== undefined && !listedPaths.has(recordPath)) stalePaths.push(recordPath);
      }
      if (stalePaths.length > 0) stale.set(project.id, stalePaths);
      const usable: Worktree[] = [];
      for (const entry of entries) {
        // a bare entry is never a Worktree; a stale (prunable) one is hidden and kept
        if (entry.bare || entry.prunable) continue;
        const path = await realpath(entry.path).catch(() => entry.path);
        const main = path === mainPath;
        const id = worktreeWireId(project.id, path);
        const sha = entry.head === undefined ? undefined : entry.head.slice(0, 7);
        const generatedLabel = main ? project.label : entry.branch !== undefined ? `${project.label} · ${entry.branch}` : `${project.label} · ${sha ?? path.split('/').pop() ?? path}`;
        const customLabel = labels[id];
        const label = customLabel ?? generatedLabel;
        // use exact checkout settings without leaking defaults into disabled stacks
        const stack = project.worktreeOverrides?.find(override => override.path === path) ?? project;
        usable.push({
          id, projectId: project.id, label, ...(customLabel === undefined ? {} : { customLabel: true }), path, identity: path,
          ...(main && project.hostPath !== undefined ? { hostPath: project.hostPath } : {}),
          // an implicit Project's Main worktree starts unpinned, so a repository an agent once ran in keeps no tab
          available: true, pinned: pins[id] ?? (main && project.implicit !== true), main, detached: entry.detached, locked: entry.locked,
          ...(entry.locked && entry.lockedReason !== undefined ? { lockedReason: entry.lockedReason } : {}),
          ...(entry.branch === undefined ? {} : { branch: entry.branch }),
          ...(entry.detached && sha !== undefined ? { sha } : {}),
          ...(stack.commands === undefined ? {} : { commands: stack.commands }),
          ...(project.newTask === undefined ? {} : { newTask: project.newTask }),
          ...(project.defaultBranch === undefined ? {} : { defaultBranch: project.defaultBranch }),
          ...(stack.projectUrl === undefined ? {} : { projectUrl: stack.projectUrl, ...(stack.projectPort === undefined ? {} : { projectPort: stack.projectPort }) })
        });
      }
      // explicit checkout order first, then the existing main/branch/detached defaults
      usable.sort((left, right) => {
        const leftOrder = project.worktreeOrder?.indexOf(left.path) ?? -1;
        const rightOrder = project.worktreeOrder?.indexOf(right.path) ?? -1;
        // unlisted checkouts follow every configured checkout
        if (leftOrder !== rightOrder) return (leftOrder < 0 ? Infinity : leftOrder) - (rightOrder < 0 ? Infinity : rightOrder);
        // keep the main checkout first within the unlisted group
        if (left.main !== right.main) return left.main ? -1 : 1;
        // keep detached checkouts after named branches within the unlisted group
        if (left.detached !== right.detached) return left.detached ? 1 : -1;
        return (left.branch ?? left.sha ?? '').localeCompare(right.branch ?? right.sha ?? '');
      });
      worktrees.push(...usable);
    }
    return { worktrees, stale, pins, projects };
  }

  // build or reuse one dashboard view; freshAgents bypasses pane snapshots only
  async dashboard(force = false, freshAgents = false): Promise<Dashboard> {
    const cached = this.dashboardSnapshot;
    // bypass cached state for lifecycle checks
    if (!force && !freshAgents && cached !== undefined && Date.now() - cached.refreshedAt < DiscoveryService.refreshCacheMs) return cached.value;
    // reuse only ordinary dashboard refreshes
    if (!force && !freshAgents && this.dashboardRefreshInFlight !== undefined) return this.dashboardRefreshInFlight;
    const startedAt = Date.now();
    const value = this.buildDashboard(force, freshAgents)
      .then(dashboard => {
        // publish only the newest build without re-aging an older agent snapshot
        if (this.dashboardRefreshInFlight === value) this.dashboardSnapshot = { refreshedAt: startedAt, value: dashboard };
        return dashboard;
      })
      .finally(() => {
        if (this.dashboardRefreshInFlight === value) this.dashboardRefreshInFlight = undefined;
      });
    this.dashboardRefreshInFlight = value;
    return value;
  }

  // enrich one discovered dashboard
  // the Inline question one agent is asking: OMX's structured file (`pending`), else
  // the Claude payload it reported on its pane (`reported`), confirmed live against a
  // fresh capture. One capture per dashboard build per agent that holds a payload.
  private async agentQuestion(agent: Agent, workspace: string): Promise<InlineQuestion | undefined> {
    const questions = adapterFor(agent.kind)?.questions;
    if (questions === undefined) return undefined;
    const pending = await questions.pending?.(workspace, agent.paneId);
    if (pending !== undefined || questions.reported === undefined) return pending;
    const payload = this.paneQuestionPayloads.get(agent.id);
    if (payload === undefined) return undefined;
    const socket = this.socketSnapshot.find(candidate => candidate.fingerprint === agent.socketFingerprint);
    if (socket === undefined) return undefined;
    const capture = await this.tmux.capture(socket, agent.paneId).catch(() => undefined);
    return capture === undefined ? undefined : questions.reported(payload, capture);
  }

  // accepted prompts and native dialogs supersede cached and in-flight prose questions
  invalidateMessageQuestion(agentId: string): void {
    const state = this.messageQuestions.get(agentId);
    // dashboard builds may still hold this mutable observation
    if (state !== undefined) state.hasQuestion = false;
    this.messageQuestions.delete(agentId);
    this.dashboardSnapshot = undefined;
  }

  // read unanswered prose independently of browser connections and native answer dialogs
  private agentMessageQuestion(agent: Agent): { hasQuestion: boolean } {
    const read = adapterFor(agent.kind)?.conversations?.latestMessage;
    const pid = this.panePids.get(agent.id);
    // new work, native dialogs and vanished panes invalidate older question reads
    if (agent.attention !== 'finished' || read === undefined || pid === undefined) {
      this.invalidateMessageQuestion(agent.id);
      return { hasQuestion: false };
    }
    // claude has an exact session id; codex's directory fallback must be unshared
    const cwd = agent.kind === 'claude' ? this.paneDirectory(agent.id) : this.paneWorkingDirectory(agent.id);
    const pane = { pid, ...(cwd === undefined ? {} : { cwd }), ...(agent.conversationId === undefined ? {} : { conversationId: agent.conversationId }) };
    const identity = JSON.stringify([agent.kind, pane]);
    const previous = this.messageQuestions.get(agent.id);
    // prevent an older dashboard build from publishing a replaced conversation
    if (previous !== undefined && previous.identity !== identity) previous.hasQuestion = false;
    const state = previous?.identity === identity ? previous : { identity, hasQuestion: false, pending: false, nextReadAt: 0 };
    this.messageQuestions.set(agent.id, state);
    // bound identity scans across faster pane polls without caching a stale rollout path
    if (!state.pending && Date.now() >= state.nextReadAt) {
      state.pending = true;
      void read(pane).catch(() => undefined).then(message => {
        // ignore replies from removed panes, older conversations or resumed work
        if (this.messageQuestions.get(agent.id) === state) state.hasQuestion = messageAsksQuestion(message);
      }).finally(() => {
        state.pending = false;
        state.nextReadAt = Date.now() + DiscoveryService.refreshCacheMs;
      });
    }
    return state;
  }

  // cache the pull request-aware base without slowing live pane scans
  private async gitPrComparisonForBase(meta: GitMeta, branch: string | undefined, baseBranch: string | undefined, defaultBranch?: string): Promise<GitComparisonSummary | undefined> {
    // incomplete PR metadata has the same fallbacks as the Git snapshot
    if (baseBranch === undefined) return meta.gitPrStatus;
    const preferredBase = baseBranch.startsWith('origin/') || baseBranch.startsWith('refs/') ? baseBranch : `origin/${baseBranch}`;
    const comparisons = this.gitPrComparisons.get(meta) ?? new Map<string, Promise<GitComparisonSummary | undefined>>();
    this.gitPrComparisons.set(meta, comparisons);
    const key = JSON.stringify([branch, preferredBase, defaultBranch]);
    const cached = comparisons.get(key);
    // share both pending and completed comparisons across agents and dashboard polls
    if (cached !== undefined) return cached;
    // resolve the full ladder only inside the shared cache promise
    const value = (async () => {
      const candidates = await prComparisonCandidates(meta.workspace, branch, preferredBase, defaultBranch);
      // reuse a comparison that already resolved the first-priority candidate
      if (meta.gitPrStatus?.base === candidates[0]) return meta.gitPrStatus;
      const untracked = meta.gitStatus?.changes?.filter(change => change.code === '??') ?? [];
      return (await comparisonAgainst(meta.workspace, candidates, untracked))?.comparison;
    })().catch(error => {
      comparisons.delete(key);
      throw error;
    });
    comparisons.set(key, value);
    return value;
  }

  // enrich live agent state with independently cached worktree metadata
  private async buildDashboard(force = false, freshAgents = false): Promise<Dashboard> {
    const discovered = await this.refresh(force, freshAgents);
    let worktrees = await this.worktrees(force);
    // a `git worktree add` from a terminal appears within one tick: if a live agent sits
    // in a checkout we do not know yet whose repository is a configured Project, re-scan once
    if (!force && await this.hasUnknownProjectWorktree(discovered, worktrees)) worktrees = await this.worktrees(true);
    // share git snapshots with the owning project's comparison default
    const metadataFor = (workspace: string, defaultBranch?: string) => {
      const cached = this.gitMetadata.get(workspace);
      // reuse recent Git state across frequent dashboard polls
      if (cached !== undefined && Date.now() - cached.refreshedAt < DiscoveryService.gitMetadataCacheMs) return Promise.resolve(cached.value);
      const active = this.gitMetadataInFlight.get(workspace);
      // coalesce matching repository scans
      if (active !== undefined) return active;
      const value = gitMeta(workspace, true, defaultBranch).then(meta => {
        // a scan begun before invalidateWorktrees() read the old checkout; do not cache it
        if (this.gitMetadataInFlight.get(workspace) === value) this.gitMetadata.set(workspace, { refreshedAt: Date.now(), value: meta });
        return meta;
      }).finally(() => {
        // release only the matching scan
        if (this.gitMetadataInFlight.get(workspace) === value) this.gitMetadataInFlight.delete(workspace);
      });
      this.gitMetadataInFlight.set(workspace, value);
      // refresh expired metadata without delaying console traffic
      if (cached !== undefined) return Promise.resolve(cached.value);
      return value;
    };
    // re-place every agent against this (possibly fresher) Worktree set, publishing the
    // console-side Place home; a Worktree's Agents take its git identity as before
    let places = await this.places(worktrees);
    if (await this.claimSessions(discovered, places)) { worktrees = await this.worktrees(true); places = await this.places(worktrees); }
    const worktreeById = new Map(worktrees.map(worktree => [worktree.id, worktree] as const));
    // the stable tab order follows configured checkout order and discovery defaults
    const orderOf = new Map(worktrees.map((worktree, index) => [worktree.id, index] as const));
    // retain mutable observations until all panes and places finish enrichment
    const messageQuestionStates = new Map<string, { hasQuestion: boolean }>();
    const agents = await Promise.all(discovered.map(async (discoveredAgent) => {
      const place = this.placeOf(discoveredAgent, places);
      const agent = place === undefined ? discoveredAgent : { ...discoveredAgent, placeId: place.id, home: place.home };
      const worktree = place === undefined ? undefined : worktreeById.get(place.id);
      // git metadata reads the Worktree, else the checkout the pane is in; a question file lives
      // where the pane runs, read through the console-side path when that is the Worktree itself
      const home = worktree?.identity ?? discoveredAgent.home;
      const questionFolder = worktree !== undefined && worktreeMatchesWorkspace(worktree, discoveredAgent.home) ? worktree.identity : discoveredAgent.home;
      const defaultBranch = worktree?.defaultBranch ?? this.projectsNow().find(project => project.id === place?.projectId)?.defaultBranch;
      const [meta, question] = await Promise.all([
        metadataFor(home, defaultBranch),
        this.agentQuestion(agent, questionFolder)
      ]);
      // native questions replace prose state without starting another transcript read
      if (question !== undefined) this.invalidateMessageQuestion(agent.id);
      messageQuestionStates.set(agent.id, question === undefined ? this.agentMessageQuestion(agent) : { hasQuestion: false });
      const branch = meta.branch ?? agent.branch;
      const pullRequest = await this.pullRequests.cachedPullRequest(meta.workspace, branch);
      const gitPrStatus = await this.gitPrComparisonForBase(meta, branch, pullRequest?.baseBranch, defaultBranch);
      const details = worktree === undefined
        ? { ...agent, branch, ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(meta.gitUpstream === undefined ? {} : { gitUpstream: meta.gitUpstream }) }
        : { ...agent, branch, ...(meta.gitStatus === undefined ? {} : { gitStatus: meta.gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(meta.gitUpstream === undefined ? {} : { gitUpstream: meta.gitUpstream }), home: worktree.identity, projectId: worktree.projectId, worktreeId: worktree.id, ...(worktree.newTask === undefined ? {} : { newTaskConfigured: true }), ...(worktree.projectUrl === undefined ? {} : { projectUrl: worktree.projectUrl, projectProxied: worktree.projectPort !== undefined }) };
      // re-resolve now that a pending Inline question is known (precedence: reported → question → inferred → finished)
      const attention = resolveAttention({ kind: agent.kind, title: agent.title, reported: this.paneReported.get(agent.id), hasQuestion: question !== undefined });
      return { ...details, attention, ...(pullRequest === undefined ? {} : { pullRequest }), ...(question === undefined ? {} : { question }) };
    }));
    // a Worktree with a live agent carries its git metadata on the Agent; an idle one carries
    // it on the Worktree record, as the flat list used to. A modal advisor never claims one.
    const activeAgents = agents.filter(agent => !isUpdateAdvisorLabel(agent.displayLabel));
    const activeWorktreeIds = new Set(activeAgents.flatMap(agent => agent.worktreeId === undefined ? [] : [agent.worktreeId]));
    // every Console shell counts for its session's Place, by the same rule as Agents
    const shellPlaces = this.consoleShellSessions.flatMap(key => { const mark = this.sessionMarks.get(key); return mark === undefined ? [] : markedPlace(places, mark) ?? []; });
    const shellCounts = new Map<string, number>();
    for (const place of shellPlaces) shellCounts.set(place.id, (shellCounts.get(place.id) ?? 0) + 1);
    const worktreeViews = await Promise.all(worktrees.map(async (worktree): Promise<DashboardWorktree> => {
      // a Worktree carries its Console-shell count whether or not it has a live Agent, so the
      // row shows it and the idle-tab retain rule can keep the tab open (spec, Console shells)
      const consoleShells = shellCounts.get(worktree.id) ?? 0;
      const base: DashboardWorktree = { id: worktree.id, projectId: worktree.projectId, label: worktree.label, ...(worktree.customLabel === true ? { customLabel: true } : {}), path: worktree.path, available: worktree.available, pinned: worktree.pinned, main: worktree.main, detached: worktree.detached, locked: worktree.locked, order: orderOf.get(worktree.id) ?? 0, ...(worktree.branch === undefined ? {} : { branch: worktree.branch }), ...(worktree.sha === undefined ? {} : { sha: worktree.sha }), ...(consoleShells > 0 ? { consoleShells } : {}), ...(worktree.projectUrl === undefined ? {} : { projectUrl: worktree.projectUrl, projectProxied: worktree.projectPort !== undefined }) };
      if (activeWorktreeIds.has(worktree.id)) return base;
      const meta = await metadataFor(worktree.identity, worktree.defaultBranch);
      const pullRequest = await this.pullRequests.cachedPullRequest(meta.workspace, meta.branch);
      const gitPrStatus = await this.gitPrComparisonForBase(meta, meta.branch, pullRequest?.baseBranch, worktree.defaultBranch);
      return { ...base, ...(meta.gitStatus === undefined ? {} : { gitStatus: meta.gitStatus }), ...(gitPrStatus === undefined ? {} : { gitPrStatus }), ...(meta.gitUpstream === undefined ? {} : { gitUpstream: meta.gitUpstream }), ...(pullRequest === undefined ? {} : { pullRequest }) };
    }));
    const byProject = new Map<string, DashboardWorktree[]>();
    for (const view of worktreeViews) { const list = byProject.get(view.projectId) ?? []; list.push(view); byProject.set(view.projectId, list); }
    const projects: DashboardProject[] = this.projectsNow().map(project => {
      const management = worktreeManagementAvailability(project);
      return { id: project.id, ...(project.implicit === true ? { implicit: true as const } : {}), label: project.label, mode: project.mode, available: project.available, ...(project.unavailableReason === undefined ? {} : { unavailableReason: project.unavailableReason }), manageWorktrees: management.available, ...(management.reason === undefined ? {} : { manageWorktreesReason: management.reason }), stalePaths: this.staleSnapshot.get(project.id) ?? [], ...(project.commands?.setup === undefined ? {} : { setup: true }), worktrees: byProject.get(project.id) ?? [] };
    });
    const listed = this.listPlaces(places, [...discovered.flatMap(agent => this.placeOf(agent, places) ?? []), ...shellPlaces, ...await this.pinnedScratchPlaces(places)]);
    this.listedPlaces = new Map(listed.map(place => [place.id, place]));
    // materialize flags only at publication so concurrent replies can invalidate earlier panes
    const presentedAgents = agents.map(agent => agent.attention === 'finished' && agent.question === undefined && messageQuestionStates.get(agent.id)?.hasQuestion === true
      ? { ...agent, hasMessageQuestion: true as const }
      : agent);
    return { generation: this.generation, serverStartedAt: this.serverStartedAt, adapters: adapterCapabilities(this.adapters), agents: presentedAgents, projects, places: listed.map(place => this.placeView(place, shellCounts)) };
  }

  // The directory-Project or Scratch Place with this id, as the current dashboard lists it (with
  // its bridge host path), so a Place route only reaches a folder the console already shows.
  // Worktrees are not included; they resolve from the Worktree snapshot.
  async place(id: string): Promise<Place | undefined> {
    await this.dashboard();
    return this.listedPlaces.get(id);
  }

  // the pinned ad-hoc Scratch Places: a pinned `scratch:<root>` whose folder still resolves to that
  // root (not removed, not swapped for a symlink) and lies inside no configured Place, where a
  // folder since made part of a directory Project would otherwise linger as a Place of its own
  private async pinnedScratchPlaces(configured: readonly Place[]): Promise<Place[]> {
    const pinned = await Promise.all(Object.entries(this.pinSnapshot).map(async ([id, isPinned]) => {
      const root = worktreePathOf(id);
      if (!isPinned || projectIdOf(id) !== scratchProjectId || root === undefined) return undefined;
      if (await realpath(root).catch(() => undefined) !== root) return undefined;
      return markedPlace(configured, id);
    }));
    return pinned.filter((place): place is Place => place !== undefined);
  }

  // the directory-Project and Scratch Places the dashboard lists: every configured one, then each
  // other Scratch Place that holds an Agent or a Console shell or is pinned, ordered by home
  private listPlaces(configured: readonly Place[], occupied: readonly Place[]): Place[] {
    const known = new Set(configured.map(place => place.id));
    const adhoc = new Map<string, Place>();
    for (const place of occupied) if (!known.has(place.id)) adhoc.set(place.id, place);
    return [...configured.filter(place => place.kind !== 'worktree'), ...[...adhoc.values()].sort((left, right) => left.home.localeCompare(right.home))];
  }
  // one listed Place on the wire, with its pin and Console-shell count
  private placeView(place: Place, shellCounts: ReadonlyMap<string, number>): DashboardPlace {
    const consoleShells = shellCounts.get(place.id) ?? 0;
    return { id: place.id, kind: place.kind === 'directory' ? 'directory' : 'scratch', projectId: place.projectId, label: place.label, home: place.home, ...(place.adhoc === true ? { adhoc: true as const } : {}), pinned: this.pinSnapshot[place.id] ?? false, ...(consoleShells > 0 ? { consoleShells } : {}) };
  }

  // whether a live agent sits in a checkout that is not a known Worktree but whose
  // repository is a configured Project — the signal to re-run discovery on demand
  private async hasUnknownProjectWorktree(agents: Agent[], worktrees: Worktree[]): Promise<boolean> {
    const seen = new Set<string>();
    for (const agent of agents) {
      // the checkout the pane is in, not the Place it was placed in: a new Worktree nested in
      // a known one is placed in the outer one until the re-scan lists it
      const root = agent.home;
      if (isUpdateAdvisorLabel(agent.displayLabel) || seen.has(root)) continue;
      seen.add(root);
      if (worktrees.some(worktree => worktreeMatchesWorkspace(worktree, root))) continue;
      const common = await this.cachedCommonDir(root);
      if (common !== undefined && this.projectsNow().some(project => project.available && project.identity === common)) return true;
    }
    return false;
  }

  // the workspace's common git dir, memoised until the next invalidateWorktrees()
  private async cachedCommonDir(workspace: string): Promise<string | undefined> {
    const cached = this.commonDirCache.get(workspace);
    if (cached !== undefined) return cached ?? undefined;
    const common = await gitCommonDir(workspace).catch(() => undefined);
    if (this.commonDirCache.size < 500) this.commonDirCache.set(workspace, common ?? null);
    return common;
  }
}
