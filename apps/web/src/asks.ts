import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewDiffSide as Side } from './code-panel/review-diffs.js';
import { failureCode, isRecord, isReviewJob, reviewJobProgress, transientFailure, type ReviewJob, type ReviewRunLink } from './review-jobs.js';

// Ask threads: questions about a stored tour, asked of the conversation of the run asked about (the
// Code review's for a Finding, the tour's own for some of its lines) and stored with the tour on the
// server, or about a Code panel's Comparison, asked of the tour guide or the Comparison's own diff conversation. Each question is a job polled to its end; the thread is read back from the server once it
// settles. Every guard tolerates extra fields.

export const maxAskQuestion = 4_000;

// one question and how it settled
export type AskTurn = { id: string; question: string; askedAt: string; answer?: string; error?: { code: string; retryable: boolean } };
// Lines of one Change: a range on `side`, or, with `startSide`, from a line on that side to `endLine` on `side`
export type AskLines = { changeId: string; startSide?: Side; side: Side; startLine: number; endLine: number };
// where a thread points: its lines, and the Finding when it is about one
export type AskAnchor = AskLines & { findingId?: string };
// the questions about one anchor; a reviewer thread's id is its Finding's
export type AskThread = { id: string; target: AskRole; anchor: AskAnchor; turns: AskTurn[] };
// A question still being answered: its job, what the job's latest poll said about its pane, and the
// thread it is on, which it may be starting
export type PendingAsk = { question: string; job: ReviewJob; target: AskRole; anchor: AskAnchor; run?: ReviewRunLink; startedAt?: string };
// what a question is about: a Finding, new lines, or an existing thread of lines, each with the target
// its endpoint asks it of when it asks more than one
export type AskSubject = { target: 'reviewer'; findingId: string } | { target?: 'guide'; lines: AskLines } | { target?: 'guide'; threadId: string };
// Why a thread's last question has no answer when the thread does not hold it as a turn (`turnId`), and
// where that question was asked, for a thread its failed first question left unstored
export type AskFailure = { turnId: string; message: string; target: AskRole; anchor: AskAnchor };
type AskRequest = (url: string, init?: RequestInit, observeReachability?: boolean) => Promise<Response>;


function turnFrom(value: unknown): AskTurn | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string' || typeof value.askedAt !== 'string') return undefined;
  const error = isRecord(value.error) && typeof value.error.code === 'string' ? { code: value.error.code, retryable: value.error.retryable === true } : undefined;
  return { id: value.id, question: value.question, askedAt: value.askedAt, ...(typeof value.answer === 'string' ? { answer: value.answer } : {}), ...(error === undefined ? {} : { error }) };
}

const isSide = (value: unknown): value is Side => value === 'additions' || value === 'deletions';
const isRole = (value: unknown): value is AskRole => value === 'reviewer' || value === 'guide' || value === 'diff';

function anchorFrom(value: unknown): AskAnchor | undefined {
  if (!isRecord(value) || typeof value.changeId !== 'string' || !isSide(value.side) || typeof value.startLine !== 'number' || typeof value.endLine !== 'number') return undefined;
  return { changeId: value.changeId, side: value.side, startLine: value.startLine, endLine: value.endLine, ...(isSide(value.startSide) ? { startSide: value.startSide } : {}), ...(typeof value.findingId === 'string' ? { findingId: value.findingId } : {}) };
}

function threadFrom(value: unknown): AskThread | undefined {
  const anchor = isRecord(value) ? anchorFrom(value.anchor) : undefined;
  if (!isRecord(value) || typeof value.id !== 'string' || !isRole(value.target) || anchor === undefined || !Array.isArray(value.turns)) return undefined;
  return { id: value.id, target: value.target, anchor, turns: value.turns.map(turnFrom).filter((turn): turn is AskTurn => turn !== undefined) };
}

function pendingFrom(value: unknown): [string, PendingAsk] | undefined {
  const anchor = isRecord(value) ? anchorFrom(value.anchor) : undefined;
  if (!isRecord(value) || typeof value.threadId !== 'string' || typeof value.question !== 'string' || !isRole(value.target) || anchor === undefined || !isReviewJob(value.job)) return undefined;
  return [value.threadId, { question: value.question, job: value.job, target: value.target, anchor }];
}

