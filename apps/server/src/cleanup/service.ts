import { createHash } from 'node:crypto';
import type { Agent, CleanupTarget, CleanupTargetKind, Pane, SocketRef } from '../domain/models.js';
import { ProcSocketFinder, type SocketFinder } from '../discovery/service.js';
import { ProcInspector, type HostProcessInspector, type ProcessInspector, type RecognizedAgent } from '../discovery/processes.js';
import { adapterFor, adapters, paneExcluded } from '../adapters/registry.js';
import { messageAsksQuestion } from '../adapters/attention.js';
import { paneLabel, type CleanupClassification, type PaneScan } from '../adapters/types.js';
import type { WorktreeManagementService } from '../worktrees/management.js';
import { TmuxAdapter } from '../tmux/adapter.js';

type DiscoverySnapshot = { refresh(force?: boolean): Promise<Agent[]>; readonly tmuxDiscoverySockets?: ReadonlySet<string> };
type BranchCleanup = Pick<WorktreeManagementService, 'cleanupBranches' | 'deleteCleanupBranch'>;
type CleanupTmux = Pick<TmuxAdapter, 'listPanes' | 'close' | 'terminateHostProcess'> & Partial<Pick<TmuxAdapter, 'capture' | 'closeIdlePane'>>;
type IdleCandidate = { pane: Pane & { cleanupActivity: string }; kind: RecognizedAgent['kind']; witness: string };
type CleanupAction = { target: CleanupTarget; socket?: SocketRef; paneId?: string; pid?: number; idle?: IdleCandidate; branch?: { projectId: string; name: string; reason: 'merged' | 'closed' } };
export type CleanupVersion = { epoch: number; revision: number };

const idleThresholdMs = 24 * 60 * 60 * 1_000;
const legacyActivityPrecisionMs = 1_000;
const opaqueId = (kind: CleanupTargetKind, identity: string) => `cleanup-${createHash('sha256').update(`${kind}\0${identity}`).digest('base64url').slice(0, 24)}`;
const paneIdentity = (pane: Pane) => `${pane.socket.fingerprint}:${pane.paneId}`;
// a pane may have become an agent since it was first listed as debris
const isPaneAction = (action: CleanupAction): boolean => action.paneId !== undefined || action.idle !== undefined;

// arm only for a proven live agent that is idle and out of RAC
function idleCandidate(pane: Pane, agent: RecognizedAgent | undefined): IdleCandidate | undefined {
  // missing activity or identity evidence cannot produce a cleanup suggestion
  if (agent?.startTime === undefined || pane.cleanupActivity === undefined || pane.windowId === undefined
    || pane.paneMode !== undefined || pane.reviewRun !== undefined || pane.spawnedBy !== undefined || pane.reportedQuestion !== undefined) return undefined;
  // require affirmative attention evidence without ignoring conflicting signals
  const inferred = adapterFor(agent.kind)?.inferState(pane);
  if ((pane.reportedAttention ?? inferred) !== 'finished' || (inferred !== undefined && inferred !== 'finished')) return undefined;
  return {
    pane: { ...pane, cleanupActivity: pane.cleanupActivity }, kind: agent.kind,
    witness: JSON.stringify([pane.sessionId, pane.windowId, agent.kind, agent.pid, agent.startTime, pane.cleanupActivity])
  };
}

export class CleanupService {
  private readonly dismissed = new Set<string>();
  private readonly versionEpoch = Date.now();
  private versionRevision = 0;
  private current = new Map<string, CleanupAction>();
  private scanInFlight?: Promise<CleanupTarget[]>;
  private idleObserved = new Map<string, number>();

  // configure runtime and branch cleanup dependencies
  constructor(
    private readonly discovery: DiscoverySnapshot,
    private readonly finder: SocketFinder = new ProcSocketFinder(),
    private readonly tmux: CleanupTmux = new TmuxAdapter(),
    private readonly processInspector: ProcessInspector & HostProcessInspector = new ProcInspector(),
    private readonly branchCleanup?: BranchCleanup,
    private readonly monotonicNow = () => performance.now()
  ) {}

  // copy the current cache ordering metadata
  get version(): CleanupVersion {
    return { epoch: this.versionEpoch, revision: this.versionRevision };
  }

  pending(): CleanupTarget[] {
    return [...this.current.values()].filter(candidate => !this.dismissed.has(candidate.target.id)).map(candidate => candidate.target);
  }

  // collect suggestions only, never execute them from discovery
  scan(): Promise<CleanupTarget[]> {
    if (this.scanInFlight !== undefined) return this.scanInFlight;
    const scan = this.discover().catch(error => {
      // an unobservable interval does not count toward the threshold
      this.idleObserved.clear();
      throw error;
    }).finally(() => {
      if (this.scanInFlight === scan) this.scanInFlight = undefined;
    });
    this.scanInFlight = scan;
    return scan;
  }

