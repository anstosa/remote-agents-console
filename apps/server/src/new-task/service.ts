import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { ValidatedConfig } from '../config/schema.js';
import type { DiscoveryService } from '../discovery/service.js';
import { paneTmuxSession, type Worktree } from '../domain/models.js';
import { cleanAndPushedOrDetached, type GitCommand } from '../git/worktree-state.js';
import { worktreeHostRoot, worktreeMatchesWorkspace } from '../workspaces/resolver.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { run, tmuxFormatLiteral } from '../tmux/command.js';
import { hostCommand, hostInteractiveShellPath, interactiveShellBootstrap, interactiveShellPath } from '../tmux/interactive-shell.js';
import { startNamedReplacementSession, worktreeSessionName } from '../tmux/session-name.js';

export type NewTaskAvailability = { enabled: boolean; reason?: string };

const unavailableReason = 'The working copy must be clean, and any checked-out branch must be pushed before starting a new task.';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const taskId = () => randomBytes(6).toString('base64url');

export class NewTaskService {
  private readonly tmuxBinary = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  constructor(private readonly config: ValidatedConfig, private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly command: GitCommand = run) {}

  async available(agentId: string): Promise<NewTaskAvailability | undefined> {
    const target = await this.discovery.target(agentId);
    const worktree = target === undefined ? undefined : this.worktree(target.agent.home);
    if (worktree?.newTask === undefined) return undefined;
    const enabled = await this.cleanAndPushed(worktree);
    return enabled ? { enabled } : { enabled, reason: unavailableReason };
  }

  async start(agentId: string): Promise<boolean> {
    const target = await this.discovery.target(agentId);
    const worktree = target === undefined ? undefined : this.worktree(target.agent.home);
    if (target === undefined || worktree?.newTask === undefined || !await this.cleanAndPushed(worktree)) return false;
    const path = worktreeHostRoot(worktree);
    const home = dirname(path);
    const task = worktree.newTask.replaceAll('{taskId}', taskId());
    const script = hostCommand(`cd -- ${quote(path)} && eval ${quote(task)}`, home);
    const session = worktreeSessionName(path);
    const currentSession = paneTmuxSession(target.agent.pane);
    const shell = process.env.RAC_HOST_TMUX_DIR === undefined ? interactiveShellPath() : hostInteractiveShellPath();
    const pane = await startNamedReplacementSession(this.tmuxBinary, target.socket.path, currentSession, session, ['-c', tmuxFormatLiteral(path), shell, '-lc', interactiveShellBootstrap(script, home, shell, true)], this.command);
    if (pane === undefined) return false;
    // the new session replaces the Agent's as the Worktree's Workspace
    await this.tmux.markSessionPlace(target.socket, pane, worktree.id);
    return await this.tmux.closeSession(target.socket, currentSession);
  }

  private worktree(workspace: string): Worktree | undefined {
    return this.discovery.worktreesNow().find(worktree => worktreeMatchesWorkspace(worktree, workspace));
  }

  private async cleanAndPushed(worktree: Worktree): Promise<boolean> {
    return await cleanAndPushedOrDetached(worktree.identity, this.command);
  }
}