// who a thread asks: the reviewer about one of its Findings, the tour's guide about some lines, or
// the agent a Code panel's questions about one Comparison started
export type AskRole = 'reviewer' | 'guide' | 'diff';
// how the thread names who it asks, the agent behind them, and what was asked about
const tourStale = 'The changes moved since this tour was built. Regenerate the tour to ask about them.';
export const askRoleCopy: Record<AskRole, { who: string; agent: string; placeholder: string; noConversation: string; gone: string; stale: string }> = {
  reviewer: { who: 'reviewer', agent: 'review agent', placeholder: 'Ask the reviewer about this finding', noConversation: 'This AI review kept no conversation to ask. Run the AI review again to ask about its findings.', gone: 'This finding is no longer part of the stored review.', stale: tourStale },
  guide: { who: 'guide', agent: 'tour agent', placeholder: 'Ask the guide about these lines', noConversation: 'This tour kept no conversation to ask. Regenerate the tour to ask its guide.', gone: 'These lines are no longer part of the stored tour.', stale: tourStale },
  diff: { who: 'agent', agent: 'tour agent', placeholder: 'Ask about these lines', noConversation: 'The agent kept no conversation to follow up. Ask about the lines again.', gone: 'These lines are no longer part of the changes.', stale: 'The changes moved while these lines were picked. Pick them again.' }
};

// explain why a question to `role` could not be asked or answered
export function askErrorMessage(role: AskRole, code: string | undefined, status = 0): string {
  const copy = askRoleCopy[role];
  if (code === 'busy') return `The ${copy.who} is still answering the last question.`;
  if (code === 'agent_busy') return `The ${copy.who}’s pane is in use. Finish there, then ask again.`;
  if (code === 'conversation_unavailable') return copy.noConversation;
  if (code === 'stale_during_generation') return copy.stale;
  if (code === 'target_unavailable') return copy.gone;
  if (code === 'timed_out') return `The ${copy.who} took too long to answer.`;
  if (code === 'authentication_required') return `The ${copy.agent}’s login on the server expired. Sign in again, then ask again.`;
  if (code === 'capability_unavailable') return `The ${copy.agent} cannot run on this server.`;
  if (code === 'malformed_result') return `The ${copy.who} gave no answer. Its pane is left open if it needs you.`;
  if (code === 'cancelled') return 'The question was cancelled.';
  if (code === 'job_lost') return 'The question was lost, likely to a server restart. Ask again.';
  if (code === 'too_large') return 'There are too many questions here. Ask on one of the threads instead.';
  if (code === 'invalid_request') return 'The question was rejected. Refresh the console and try again.';
  if (status === 423) return 'Another browser controls this console. Take control, then try again.';
  if (status === 429) return 'Too many requests were sent. Wait a moment, then try again.';
  return 'The question failed. Try again.';
}

// One collection of Ask threads, and `ask`, which starts a question of `role` and resolves to why it did not start
export type AskThreads = { threads: Map<string, AskThread>; pending: Map<string, PendingAsk>; failures: Map<string, AskFailure>; ask: (role: AskRole, subject: AskSubject, anchor: AskAnchor, question: string, replacing?: string) => Promise<string | undefined> };

// the lines a range picked in a diff covers
export const askLines = ({ changeId, startSide, startLine, endSide, endLine }: { changeId: string; startSide: Side; startLine: number; endSide: Side; endLine: number }): AskLines => ({ changeId, side: endSide, startLine, endLine, ...(startSide === endSide ? {} : { startSide }) });

