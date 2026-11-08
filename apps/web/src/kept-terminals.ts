import { mountStreamedTerminal, type StreamedTerminalHandle, type StreamedTerminalOptions } from './streamed-terminal.js';

// The streamed terminals of recently left Workspaces stay parked (stream closed, xterm and
// screen kept) so going back shows the last screen at once instead of a loading cover.
export type TerminalKeep = { workspace: string; panel: string };

const keptWorkspaces = 3;
// workspace key -> panel key -> parked terminal; the Map's order is least recently left first
const kept = new Map<string, Map<string, StreamedTerminalHandle>>();
const shown = new Set<string>();

const disposeWorkspace = (workspace: string) => {
  kept.get(workspace)?.forEach(handle => handle.dispose());
  kept.delete(workspace);
};

// a panel unmounted in a Workspace that is still shown was closed, not left behind
const settle = () => {
  for (const workspace of [...kept.keys()]) if (shown.has(workspace)) disposeWorkspace(workspace);
  while (kept.size > keptWorkspaces) disposeWorkspace(kept.keys().next().value!);
};

// a panel's terminal: its parked one when its Workspace kept it, else a new mount
export const mountKeptTerminal = (keep: TerminalKeep | undefined, container: HTMLElement, options: StreamedTerminalOptions): StreamedTerminalHandle => {
  const panels = keep === undefined ? undefined : kept.get(keep.workspace);
  const handle = keep === undefined ? undefined : panels?.get(keep.panel);
  if (keep === undefined || panels === undefined || handle === undefined) return mountStreamedTerminal(container, options);
  panels.delete(keep.panel);
  if (panels.size === 0) kept.delete(keep.workspace);
  handle.reattach(container, options);
  return handle;
};

// Park a panel's terminal as its panel unmounts. Whether its Workspace was left or the panel
// closed is known only once the whole commit has run, so that is decided a microtask later.
export const releaseKeptTerminal = (keep: TerminalKeep | undefined, handle: StreamedTerminalHandle) => {
  if (keep === undefined) return handle.dispose();
  handle.park();
  const panels = kept.get(keep.workspace) ?? new Map<string, StreamedTerminalHandle>();
  const previous = panels.get(keep.panel);
  if (previous !== undefined && previous !== handle) previous.dispose();
  panels.set(keep.panel, handle);
  kept.delete(keep.workspace);
  kept.set(keep.workspace, panels);
  queueMicrotask(settle);
};

// Mark a Workspace shown. Run from the Workspace's own effect, after its panels' effects have
// claimed their terminals, so whatever it kept and nothing claimed belongs to a panel that is gone.
export const showKeptWorkspace = (workspace: string): (() => void) => {
  shown.add(workspace);
  disposeWorkspace(workspace);
  return () => { shown.delete(workspace); };
};
