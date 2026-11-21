import { createContext, type ReactNode, useContext, useLayoutEffect } from 'react';

export type FileOpenAction = 'preview' | 'edit';
export type ServerPreferences = {
  fileOpenAction: FileOpenAction;
  flyoutMarkers: boolean;
  dynamicWorktrees: boolean;
  usagePace: boolean;
};
type ServerPreferenceSource = {
  fileOpenAction?: unknown;
  flyoutMarkers?: unknown;
  dynamicWorktrees?: unknown;
  usagePace?: unknown;
};

const defaults: ServerPreferences = {
  fileOpenAction: 'edit',
  flyoutMarkers: false,
  dynamicWorktrees: true,
  usagePace: true
};
const ServerPreferencesContext = createContext<ServerPreferences>(defaults);

// resolve one authenticated preference snapshot without trusting response casts
export const serverPreferences = (source?: ServerPreferenceSource): ServerPreferences => ({
  fileOpenAction: source?.fileOpenAction === 'preview' ? 'preview' : 'edit',
  flyoutMarkers: source?.flyoutMarkers === true,
  dynamicWorktrees: source?.dynamicWorktrees !== false,
  usagePace: source?.usagePace !== false
});

// publish the current server preferences to runtime consumers and portaled marker controls
export function ServerPreferencesProvider({ value, children }: { value: ServerPreferences; children: ReactNode }) {
  useLayoutEffect(() => {
    // keep portaled controls on the same marker setting
    if (value.flyoutMarkers) document.documentElement.dataset.flyoutMarkers = 'enabled';
    else delete document.documentElement.dataset.flyoutMarkers;
  }, [value.flyoutMarkers]);
  return <ServerPreferencesContext.Provider value={value}>{children}</ServerPreferencesContext.Provider>;
}

// read the current authenticated server preferences
export const useServerPreferences = (): ServerPreferences => useContext(ServerPreferencesContext);