// The Ask threads at `url` (which reads them and takes questions about the Comparison `fingerprint`),
// read when `enabled` and again whenever `refreshKey` (such as the conversations they can ask)
// changes, with the owner's questions still being answered polled until they settle.
export function useAskThreads(request: AskRequest, url: string, fingerprint: string | undefined, refreshKey: string, enabled: boolean): AskThreads {
  const [threads, setThreads] = useState(new Map<string, AskThread>());
  const [pending, setPending] = useState(new Map<string, PendingAsk>());
  const [failures, setFailures] = useState(new Map<string, AskFailure>());
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  // another endpoint is another collection of threads: none of these carry over, nor a late read of them
  const currentUrl = useRef(url);
  currentUrl.current = url;
  useEffect(() => { setThreads(new Map()); setPending(new Map()); setFailures(new Map()); }, [url]);

  // read the stored threads, and the questions still pending when asked to
  const refresh = useCallback(async (withPending: boolean) => {
    const response = await request(url, undefined, false);
    const body: unknown = await response.json().catch(() => undefined);
    if (!live.current || currentUrl.current !== url || !response.ok || !isRecord(body) || !Array.isArray(body.threads)) return;
    setThreads(new Map(body.threads.map(threadFrom).filter((thread): thread is AskThread => thread !== undefined).map(thread => [thread.id, thread])));
    // a question started while this read was out is not in it; one that settled meanwhile settles through its poll
    if (withPending && Array.isArray(body.pending)) { const read = body.pending.map(pendingFrom).filter((entry): entry is [string, PendingAsk] => entry !== undefined); setPending(current => new Map([...current, ...read])); }
  }, [request, url]);
  useEffect(() => { if (enabled) void refresh(true); }, [enabled, fingerprint, refreshKey, refresh]);

  // poll each pending question's job; a settled one is read back with its thread
  const polling = [...pending.entries()].map(([threadId, entry]) => `${threadId}\0${entry.job.id}`).join('|');
  useEffect(() => {
    const timers: number[] = [];
    let stopped = false;
    // A failed job's turn is normally on its thread; `message` shows when it is not (a store failure, a
    // restart). The question stays pending until its thread is read back, so a thread it was starting
    // never drops out of view in between.
    const settle = (threadId: string, entry: PendingAsk, message?: string) => {
      if (message !== undefined) setFailures(current => new Map(current).set(threadId, { turnId: entry.job.id, message, target: entry.target, anchor: entry.anchor }));
      void refresh(false).finally(() => setPending(current => { if (current.get(threadId)?.job.id !== entry.job.id) return current; const next = new Map(current); next.delete(threadId); return next; }));
    };
    for (const [threadId, entry] of pending) {
      const { job, target } = entry;
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
        settle(threadId, entry, response.ok || response.status === 410 ? undefined : response.status === 404 ? askErrorMessage(target, 'job_lost') : askErrorMessage(target, failureCode(record), response.status));
      };
      timers.push(window.setTimeout(() => void poll(), 0));
    }
    return () => { stopped = true; timers.forEach(timer => window.clearTimeout(timer)); };
    // `polling` stands in for `pending`: it changes only when a job starts or settles
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, refresh, request]);

  // `anchor` is where the question's thread sits, shown while its first question is answered;
  // `replacing` is a thread its failed first question left unstored, which this question starts again
  const ask = useCallback(async (role: AskRole, subject: AskSubject, anchor: AskAnchor, question: string, replacing?: string): Promise<string | undefined> => {
    if (fingerprint === undefined) return askErrorMessage(role, 'target_unavailable');
    const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...subject, question, fingerprint }) }, false);
    const body: unknown = await response.json().catch(() => ({}));
    const record = isRecord(body) ? body : {};
    if (response.status === 202 && isReviewJob(record.job) && typeof record.threadId === 'string') {
      const job = record.job;
      const threadId = record.threadId;
      // the endpoint may name who it asked, which a Code panel's question learns only now
      setPending(current => new Map(current).set(threadId, { question, job, target: isRole(record.target) ? record.target : role, anchor }));
      setFailures(current => { if (!current.has(threadId) && (replacing === undefined || !current.has(replacing))) return current; const next = new Map(current); next.delete(threadId); if (replacing !== undefined) next.delete(replacing); return next; });
      return undefined;
    }
    return askErrorMessage(role, failureCode(record), response.status);
  }, [request, url, fingerprint]);

  return { threads, pending, failures, ask };
}
