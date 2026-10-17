import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PanelIcon, panelIcons } from './panel-header.js';
import type { ReviewLaunch, ReviewScope, ReviewTarget } from './review-tour.js';
import { initialEffort, initialPreset, maxCodeReviewFocus, saveCodeReviewChoice, type CodeReviewCapability, type CodeReviewOptions } from './code-review.js';

// The dashboard's `reviewTour`: whether the tour's agent can run, which agent narrates, and the
// efforts it accepts. An older server sends only `available` (and `reason`), so the rest is optional.
export type ReviewAgentKind = 'codex' | 'claude';
export type ReviewTourCapability = ({ available: true } | { available: false; reason: 'generator_unavailable'|'unsupported_cli'|'configuration_invalid'|'authentication_required'|'interactive_unavailable' }) & { agent?: ReviewAgentKind; effort?: string; efforts?: string[] };

// the user-facing name of a Review run's agent
export const reviewAgentLabel = (agent: ReviewAgentKind | undefined): string => agent === 'claude' ? 'Claude' : 'Codex';

// the efforts an agent accepts, keeping only strings from a possibly older or malformed payload
const effortList = (efforts: unknown): string[] => Array.isArray(efforts) ? efforts.filter((effort): effort is string => typeof effort === 'string') : [];

// Why a Review run's agent cannot run, from the capability's reason code.
export function reviewRunUnavailableText(reason: string | undefined, agent: ReviewAgentKind | undefined): string {
  const name = reviewAgentLabel(agent);
  if (reason === 'authentication_required') return `Sign in to ${name} on the server`;
  if (reason === 'interactive_unavailable') return 'Interactive review runs are not available yet';
  if (reason === 'unsupported_cli') return `The server's ${name} CLI is too old`;
  if (reason === 'configuration_invalid') return `The server's ${name} program path is invalid`;
  if (reason === 'generator_unavailable') return `${name} is not installed on the server`;
  return `${name} is unavailable on this server`;
}

// Why guided review cannot start, naming the agent that narrates the tour.
export function reviewTourUnavailableText(capability: ReviewTourCapability | undefined): string | undefined {
  if (capability?.available === true) return undefined;
  if (capability === undefined) return 'Guided review unavailable on this server';
  if (capability.reason === 'authentication_required') return `Authenticate ${reviewAgentLabel(capability.agent)} to use guided review`;
  if (capability.reason === 'interactive_unavailable') return 'Interactive review runs are not available yet';
  return `Guided review unavailable: ${reviewRunUnavailableText(capability.reason, capability.agent)}`;
}

// An effort picker: "Default (…)" sends no effort, so the configured or agent default applies.
function EffortSelect({ label, value, efforts, fallback, onChange }: { label: string; value: string; efforts: string[]; fallback?: string; onChange: (value: string) => void }) {
  return <label>{label}<select value={value} onChange={event => onChange(event.target.value)}><option value="">Default ({fallback ?? 'agent default'})</option>{efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>;
}

// The sheet's frame: a centered dialog on desktop, a bottom sheet on a phone. Focus moves to the
// first control, Tab stays inside, and Escape cancels. Keys stop here so a sheet opened over the
// guided review does not reach the review's own focus trap and Escape handling.
function StartSheetFrame({ title, eyebrow, submitLabel, submitDisabled, pending, error, onSubmit, onCancel, children }: { title: string; eyebrow: string; submitLabel: string; submitDisabled?: boolean; pending?: boolean; error?: string; onSubmit: () => void; onCancel: () => void; children: ReactNode }) {
  const sheet = useRef<HTMLDivElement | null>(null);
  // focus the first control once on open
  useEffect(() => { sheet.current?.querySelector<HTMLElement>('form button:not(:disabled), form input:not(:disabled), form select:not(:disabled), form textarea:not(:disabled)')?.focus(); }, []);
  // dismiss on Escape and keep Tab inside the sheet
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!pending) onCancel(); return; }
    if (event.key !== 'Tab' || sheet.current === null) return;
    const controls = Array.from(sheet.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')).filter(control => control.offsetParent !== null);
    if (controls.length === 0) return;
    const index = controls.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? index <= 0 ? controls.length - 1 : index - 1 : index < 0 || index === controls.length - 1 ? 0 : index + 1;
    event.preventDefault();
    controls[next]!.focus();
  };
  return createPortal(<div className="dialog client-rename-dialog review-start-dialog" role="dialog" aria-modal="true" aria-labelledby="review-start-title" onKeyDown={keyDown}><div ref={sheet}>
    <header><div><small>{eyebrow}</small><h2 id="review-start-title">{title}</h2></div><button type="button" aria-label={`Close ${title.toLowerCase()}`} disabled={pending} onClick={onCancel}><PanelIcon path={panelIcons.close} /></button></header>
    <form onSubmit={event => { event.preventDefault(); if (!pending && !submitDisabled) onSubmit(); }}>
      {children}
      {error && <p className="review-start-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={pending} onClick={onCancel}>Cancel</button><button type="submit" disabled={pending || submitDisabled}>{pending && <span className="spinner" aria-hidden="true" />}{submitLabel}</button></footer>
    </form>
  </div></div>, document.body);
}

