// The console's tmux vocabulary for stack work. Every session it creates to run stack commands
// is named under the `rac-stack-` prefix, which keeps its panes out of launch reuse and
// Console-shell adoption.
export const stackSessionPrefix = 'rac-stack-';
// the long-lived session whose windows run status probes
export const probeHolderSession = `${stackSessionPrefix}probes`;
// A Stack process runs as a window of its Worktree's Workspace session. The window options tag
// it with its Worktree (by path) and process name, so the console finds it again without
// remembering it, and the pane role keeps launch adoption and idle-shell cleanup off it.
export const processWorktreeOption = '@rac_worktree';
export const processNameOption = '@rac_process';
export const processPaneRole = 'process';
// A structured Agent's process runs under a holder in its own window of its Place's Workspace
// session (ADR 0016); the pane role keeps it from ever being a Terminal or a recognised Agent.
export const holderPaneRole = 'holder';
