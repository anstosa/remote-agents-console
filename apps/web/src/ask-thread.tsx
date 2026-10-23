import { type ReactNode, useCallback, useState } from 'react';
import { askErrorMessage, askRoleCopy, maxAskQuestion, type AskAnchor, type AskFailure, type AskLines, type AskRole, type AskSubject, type AskThread, type AskThreads, type PendingAsk } from './asks.js';
import type { ReviewDiffAsk } from './code-panel/review-diffs.js';
import { useJobElapsed, type ReviewRunLink } from './review-jobs.js';
import { MarkdownBlocks } from './note-markdown.js';

// One Ask thread in a tour diff: the questions asked and the Markdown answers of `role` (the reviewer
// under its Finding, the guide under the asked-about lines), the question still being answered (with
// its pane, when the agent runs interactive), and a box for the next one. Closed and empty, it is one
// "Ask reviewer" button; a thread just started from the gutter (`onCancel`) opens on its box instead,
// and Cancel drops it. Answers copy into a comment where there is one to copy them into (`onUseAnswer`).
export function AskThreadView({ role, thread, pending, failed, onAsk, onUseAnswer, onOpenRun, onCancel }: { role: AskRole; thread?: AskThread; pending?: PendingAsk; failed?: AskFailure; onAsk: (question: string) => Promise<string | undefined>; onUseAnswer?: (answer: string) => void; onOpenRun?: (run: ReviewRunLink) => void; onCancel?: () => void }) {
  const copy = askRoleCopy[role];
  const turns = thread?.turns ?? [];
  const [open, setOpen] = useState(onCancel !== undefined);
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const elapsed = useJobElapsed(pending?.job, pending?.startedAt);
  // a failure the thread holds no turn for
  const lost = failed !== undefined && !turns.some(turn => turn.id === failed.turnId) ? failed.message : undefined;
  if (!open && turns.length === 0 && pending === undefined && lost === undefined) return <div className="review-ask-open"><button type="button" onClick={() => setOpen(true)}>Ask {copy.who}</button></div>;
  const send = async (text: string) => {
    setSending(true);
    setFailure('');
    const refused = await onAsk(text);
    setSending(false);
    if (refused === undefined) setQuestion(''); else setFailure(refused);
  };
  const busy = pending !== undefined || sending;
  return (
    <section className="review-ask" aria-label={`Questions for the ${copy.who}`}>
      {turns.map(turn => (
        <article key={turn.id} className="review-ask-turn">
          <p className="review-ask-question">{turn.question}</p>
          {turn.answer !== undefined
            ? <><div className="note-markdown review-ask-answer"><MarkdownBlocks text={turn.answer} /></div>{onUseAnswer !== undefined && <div className="review-ask-actions"><button type="button" onClick={() => onUseAnswer(turn.answer!)}>Copy to comment</button></div>}</>
            : <p className="review-ask-error" role="alert">{askErrorMessage(role, turn.error?.code)}{turn.error?.retryable === true && !busy && <button type="button" onClick={() => void send(turn.question)}>Ask again</button>}</p>}
        </article>
      ))}
      {pending !== undefined && (
        <article className="review-ask-turn">
          <p className="review-ask-question">{pending.question}</p>
          <p className="review-ask-pending progress-border progress-mauve" role="status" aria-busy="true">
            <span className="update-progress-ring" aria-hidden="true" />
            {pending.run?.needsInput === true ? `The ${copy.who} asked something in its pane. Answer it there.` : `The ${copy.who} is answering… ${elapsed}`}
            {pending.run !== undefined && onOpenRun !== undefined && <button type="button" onClick={() => onOpenRun(pending.run!)}>Open pane</button>}
          </p>
        </article>
      )}
      {lost !== undefined && <p className="review-ask-error" role="alert">{lost}</p>}
      <form className="review-ask-compose" onSubmit={event => { event.preventDefault(); if (question.trim() !== '' && !busy) void send(question.trim()); }}>
        <textarea aria-label={`Question for the ${copy.who}`} placeholder={turns.length === 0 && pending === undefined ? copy.placeholder : 'Ask a follow-up'} value={question} maxLength={maxAskQuestion} autoFocus={turns.length === 0 && pending === undefined} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }} />
        {failure !== '' && <p className="review-ask-error" role="alert">{failure}</p>}
        <div className="review-ask-actions">
          {turns.length === 0 && pending === undefined && <button type="button" onClick={() => { if (onCancel !== undefined) { onCancel(); return; } setOpen(false); setFailure(''); }}>Cancel</button>}
          <button type="submit" disabled={busy || question.trim() === ''}>{sending ? 'Asking…' : 'Ask'}</button>
        </div>
      </form>
    </section>
  );
}