  // protect prompts not reflected in tmux attention metadata on explicit cleanup
  private async closeIdleAgent({ pane, kind, witness }: IdleCandidate): Promise<boolean> {
    const adapter = adapterFor(kind);
    const questions = adapter?.questions;
    const capture = await this.tmux.capture?.(pane.socket, pane.paneId);
    // refuse drafts, unanswered questions and captures without a known empty composer
    if (!capture || adapter?.newConversation?.composerEmpty(capture) !== true
      || questions?.parse?.(capture) !== undefined || messageAsksQuestion(adapter?.turns?.latestMessage?.(capture) ?? capture)) return false;
    // check OMX question files that may not be visible on the screen
    if (await questions?.pending?.(pane.path, pane.paneId) !== undefined) return false;
    // the screen and question reads must not carry authority across a replaced child process
    const current = idleCandidate(pane, await this.processInspector.recognizeAgent(pane.pid));
    if (current?.witness !== witness) return false;
    return await this.tmux.closeIdlePane?.(pane) ?? false;
  }

  // execute selected targets without hiding unchecked work
  async cleanup(targetIds: unknown): Promise<CleanupTarget[] | undefined> {
    if (!Array.isArray(targetIds) || targetIds.length > 500 || targetIds.some(id => typeof id !== 'string') || new Set(targetIds).size !== targetIds.length) return undefined;
    const pending = this.pending();
    const pendingIds = new Set(pending.map(target => target.id));
    if (targetIds.some(id => !pendingIds.has(id as string))) return undefined;
    // capture selected rows and revalidate all panes in one fresh runtime scan
    const selected = (targetIds as string[]).map(id => this.current.get(id)!);
    const fresh = selected.some(isPaneAction)
      ? new Map((await this.discoverRuntime().catch(() => [])).map(action => [action.target.id, action]))
      : undefined;
    // dispatch only the user's explicit selections
    await Promise.all(selected.map(async action => {
      const id = action.target.id;
      const revalidated = isPaneAction(action) ? fresh?.get(id) : action;
      // changed panes cannot be closed using a stale selection
      if (this.dismissed.has(id) || revalidated === undefined) return;
      // suppress completed targets
      if (await this.execute(revalidated).catch(() => false)) {
        this.dismissed.add(id);
        this.versionRevision += 1;
      }
    }));
    return this.pending();
  }

  // collect fresh runtime candidates independently of branch discovery
  private async discoverRuntime(): Promise<CleanupAction[]> {
    const [sockets, { agents, visibleSockets }, processes] = await Promise.all([
      this.finder.find(),
      // bind visibility to the socket lifetimes observed by discovery
      this.discovery.refresh(true).then(agents => ({ agents, visibleSockets: this.discovery.tmuxDiscoverySockets })),
      this.processInspector.listProcesses()
    ]);
    const panes = (await Promise.all(sockets.map(socket => this.tmux.listPanes(socket)))).flat();
    const recognized = await Promise.all(panes.map(pane => this.processInspector.recognizeAgent(pane.pid)));
    const recognizedByPane = new Map(panes.map((pane, index) => [paneIdentity(pane), recognized[index]]));
    const duplicates = new Set<string>();
    const seenPanes = new Set<string>();
    // linked windows can show one pane in multiple sessions, so leave them alone
    for (const pane of panes) {
      const id = paneIdentity(pane);
      // do not treat a second session as a separate agent
      if (seenPanes.has(id)) duplicates.add(id);
      seenPanes.add(id);
    }
    const activeAgents = new Set(agents.map(agent => agent.id));
    const paneByPid = new Map(panes.map(pane => [pane.pid, pane]));
    const processByPid = new Map(processes.map(process => [process.pid, process]));
    const paneAncestor = (pid: number): Pane | undefined => {
      const seen = new Set<number>();
      let current = pid;
      while (current > 0 && seen.size < 256 && !seen.has(current)) {
        const pane = paneByPid.get(current);
        if (pane !== undefined) return pane;
        seen.add(current);
        current = processByPid.get(current)?.parentPid ?? 0;
      }
      return undefined;
    };
    // the agent-agnostic facts every Adapter classifies its panes against
    const scan: PaneScan = {
      panes,
      processes,
      identity: paneIdentity,
      sessionIdentity: pane => `${pane.socket.fingerprint}:${pane.sessionId}`,
      active: pane => activeAgents.has(paneIdentity(pane)),
      recognizedKind: pane => recognizedByPane.get(paneIdentity(pane))?.kind,
      excluded: paneExcluded,
      paneAncestor
    };

    const candidates: CleanupAction[] = [];
    for (const pane of panes) {
      // roles and dashboard visibility protect a pane even if fresh process recognition fails
      if (pane.role !== undefined || scan.active(pane)) continue;
      let classification: CleanupClassification | undefined;
      // preserve the adapter registry's cleanup precedence
      for (const adapter of adapters) {
        classification = adapter.panes?.classify(pane, scan);
        // take the first match
        if (classification !== undefined) break;
      }
      const id = paneIdentity(pane);
      const agent = recognizedByPane.get(id);
      // no recognized agent can fall through to an ordinary pane close
      if (agent !== undefined) {
        const agentClassification = classification?.kind === 'stale-agent' || classification?.kind === 'orphan-worker' ? classification : undefined;
        const idle = visibleSockets?.has(pane.socket.fingerprint) && !duplicates.has(id) && (!scan.excluded(pane) || agentClassification?.kind === 'orphan-worker')
          ? idleCandidate(pane, agent) : undefined;
        // absence alone is not evidence of inactivity
        if (idle === undefined) continue;
        const kind = agentClassification?.kind ?? 'stale-agent';
        const label = agentClassification?.label ?? `Idle ${agent.kind} agent`;
        const detail = agentClassification?.detail ?? `${paneLabel(pane)} at ${pane.path}`;
        candidates.push({ idle, target: this.target(kind, `${id}:${pane.pid}:${idle.witness}`, label, `Idle for more than 24 hours · ${detail}`) });
        continue;
      }
      // non-agent runtime debris keeps the existing manual cleanup rules
      if (classification !== undefined) candidates.push({ socket: pane.socket, paneId: pane.paneId, target: this.target(classification.kind, `${id}:${pane.pid}`, classification.label, classification.detail) });
    }
    const executorSocket = sockets[0];
    for (const process of processes) {
      for (const adapter of adapters) {
        const classification = adapter.panes?.classifyProcess?.(process, scan);
        if (classification === undefined) continue;
        candidates.push({
          target: this.target(classification.kind, `${process.pid}:${process.startTime}`, classification.label, classification.detail),
          ...(executorSocket === undefined ? {} : { socket: executorSocket }),
          pid: process.pid
        });
        break;
      }
    }
    return candidates;
  }

