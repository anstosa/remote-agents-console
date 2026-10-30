import { Fragment, useEffect, useRef, useState } from 'react';
import { agentKindGlyph, agentKindLabel, type AgentKind, type AllowedModel } from './launch-profile.js';

// The wire shape of a Schedule (mirrors the server's `Schedule`). `updatedAt` and
// `lastRun` are server-owned; the editor emits only the four fields the set route reads.
export type ScheduleTarget = { worktreeId: string } | { projectId: string } | { scratch: true } | { conductor: true };
export type ScheduleRunStatus = 'launched' | 'running' | 'completed' | 'needs-input' | 'timed-out' | 'skipped' | 'failed' | 'delivered';
export type ScheduleLastRun = { at: string; status: ScheduleRunStatus; detail?: string; agentId?: string };
export type Schedule = { cron: string; kind: AgentKind; model?: string; effort?: string; target: ScheduleTarget; enabled: boolean; updatedAt?: string; lastRun?: ScheduleLastRun };
export type ScheduleSetBody = { cron: string; kind: AgentKind; model?: string; effort?: string; target: ScheduleTarget; enabled: boolean };

// The Adapter picker's rows, one per configured kind, precomputed by the note pane so the editor
// stays free of dashboard logic: `detail` is the launcher's sandbox line when launchable, else the
// disabled reason. Choosing one writes the kind and marks the choice explicit.
export type ScheduleAdapterOption = { kind: AgentKind; launchable: boolean; detail: string; unavailableReason?: string; models?: AllowedModel[]; efforts?: string[] };
// One target row, mirroring a launcher row: its wire target, the picker label/sublabel/grouping,
// its availability, and the launch kind it resolves to — the Adapter follows this kind on a
// target change until the operator picks a kind explicitly. The "Runs on" sentence is derived
// from group/sublabel/label rather than stored, so the slot text and the row text can't drift.
export type ScheduleTargetOption = { target: ScheduleTarget; label: string; sublabel?: string; group?: string; main?: boolean; available: boolean; unavailableReason?: string; kind: AgentKind; origin?: string };

// two targets name the same destination when their single discriminant matches
const sameScheduleTarget = (a: ScheduleTarget | undefined, b: ScheduleTarget | undefined): boolean => {
  if (a === undefined || b === undefined) return false;
  if ('scratch' in a) return 'scratch' in b;
  if ('conductor' in a) return 'conductor' in b;
  if ('worktreeId' in a) return 'worktreeId' in b && a.worktreeId === b.worktreeId;
  return 'projectId' in a && 'projectId' in b && a.projectId === b.projectId;
};
const targetRowKey = (target: ScheduleTarget): string => 'scratch' in target ? 'scratch' : 'conductor' in target ? 'conductor' : 'worktreeId' in target ? `wt:${target.worktreeId}` : `proj:${target.projectId}`;
// the picker's leading glyph: Scratch, a directory Project, the main worktree, or another worktree
const targetGlyph = (option: ScheduleTargetOption): string => 'scratch' in option.target ? '~' : 'conductor' in option.target ? '◆' : 'projectId' in option.target ? '▤' : option.main === true ? '⌂' : '⎇';
// the "Runs on" statement a target reads as, e.g. "atlas · main worktree" / "Scratch"
const targetRunsOn = (option: ScheduleTargetOption): string => option.group === undefined ? option.label : `${option.group} · ${option.sublabel ?? option.label}`;
// what the target slot reads when a stored target has vanished, honest about its shape
const goneTargetLabel = (target: ScheduleTarget): string => 'conductor' in target ? 'the Conductor (not running)' : 'projectId' in target ? 'an unavailable project' : 'a removed worktree';

export const defaultScheduleCron = '0 9 * * *';