// what useLineAsks gives a diff renderer: the lines with a thread, picking lines, and each thread
export type LineAsks = { lineAsks: ReviewDiffAsk[]; start: (lines: AskLines) => void; threadFor: (id: string) => ReactNode };

// The Ask threads under lines of a diff rather than a Finding: lines just picked, which show a thread's
// box until its first question starts it, then the threads stored, starting with a pending first
// question, or left unstored by a failed first question (asked again as new lines). `role` asks the
// picked lines, and `target` is what the endpoint is told it asks, when it asks more than one; only
// threads of `targets` are line threads. Picked lines belong to the `scope` they were picked in, and
// drop out of view when it changes. `onUseAnswer` copies an answer near its thread's anchor.
export function useLineAsks(asks: AskThreads, { role, target, targets, enabled, scope, onUseAnswer, onOpenRun }: { role: AskRole; target?: 'guide'; targets?: readonly AskRole[]; enabled: boolean; scope: string; onUseAnswer?: (threadId: string, anchor: AskAnchor, answer: string) => void; onOpenRun?: (run: ReviewRunLink) => void }): LineAsks {
  const { threads, pending, failures, ask } = asks;
  const [picked, setPicked] = useState<Array<{ id: string; scope: string; lines: AskLines }>>([]);
  const drafts = picked.filter(draft => draft.scope === scope);
  const start = useCallback((lines: AskLines) => setPicked(current => [...current.filter(draft => draft.scope === scope), { id: crypto.randomUUID(), scope, lines }]), [scope]);
  const anchors = new Map<string, AskAnchor>();
  for (const [id, entry] of [...failures, ...pending, ...threads]) if (targets === undefined || targets.includes(entry.target)) anchors.set(id, entry.anchor);
  const lineAsks: ReviewDiffAsk[] = !enabled ? [] : [...[...anchors].map(([id, anchor]) => ({ id, ...anchor })), ...drafts.map(draft => ({ id: draft.id, ...draft.lines }))];
  const subject = (about: { lines: AskLines } | { threadId: string }): AskSubject => target === undefined ? about : { target, ...about };
  const runLink = onOpenRun === undefined ? {} : { onOpenRun };
  const threadFor = (id: string): ReactNode => {
    if (!enabled) return null;
    const draft = drafts.find(candidate => candidate.id === id);
    const dropDraft = () => setPicked(current => current.filter(candidate => candidate.id !== id));
    if (draft !== undefined) return <AskThreadView key={id} role={role} onCancel={dropDraft} onAsk={async question => { const refused = await ask(role, subject({ lines: draft.lines }), draft.lines, question); if (refused === undefined) dropDraft(); return refused; }} {...runLink} />;
    const thread = threads.get(id);
    const waiting = pending.get(id);
    const failed = failures.get(id);
    const anchor = thread?.anchor ?? waiting?.anchor ?? failed?.anchor;
    if (anchor === undefined) return null;
    const asked = thread?.target ?? waiting?.target ?? failed?.target ?? role;
    const { findingId: _findingId, ...lines } = anchor;
    const onAsk = (question: string) => thread === undefined && waiting === undefined ? ask(role, subject({ lines }), anchor, question, id) : ask(asked, subject({ threadId: id }), anchor, question);
    return <AskThreadView key={id} role={asked} thread={thread} pending={waiting} failed={failed} onAsk={onAsk} {...(onUseAnswer === undefined ? {} : { onUseAnswer: (answer: string) => onUseAnswer(id, anchor, answer) })} {...runLink} />;
  };
  return { lineAsks, start, threadFor };
}
