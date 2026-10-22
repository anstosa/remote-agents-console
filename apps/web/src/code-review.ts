import { useEffect, useRef, useState } from 'react';
import { failureCode, isRecord, reviewJobProgress, transientFailure, type ReviewJob, type ReviewJobProgress } from './review-jobs.js';

// The AI Code review that can run beside a Review tour: its Findings, the dashboard's Review presets,
// the device's last choice, and the polling of a running job. The shapes follow the server's Code review API; every guard
// tolerates extra fields, and a malformed payload reads as absent rather than throwing.

export type CodeReviewSeverity = 'high' | 'medium' | 'low';
export type CodeReviewAgent = 'codex' | 'claude';
// one Finding anchored to a tour Change: `side` and the lines follow ReviewDiffComment
// (`additions` = new-file line numbers, `deletions` = old-file line numbers); `id` is a stable digest
export type Finding = { id: string; changeId: string; side: 'additions' | 'deletions'; startLine: number; endLine: number; severity: CodeReviewSeverity; title: string; body: string };
// a Finding with no anchor in the tour's diffs (an unknown Change or lines outside its hunk)
export type GeneralFinding = { id: string; severity: CodeReviewSeverity; title: string; body: string; file?: string };
// a completed Code review of the tour's Comparison; `conversation` is present when its reviewer can be asked about it
export type CodeReview = { fingerprint: string; preset: { id: string; label: string; agent: CodeReviewAgent }; effort?: string; focus?: string; findings: Finding[]; general: GeneralFinding[]; completedAt: string; conversation?: string };
// what one Code review run asks for: a preset id, an effort it accepts, and an optional extra focus
export type CodeReviewOptions = { preset: string; effort?: string; focus?: string };
// one Review preset as the dashboard lists it; an unavailable one says why
export type CodeReviewPreset = { id: string; label: string; agent: CodeReviewAgent; effort?: string; efforts: string[]; available: boolean; reason?: string };
// the dashboard's `codeReview`; an older server omits it
export type CodeReviewCapability = { defaultPreset: string; presets: CodeReviewPreset[] };

export const maxCodeReviewFocus = 2_000;

const isSeverity = (value: unknown): value is CodeReviewSeverity => value === 'high' || value === 'medium' || value === 'low';
const isAgent = (value: unknown): value is CodeReviewAgent => value === 'codex' || value === 'claude';
const isLine = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

// validate one anchored Finding
export function isFinding(value: unknown): value is Finding {
  return isRecord(value) && typeof value.id === 'string' && typeof value.changeId === 'string' && (value.side === 'additions' || value.side === 'deletions')
    && isLine(value.startLine) && isLine(value.endLine) && value.startLine <= value.endLine && isSeverity(value.severity) && typeof value.title === 'string' && typeof value.body === 'string';
}

// validate one general Finding
export function isGeneralFinding(value: unknown): value is GeneralFinding {
  return isRecord(value) && typeof value.id === 'string' && isSeverity(value.severity) && typeof value.title === 'string' && typeof value.body === 'string' && optionalString(value.file);
}

// validate a completed Code review
export function isCodeReview(value: unknown): value is CodeReview {
  return isRecord(value) && typeof value.fingerprint === 'string' && typeof value.completedAt === 'string' && optionalString(value.effort) && optionalString(value.focus) && optionalString(value.conversation)
    && isRecord(value.preset) && typeof value.preset.id === 'string' && typeof value.preset.label === 'string' && isAgent(value.preset.agent)
    && Array.isArray(value.findings) && value.findings.every(isFinding) && Array.isArray(value.general) && value.general.every(isGeneralFinding);
}

// Read a completed Code review from a reply, or undefined when malformed. A general Finding's
// `file` is omitted when absent; a null one is dropped too.
export function codeReviewFrom(value: unknown): CodeReview | undefined {
  // require the general Findings list before normalizing it
  if (!isRecord(value) || !Array.isArray(value.general)) return undefined;
  const general = value.general.map(entry => isRecord(entry) && entry.file === null ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'file')) : entry);
  const review = { ...value, general };
  return isCodeReview(review) ? review : undefined;
}