  // publish runtime and inactive branch suggestions for manual cleanup
  private async discover(): Promise<CleanupTarget[]> {
    const [candidates, cleanupBranches] = await Promise.all([
      this.discoverRuntime(),
      this.branchCleanup?.cleanupBranches().catch(() => []) ?? Promise.resolve([])
    ]);
    // distinguish closed PR work so the operator can explicitly choose to discard it
    for (const branch of cleanupBranches) {
      candidates.push({
        target: this.target(branch.reason === 'closed' ? 'closed-pr-branch' : 'merged-branch', `${branch.projectId}:${branch.branch}`, branch.branch, branch.reason === 'closed' ? `Closed PR (not merged) in ${branch.projectLabel}; deleting this branch discards unmerged work` : `Merged branch in ${branch.projectLabel}`),
        branch: { projectId: branch.projectId, name: branch.branch, reason: branch.reason }
      });
    }

    const now = this.monotonicNow();
    const observed = new Map<string, number>();
    const next = new Map<string, CleanupAction>();
    // expose each live agent only after its exact idle observation clears the threshold
    for (const candidate of candidates) {
      const id = candidate.target.id;
      // other cleanup categories do not share an idle requirement
      if (candidate.idle !== undefined) {
        const since = this.idleObserved.get(id) ?? now;
        observed.set(id, since);
        // allow for output in the observation second on older tmux
        const margin = candidate.idle.pane.cleanupActivity.startsWith('w') ? legacyActivityPrecisionMs : 0;
        if (now - since <= idleThresholdMs + margin) continue;
      }
      next.set(id, candidate);
    }
    this.idleObserved = observed;
    for (const id of this.dismissed) if (!next.has(id)) this.dismissed.delete(id);
    this.current = next;
    this.versionRevision += 1;
    return this.pending();
  }

  private target(kind: CleanupTargetKind, identity: string, label: string, detail: string): CleanupTarget {
    return { id: opaqueId(kind, identity), kind, label, detail };
  }

  // execute only the selected action after its safety checks
  private async execute(action: CleanupAction): Promise<boolean> {
    // the selected live agent still needs terminal and process checks
    if (action.idle !== undefined) return await this.closeIdleAgent(action.idle);
    // revalidate the branch using the reason the operator selected
    if (action.branch !== undefined) {
      // reject an impossible provider mismatch
      if (this.branchCleanup === undefined) return false;
      return await this.branchCleanup.deleteCleanupBranch(action.branch.projectId, action.branch.name, action.branch.reason);
    }
    if (action.socket === undefined) return false;
    if (action.paneId !== undefined) return await this.tmux.close(action.socket, action.paneId);
    if (action.pid !== undefined) return await this.tmux.terminateHostProcess(action.socket, action.pid);
    return false;
  }
}
