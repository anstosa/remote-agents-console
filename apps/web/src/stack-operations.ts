export type StackAction = 'start'|'stop'|'build'|'restart'|'migrate';
// the discovered Worktree a Process notice names, with the process it names there and that
// process's state when the Worktree declares it
export type ProcessNoticeTarget = { worktreeId: string; label: string; process?: string; state?: 'exited'|'stopped' };
// a notice target whose declared process is not running, which a notice's Start starts; the
// console hides a notice while the process it names runs, which is what ends that Start's progress
export type StartableNoticeTarget = ProcessNoticeTarget & { process: string };
// a message a Stack process reported about its own run, and the Worktree it names
export type ProcessNotice = { level: 'warning'|'info'; message: string; target?: ProcessNoticeTarget };
// A process in another Worktree that a Stack process reported it uses: with `worktreeId` and
// `state` when the console found that Worktree declaring it, labelled "<Project> / <Worktree>";
// otherwise `label` is the checkout path it named, and there is nothing to act on
export type ProcessUse = { worktreeId?: string; label: string; process: string; state?: 'running'|'exited'|'stopped'; exitCode?: number };
// a Worktree's Stack process as its pane shows it; `exitCode` is absent after a signal,
// `operation` is an action on this process alone in flight, `notices` its Process notices that
// are showing, `dependsOn` the processes here it needs and `uses` those in other Worktrees it last
// reported using
export type StackProcessState = { name: string; state: 'running'|'exited'|'stopped'; exitCode?: number; operation?: StackAction; notices?: ProcessNotice[]; dependsOn?: string[]; uses?: ProcessUse[] };
// what "Show <name> output" reads: the process's state and its pane's recent output, and while
// it runs the pane's id, which "Open as Terminal" opens
export type StackProcessOutput = StackProcessState & { paneId?: string; output: string };
export type ProjectStackStatus = 'working'|'exited'|'partial'|'healthy'|'down'|'running'|'stopped'|'unknown';
// the actions a Stack process derives; any other action is a one-shot command (mirrors the
// server's list in worktree-commands/service.ts)
export const processActions = ['start', 'stop', 'restart'] as const satisfies readonly StackAction[];
export type StackOperationLog = { action: StackAction; active: boolean; startedAt: string; completedAt?: string; output: string };

const actionLabels: Record<StackAction, string> = {
  start: 'Start stack',
  stop: 'Stop stack',
  build: 'Build stack',
  restart: 'Restart stack',
  migrate: 'Migrate stack'
};

const operationLabels: Record<StackAction, string> = {
  start: 'Starting',
  stop: 'Stopping',
  build: 'Building',
  restart: 'Restarting',
  migrate: 'Migrating'
};

// a Stack process's own actions, named for the one process they act on
const processActionLabels: Record<'start'|'stop'|'restart', string> = { start: 'Start', stop: 'Stop', restart: 'Restart' };

export const stackActionLabel = (action: StackAction) => actionLabels[action];
export const processActionLabel = (action: 'start'|'stop'|'restart') => processActionLabels[action];
export const stackOperationLabel = (action: StackAction) => operationLabels[action];

// validate stack log responses
export const isStackOperationLog = (value: unknown): value is StackOperationLog => {
  // require the response object
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<StackOperationLog>;
  return typeof candidate.action === 'string'
    && candidate.action in actionLabels
    && typeof candidate.active === 'boolean'
    && typeof candidate.startedAt === 'string'
    && (candidate.completedAt === undefined || typeof candidate.completedAt === 'string')
    && typeof candidate.output === 'string';
};

// validate Stack process output responses
export const isStackProcessOutput = (value: unknown): value is StackProcessOutput => {
  // require the response object
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<StackProcessOutput>;
  return typeof candidate.name === 'string'
    && (candidate.state === 'running' || candidate.state === 'exited' || candidate.state === 'stopped')
    && (candidate.exitCode === undefined || typeof candidate.exitCode === 'number')
    && (candidate.paneId === undefined || (typeof candidate.paneId === 'string' && /^%\d+$/u.test(candidate.paneId)))
    && typeof candidate.output === 'string';
};