// The Code review choice a sheet edits: preset, effort and extra focus, opening on this device's
// last preset and effort. `options` is what a start sends; `remember` keeps it for next time.
function useCodeReviewChoice(capability: CodeReviewCapability | undefined) {
  const [presetId, setPresetId] = useState(() => capability === undefined ? '' : initialPreset(capability)?.id ?? '');
  const preset = capability?.presets.find(candidate => candidate.id === presetId && candidate.available);
  const [effort, setEffort] = useState(() => preset === undefined ? '' : initialEffort(preset));
  const [focus, setFocus] = useState('');
  // a newly chosen preset opens on its own last or configured effort
  const choosePreset = (id: string) => {
    const next = capability?.presets.find(candidate => candidate.id === id);
    setPresetId(id);
    setEffort(next === undefined ? '' : initialEffort(next));
  };
  const options: CodeReviewOptions | undefined = preset === undefined ? undefined : { preset: preset.id, ...(effort === '' ? {} : { effort }), ...(focus.trim() === '' ? {} : { focus: focus.trim() }) };
  // remember the preset and effort; the extra focus is for one run only
  const remember = () => { if (options !== undefined) saveCodeReviewChoice(options); };
  return { capability, preset, presetId, choosePreset, effort, setEffort, focus, setFocus, options, remember };
}
type CodeReviewChoiceState = ReturnType<typeof useCodeReviewChoice>;

// The Code review's preset, effort and extra focus. An unavailable preset is listed disabled with its reason.
function CodeReviewFields({ choice }: { choice: CodeReviewChoiceState }) {
  const { capability, preset } = choice;
  return <>
    <label>Preset<select value={choice.presetId} onChange={event => choice.choosePreset(event.target.value)}>{preset === undefined && <option value="" disabled>No preset available</option>}{capability?.presets.map(candidate => <option key={candidate.id} value={candidate.id} disabled={!candidate.available}>{candidate.available ? `${candidate.label} · ${reviewAgentLabel(candidate.agent)}` : `${candidate.label} (${reviewRunUnavailableText(candidate.reason, candidate.agent)})`}</option>)}</select></label>
    {preset !== undefined && <EffortSelect label="Review effort" value={choice.effort} efforts={preset.efforts} fallback={preset.effort} onChange={choice.setEffort} />}
    <label>Extra focus<textarea value={choice.focus} maxLength={maxCodeReviewFocus} placeholder="e.g. look hard at the migration" onChange={event => choice.setFocus(event.target.value)} />{choice.focus.length >= maxCodeReviewFocus && <span className="review-start-hint" role="status">{maxCodeReviewFocus.toLocaleString()} character limit reached</span>}</label>
  </>;
}

// the Worktree branch's saved All PR base and the origin branches it may name; `branch` is absent
// when HEAD is detached
type MergeBaseChoices = { branch?: string; configured?: string; branches: string[] };

