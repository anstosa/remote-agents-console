import type { Agent, Dashboard, SocketRef, Worktree } from '../../src/domain/models.js';
import type { Place } from '../../src/places/places.js';

/**
 * The fakes the Run primitive's HTTP-seam tests drive `buildApp` with, kept here so the
 * later Run tickets (reuse-a-pane, unattended firing) reuse the same counter-driven
 * discovery, recording tmux, fake launch service and zero poll delay (Scheduled prompts).
 */

/** A `launchPollDelay` that never waits, so the sixty-second poll runs at full speed in tests. */
export const zeroPollDelay = async (): Promise<void> => {};

/**
 * A launch service whose launch methods succeed unless `refuse` is set, recording the kinds they
 * saw. It covers the three Run targets — a Worktree (`launch`), a directory Project
 * (`launchProjectDirectory`) and Scratch (`launchHome`) — and reports every kind launchable unless
 * `unlaunchable` is set, so the Run primitive's launchability precondition can be exercised.
 * A directory Project's Place is `<projectId>:/<projectId>` and the Scratch Place `scratch:/scratch`;
 * a launched Agent there is matched back by that `placeId`.
 */
export type LaunchVia = 'worktree' | 'project' | 'home';
export function launchFake(options: { refuse?: boolean; unlaunchable?: boolean } = {}): {
  launch: (worktreeId: string, kind?: string) => Promise<boolean>;
  launchProjectDirectory: (projectId: string, kind?: string) => Promise<boolean>;
  launchHome: (kind?: string) => Promise<boolean>;
  directoryPlace: (projectId: string) => Promise<Place>;
  scratchPlace: () => Promise<Place>;
  isLaunchableKind: (kind: string) => boolean;
  kinds: Array<string | undefined>;
  // which launch method fired, so a test can tell the three target dispatches apart
  calls: Array<{ via: LaunchVia; kind?: string }>;
} {
  const kinds: Array<string | undefined> = [];
  const calls: Array<{ via: LaunchVia; kind?: string }> = [];
  const record = (via: LaunchVia, kind?: string) => { kinds.push(kind); calls.push(kind === undefined ? { via } : { via, kind }); return !options.refuse; };
  return {
    launch: async (_worktreeId, kind) => record('worktree', kind),
    launchProjectDirectory: async (_projectId, kind) => record('project', kind),
    launchHome: async kind => record('home', kind),
    directoryPlace: async projectId => ({ id: `${projectId}:/${projectId}`, kind: 'directory', projectId, label: projectId, home: `/${projectId}` }),
    scratchPlace: async () => ({ id: 'scratch:/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/scratch' }),
    isLaunchableKind: () => !options.unlaunchable,
    kinds,
    calls,
  };
}

/**
 * A stateful world for a reuse Run: one remembered agent the Run resets in place. `discovery.target`
 * returns the pre-reset `agent` until the reset command lands (a `/`-prefixed paste submitted with a
 * key), then `afterReset(readIndex)` for each later read, so the Adapter's `settled` rule observes
 * the change (Codex's title spin, Claude's new conversation id). The tmux reflects the live composer
 * draft like {@link recordingTmux}, so a Codex note submit settles after the reset; `pasted` records
 * the reset command then the note, in order. Drives the reuse-a-pane Run tickets (Scheduled prompts).
 */
