import { createHash } from 'node:crypto';
import type { Agent, CleanupTarget, CleanupTargetKind, Pane, SocketRef } from '../domain/models.js';
import { ProcSocketFinder, type SocketFinder } from '../discovery/service.js';
import { ProcInspector, type HostProcess, type HostProcessInspector, type ProcessInspector } from '../discovery/processes.js';
import { adapters, paneExcluded } from '../adapters/registry.js';
import type { AgentKind, PaneScan } from '../adapters/types.js';
import type { WorktreeManagementService } from '../worktrees/management.js';
import { TmuxAdapter } from '../tmux/adapter.js';

type DiscoverySnapshot = { refresh(force?: boolean): Promise<Agent[]> };
type BranchCleanup = Pick<WorktreeManagementService, 'cleanupBranches' | 'deleteCleanupBranch'>;
type CleanupAction = { target: CleanupTarget; socket?: SocketRef; paneId?: string; pid?: number; branch?: { projectId: string; name: string; reason: 'merged' | 'closed' } };
export type CleanupVersion = { epoch: number; revision: number };

const opaqueId = (kind: CleanupTargetKind, identity: string) => `cleanup-${createHash('sha256').update(`${kind}\0${identity}`).digest('base64url').slice(0, 24)}`;
const paneIdentity = (pane: Pane) => `${pane.socket.fingerprint}:${pane.paneId}`;

export class CleanupService {
  private readonly dismissed = new Set<string>();
  private readonly versionEpoch = Date.now();
  private versionRevision = 0;
  private current = new Map<string, CleanupAction>();
  private scanInFlight?: Promise<CleanupTarget[]>;

  // configure runtime and branch cleanup dependencies
  constructor(
    private readonly discovery: DiscoverySnapshot,
    private readonly finder: SocketFinder = new ProcSocketFinder(),
    private readonly tmux: Pick<TmuxAdapter, 'listPanes' | 'close' | 'terminateHostProcess'> = new TmuxAdapter(),
    private readonly processInspector: ProcessInspector & HostProcessInspector = new ProcInspector(),
    private readonly branchCleanup?: BranchCleanup
  ) {}

  // copy the current cache ordering metadata
  get version(): CleanupVersion {
    return { epoch: this.versionEpoch, revision: this.versionRevision };
  }

  pending(): CleanupTarget[] {
    return [...this.current.values()].filter(candidate => !this.dismissed.has(candidate.target.id)).map(candidate => candidate.target);
  }

  scan(): Promise<CleanupTarget[]> {
    if (this.scanInFlight !== undefined) return this.scanInFlight;
    const scan = this.discover().finally(() => {
      if (this.scanInFlight === scan) this.scanInFlight = undefined;
    });
    this.scanInFlight = scan;
    return scan;
  }

  // execute selected targets without hiding unchecked work
  async cleanup(targetIds: unknown): Promise<CleanupTarget[] | undefined> {
    if (!Array.isArray(targetIds) || targetIds.length > 500 || targetIds.some(id => typeof id !== 'string') || new Set(targetIds).size !== targetIds.length) return undefined;
    const pending = this.pending();
    const pendingIds = new Set(pending.map(target => target.id));
    if (targetIds.some(id => !pendingIds.has(id as string))) return undefined;
    const selected = new Set(targetIds as string[]);
    await Promise.all([...selected].map(async id => {
      const action = this.current.get(id);
      // suppress completed targets
      if (action !== undefined && await this.execute(action).catch(() => false)) {
        this.dismissed.add(id);
        this.versionRevision += 1;
      }
    }));
    return this.pending();
  }

  // collect runtime and inactive branch suggestions with their cleanup reasons
  private async discover(): Promise<CleanupTarget[]> {
    const [sockets, agents, processes, cleanupBranches] = await Promise.all([
      this.finder.find(),
      this.discovery.refresh(true),
      this.processInspector.listProcesses(),
      this.branchCleanup?.cleanupBranches().catch(() => []) ?? Promise.resolve([])
    ]);
    const panes = (await Promise.all(sockets.map(socket => this.tmux.listPanes(socket)))).flat();
    const recognized = await Promise.all(panes.map(pane => this.processInspector.recognizeAgent(pane.pid)));
    const recognizedKind = new Map<string, AgentKind>();
    panes.forEach((pane, index) => { const agent = recognized[index]; if (agent !== undefined) recognizedKind.set(paneIdentity(pane), agent.kind); });
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
      recognizedKind: pane => recognizedKind.get(paneIdentity(pane)),
      excluded: paneExcluded,
      paneAncestor
    };

    const candidates: CleanupAction[] = [];
    for (const pane of panes) {
      // a pane with a console role — a Console shell (the operator's own) or a Stack process —
      // is never proposed, even should a future adapter rule match a bare shell (spec, Console shells)
      if (pane.role !== undefined) continue;
      for (const adapter of adapters) {
        const classification = adapter.panes?.classify(pane, scan);
        if (classification === undefined) continue;
        candidates.push({ socket: pane.socket, paneId: pane.paneId, target: this.target(classification.kind, `${paneIdentity(pane)}:${pane.pid}`, classification.label, classification.detail) });
        break;
      }
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

    // distinguish closed PR work so the operator can explicitly choose to discard it
    for (const branch of cleanupBranches) {
      candidates.push({
        target: this.target(branch.reason === 'closed' ? 'closed-pr-branch' : 'merged-branch', `${branch.projectId}:${branch.branch}`, branch.branch, branch.reason === 'closed' ? `Closed PR (not merged) in ${branch.projectLabel}; deleting this branch discards unmerged work` : `Merged branch in ${branch.projectLabel}`),
        branch: { projectId: branch.projectId, name: branch.branch, reason: branch.reason }
      });
    }

    const next = new Map(candidates.map(candidate => [candidate.target.id, candidate]));
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