// Start a guided review: the Comparison (scope, base, Tests, Docs) and the tour's effort. Opened from
// the Review button when the Worktree has no tour, or from a commit in the flyout's commit list, which
// fixes the scope to that commit; `prBase` is the flyout's PR base. The All PR base
// can be picked from origin's branches; Start saves a changed pick as the branch's `gh-merge-base`,
// which outranks a pull request's base, before launching. Cancel saves nothing.
// The opt-in AI Code review is unchecked on every open; `codeReview` absent hides it.
export function ReviewStartSheet({ target, prBase, request, tour, codeReview, onStart, onCancel }: { target: ReviewTarget; prBase?: string; request: (url: string, init?: RequestInit) => Promise<Response>; tour?: ReviewTourCapability; codeReview?: CodeReviewCapability; onStart: (launch: ReviewLaunch) => void; onCancel: () => void }) {
  const [scope, setScope] = useState<ReviewScope>(target.scope === 'commit' ? 'commit' : target.scope === 'pr' && prBase !== undefined ? 'pr' : 'working');
  const [includeTests, setIncludeTests] = useState(false);
  const [includeDocs, setIncludeDocs] = useState(false);
  const tourEfforts = effortList(tour?.efforts);
  const [tourEffort, setTourEffort] = useState('');
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const choice = useCodeReviewChoice(codeReview);
  const reviewOptions = reviewEnabled ? choice.options : undefined;
  const [choices, setChoices] = useState<MergeBaseChoices | { error: string }>();
  // the picked base: '' is the default ladder, a name is an origin branch
  const [base, setBase] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const mergeBaseUrl = `/api/worktrees/${encodeURIComponent(target.worktreeId)}/merge-base`;
  useEffect(() => {
    let live = true;
    void request(mergeBaseUrl).then(async response => {
      const payload = await response.json().catch(() => undefined) as (Partial<MergeBaseChoices> & { error?: string }) | undefined;
      if (!live) return;
      if (!response.ok || !Array.isArray(payload?.branches)) { setChoices({ error: payload?.error ?? 'Could not list the branches on origin.' }); return; }
      setChoices(payload as MergeBaseChoices);
      setBase(payload.configured ?? '');
    });
    return () => { live = false; };
  }, [request, mergeBaseUrl]);
  const loaded = choices === undefined || 'error' in choices ? undefined : choices;
  const branch = loaded?.branch;
  const pickReason = choices === undefined ? 'Loading origin branches…' : 'error' in choices ? choices.error : branch === undefined ? 'Detached HEAD: no branch to save a base for' : loaded!.branches.length === 0 ? 'origin has no branches' : undefined;
  const pickable = pickReason === undefined;
  const baseChanged = pickable && base !== (loaded?.configured ?? '');
  // keep a saved base listed even when origin no longer has it
  const baseOptions = loaded === undefined ? [] : loaded.configured !== undefined && !loaded.branches.includes(loaded.configured) ? [...loaded.branches, loaded.configured] : loaded.branches;
  const baseNote = !pickable ? pickReason
    : baseChanged && base !== '' ? <>Starting saves <code>origin/{base}</code> as the All PR base of <code>{branch}</code> everywhere in the console, and <code>gh pr create</code> will default to it (git config <code>branch.{branch}.gh-merge-base</code>).</>
    : baseChanged ? <>Starting clears the saved base of <code>{branch}</code>; All PR falls back to the pull request's base, the branch it was created from, or the default branch.</>
    : base !== '' ? <>Saved for <code>{branch}</code> (git config <code>branch.{branch}.gh-merge-base</code>).</>
    : undefined;
  // All PR needs a base: the resolved one, or a branch picked here
  const prReady = prBase !== undefined || (pickable && base !== '');
  // send only the choices that differ from the configured defaults
  const start = async () => {
    if (scope === 'pr' && baseChanged) {
      setSaving(true);
      setSaveError(undefined);
      const response = await request(mergeBaseUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch: base === '' ? null : base }) });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
        setSaveError(payload?.error ?? 'Could not save the base branch.');
        setSaving(false);
        return;
      }
    }
    if (reviewOptions !== undefined) choice.remember();
    onStart({ agentId: target.agentId, worktreeId: target.worktreeId, scope, ...(scope === 'commit' && target.commit !== undefined ? { commit: target.commit } : {}), includeTests, includeDocs, ...(tourEffort === '' ? {} : { effort: tourEffort }), ...(reviewOptions === undefined ? {} : { codeReview: reviewOptions }) });
  };
  return <StartSheetFrame title="Start guided review" eyebrow="Guided review" submitLabel="Start" submitDisabled={(reviewEnabled && reviewOptions === undefined) || (scope === 'pr' && !prReady)} pending={saving} {...(saveError === undefined ? {} : { error: saveError })} onSubmit={() => void start()} onCancel={onCancel}>
    {scope === 'commit' ? <div className="review-start-row"><span>Commit</span><span className="review-start-commit" title={target.commit}><code>{target.commit?.slice(0, 7)}</code>{target.commitSubject}</span></div> : <div className="review-start-row"><span id="review-start-scope">Scope</span><span className="git-status-mode" role="group" aria-labelledby="review-start-scope"><button type="button" aria-pressed={scope === 'working'} onClick={() => setScope('working')}>Working</button><button type="button" aria-pressed={scope === 'pr'} disabled={prBase === undefined && !pickable} title={prBase === undefined ? pickable ? 'Pick a base to compare with' : 'Merge target unavailable' : `Compare with ${prBase}`} onClick={() => setScope('pr')}>All PR</button></span></div>}
    {scope === 'pr' && <div className="review-start-base"><label htmlFor="review-start-base">Compare with</label>{pickable
      ? <select id="review-start-base" value={base} aria-describedby={baseNote === undefined ? undefined : 'review-start-base-note'} onChange={event => setBase(event.target.value)}><option value="">{loaded?.configured === undefined && prBase !== undefined ? `Default (${prBase})` : 'Default'}</option>{baseOptions.map(name => <option key={name} value={name}>origin/{name}</option>)}</select>
      : <select id="review-start-base" value="" disabled aria-describedby="review-start-base-note"><option value="">{prBase ?? 'No base'}</option></select>}{baseNote !== undefined && <p id="review-start-base-note" className="review-start-base-note">{baseNote}</p>}</div>}
    <div className="review-start-row" role="group" aria-labelledby="review-start-include"><span id="review-start-include">Include</span><span className="review-start-checks"><label><input type="checkbox" checked={includeTests} onChange={event => setIncludeTests(event.target.checked)} />Tests</label><label><input type="checkbox" checked={includeDocs} onChange={event => setIncludeDocs(event.target.checked)} />Docs</label></span></div>
    <section className="review-start-section" aria-labelledby="review-start-tour"><h3 id="review-start-tour">Tour</h3><p>Narrated by {reviewAgentLabel(tour?.agent)}</p><EffortSelect label="Tour effort" value={tourEffort} efforts={tourEfforts} fallback={tour?.effort} onChange={setTourEffort} /></section>
    {codeReview !== undefined && <section className="review-start-section" aria-label="AI code review"><label className="review-start-check"><input type="checkbox" checked={reviewEnabled} onChange={event => setReviewEnabled(event.target.checked)} />Add AI code review</label>{reviewEnabled && <CodeReviewFields choice={choice} />}</section>}
  </StartSheetFrame>;
}

// Add an AI Code review to a ready tour: the review-only part of the start sheet. `onStart` resolves
// to an error to show (the sheet stays open), or undefined once the review is running.
export function CodeReviewSheet({ codeReview, onStart, onCancel }: { codeReview: CodeReviewCapability; onStart: (options: CodeReviewOptions) => Promise<string | undefined>; onCancel: () => void }) {
  const choice = useCodeReviewChoice(codeReview);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // start once; a failure keeps the sheet open with its reason
  const start = async () => {
    if (choice.options === undefined) return;
    setPending(true);
    setError(undefined);
    choice.remember();
    const failure = await onStart(choice.options).catch(() => 'The AI review could not be started.');
    if (failure !== undefined) { setError(failure); setPending(false); }
  };
  return <StartSheetFrame title="Add AI review" eyebrow="Guided review" submitLabel="Start review" submitDisabled={choice.options === undefined} pending={pending} error={error} onSubmit={() => void start()} onCancel={onCancel}>
    <p>The review reads this tour’s changes and suggests Findings on its diffs.</p>
    <CodeReviewFields choice={choice} />
  </StartSheetFrame>;
}
