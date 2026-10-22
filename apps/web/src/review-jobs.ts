import { useEffect, useState } from 'react';

// What every Review job poll shares, whatever the job runs (a tour, a Code review or an Ask): the job
// descriptor, what a pending reply says about its run, error codes, and the elapsed time a running job
// shows. Every guard tolerates extra fields.

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

// A running job's descriptor (a tour, a Code review or an Ask), polled until it settles. A newer
// server says when it started.
export type ReviewJob = { id: string; expiresAt: string; retryAfterMs: number; startedAt?: string };
// The Agent an interactive Review run is working in, and whether it is waiting on the operator; a
// pending poll reply carries it once the run's pane is up.
export type ReviewRunLink = { agentId: string; needsInput: boolean };
// what a pending poll reply says about a running job, beyond that it is still running
export type ReviewJobProgress = { run?: ReviewRunLink; startedAt?: string };
// validate a bounded job descriptor
export function isReviewJob(value: unknown): value is ReviewJob {
  return isRecord(value) && typeof value.id === 'string' && typeof value.expiresAt === 'string' && typeof value.retryAfterMs === 'number';
}

// Read a pending reply's `run`, or undefined when absent (a headless run, an older server) or malformed.
export function reviewRunFrom(value: unknown): ReviewRunLink | undefined {
  return isRecord(value) && typeof value.agentId === 'string' && value.agentId !== '' ? { agentId: value.agentId, needsInput: value.needsInput === true } : undefined;
}

// Read what a pending poll reply says: its `run`, and its job's `startedAt` when that is a valid time.
export function reviewJobProgress(body: Record<string, unknown>): ReviewJobProgress {
  const run = reviewRunFrom(body.run);
  const startedAt = isRecord(body.job) && typeof body.job.startedAt === 'string' && Number.isFinite(Date.parse(body.job.startedAt)) ? body.job.startedAt : undefined;
  return { ...(run === undefined ? {} : { run }), ...(startedAt === undefined ? {} : { startedAt }) };
}

// the typed error code of a failed reply, if any
export function failureCode(body: Record<string, unknown>): string | undefined {
  return isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : undefined;
}

// a gateway or proxy failure without a typed code, worth polling through
export const transientFailure = (response: Response, code: string | undefined) => code === undefined && (response.status === 502 || response.status === 503 || response.status === 504 || response.status >= 520 && response.status <= 530);

// When each job was first seen running on this page, so a reopened dialog keeps counting.
const jobsSeenAt = new Map<string, number>();

// "2m 10s" or "45s"
export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

// The time a job has been running, ticking each second while it runs: from the server's start time
// (`startedAt`, else the job's own) when known, else from when this page first saw it.
export function useJobElapsed(job: ReviewJob | undefined, startedAt?: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // tick only while a job runs
    if (job === undefined) return;
    if (!jobsSeenAt.has(job.id)) jobsSeenAt.set(job.id, Date.now());
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [job]);
  if (job === undefined) return '';
  const serverStart = Date.parse(startedAt ?? job.startedAt ?? '');
  return formatElapsed(now - (Number.isFinite(serverStart) ? serverStart : jobsSeenAt.get(job.id) ?? now));
}
