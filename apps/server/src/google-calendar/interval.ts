import type { CalendarActivity } from './provider-types.js';

const estimatedDurationMs = 15 * 60 * 1_000;
// keep the estimate marker in the same immutable snapshot as its boundaries
type CalendarInterval = { startAt: string; endAt: string; estimatedInterval?: true };

// derive exact or fixed-duration timing from persisted work evidence
export function calendarInterval(activity: CalendarActivity): CalendarInterval | undefined {
  const startedMs = Date.parse(activity.startedAt ?? '');
  // never turn an unsent or canceled prompt into recorded work
  if (!Number.isFinite(startedMs) || startedMs <= 0) return undefined;
  const start = activity.policy.startMoment === 'prompt_submitted' ? activity.submittedAt : activity.policy.startMoment === 'prompt_sent' ? activity.sentAt : activity.startedAt;
  const end = activity.policy.endMoment === 'first_question_or_finished' ? activity.questionAt ?? activity.finishedAt : activity.finishedAt;
  const startMs = Date.parse(start ?? '');
  const endMs = Date.parse(end ?? '');
  const selectedStartValid = Number.isFinite(startMs) && startMs > 0;
  // preserve every positive interval supported by the selected lifecycle boundaries
  if (selectedStartValid && Number.isFinite(endMs) && endMs > startMs) {
    return { startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString() };
  }
  const estimatedStartMs = selectedStartValid ? startMs : startedMs;
  const estimatedEnd = new Date(estimatedStartMs + estimatedDurationMs);
  // reject an estimate beyond the supported timestamp range
  if (!Number.isFinite(estimatedEnd.getTime())) return undefined;
  return { startAt: new Date(estimatedStartMs).toISOString(), endAt: estimatedEnd.toISOString(), estimatedInterval: true };
}