// read one listed preset, dropping malformed efforts
function presetFrom(value: unknown): CodeReviewPreset | undefined {
  // require the identifying fields
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string' || !isAgent(value.agent) || typeof value.available !== 'boolean') return undefined;
  const efforts = Array.isArray(value.efforts) ? value.efforts.filter((effort): effort is string => typeof effort === 'string') : [];
  return { id: value.id, label: value.label, agent: value.agent, efforts, available: value.available, ...(typeof value.effort === 'string' ? { effort: value.effort } : {}), ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
}

// The dashboard's Code review capability, or undefined when absent, malformed or without presets
// (the start sheet then hides the AI review). Malformed presets are dropped one by one.
export function codeReviewCapability(value: unknown): CodeReviewCapability | undefined {
  // require the envelope
  if (!isRecord(value) || !Array.isArray(value.presets)) return undefined;
  const presets = value.presets.map(presetFrom).filter((preset): preset is CodeReviewPreset => preset !== undefined);
  // hide a capability with nothing to offer
  if (presets.length === 0) return undefined;
  return { defaultPreset: typeof value.defaultPreset === 'string' ? value.defaultPreset : presets[0]!.id, presets };
}

// The device's last Code review choice: the preset, and per preset the effort ('' = its default).
type CodeReviewChoice = { preset?: string; efforts: Record<string, string> };
const codeReviewChoiceKey = 'rac.code-review-choice';

// read the last choice, tolerating absent or malformed storage
export function readCodeReviewChoice(): CodeReviewChoice {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(codeReviewChoiceKey) ?? 'null');
    // ignore unreadable choices
    if (!isRecord(stored)) return { efforts: {} };
    const efforts = isRecord(stored.efforts) ? Object.fromEntries(Object.entries(stored.efforts).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    return { ...(typeof stored.preset === 'string' ? { preset: stored.preset } : {}), efforts };
  } catch { return { efforts: {} }; }
}

// remember the preset and its effort for the next start on this device
export function saveCodeReviewChoice(options: CodeReviewOptions): void {
  const current = readCodeReviewChoice();
  try { localStorage.setItem(codeReviewChoiceKey, JSON.stringify({ preset: options.preset, efforts: { ...current.efforts, [options.preset]: options.effort ?? '' } })); }
  catch { /* storage unavailable: the defaults apply next time */ }
}

// The preset a sheet opens on: the last one used if it is still available, else the default, else
// the first available one.
export function initialPreset(capability: CodeReviewCapability): CodeReviewPreset | undefined {
  const available = capability.presets.filter(preset => preset.available);
  const last = readCodeReviewChoice().preset;
  return available.find(preset => preset.id === last) ?? available.find(preset => preset.id === capability.defaultPreset) ?? available[0];
}

// The effort a preset opens on: the last one used with it if still accepted, else the preset's own
// effort, else '' (its default).
export function initialEffort(preset: CodeReviewPreset): string {
  const last = readCodeReviewChoice().efforts[preset.id];
  if (last !== undefined && (last === '' || preset.efforts.includes(last))) return last;
  return preset.effort !== undefined && preset.efforts.includes(preset.effort) ? preset.effort : '';
}

type CodeReviewRequest = (url: string, init?: RequestInit, observeReachability?: boolean) => Promise<Response>;
// how a polled job settled: its review, why it failed, or quietly gone (cancelled, or superseded by a
// new tour start or a dismissal)
export type CodeReviewOutcome = { review: CodeReview } | { error: string } | { gone: true };

// read one JSON body, tolerating empty or invalid ones
async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  return await response.json().then((value: unknown) => isRecord(value) ? value : {}).catch(() => ({}));
}

