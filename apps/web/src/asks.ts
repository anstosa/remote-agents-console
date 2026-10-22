import { useCallback, useEffect, useRef, useState } from 'react';
import { failureCode, isReviewJob, reviewJobProgress, transientFailure, type ReviewJob, type ReviewRunLink } from './review-jobs.js';

// Ask threads: questions about a stored tour's Findings, asked of the Code review's own conversation and
// stored with the tour on the server. Each question is a job polled to its end; the thread is read
// back from the server once it settles. Every guard tolerates extra fields.

export const maxAskQuestion = 4_000;

// one question and how it settled
export type AskTurn = { id: string; question: string; askedAt: string; answer?: string; error?: { code: string; retryable: boolean } };
// the questions about one Finding, keyed by the Finding's id
export type AskThread = { id: string; findingId: string; turns: AskTurn[] };
// a question still being answered: its job, and what the job's latest poll said about its pane
export type PendingAsk = { question: string; job: ReviewJob; run?: ReviewRunLink; startedAt?: string };
// why a thread's last question has no answer when the thread does not hold it as a turn (`turnId`)
export type AskFailure = { turnId: string; message: string };
type AskRequest = (url: string, init?: RequestInit, observeReachability?: boolean) => Promise<Response>;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

function turnFrom(value: unknown): AskTurn | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string' || typeof value.askedAt !== 'string') return undefined;
  const error = isRecord(value.error) && typeof value.error.code === 'string' ? { code: value.error.code, retryable: value.error.retryable === true } : undefined;
  return { id: value.id, question: value.question, askedAt: value.askedAt, ...(typeof value.answer === 'string' ? { answer: value.answer } : {}), ...(error === undefined ? {} : { error }) };
}

function threadFrom(value: unknown): AskThread | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.anchor) || typeof value.anchor.findingId !== 'string' || !Array.isArray(value.turns)) return undefined;
  return { id: value.id, findingId: value.anchor.findingId, turns: value.turns.map(turnFrom).filter((turn): turn is AskTurn => turn !== undefined) };
}

// who a thread asks: the reviewer about one of its Findings, or the tour's guide about some lines
export type AskRole = 'reviewer' | 'guide';
// how the thread names who it asks, the agent behind them, and what was asked about
export const askRoleCopy: Record<AskRole, { who: string; agent: string; placeholder: string; noConversation: string; gone: string }> = {
  reviewer: { who: 'reviewer', agent: 'review agent', placeholder: 'Ask the reviewer about this finding', noConversation: 'This AI review kept no conversation to ask. Run the AI review again to ask about its findings.', gone: 'This finding is no longer part of the stored review.' },
  guide: { who: 'guide', agent: 'tour agent', placeholder: 'Ask the guide about these lines', noConversation: 'This tour kept no conversation to ask. Regenerate the tour to ask its guide.', gone: 'These lines are no longer part of the stored tour.' }
};

// explain why a question to `role` could not be asked or answered
export function askErrorMessage(role: AskRole, code: string | undefined, status = 0): string {
  const copy = askRoleCopy[role];
  if (code === 'busy') return `The ${copy.who} is still answering the last question.`;
  if (code === 'agent_busy') return `The ${copy.who}’s pane is in use. Finish there, then ask again.`;
  if (code === 'conversation_unavailable') return copy.noConversation;
  if (code === 'stale_during_generation') return 'The changes moved since this tour was built. Regenerate the tour to ask about them.';
  if (code === 'target_unavailable') return copy.gone;
  if (code === 'timed_out') return `The ${copy.who} took too long to answer.`;
  if (code === 'authentication_required') return `The ${copy.agent}’s login on the server expired. Sign in again, then ask again.`;
  if (code === 'capability_unavailable') return `The ${copy.agent} cannot run on this server.`;
  if (code === 'malformed_result') return `The ${copy.who} gave no answer. Its pane is left open if it needs you.`;
  if (code === 'cancelled') return 'The question was cancelled.';
  if (code === 'invalid_request') return 'The question was rejected. Refresh the console and try again.';
  if (status === 423) return 'Another browser controls this console. Take control, then try again.';
  if (status === 429) return 'Too many requests were sent. Wait a moment, then try again.';
  return 'The question failed. Try again.';
}

