import { useSyncExternalStore } from 'react';

export type WorkspaceSplit = { key: string; label: string };
// A mounted Workspace's panels and what the keyboard does to them. `jump` brings a panel into view
// and focuses it, its input (a terminal, the composer) when `input`. `currentPanel` is the panel
// holding focus, else the last focused, else the one in view; `lastPanel` the one before it.
// `toggleCode` is set only for a Worktree, which has a Code panel; `toggleStack` only for a Worktree
// whose Stack has processes.
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
  // guard non-destructive minimization across panel entry points
  minimizePanel: (key: string, minimize: () => void) => void;
  openTerminal: (binding?: { table: string; key: string }) => void;
  toggleCode?: () => void;
  toggleStack?: () => void;
};
export const workspaceViews = new Map<string, WorkspaceView>();
export const pendingWorkspaceJumps = new Map<string, string>();
const listeners = new Set<() => void>();
let revision = 0;
const preferences = new Map<string, string | null>();
// retain close ordering even after an explicit restore clears empty intent
const openGenerations = new Map<string, number>();

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
// capture close-all ordering before an asynchronous explicit open
export const workspaceOpenGeneration = (key: string) => openGenerations.get(key) ?? 0;
// distinguish deliberate empty layouts from accidental all-minimized state
export const workspaceIntentionallyEmpty = (key: string) => read(`rac.workspace-empty:${key}`) !== null;
// retain close-all intent only in this browser and workspace
export const setWorkspaceIntentionallyEmpty = (key: string, empty: boolean) => {
  // a completed close invalidates old opens without invalidating later explicit restores
  if (empty) openGenerations.set(key, workspaceOpenGeneration(key) + 1);
  write(`rac.workspace-empty:${key}`, empty ? '1' : null);
};
// a newer close-all wins over an open that was already in flight
export const workspaceOpenStillCurrent = (key: string, generation: number) => workspaceOpenGeneration(key) === generation;
// exposing an agent explicitly resumes the ordinary visibility policy
export const setAgentSplitHidden = (key: string, hidden: boolean) => {
  // restoring a split ends deliberate emptiness
  if (!hidden && workspaceIntentionallyEmpty(key)) setWorkspaceIntentionallyEmpty(key, false);
  write(`rac.hidden-agent:${key}`, hidden ? '1' : null);
};
// directory and scratch aliases are private to this browser
export const workspaceAlias = (key: string) => read(`rac.workspace-name:${key}`);
// clear an empty alias back to the discovered workspace name
export const setWorkspaceAlias = (key: string, name: string) => write(`rac.workspace-name:${key}`, name.trim() || null);
// restore settings visibility without sharing it across workspace identities
export const settingsSplitOpen = (key: string) => read(`rac.settings-open:${key}`) === '1';
// retain visibility only and keep settings values out of browser persistence
export const setSettingsSplitOpen = (key: string, open: boolean) => write(`rac.settings-open:${key}`, open ? '1' : null);