// explain one failed Code review start or run
export function codeReviewErrorMessage(code: string | undefined, status: number): string {
  if (code === 'stale_during_generation') return 'The changes moved since this tour was built. Regenerate the tour to add an AI review.';
  if (code === 'timed_out') return 'The AI review timed out.';
  if (code === 'authentication_required') return 'The review agent’s login on the server expired. Sign in again, then retry.';
  if (code === 'capability_unavailable') return 'This review preset cannot run on this server.';
  if (code === 'invalid_request') return 'The AI review request was rejected. Refresh the console and try again.';
  if (code === 'too_large') return 'This change is too large for an AI review.';
  if (code === 'cancelled') return 'The AI review was cancelled.';
  if (code === 'malformed_result' || code === 'generation_rejected') return 'The AI review returned an unusable result. Try again.';
  if (code === 'job_expired') return 'The AI review expired before it finished.';
  if (code === 'target_unavailable') return 'The AI review is no longer available. Try again.';
  if (status === 410) return 'The AI review expired or was replaced.';
  if (status === 423) return 'Another browser controls this console. Take control, then try again.';
  if (status === 429) return 'Too many review requests were sent. Wait a moment, then try again.';
  return 'The AI review failed. Try again.';
}

// Poll one Code review job until it settles, then report its outcome once. Polling stops when the
// job changes or the caller unmounts; it never cancels the job. Returns what the job's latest pending
// reply said (its run's pane and start time).
export function useCodeReviewPoll(request: CodeReviewRequest, job: ReviewJob | undefined, onSettled: (outcome: CodeReviewOutcome) => void): ReviewJobProgress {
  const [progress, setProgress] = useState<ReviewJobProgress & { jobId: string }>();
  const settled = useRef(onSettled);
  // retain the latest outcome callback
  useEffect(() => { settled.current = onSettled; }, [onSettled]);
  useEffect(() => {
    // wait for a running job
    if (job === undefined) return;
    let stopped = false;
    let timer: number | undefined;
    const later = () => { timer = window.setTimeout(() => void poll(), Math.max(250, Math.min(5_000, job.retryAfterMs))); };
    const poll = async () => {
      const response = await request(`/api/code-review/jobs/${encodeURIComponent(job.id)}`, undefined, false);
      const body = await responseRecord(response);
      // ignore replaced jobs
      if (stopped) return;
      // keep polling pending work
      if (response.status === 202 && body.status === 'pending') { setProgress({ jobId: job.id, ...reviewJobProgress(body) }); later(); return; }
      const review = response.ok && body.status === 'ready' ? codeReviewFrom(body.review) : undefined;
      // publish a validated review
      if (review !== undefined) { settled.current({ review }); return; }
      const code = failureCode(body);
      // a cancelled or superseded job ends quietly
      if (response.status === 410 && (code === 'job_superseded' || code === 'job_cancelled')) { settled.current({ gone: true }); return; }
      // poll through transient failures for the job lifetime
      if (transientFailure(response, code) && Date.now() < Date.parse(job.expiresAt)) { later(); return; }
      settled.current({ error: response.ok ? 'The server returned an invalid AI review.' : codeReviewErrorMessage(code, response.status) });
    };
    void poll();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [job, request]);
  // only the current job's progress
  return progress !== undefined && progress.jobId === job?.id ? { ...(progress.run === undefined ? {} : { run: progress.run }), ...(progress.startedAt === undefined ? {} : { startedAt: progress.startedAt }) } : {};
}

// "4 findings · 1 general", the chip's count of a completed review
export function codeReviewCount(review: CodeReview): string {
  const anchored = review.findings.length;
  const general = review.general.length;
  if (anchored + general === 0) return 'no findings';
  return [`${anchored} ${anchored === 1 ? 'finding' : 'findings'}`, ...(general > 0 ? [`${general} general`] : [])].join(' · ');
}