// A process's state in a word, as the stack menu and the Stack panel show it, with the exit code
// once it has died ("exited 0"); a used process the console could not place has none
export const processStateText = (process: { state?: 'running'|'exited'|'stopped'; exitCode?: number }) => process.state === undefined ? 'unknown' : process.state === 'exited' && process.exitCode !== undefined ? `exited ${process.exitCode}` : process.state;

// Whether a process here is running or on its way: what makes a process it uses matter
export const processLive = (process: StackProcessState) => process.state === 'running' || process.operation === 'start' || process.operation === 'restart';

// the processes here whose `dependsOn` names `name`, in declared order
export const dependantsOf = (processes: readonly StackProcessState[], name: string) => processes.filter(process => process.dependsOn?.includes(name) === true).map(process => process.name);

// One process used in another Worktree, across every process here that reported it: the first
// report of it, and the processes here using it, in declared order. `key` tells it from the rest.
export type UsedProcess = { key: string; use: ProcessUse; usedBy: string[] };
export const usedKey = (use: ProcessUse) => `${use.worktreeId ?? use.label}\u0000${use.process}`;
export const usedProcesses = (processes: readonly StackProcessState[]): UsedProcess[] => {
  const used = new Map<string, UsedProcess>();
  for (const process of processes) for (const use of process.uses ?? []) {
    const key = usedKey(use);
    const entry = used.get(key) ?? { key, use, usedBy: [] };
    if (!entry.usedBy.includes(process.name)) entry.usedBy.push(process.name);
    used.set(key, entry);
  }
  return [...used.values()];
};

// The down rule: a used process counts as down only when it is known not to run and a process
// here that uses it is running or starting. One whose state the console does not know is not.
export const usedProcessDown = (used: UsedProcess, processes: readonly StackProcessState[]) =>
  used.use.state !== undefined && used.use.state !== 'running' && processes.some(process => used.usedBy.includes(process.name) && processLive(process));

// whether a process's row warns: something it uses is down by its own use, or it reported a
// warning notice
export const processWarns = (process: StackProcessState) =>
  usedProcesses([process]).some(used => usedProcessDown(used, [process]))
  || (process.notices ?? []).some(notice => notice.level === 'warning');

// a stack of processes in a few words: running, stopped, or how many of them run
export const processesSummary = (processes: readonly StackProcessState[]) => {
  const live = processes.filter(process => process.state === 'running').length;
  return live === 0 ? 'stopped' : live === processes.length ? 'running' : `${live} of ${processes.length} running`;
};

// share stack badge precedence between the toolbar and passive workspace cards
export function resolveStackStatus(stack: { processes?: readonly StackProcessState[]; tunnel?: boolean; running?: boolean } | undefined, inProgress: boolean): ProjectStackStatus {
  // prioritize active operations
  if (inProgress) return 'working';
  // prefer observed process health to a potentially stale tunnel check
  if (stack?.processes !== undefined) {
    // unexpected exits outrank a partial stack
    if (stack.processes.some(process => process.state === 'exited')) return 'exited';
    const live = stack.processes.filter(process => process.state === 'running').length;
    // separate stopped stacks from stacks with at least one running process
    if (live === 0) return 'stopped';
    // report mixed process health before consulting the tunnel
    if (live < stack.processes.length) return 'partial';
  }
  // use known tunnel health before the generic running flag
  if (stack?.tunnel !== undefined) return stack.tunnel ? 'healthy' : 'down';
  return stack?.running === undefined ? 'unknown' : stack.running ? 'running' : 'stopped';
}

// What the Stack panel shows on its right: one of this Worktree's processes, or a process used in
// another Worktree, by its `usedKey`
export type StackSelection = { kind: 'process'; name: string } | { kind: 'use'; key: string };
