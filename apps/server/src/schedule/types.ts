import { agentKinds, type AgentKind } from '../adapters/types.js';
import { agentEffort, agentModel } from '../launch/agent-choice.js';

/**
 * Where a Schedule's Run happens, mirroring the launcher rows exactly: a specific
 * Worktree by wire id, an available directory Project by id, or the console's
 * Scratch target. A repository Project is targeted only through its Worktrees.
 */
export type ScheduleTarget = { worktreeId: string } | { projectId: string } | { scratch: true };

export const scheduleRunStatuses = ['launched', 'running', 'completed', 'needs-input', 'timed-out', 'skipped', 'failed'] as const;
export type ScheduleRunStatus = typeof scheduleRunStatuses[number];

/**
 * The outcome of the most recent Run; `at` is the due instant (or the request time for Run now).
 * `agentId` is the pane the Run used or created — and the *sole* handle a Schedule keeps to its own
 * pane, so "one pane per Schedule" and every reuse decision key on it. A skip or failure that carries
 * an `agentId` keeps the pane reusable; one that drops it makes the next Run launch fresh.
 *
 * An *unattended* (scheduler-fired) Run is a managed lifecycle: it launches fresh, records `running`
 * with `startedAt` and `sawWorking: false`, and the scheduler's reconcile pass watches its pane —
 * flipping `sawWorking` once it observes `working`, then advancing to a terminal status (`completed`,
 * `needs-input`, `timed-out`, or `failed`) and closing the pane. `launched` remains the terminal
 * success of an *attended* Run now, whose pane is left open.
 */
export type ScheduleLastRun = { at: string; status: ScheduleRunStatus; detail?: string; agentId?: string; startedAt?: string; sawWorking?: boolean };

/**
 * A standing instruction on a Note: when to run it (a 5-field, host-local cron
 * expression), with which Adapter (and, for a kind on Allowed models, which model and
 * Effort), and in which target. At most one per Note.
 * `updatedAt` is stamped on create, edit, pause and resume — it is the no-catch-up
 * anchor the scheduler evaluates from.
 */
export type Schedule = {
  cron: string;
  kind: AgentKind;
  model?: string;
  effort?: string;
  target: ScheduleTarget;
  enabled: boolean;
  updatedAt: string;
  lastRun?: ScheduleLastRun;
};

const isKind = (value: unknown): value is AgentKind => typeof value === 'string' && (agentKinds as readonly string[]).includes(value);

// A target names exactly one destination of a known shape.
export const validScheduleTarget = (value: unknown): value is ScheduleTarget => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  if (Object.keys(target).length !== 1) return false;
  if ('scratch' in target) return target.scratch === true;
  if ('worktreeId' in target) return typeof target.worktreeId === 'string' && target.worktreeId.length > 0 && target.worktreeId.length <= 200;
  if ('projectId' in target) return typeof target.projectId === 'string' && target.projectId.length > 0 && target.projectId.length <= 200;
  return false;
};

const validLastRun = (value: unknown): value is ScheduleLastRun => {
  if (value === null || typeof value !== 'object') return false;
  const run = value as Record<string, unknown>;
  if (typeof run.at !== 'string' || Number.isNaN(Date.parse(run.at))) return false;
  if (typeof run.status !== 'string' || !(scheduleRunStatuses as readonly string[]).includes(run.status)) return false;
  if (run.detail !== undefined && (typeof run.detail !== 'string' || run.detail.length > 400)) return false;
  if (run.agentId !== undefined && (typeof run.agentId !== 'string' || run.agentId.length > 200)) return false;
  if (run.startedAt !== undefined && (typeof run.startedAt !== 'string' || Number.isNaN(Date.parse(run.startedAt)))) return false;
  if (run.sawWorking !== undefined && typeof run.sawWorking !== 'boolean') return false;
  return true;
};

/**
 * Structural validation of a persisted Schedule. Deliberately does not parse the
 * cron expression: a stored expression that no longer parses is kept and shown as
 * invalid rather than failing the whole notes file (the scheduler never fires it).
 */
export const validSchedule = (value: unknown): value is Schedule => {
  if (value === null || typeof value !== 'object') return false;
  const schedule = value as Record<string, unknown>;
  if (typeof schedule.cron !== 'string' || schedule.cron.length === 0 || schedule.cron.length > 200) return false;
  if (!isKind(schedule.kind)) return false;
  if (schedule.model !== undefined && !agentModel.safeParse(schedule.model).success) return false;
  if (schedule.effort !== undefined && !agentEffort.safeParse(schedule.effort).success) return false;
  if (!validScheduleTarget(schedule.target)) return false;
  if (typeof schedule.enabled !== 'boolean') return false;
  if (typeof schedule.updatedAt !== 'string' || Number.isNaN(Date.parse(schedule.updatedAt))) return false;
  if (schedule.lastRun !== undefined && !validLastRun(schedule.lastRun)) return false;
  return true;
};
