import type { CalendarLabels } from './contracts.js';
import type { AgentKind } from '../adapters/types.js';

const labels: Record<AgentKind, string> = { codex: 'Codex', omx: 'OMX', claude: 'Claude', pi: 'Pi', opencode: 'OpenCode' };
const allowed = new Set(Object.values(labels));

// derive display identity only from the closed adapter vocabulary
export function calendarAgentLabel(kind: string): string {
  return Object.entries(labels).find(([candidate]) => candidate === kind)?.[1] ?? 'Agent';
}

// recognize product labels without promoting generated pane or conversation content
export function isCalendarAgentLabel(value: unknown): value is string {
  return typeof value === 'string' && allowed.has(value);
}

// normalize metadata identically before lifecycle, provider and title snapshots
export function normalizeCalendarLabels(labels: CalendarLabels, kind?: string): CalendarLabels {
  const agent = kind === undefined ? isCalendarAgentLabel(labels.agent) ? labels.agent : 'Agent' : calendarAgentLabel(kind);
  return { worktree: boundedLabel(labels.worktree, 'Worktree'), ...(labels.project === undefined ? {} : { project: boundedLabel(labels.project, 'Project') }), agent };
}

// preserve at most eighty visible unicode scalars without control bytes
function boundedLabel(value: string | undefined, fallback: string): string {
  return [...(value ?? '').replace(/[\p{Cc}\p{Cs}]/gu, ' ').trim()].slice(0, 80).join('') || fallback;
}
