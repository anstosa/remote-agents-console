import type { Agent, Project, Worktree } from '../domain/models.js';
import { configuredWorktreeForWorkspace, projectIdOf } from '../workspaces/resolver.js';
import type { CalendarLabels } from './contracts.js';
import { calendarAgentLabel } from './agent-labels.js';

// resolve raw discovery agents without exporting generated titles or host paths
export function calendarLabelsForAgent(agent: Pick<Agent, 'home' | 'kind' | 'placeId' | 'projectId' | 'worktreeId'> | undefined, worktrees: Worktree[], projects: readonly Project[]): CalendarLabels {
  // missing discovery never invents metadata from private filesystem information
  if (agent === undefined) return { worktree: 'Scratch', project: 'Scratch', agent: 'Agent' };
  const worktree = worktrees.find(candidate => candidate.id === (agent.placeId ?? agent.worktreeId)) ?? configuredWorktreeForWorkspace(worktrees, agent.home);
  const projectId = worktree?.projectId ?? agent.projectId ?? (agent.placeId === undefined ? undefined : projectIdOf(agent.placeId));
  const project = projects.find(candidate => candidate.id === projectId || candidate.mode === 'directory' && (candidate.identity === agent.home || candidate.hostPath === agent.home));
  return { worktree: worktree?.label ?? (project?.mode === 'directory' ? project.label : project === undefined ? 'Scratch' : 'Worktree'), project: project?.label ?? 'Scratch', agent: calendarAgentLabel(agent.kind) };
}
