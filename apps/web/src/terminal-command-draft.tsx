import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

type CommandDraft = { text: string; focus: number };
const drafts = new Map<string, CommandDraft>();
const listeners = new Map<string, Set<() => void>>();
// bound the entire editable command rather than only each transport frame
const terminalCommandByteLimit = 256 * 1024;
export const terminalCommandLimitMessage = `Commands are limited to ${terminalCommandByteLimit / 1024} KiB. Your existing draft has been kept.`;

// reject oversized strings before allocating their encoded representation
export const terminalCommandFits = (text: string): boolean => text.length <= terminalCommandByteLimit && new TextEncoder().encode(text).length <= terminalCommandByteLimit;

// scope staged commands to the exact place and terminal pane
export const terminalCommandKey = (placeId: string, paneId: string): string => JSON.stringify([placeId, paneId]);

// notify only the terminal whose editable draft changed
const publish = (key: string) => listeners.get(key)?.forEach(listener => listener());

// retain existing edits when another custom action is staged
export function stageTerminalCommand(key: string, text: string): boolean {
  const current = drafts.get(key);
  const prefix = current?.text ?? '';
  const separator = prefix && !prefix.endsWith('\n') ? '\n' : '';
  // preserve existing edits instead of silently truncating an appended action
  if (prefix.length + separator.length + text.length > terminalCommandByteLimit) return false;
  const next = prefix ? `${prefix}${separator}${text}` : text;
  // multi-byte characters count against the same total input budget
  if (!terminalCommandFits(next)) return false;
  drafts.set(key, { text: next, focus: (current?.focus ?? 0) + 1 });
  publish(key);
  return true;
}

// discard only an explicitly cancelled, submitted or ended terminal draft
export function clearTerminalCommand(key: string): void {
  drafts.delete(key);
  publish(key);
}

// release drafts only after a successful listing proves their pane is gone
export function pruneTerminalCommands(placeId: string, keep: (paneId: string) => boolean): void {
  // keys are generated only by terminalCommandKey in this module
  for (const key of drafts.keys()) {
    const [place, pane] = JSON.parse(key) as [string, string];
    // another workspace or a newly requested pane retains its draft
    if (place === placeId && !keep(pane)) clearTerminalCommand(key);
  }
}

// fail closed when a new server boot may reuse old terminal identities
export function resetTerminalCommands(): void {
  // notify mounted editors as their obsolete drafts are removed
  for (const key of drafts.keys()) clearTerminalCommand(key);
}

// subscribe without retaining unmounted terminal components
function subscribe(key: string, listener: () => void) {
  const current = listeners.get(key) ?? new Set();
  current.add(listener);
  listeners.set(key, current);
  // minimizing a terminal retains its draft but releases its listener
  return () => {
    current.delete(listener);
    // release an unused listener group
    if (current.size === 0) listeners.delete(key);
  };
}

// stage even multiline commands without sending any bytes to the shell
export function TerminalCommandDraft({ draftKey, onSubmit, onCancel }: { draftKey: string; onSubmit: (text: string) => boolean; onCancel: () => void }) {
  const draft = useSyncExternalStore(listener => subscribe(draftKey, listener), () => drafts.get(draftKey), () => undefined);
  const input = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string>();
  // focus new insertions without moving the caret while the user edits
  useLayoutEffect(() => {
    const field = input.current;
    // a hidden or cancelled draft has no input to focus
    if (field === null) return;
    setError(undefined);
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, [draftKey, draft?.focus]);
  // ordinary terminals do not show an extra composer
  if (draft === undefined) return null;
  const allowed = terminalCommandFits(draft.text);
  return <form className="terminal-command-draft" aria-label="Edit terminal command" onKeyDown={event => event.stopPropagation()} onSubmit={event => {
    event.preventDefault();
    // explicit submission is the only path from this editor into the pty
    if (!draft.text.trim()) return;
    // keep the transport bounded even if an invalid snapshot reaches this renderer
    if (!allowed) { setError(terminalCommandLimitMessage); return; }
    // keep the text editable if the terminal cannot accept input yet
    if (!onSubmit(draft.text)) { setError('Terminal unavailable. Your command has not been submitted.'); return; }
    clearTerminalCommand(draftKey);
    onCancel();
  }}>
    <label>Terminal command<textarea ref={input} aria-label="Terminal command" value={draft.text} spellCheck={false} onPaste={event => {
      const field = event.currentTarget;
      const text = event.clipboardData.getData('text/plain');
      const prefix = draft.text.slice(0, field.selectionStart);
      const suffix = draft.text.slice(field.selectionEnd);
      // reject the whole oversized paste instead of relying on silent maxlength truncation
      if (prefix.length + text.length + suffix.length > terminalCommandByteLimit || !terminalCommandFits(`${prefix}${text}${suffix}`)) { event.preventDefault(); setError(terminalCommandLimitMessage); }
    }} onChange={event => {
      const text = event.target.value;
      // retain the prior draft after an oversized edit or a non-clipboard insertion
      if (!terminalCommandFits(text)) { setError(terminalCommandLimitMessage); return; }
      // typing never sends terminal input or changes the focus generation
      drafts.set(draftKey, { ...draft, text });
      setError(undefined);
      publish(draftKey);
    }} /></label>
    {error !== undefined && <p role="alert">{error}</p>}
    <div className="terminal-command-actions"><button type="button" onClick={() => {
      // cancellation leaves the running shell untouched
      clearTerminalCommand(draftKey);
      onCancel();
    }}>Cancel command edit</button><button type="submit" disabled={!draft.text.trim() || !allowed}>Submit command</button></div>
  </form>;
}