// ---- pure preset / cron / copy helpers (no dashboard dependency) ----
// The presets the cadence popover offers; a stored expression that no preset reproduces
// falls back to `cron`, the raw-field display. `hour`/`minute` drive the time slot for the
// three time-of-day presets, `days` the weekly chips (Sunday = 0), `everyN` the interval.
export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'everyN' | 'cron';
export type ScheduleEdit = { preset: SchedulePreset; hour: number; minute: number; days: number[]; everyN: number; cron: string };

const pad = (value: number) => String(value).padStart(2, '0');
// short weekday / month names for the "Mon 7 Sep" instant format
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 12-hour clock, so the sentence reads like a sentence
export const clock = (hour: number, minute: number) => `${((hour + 11) % 12) + 1}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
const hhmm = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
export const formatInstant = (iso: string) => { const date = new Date(iso); return `${WD[date.getDay()]} ${date.getDate()} ${MON[date.getMonth()]} ${clock(date.getHours(), date.getMinutes())}`; };
export const relativeAge = (iso: string, now: number) => {
  const seconds = (now - new Date(iso).getTime()) / 1000;
  if (seconds < 90) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

// ascending, de-duplicated weekday list, so a preset's cron is canonical
const sortedDays = (days: number[]) => Array.from(new Set(days)).filter(day => day >= 0 && day <= 6).sort((a, b) => a - b);
const dayNames = (days: number[]) => sortedDays(days).map(day => WD[day]).join(', ');
// the hours an "every N hours" schedule fires: N restarts at midnight, so the sequence is 0, N, 2N, … below 24
const everyNHours = (n: number) => { const hours: number[] = []; for (let hour = 0; hour < 24; hour += n) hours.push(hour); return hours; };
// those hours as comma-joined 12-hour clock times, shared by the slot label and the popover description
const everyNHoursText = (n: number) => everyNHours(n).map(hour => clock(hour, 0)).join(', ');
// N evenly tiles the day only when it divides 24; otherwise the last gap before midnight is short
const everyNDivides = (n: number) => 24 % n === 0;
const isNumericField = (value: string) => /^\d+$/u.test(value);

// A stored expression maps back to the preset that reproduces it exactly, else to the raw
// `cron` display — so re-opening the popover restores the controls that emitted the schedule.
export const cronToEdit = (cron: string): ScheduleEdit => {
  const normal = cron.trim().replace(/\s+/gu, ' ');
  const base: ScheduleEdit = { preset: 'cron', hour: 9, minute: 0, days: [1], everyN: 6, cron: normal };
  const fields = normal.split(' ');
  if (fields.length !== 5) return base;
  const [minute, hour, dom, month, dow] = fields;
  // every N hours: `0 */N * * *`
  const every = /^\*\/(\d+)$/u.exec(hour);
  if (minute === '0' && every !== null && dom === '*' && month === '*' && dow === '*') {
    const n = Number(every[1]);
    const candidate: ScheduleEdit = { ...base, preset: 'everyN', everyN: n };
    if (n >= 1 && n <= 23 && editToCron(candidate) === normal) return candidate;
  }
  if (dom !== '*' || month !== '*' || !isNumericField(minute) || !isNumericField(hour)) return base;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return base;
  if (dow === '*') return { ...base, preset: 'daily', hour: h, minute: m };
  if (dow === '1-5') return { ...base, preset: 'weekdays', hour: h, minute: m };
  // weekly: a comma list of single-digit days that our own emit would reproduce
  if (/^[0-6](,[0-6])*$/u.test(dow)) {
    const candidate: ScheduleEdit = { ...base, preset: 'weekly', hour: h, minute: m, days: dow.split(',').map(Number) };
    if (editToCron(candidate) === normal) return candidate;
  }
  return base;
};
export const editToCron = (edit: ScheduleEdit): string => {
  switch (edit.preset) {
    case 'daily': return `${edit.minute} ${edit.hour} * * *`;
    case 'weekdays': return `${edit.minute} ${edit.hour} * * 1-5`;
    case 'weekly': return `${edit.minute} ${edit.hour} * * ${sortedDays(edit.days).join(',')}`;
    case 'everyN': return `0 */${edit.everyN} * * *`;
    case 'cron': return edit.cron;
  }
};
// the three time-of-day presets carry a trailing "at <time>" slot; everyN and cron do not
export const presetHasTime = (preset: SchedulePreset) => preset === 'daily' || preset === 'weekdays' || preset === 'weekly';
// the tappable cadence-slot label — the sentence's reading of the cadence
export const cadenceLabel = (edit: ScheduleEdit): string => {
  switch (edit.preset) {
    case 'daily': return 'every day';
    case 'weekdays': return 'every weekday';
    case 'weekly': return `every ${dayNames(edit.days)}`;
    // a divisor tiles the day evenly; otherwise spell out the hours so the midnight restart is not a surprise
    case 'everyN': return everyNDivides(edit.everyN) ? `every ${edit.everyN} h` : `at ${everyNHoursText(edit.everyN)} (restarts at midnight)`;
    case 'cron': return `on cron ${edit.cron}`;
  }
};
// the popover description line
export const describeCadence = (edit: ScheduleEdit): string => {
  switch (edit.preset) {
    case 'daily': return `Every day at ${clock(edit.hour, edit.minute)}`;
    case 'weekdays': return `Every weekday at ${clock(edit.hour, edit.minute)}`;
    case 'weekly': return `Every ${dayNames(edit.days)} at ${clock(edit.hour, edit.minute)}`;
    case 'everyN': return everyNDivides(edit.everyN) ? `Every ${edit.everyN} hours, on the hour` : `Fires ${everyNHoursText(edit.everyN)}; the count restarts at midnight`;
    case 'cron': return `Cron ${edit.cron}`;
  }
};

// The one place the "a scheduled note the server gave no nextRun to won't run" rule lives, shared
// by the editor and the fly-out badge. The server omits nextRun when the stored cron no longer
// parses or never matches a date (a valid, matchable 5-field expression always has a next instant).
export const scheduleInvalid = (note: { schedule?: unknown; nextRun?: string }) => note.schedule !== undefined && note.nextRun === undefined;

// A last Run that failed or was skipped needs attention — the single definition the note-pane
// footnote and the fly-out badge both read, so the two never drift apart.
// a skip, failure, timeout or a run that ended asking a question wants attention; launched, running
// (a managed run in flight) and completed do not
const scheduleAttentionStatuses = new Set<ScheduleRunStatus>(['skipped', 'failed', 'needs-input', 'timed-out']);
export const lastRunNeedsAttention = (lastRun?: ScheduleLastRun): boolean => lastRun !== undefined && scheduleAttentionStatuses.has(lastRun.status);

type ScheduleEditorProps = {
  schedule?: Schedule;
  nextRun?: string;
  prefill: { kind: AgentKind; target: ScheduleTarget };
  runsOnText: string;
  // the launcher's kind rows and the target rows, precomputed from the dashboard by the note pane
  adapterOptions: ScheduleAdapterOption[];
  targetOptions: ScheduleTargetOption[];
  onSet: (body: ScheduleSetBody) => void | Promise<void>;
  onRemove: () => void | Promise<void>;
  // Run the Schedule now, exactly as the scheduler will; absent when the pane cannot run it
  onRunNow?: () => void | Promise<void>;
  // a Run now is in flight (the server runs it synchronously), so the controls show progress
  running?: boolean;
  // the last Run's agent id, only while it is still on the dashboard, so "Open agent" links to it
  openAgentId?: string;
  // the server owns the clock and the parser, so the preview returns both the next instants and,
  // for an unparseable expression, the parser's message the raw-cron field shows inline
  preview: (cron: string) => Promise<{ next: string[]; error?: string }>;
  busy?: boolean;
  now?: () => number;
};

const KindMark = ({ kind }: { kind: AgentKind }) => <span className={`schedule-kind-mark launch-kind-${kind}`} aria-hidden="true">{agentKindGlyph[kind]}</span>;

// The note-pane Schedule editor: variant C, the sentence with tappable slots, on two
// lines. Every change applies immediately by emitting the full set body. The Adapter and
// target slots open pickers built from the launcher rows; the Adapter follows the target's
// resolved kind until the operator pins one, and a target that has vanished reads red.
export function ScheduleEditor({ schedule, nextRun, prefill, runsOnText, adapterOptions, targetOptions, onSet, onRemove, onRunNow, running = false, openAgentId, preview, busy = false, now = Date.now }: ScheduleEditorProps) {
  const [openSlot, setOpenSlot] = useState<'cadence' | 'time' | 'kind' | 'target' | null>(null);
  const [previewRuns, setPreviewRuns] = useState<string[]>([]);
  const [cronDraft, setCronDraft] = useState(() => schedule?.cron ?? defaultScheduleCron);
  const [cronFieldError, setCronFieldError] = useState<string | undefined>(undefined);
  // The preset is normally derived from the stored cron, but choosing "Cron" is a mode the
  // string cannot express (an expression that also matches a preset would re-derive to it), so
  // raw editing is held here and reset whenever the cadence popover closes — a reopen re-derives.
  const [rawCron, setRawCron] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cron = schedule?.cron ?? defaultScheduleCron;
  const derived = cronToEdit(cron);
  const edit: ScheduleEdit = rawCron ? { ...derived, preset: 'cron' } : derived;
  const kind = schedule?.kind ?? prefill.kind;
  // the chosen kind's Allowed models, offered for this Schedule alone
  const kindOption = adapterOptions.find(option => option.kind === kind);
  const kindModels = kindOption?.models;
  const invalid = scheduleInvalid({ schedule, nextRun });
  // the target row the stored Schedule points at; absent → its target has disappeared (a removed
  // Worktree, an unavailable Project), so the Schedule is kept but shown as unable to run
  const currentTarget = schedule?.target ?? prefill.target;
  const currentTargetOption = targetOptions.find(option => sameScheduleTarget(option.target, currentTarget));
  const gone = schedule !== undefined && currentTargetOption === undefined;
  const targetText = currentTargetOption === undefined ? runsOnText : targetRunsOn(currentTargetOption);
  // the current target's resolved launch kind and why, for the follow rule and the resolved-row mark
  const resolvedKind = currentTargetOption?.kind;
  const resolvedOrigin = currentTargetOption?.origin;
  // Whether the operator has pinned the kind. A stored kind that differs from its target's resolved
  // kind was chosen deliberately; otherwise the Adapter is still following the target. Once true, a
  // target change no longer rewrites the kind.
  const [kindExplicit, setKindExplicit] = useState(() => {
    if (schedule === undefined) return false;
    const option = targetOptions.find(candidate => sameScheduleTarget(candidate.target, schedule.target));
    return option !== undefined && schedule.kind !== option.kind;
  });

  // close the open popover on an outside click or Escape
  useEffect(() => {
    if (openSlot === null) return;
    const dismiss = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpenSlot(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenSlot(null); };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', dismiss); document.removeEventListener('keydown', key); };
  }, [openSlot]);

  // fetch the next-three preview from the server while a popover is open
  useEffect(() => {
    if (openSlot === null) { setPreviewRuns([]); return; }
    let live = true;
    void preview(cron).then(result => { if (live) setPreviewRuns(result.next); }, () => { if (live) setPreviewRuns([]); });
    return () => { live = false; };
  }, [openSlot, cron, preview]);

  // Keep the raw-cron field honest across opens, closes and commits. A rejected edit changes
  // neither `openSlot` nor `cron`, so its inline error survives (the value is kept); but any
  // open/close or a committed expression clears the error, an open (re)syncs the draft to the
  // stored expression, and a close drops raw-editing mode so a reopen re-derives the preset.
  useEffect(() => {
    setCronFieldError(undefined);
    if (openSlot === 'cadence') setCronDraft(cron);
    else setRawCron(false);
  }, [openSlot, cron]);

  // a Schedule keeps its model and Effort until its kind changes, they are picked again, or its kind
  // no longer has Allowed models to choose from
  const apply = (next: ScheduleSetBody) => { void onSet(schedule === undefined || next.kind !== schedule.kind || (kindModels?.length ?? 0) === 0 ? next : { ...next, ...(schedule.model === undefined ? {} : { model: schedule.model }), ...(schedule.effort === undefined ? {} : { effort: schedule.effort }) }); };
  // run this Schedule on one of its kind's Allowed models (else the first) at an Effort (else the model's default)
  const pickModel = (model: string | undefined, effort: string | undefined) => {
    if (schedule === undefined) return;
    void onSet({ cron, kind: schedule.kind, target: schedule.target, enabled: schedule.enabled, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) });
  };
  const applyEdit = (nextEdit: ScheduleEdit) => { if (schedule === undefined) return; apply({ cron: editToCron(nextEdit), kind: schedule.kind, target: schedule.target, enabled: schedule.enabled }); };
  // pick an Adapter: the choice is explicit from now on, so it survives later target changes
  const pickKind = (nextKind: AgentKind) => {
    if (schedule === undefined) return;
    setKindExplicit(true);
    setOpenSlot(null);
    apply({ cron, kind: nextKind, target: schedule.target, enabled: schedule.enabled });
  };
  // pick a target: unless the operator has pinned the kind, the Adapter follows the new target's
  // resolved launch kind, so retargeting never leaves a stale kind behind
  const pickTarget = (option: ScheduleTargetOption) => {
    if (schedule === undefined) return;
    setOpenSlot(null);
    apply({ cron, kind: kindExplicit ? schedule.kind : option.kind, target: option.target, enabled: schedule.enabled });
  };
  // choose a cadence preset: Cron just enters raw-editing mode (the expression is unchanged until
  // the field is applied); every other preset leaves raw mode and emits its canonical expression.
  // Clear the raw field here too, since a preset whose cron equals the stored one won't change the
  // `cron` prop and so won't trip the reset effect, leaving a rejected draft to resurface later.
  const selectPreset = (preset: SchedulePreset) => {
    if (preset === 'cron') { setRawCron(true); return; }
    setRawCron(false);
    setCronDraft(cron);
    setCronFieldError(undefined);
    applyEdit({ ...edit, preset });
  };
  // toggle a weekly day chip, keeping at least one day selected so the emitted cron is always valid
  const toggleDay = (day: number) => {
    const current = sortedDays(edit.days);
    const next = current.includes(day) ? current.filter(other => other !== day) : [...current, day];
    if (next.length > 0) applyEdit({ ...edit, preset: 'weekly', days: next });
  };
  // validate the raw-cron draft against the server; on an error keep the previous expression and show it inline
  const applyCron = async () => {
    if (schedule === undefined) return;
    const value = cronDraft.trim();
    if (value === cron) { setCronFieldError(undefined); return; }
    if (value === '') { setCronFieldError('Enter a cron expression'); return; }
    const result = await preview(value);
    if (result.error !== undefined) { setCronFieldError(result.error); return; }
    // a parseable expression that never matches a date (e.g. `0 0 31 2 *`) previews empty; refuse it
    // rather than commit a schedule that would immediately read as invalid
    if (result.next.length === 0) { setCronFieldError('This expression never runs'); return; }
    setCronFieldError(undefined);
    apply({ cron: value, kind: schedule.kind, target: schedule.target, enabled: schedule.enabled });
  };

  if (schedule === undefined) {
    return (
      <div className="schedule-sentence schedule-unscheduled" role="group" aria-label="Schedule" ref={rootRef}>
        <p className="schedule-line">
          <span>Not scheduled.</span>
          <button type="button" className="schedule-create" disabled={busy} onClick={() => { setKindExplicit(false); apply({ cron: defaultScheduleCron, kind: prefill.kind, target: prefill.target, enabled: true }); }}>
            <ClockGlyph />Schedule this note
          </button>
        </p>
        <p className="schedule-hint">Starts as every day at 9:00 AM on <b>{runsOnText}</b>; tap any part of the sentence to change it.</p>
      </div>
    );
  }

  const enabled = schedule.enabled;
  const lastRun = schedule.lastRun;
  return (
    <div className={`schedule-sentence${invalid ? ' schedule-invalid' : ''}`} role="group" aria-label="Schedule" ref={rootRef}>
      <p className="schedule-line">
        <button type="button" className={`schedule-slot schedule-onoff${enabled ? '' : ' off'}`} role="switch" aria-checked={enabled} aria-label="Schedule enabled" disabled={busy} onClick={() => apply({ cron, kind: schedule.kind, target: schedule.target, enabled: !enabled })}>{enabled ? '● Runs' : '○ Paused'}</button>
        <button type="button" className="schedule-slot" aria-label="Cadence" data-context-flyout aria-expanded={openSlot === 'cadence'} disabled={busy} onClick={() => setOpenSlot(current => current === 'cadence' ? null : 'cadence')}>{cadenceLabel(edit)}</button>
        {presetHasTime(edit.preset) && <>
          <span>at</span>
          <button type="button" className="schedule-slot" aria-label="Time" data-context-flyout aria-expanded={openSlot === 'time'} disabled={busy} onClick={() => setOpenSlot(current => current === 'time' ? null : 'time')}>{clock(edit.hour, edit.minute)}</button>
        </>}
      </p>
      <p className="schedule-line">
        <span>with</span>
        <button type="button" className="schedule-slot schedule-slot-kind" aria-label="Agent" data-context-flyout aria-expanded={openSlot === 'kind'} disabled={busy} onClick={() => setOpenSlot(current => current === 'kind' ? null : 'kind')}><KindMark kind={kind} />{agentKindLabel[kind]}{schedule.model === undefined ? '' : ` · ${schedule.model}`}{schedule.effort === undefined ? '' : ` · ${schedule.effort}`}</button>
        <span>on</span>
        <button type="button" className={`schedule-slot${gone ? ' schedule-slot-bad' : ''}`} aria-label="Target" data-context-flyout aria-expanded={openSlot === 'target'} disabled={busy} onClick={() => setOpenSlot(current => current === 'target' ? null : 'target')}>{gone ? goneTargetLabel(currentTarget) : targetText}</button>
      </p>
      {invalid && <p className="schedule-invalid-note" role="alert">This schedule won’t run — its cron can’t be read or never matches a date. Edit it under Cadence or remove it.</p>}
      <div className="schedule-meta">
        {gone && <p className="schedule-skip-note" role="alert">Runs are skipped until you pick another target.</p>}
        <p className={`schedule-next${enabled ? '' : ' paused'}${gone && enabled && nextRun !== undefined ? ' skip' : ''}`}>{nextRun === undefined ? 'Won’t run — invalid cron' : !enabled ? <>Paused · would next run <b>{formatInstant(nextRun)}</b></> : gone ? <>Next <b>{formatInstant(nextRun)}</b> · will be skipped</> : <>Next <b>{formatInstant(nextRun)}</b></>}</p>
        <p className={`schedule-last${lastRunNeedsAttention(lastRun) ? ' bad' : ''}`}>{lastRun === undefined ? 'Not run yet' : <>Last run {relativeAge(lastRun.at, now())} · <b>{lastRun.status}</b>{lastRun.detail ? `, ${lastRun.detail}` : ''}{openAgentId !== undefined && <> · <a className="schedule-open-agent" href={`#agent=${encodeURIComponent(openAgentId)}`}>Open agent</a></>}</>}</p>
      </div>
      <div className="schedule-foot">
        {onRunNow !== undefined && <button type="button" className={`schedule-run-now${running ? ' progress-border progress-green' : ''}`} aria-busy={running || undefined} disabled={busy || running || gone || invalid} onClick={() => void onRunNow()}>{running && <span className="update-progress-ring" aria-hidden="true" />}▷ Run now</button>}
        <button type="button" className="schedule-remove" disabled={busy || running} onClick={() => void onRemove()}>Remove schedule</button>
      </div>
      {openSlot === 'cadence' && (
        <div className="schedule-popover" role="dialog" aria-label="Cadence">
          <p className="schedule-popover-title">Cadence</p>
          <div className="schedule-presets" role="group" aria-label="Cadence preset">
            <button type="button" aria-pressed={edit.preset === 'daily'} onClick={() => selectPreset('daily')}>Daily at</button>
            <button type="button" aria-pressed={edit.preset === 'weekdays'} onClick={() => selectPreset('weekdays')}>Weekdays at</button>
            <button type="button" aria-pressed={edit.preset === 'weekly'} onClick={() => selectPreset('weekly')}>Weekly on</button>
            <button type="button" aria-pressed={edit.preset === 'everyN'} onClick={() => selectPreset('everyN')}>Every N hours</button>
            <button type="button" aria-pressed={edit.preset === 'cron'} onClick={() => selectPreset('cron')}>Cron</button>
          </div>
          {edit.preset === 'weekly' && (
            <div className="schedule-days" role="group" aria-label="Days">
              {WD.map((name, day) => <button key={day} type="button" aria-pressed={sortedDays(edit.days).includes(day)} aria-label={WD_FULL[day]} onClick={() => toggleDay(day)}>{name.charAt(0)}</button>)}
            </div>
          )}
          {edit.preset === 'everyN' && (
            <div className="schedule-stepper" role="group" aria-label="Hours between runs">
              <button type="button" aria-label="Fewer hours" disabled={edit.everyN <= 1} onClick={() => applyEdit({ ...edit, preset: 'everyN', everyN: edit.everyN - 1 })}>−</button>
              <span className="schedule-stepper-value">{edit.everyN} h</span>
              <button type="button" aria-label="More hours" disabled={edit.everyN >= 23} onClick={() => applyEdit({ ...edit, preset: 'everyN', everyN: edit.everyN + 1 })}>+</button>
            </div>
          )}
          {edit.preset === 'cron' && (
            <form className="schedule-cron-field" onSubmit={event => { event.preventDefault(); void applyCron(); }}>
              <input aria-label="Cron expression" value={cronDraft} spellCheck={false} autoCapitalize="none" autoCorrect="off" maxLength={200} onChange={event => setCronDraft(event.target.value)} onBlur={() => void applyCron()} />
              {cronFieldError !== undefined && <p className="schedule-cron-error" role="alert">{cronFieldError}</p>}
            </form>
          )}
          <p className="schedule-describe">{describeCadence(edit)}</p>
          {previewRuns.length > 0 && <p className="schedule-preview">Next <b>{previewRuns.map(formatInstant).join(' · ')}</b></p>}
        </div>
      )}
      {openSlot === 'time' && (
        <div className="schedule-popover" role="dialog" aria-label="Time">
          <input type="time" aria-label="Set time" value={hhmm(edit.hour, edit.minute)} step={60} onChange={event => { const [hour, minute] = event.target.value.split(':').map(Number); if (Number.isFinite(hour) && Number.isFinite(minute)) applyEdit({ ...edit, hour, minute }); }} />
          <p className="schedule-describe">{describeCadence(edit)}</p>
          {previewRuns.length > 0 && <p className="schedule-preview">Next <b>{previewRuns.map(formatInstant).join(' · ')}</b></p>}
        </div>
      )}
      {openSlot === 'kind' && (
        <div className="schedule-popover schedule-picker" role="dialog" aria-label="Agent">
          <p className="schedule-popover-title">Agent · {targetText}</p>
          <div className="schedule-rows" role="radiogroup" aria-label="Agent">
            {adapterOptions.length === 0 && <p className="schedule-picker-empty">No agents configured.</p>}
            {adapterOptions.map(option => (
              <button key={option.kind} type="button" role="radio" aria-checked={option.kind === kind} className="launch-row" disabled={!option.launchable} title={option.unavailableReason} onClick={() => pickKind(option.kind)}>
                <KindMark kind={option.kind} />
                <span className="launch-row-copy"><strong>{agentKindLabel[option.kind]}{option.kind === resolvedKind && resolvedOrigin !== undefined && <em> · {resolvedOrigin}</em>}</strong><small>{option.launchable ? option.detail : option.unavailableReason ?? 'Unavailable'}</small></span>
              </button>
            ))}
          </div>
          {/* the Conductor runs on its own configured model, which a Schedule cannot change */}
          {kindModels !== undefined && kindModels.length > 0 && !('conductor' in schedule.target) && <>
            <p className="schedule-popover-title">Model · this Schedule only</p>
            <div className="schedule-rows" role="radiogroup" aria-label="Model">
              <button type="button" role="radio" aria-checked={schedule.model === undefined} className="launch-row" onClick={() => pickModel(undefined, schedule.effort)}><span className="launch-row-copy"><strong>Default</strong><small>The first Allowed model</small></span></button>
              {kindModels.map(entry => <button key={entry.model} type="button" role="radio" aria-checked={schedule.model === entry.model} className="launch-row" onClick={() => pickModel(entry.model, schedule.effort)}><span className="launch-row-copy"><strong>{entry.model}</strong><small>{entry.effort === undefined ? 'Default Effort' : `Effort ${entry.effort}`}</small></span></button>)}
            </div>
            <label className="schedule-effort">Effort <select value={schedule.effort ?? ''} onChange={event => pickModel(schedule.model, event.target.value === '' ? undefined : event.target.value)}><option value="">Model default</option>{kindOption?.efforts?.map(level => <option key={level} value={level}>{level}</option>)}</select></label>
          </>}
        </div>
      )}
      {openSlot === 'target' && (
        <div className="schedule-popover schedule-picker" role="dialog" aria-label="Target">
          <p className="schedule-popover-title">Target · where the Run launches</p>
          <div className="schedule-rows" role="radiogroup" aria-label="Target">
            {gone && <p className="schedule-target-removed" role="note"><span className="schedule-target-sym" aria-hidden="true">✕</span> This target no longer exists. Pick another below.</p>}
            {targetOptions.map((option, index) => {
              const heading = option.group !== undefined && option.group !== targetOptions[index - 1]?.group;
              return <Fragment key={targetRowKey(option.target)}>
                {heading && <p className="schedule-proj-head">{option.group}</p>}
                <button type="button" role="radio" aria-checked={sameScheduleTarget(option.target, currentTarget)} className="launch-row" disabled={!option.available} title={option.unavailableReason} onClick={() => pickTarget(option)}>
                  <span className="schedule-target-sym" aria-hidden="true">{targetGlyph(option)}</span>
                  <span className="launch-row-copy"><strong>{option.label}{option.sublabel !== undefined && <em> · {option.sublabel}</em>}</strong><small>{option.available ? <><KindMark kind={option.kind} /> {agentKindLabel[option.kind]}{option.origin !== undefined ? ` · ${option.origin}` : ''}</> : option.unavailableReason ?? 'Unavailable'}</small></span>
                </button>
              </Fragment>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const ClockGlyph = () => <svg className="schedule-clock" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