export function reuseWorld(params: { worktree: Worktree; socket: SocketRef; agent: Agent; afterReset: (readIndex: number) => Agent; capture?: () => string; vanishAfterReset?: boolean }): {
  discovery: {
    invalidateWorktrees: () => void;
    worktreesNow: () => Worktree[];
    worktrees: () => Promise<Worktree[]>;
    place: () => Promise<undefined>;
    dashboard: () => Promise<Dashboard>;
    target: (id: string) => Promise<{ agent: Agent; socket: SocketRef } | undefined>;
  };
  tmux: {
    capture: () => Promise<string>;
    pastePrompt: (socket: SocketRef, pane: string, buffer: string, text: string) => Promise<boolean>;
    sendKeys: (socket: SocketRef, pane: string, keys: readonly unknown[]) => Promise<boolean>;
    close: (socket: SocketRef, pane: string) => Promise<boolean>;
    label: () => Promise<boolean>;
    pasted: string[];
    closed: string[];
    // the keys each submit sent, so a test can assert the reset used the Adapter's idle key
    sentKeys: unknown[][];
  };
} {
  const { worktree, socket, agent } = params;
  const pasted: string[] = [];
  const closed: string[] = [];
  const sentKeys: unknown[][] = [];
  let draft = '';
  let reset = false;
  let lastPasteWasReset = false;
  let readIndex = 0;
  const tmux = {
    capture: async () => (params.capture ? params.capture() : `› ${draft}`),
    pastePrompt: async (_socket: SocketRef, _pane: string, _buffer: string, text: string) => { draft = text; pasted.push(text); lastPasteWasReset = text.trim().startsWith('/'); return true; },
    // the Enter after a reset command flips the world into the fresh conversation; any other
    // submit clears the composer, so the note's own submit reads as accepted
    sendKeys: async (_socket: SocketRef, _pane: string, keys: readonly unknown[]) => { sentKeys.push([...keys]); if (lastPasteWasReset && !reset) reset = true; else draft = ''; lastPasteWasReset = false; return true; },
    close: async (_socket: SocketRef, pane: string) => { closed.push(pane); return true; },
    label: async () => true,
    pasted,
    closed,
    sentKeys,
  };
  const discovery = {
    invalidateWorktrees: () => {},
    worktreesNow: () => [worktree],
    worktrees: async () => [worktree],
    place: async () => undefined,
    dashboard: async () => ({ generation: 1, places: [], adapters: {}, agents: [agent], projects: [] }),
    // once reset, an optional `vanishAfterReset` drops the pane so the settle loop reads it as lost
    target: async (id: string) => (id !== agent.id || (reset && params.vanishAfterReset) ? undefined : { agent: reset ? params.afterReset(readIndex++) : agent, socket }),
  };
  return { discovery, tmux };
}

/**
 * A discovery stub over one Worktree and one agent: the agent is absent from the
 * dashboard until after `appearAfter` snapshots (so `waitForAgent` finds it on a later
 * poll, or never when `appearAfter` is `Infinity`), while `target` always resolves it so
 * the readiness poll can read its pane. `working` reports the agent busy while it holds, the
 * way the agent's own hook does once its prompt is submitted (pass `() => tmux.submits > 0`).
 */
export function appearingDiscovery(params: { worktree: Worktree; agent: Agent; socket: SocketRef; appearAfter?: number; working?: () => boolean }): {
  invalidateWorktrees: () => void;
  worktreesNow: () => Worktree[];
  worktrees: () => Promise<Worktree[]>;
  place: () => Promise<undefined>;
  dashboard: () => Promise<Dashboard>;
  target: (id: string) => Promise<{ agent: Agent; socket: SocketRef } | undefined>;
} {
  const { worktree, agent, socket } = params;
  const appearAfter = params.appearAfter ?? 1;
  let dashboards = 0;
  return {
    invalidateWorktrees: () => {},
    worktreesNow: () => [worktree],
    worktrees: async () => [worktree],
    place: async () => undefined,
    dashboard: async () => ({ generation: ++dashboards, places: [], adapters: {}, agents: dashboards > appearAfter ? [agent] : [], projects: [] }),
    target: async (id: string) => (id === agent.id ? { agent: params.working?.() === true ? { ...agent, attention: 'working' as const } : agent, socket } : undefined),
  };
}

/**
 * A recording tmux whose `capture` reflects the last pasted draft (`› <draft>`), so
 * Codex reads the composer as ready and the pasted prompt as visible then cleared —
 * the shape the queued-prompt tests already rely on. Pass `capture` to force a fixed
 * screen instead (a Claude safety check, or a still-loading Codex header). `pasted` and
 * `closed` record the pastes and pane closes the Run drove.
 */
export function recordingTmux(options: { capture?: () => string } = {}): {
  capture: () => Promise<string>;
  pastePrompt: (socket: SocketRef, pane: string, buffer: string, text: string) => Promise<boolean>;
  sendKeys: () => Promise<boolean>;
  close: (socket: SocketRef, pane: string) => Promise<boolean>;
  label: () => Promise<boolean>;
  pasted: string[];
  closed: string[];
  readonly submits: number;
} {
  const pasted: string[] = [];
  const closed: string[] = [];
  let draft = '';
  let submits = 0;
  return {
    capture: async () => (options.capture ? options.capture() : `› ${draft}`),
    pastePrompt: async (_socket, _pane, _buffer, text) => { draft = text; pasted.push(text); return true; },
    // Enter clears the composer, so the submission reads as accepted
    sendKeys: async () => { draft = ''; submits += 1; return true; },
    close: async (_socket, pane) => { closed.push(pane); return true; },
    label: async () => true,
    pasted,
    closed,
    get submits() { return submits; },
  };
}
