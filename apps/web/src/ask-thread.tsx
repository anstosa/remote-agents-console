import { useState } from 'react';
import { askErrorMessage, maxAskQuestion, type AskFailure, type AskThread, type PendingAsk } from './asks.js';
import { useJobElapsed, type ReviewRunLink } from './code-review.js';
import { MarkdownBlocks } from './note-markdown.js';

// One Finding's Ask thread under its suggested or kept comment: the questions asked and the
// reviewer's Markdown answers, the question still being answered (with its pane, when the reviewer
// runs interactive), and a box for the next one. Closed and empty, it is one "Ask reviewer" button.
export function AskThreadView({ thread, pending, failed, onAsk, onUseAnswer, onOpenRun }: { thread?: AskThread; pending?: PendingAsk; failed?: AskFailure; onAsk: (question: string) => Promise<string | undefined>; onUseAnswer: (answer: string) => void; onOpenRun?: (run: ReviewRunLink) => void }) {
  const turns = thread?.turns ?? [];
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState('');
  const elapsed = useJobElapsed(pending?.job, pending?.startedAt);
  // a failure the thread holds no turn for
  const lost = failed !== undefined && !turns.some(turn => turn.id === failed.turnId) ? failed.message : undefined;
  if (!open && turns.length === 0 && pending === undefined && lost === undefined) return <div className="review-ask-open"><button type="button" onClick={() => setOpen(true)}>Ask reviewer</button></div>;
  const send = async (text: string) => {
    setSending(true);
    setFailure('');
    const refused = await onAsk(text);
    setSending(false);
    if (refused === undefined) setQuestion(''); else setFailure(refused);
  };
  const busy = pending !== undefined || sending;
  return (
    <section className="review-ask" aria-label="Questions for the reviewer">
      {turns.map(turn => (
        <article key={turn.id} className="review-ask-turn">
          <p className="review-ask-question">{turn.question}</p>
          {turn.answer !== undefined
            ? <><div className="note-markdown review-ask-answer"><MarkdownBlocks text={turn.answer} /></div><div className="review-ask-actions"><button type="button" onClick={() => onUseAnswer(turn.answer!)}>Copy to comment</button></div></>
            : <p className="review-ask-error" role="alert">{askErrorMessage(turn.error?.code)}{turn.error?.retryable === true && !busy && <button type="button" onClick={() => void send(turn.question)}>Ask again</button>}</p>}
        </article>
      ))}
      {pending !== undefined && (
        <article className="review-ask-turn">
          <p className="review-ask-question">{pending.question}</p>
          <p className="review-ask-pending progress-border progress-mauve" role="status" aria-busy="true">
            <span className="update-progress-ring" aria-hidden="true" />
            {pending.run?.needsInput === true ? 'The reviewer asked something in its pane. Answer it there.' : `The reviewer is answering… ${elapsed}`}
            {pending.run !== undefined && onOpenRun !== undefined && <button type="button" onClick={() => onOpenRun(pending.run!)}>Open pane</button>}
          </p>
        </article>
      )}
      {lost !== undefined && <p className="review-ask-error" role="alert">{lost}</p>}
      <form className="review-ask-compose" onSubmit={event => { event.preventDefault(); if (question.trim() !== '' && !busy) void send(question.trim()); }}>
        <textarea aria-label="Question for the reviewer" placeholder={turns.length === 0 && pending === undefined ? 'Ask the reviewer about this finding' : 'Ask a follow-up'} value={question} maxLength={maxAskQuestion} autoFocus={turns.length === 0 && pending === undefined} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit(); }} />
        {failure !== '' && <p className="review-ask-error" role="alert">{failure}</p>}
        <div className="review-ask-actions">
          {turns.length === 0 && pending === undefined && <button type="button" onClick={() => { setOpen(false); setFailure(''); }}>Cancel</button>}
          <button type="submit" disabled={busy || question.trim() === ''}>{sending ? 'Asking…' : 'Ask'}</button>
        </div>
      </form>
    </section>
  );
}
