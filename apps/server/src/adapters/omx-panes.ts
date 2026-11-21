import type { Pane } from '../domain/models.js';
import type { HostProcess } from '../discovery/processes.js';
import { isHudWatcherCommand } from './omx-processes.js';
import { paneLabel, type CleanupClassification, type PaneScan } from './types.js';

/**
 * The OMX Adapter's runtime-cleanup rules (ADR 0002, ADR 0005): the team worker
 * panes OMX spawns are hidden from the dashboard, a worker whose session lost its
 * leader is an orphan, a HUD watcher pane or process is a monitor to clean up,
 * and an OMX pane the dashboard no longer represents is a stale agent.
 */

// OMX spawns worker panes inside its team worktrees and from generated startup
// scripts. Both are excluded from the dashboard and are never a stale agent.
const omxWorkerWorktree = /(?:^|\/)\.omx\/team\/[^/]+\/worktrees\/worker-\d+(?:\/|$)/u;
const omxWorkerStartup = /(?:^|\/)\.omx\/state\/team\/[^/]+\/runtime\/worker-\d+-startup\.sh(?:['"\s]|$)/u;
// A pane whose recorded start command launched the OMX HUD watcher.
const omxHudStartCommand = /(?:^|[/\s])omx\s+hud(?:\s+[^\s]+)*\s+--watch(?:\s|$)/u;
// distinguish an explicitly launched watcher from a leader's helper
const startedAsHud = (pane: Pane): boolean => omxHudStartCommand.test(pane.startCommand ?? '');

export function isOmxWorkerPane(pane: Pick<Pane, 'path' | 'startCommand' | 'consoleManaged'>): boolean {
  // an explicit console launch owns the pane even inside a retained team checkout
  if (pane.consoleManaged === true) return false;
  return omxWorkerWorktree.test(pane.path) || omxWorkerStartup.test(pane.startCommand ?? '');
}

// `classify` is called once per pane over a shared scan, so the two derived sets
// are memoised against the scan object rather than recomputed for every pane.
const hudCache = new WeakMap<PaneScan, Set<string>>();
const leaderCache = new WeakMap<PaneScan, Set<string>>();

// find the panes with watcher processes below them without inferring the pane's role
function hudDescendantPaneIds(scan: PaneScan): Set<string> {
  const cached = hudCache.get(scan);
  if (cached !== undefined) return cached;
  const ids = new Set<string>();
  for (const process of scan.processes) {
    if (!isHudWatcherCommand(process.cmdline)) continue;
    const pane = scan.paneAncestor(process.pid);
    if (pane !== undefined) ids.add(scan.identity(pane));
  }
  hudCache.set(scan, ids);
  return ids;
}

// A session has a leader when it still holds a live agent pane — OMX, or plain
// Codex — that no Adapter excludes and that was not started as a HUD watcher.
// a HUD helper under a recognized leader does not stop it from owning the team
function sessionsWithLeader(scan: PaneScan): Set<string> {
  const cached = leaderCache.get(scan);
  if (cached !== undefined) return cached;
  const leaders = new Set<string>();
  // only recognized agents can own a team
  for (const pane of scan.panes) {
    const kind = scan.recognizedKind(pane);
    // leave excluded workers and panes started as watchers out of the leader set
    if ((kind === 'omx' || kind === 'codex') && !scan.excluded(pane) && !startedAsHud(pane)) leaders.add(scan.sessionIdentity(pane));
  }
  leaderCache.set(scan, leaders);
  return leaders;
}

// keep standalone watchers separate from panes that contain agents
export function classifyOmxPane(pane: Pane, scan: PaneScan): CleanupClassification | undefined {
  const session = pane.sessionName ?? pane.sessionId;
  // a descendant-only watcher never changes a recognized agent's classification
  if (startedAsHud(pane) || (scan.recognizedKind(pane) === undefined && hudDescendantPaneIds(scan).has(scan.identity(pane)))) return { kind: 'hud-pane', label: 'HUD watcher', detail: `${paneLabel(pane)} in tmux session ${session}` };
  if (isOmxWorkerPane(pane) && !sessionsWithLeader(scan).has(scan.sessionIdentity(pane))) return { kind: 'orphan-worker', label: 'Orphan OMX worker', detail: `${paneLabel(pane)} in tmux session ${session}` };
  if (scan.recognizedKind(pane) === 'omx' && !scan.excluded(pane) && !scan.active(pane)) return { kind: 'stale-agent', label: 'Stale OMX agent', detail: `${paneLabel(pane)} at ${pane.path}` };
  return undefined;
}

export function classifyOmxProcess(process: HostProcess, scan: PaneScan): CleanupClassification | undefined {
  if (!isHudWatcherCommand(process.cmdline) || scan.paneAncestor(process.pid) !== undefined) return undefined;
  return { kind: 'hud-process', label: 'Detached HUD watcher', detail: `Host process ${process.pid}: ${process.cmdline.split('\0').filter(Boolean).join(' ')}` };
}
