import type { SettingsChange, SettingsPatch, SettingsSnapshot } from './contracts.js';

export const tmuxEnvironmentKeys: ReadonlySet<string> = new Set([
  'RAC_TMUX_BIN',
  'RAC_HOST_TMUX_DIR',
  'RAC_HOST_TMUX_SOURCE',
  'RAC_HOST_UNIX_SOCKETS',
  'HOST_TMUX_DIR',
  'HOST_TMUX_BIN'
]);

const portableTmuxEnvironmentKeys: ReadonlySet<string> = new Set([
  'RAC_TMUX_BIN',
  'RAC_HOST_TMUX_DIR',
  'RAC_HOST_TMUX_SOURCE',
  'RAC_HOST_UNIX_SOCKETS'
]);

// expose docker host aliases only where their installation consumes them
export function tmuxEnvironmentKeysForInstallation(kind?: SettingsSnapshot['installationKind']): ReadonlySet<string> {
  return kind === 'compose' ? tmuxEnvironmentKeys : portableTmuxEnvironmentKeys;
}

const wholeSourceIds: ReadonlySet<string> = new Set(['app', 'env', 'installation']);

// match installation edits that can replace the wrapper selector
const isWrapperSelectorPatch = (patch: SettingsPatch): boolean => {
  // retain the exact selector and any nested authored value
  if (patch.path[0] === 'sources' && patch.path[1] === 'wrapper') return true;
  const replacesAncestor = patch.op === 'set' || patch.op === 'remove';
  return replacesAncestor && (patch.path.length === 0 || patch.path.length === 1 && patch.path[0] === 'sources');
};

// classify changes represented by the virtual tmux settings tab
export function isTmuxSettingsChange(change: SettingsChange): boolean {
  // every wrapper edit belongs to its only structured destination
  if (change.sourceId === 'wrapper') return true;
  // count whole typed sources because their hidden fields cannot be inspected
  if (wholeSourceIds.has(change.sourceId) && (change.content !== undefined || change.remove === true)) return true;
  const patches = change.patches ?? [];
  // match only the application subtree represented on this page
  if (change.sourceId === 'app') return patches.some(patch => patch.path[0] === 'tmux');
  // keep broader host settings with the environment page
  if (change.sourceId === 'env') return patches.some(patch => tmuxEnvironmentKeys.has(patch.path[0] ?? ''));
  // include ancestor replacements that can move the wrapper file
  if (change.sourceId === 'installation') return patches.some(isWrapperSelectorPatch);
  return false;
}