// The Ask threads of the Worktree's stored tour, read when `enabled` and again for each Code review
// (`conversation`), with the owner's questions still being answered polled until they settle; `ask`
// starts a question about one Finding and resolves to why it did not start.
export function useAskThreads(request: AskRequest, worktreeId: string, fingerprint: string | undefined, conversation: string | undefined, enabled: boolean): { threads: Map<string, AskThread>; pending: Map<string, PendingAsk>; failures: Map<string, AskFailure>; ask: (findingId: string, question: string) => Promise<string | undefined> } {
  const [threads, setThreads] = useState(new Map<string, AskThread>());
  const [pending, setPending] = useState(new Map<string, PendingAsk>());
  const [failures, setFailures] = useState(new Map<string, AskFailure>());
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  // read the stored threads, and the questions still pending when asked to
  const refresh = useCallback(async (withPending: boolean) => {
    const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/review-tour/asks`, undefined, false);
    const body: unknown = await response.json().catch(() => undefined);
    if (!live.current || !response.ok || !isRecord(body) || !Array.isArray(body.threads)) return;
    setThreads(new Map(body.threads.map(threadFrom).filter((thread): thread is AskThread => thread !== undefined).map(thread => [thread.id, thread])));
    if (withPending && Array.isArray(body.pending)) setPending(new Map(body.pending.flatMap(entry => isRecord(entry) && typeof entry.threadId === 'string' && typeof entry.question === 'string' && isReviewJob(entry.job) ? [[entry.threadId, { question: entry.question, job: entry.job }] as const] : [])));
  }, [request, worktreeId]);
  useEffect(() => { if (enabled) void refresh(true); }, [enabled, fingerprint, conversation, refresh]);

  // poll each pending question's job; a settled one is read back with its thread
  const polling = [...pending.entries()].map(([threadId, entry]) => `${threadId}\0${entry.job.id}`).join('|');
  useEffect(() => {
    const timers: number[] = [];
    let stopped = false;
    // a failed job's turn is normally on its thread; `message` shows when it is not (a store failure)
    const settle = (threadId: string, jobId: string, message?: string) => {
      setPending(current => { if (current.get(threadId)?.job.id !== jobId) return current; const next = new Map(current); next.delete(threadId); return next; });
      if (message !== undefined) setFailures(current => new Map(current).set(threadId, { turnId: jobId, message }));
      void refresh(false);
    };
    for (const [threadId, { job }] of pending) {
      const poll = async () => {
        const response = await request(`/api/review-tour/asks/jobs/${encodeURIComponent(job.id)}`, undefined, false);
        const body: unknown = await response.json().catch(() => ({}));
        if (stopped) return;
        const record = isRecord(body) ? body : {};
        if (response.status === 202 && record.status === 'pending') {
          const progress = reviewJobProgress(record);
          setPending(current => { const entry = current.get(threadId); if (entry?.job.id !== job.id) return current; const next = new Map(current); next.set(threadId, { ...entry, ...progress }); return next; });
          timers.push(window.setTimeout(() => void poll(), Math.max(250, Math.min(5_000, job.retryAfterMs))));
          return;
        }
        // poll through transient failures for the job's lifetime
        if (transientFailure(response, failureCode(record)) && Date.now() < Date.parse(job.expiresAt)) { timers.push(window.setTimeout(() => void poll(), 2_000)); return; }
        // answered, failed, superseded with its tour or review (410), or forgotten by a restart (404)
        settle(threadId, job.id, response.ok || response.status === 410 || response.status === 404 ? undefined : askErrorMessage('reviewer', failureCode(record), response.status));
      };
      timers.push(window.setTimeout(() => void poll(), 0));
    }
    return () => { stopped = true; timers.forEach(timer => window.clearTimeout(timer)); };
    // `polling` stands in for `pending`: it changes only when a job starts or settles
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, refresh, request]);

  const ask = useCallback(async (findingId: string, question: string): Promise<string | undefined> => {
    if (fingerprint === undefined) return askErrorMessage('reviewer', 'target_unavailable');
    const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/review-tour/asks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ findingId, question, fingerprint }) }, false);
    const body: unknown = await response.json().catch(() => ({}));
    const record = isRecord(body) ? body : {};
    if (response.status === 202 && isReviewJob(record.job) && typeof record.threadId === 'string') {
      const job = record.job;
      const threadId = record.threadId;
      setPending(current => new Map(current).set(threadId, { question, job }));
      setFailures(current => { if (!current.has(threadId)) return current; const next = new Map(current); next.delete(threadId); return next; });
      return undefined;
    }
    return askErrorMessage('reviewer', failureCode(record), response.status);
  }, [request, worktreeId, fingerprint]);

  return { threads, pending, failures, ask };
}
