// share page ownership across controls, search, validation and drafts
export const applicationPreferences = [
  { key: 'flyoutMarkers', page: 'interface', label: 'Flyout markers', keywords: 'carets menu buttons' },
  { key: 'resourceMonitoring', page: 'interface', label: 'Resource monitoring', keywords: 'server flyout host cpu memory ram disks drives storage usage wsl windows' },
  { key: 'autoDeleteSentNotes', page: 'notes', label: 'Auto-delete sent notes', keywords: 'sent queued unlocked locked cleanup remove delete undo' },
  { key: 'fileOpenAction', page: 'files', label: 'Default file action', keywords: 'open files preview edit editor' },
  { key: 'dynamicWorktrees', page: 'projects', label: 'Dynamic worktrees', keywords: 'launcher multiple worktrees' },
  { key: 'replySuggestions', page: 'agents', label: 'Reply suggestions', keywords: 'prompt usage cost agent suggestions' },
  { key: 'usagePace', page: 'agents', label: 'Usage pace', keywords: 'account limit consumed reset ahead behind' }
] as const;

export type ApplicationPreferencePage = typeof applicationPreferences[number]['page'];
