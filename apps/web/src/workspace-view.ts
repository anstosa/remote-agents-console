import { useSyncExternalStore } from 'react';

export type WorkspaceSplit = { key: string; label: string };
// A mounted Workspace's panels and what the keyboard does to them. `jump` brings a panel into view
// and focuses it, its input (a terminal, the composer) when `input`. `currentPanel` is the panel
// holding focus, else the last focused, else the one in view; `lastPanel` the one before it.
// `toggleCode` is set only for a Worktree, which has a Code panel.
export type WorkspaceView = {
  splits: WorkspaceSplit[];
  canClose: boolean;
  // confirm unsaved split drafts before workspace lifecycle mutations
  prepareClose?: () => Promise<boolean>;
  closeAll: () => void;
  jump: (key: string, input?: boolean) => void;
  currentPanel: () => string | undefined;
  lastPanel: () => string | undefined;
  toggleExpand: (key: string) => void;
  renamePanel: (key: string) => boolean;
  closePanel: (key: string) => void;
  openTerminal: (binding?: { table: string; key: string }) => void;
  toggleCode?: () => void;
};
export const workspaceViews = new Map<string, WorkspaceView>();
export const pendingWorkspaceJumps = new Map<string, string>();
const listeners = new Set<() => void>();
let revision = 0;
const preferences = new Map<string, string | null>();

// read optional client-local workspace preferences
const read = (key: string): string | null => {
  // retain local actions when browser storage is blocked
  if (preferences.has(key)) return preferences.get(key) ?? null;
  try { return localStorage.getItem(key); }
  catch { return null; }
};

// publish one preference change to mounted tabs and panels
const write = (key: string, value: string | null) => {
  preferences.set(key, value);
  try {
    // clearing a preference restores its discovered default
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage is optional */ }
  revision += 1;
  listeners.forEach(listener => listener());
};

// subscribe without retaining unmounted workspaces
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

// refresh controls after an explicit workspace action
export const useWorkspaceViewRevision = () => useSyncExternalStore(subscribe, () => revision);
// keep non-destructive agent minimization separate from process lifetime
export const agentSplitHidden = (key: string) => read(`rac.hidden-agent:${key}`) === '1';
// expose a minimized agent again without restarting it
export const setAgentSplitHidden = (key: string, hidden: boolean) => write(`rac.hidden-agent:${key}`, hidden ? '1' : null);
// directory and scratch aliases are private to this browser
export const workspaceAlias = (key: string) => read(`rac.workspace-name:${key}`);
// clear an empty alias back to the discovered workspace name
export const setWorkspaceAlias = (key: string, name: string) => write(`rac.workspace-name:${key}`, name.trim() || null);
// restore settings visibility without sharing it across workspace identities
export const settingsSplitOpen = (key: string) => read(`rac.settings-open:${key}`) === '1';
// retain visibility only and keep settings values out of browser persistence
export const setSettingsSplitOpen = (key: string, open: boolean) => write(`rac.settings-open:${key}`, open ? '1' : null);
