import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PanelIcon, panelIcons } from './panel-header.js';
import { sinceReviewHeadText, sinceReviewDivergedText, type ReviewLaunch, type ReviewTarget } from './review-tour.js';
import { initialEffort, initialPreset, maxCodeReviewFocus, saveCodeReviewChoice, type CodeReviewCapability, type CodeReviewOptions } from './code-review.js';
import { WriteButton } from './github-panel.js';

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
      <footer><button type="button" disabled={pending} onClick={onCancel}>Cancel</button><button type="submit" className={pending ? 'progress-border progress-blue' : undefined} aria-busy={pending || undefined} disabled={pending || submitDisabled}>{pending && <span className="update-progress-ring" aria-hidden="true" />}{submitLabel}</button></footer>
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

// The start sheet's Include and AI review checkboxes as last started on this device; Cancel saves nothing.
type StartChecks = { tests: boolean; docs: boolean; codeReview: boolean };
const startChecksKey = 'rac.review-start-checks';
const readStartChecks = (): StartChecks => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(startChecksKey) ?? 'null');
    const flag = (name: keyof StartChecks) => typeof stored === 'object' && stored !== null && (stored as Record<string, unknown>)[name] === true;
    return { tests: flag('tests'), docs: flag('docs'), codeReview: flag('codeReview') };
  } catch { return { tests: false, docs: false, codeReview: false }; }
};
const saveStartChecks = (checks: StartChecks): void => {
  try { localStorage.setItem(startChecksKey, JSON.stringify(checks)); }
  catch { /* storage unavailable: the boxes open unchecked next time */ }
};

// the Worktree branch's saved All PR base and the origin branches it may name; `branch` is absent
// when HEAD is detached
type MergeBaseChoices = { branch?: string; configured?: string; branches: string[] };
// Since my review as the server last read it: the commit of my latest submitted review, the pull
// request's base branch and HEAD, or HEAD is behind the pull request's head, or cannot be moved there
// for the operator; absent while loading or when there is nothing to offer
type SinceReview = { reviewedCommit: string; baseBranch: string; head: string } | 'head_behind' | 'diverged';

// whether the Worktree can start a Since my review tour, read fresh from GitHub on open and again
// after Update to PR head; `update` resolves to the server's refusal, or undefined once updated
function useSinceReview(request: (url: string, init?: RequestInit) => Promise<Response>, worktreeId: string, enabled: boolean): { sinceReview?: SinceReview; update: () => Promise<string | undefined> } {
  const [sinceReview, setSinceReview] = useState<SinceReview>();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void request(`/api/worktrees/${encodeURIComponent(worktreeId)}/review-tour/since-review`).then(async response => {
      const payload = await response.json().catch(() => undefined) as { reviewedCommit?: unknown; baseBranch?: unknown; head?: unknown; error?: { code?: unknown } } | undefined;
      if (!live) return;
      if (response.ok && typeof payload?.reviewedCommit === 'string' && typeof payload.baseBranch === 'string' && typeof payload.head === 'string') setSinceReview({ reviewedCommit: payload.reviewedCommit, baseBranch: payload.baseBranch, head: payload.head });
      else setSinceReview(payload?.error?.code === 'head_behind_pull_request' ? 'head_behind' : payload?.error?.code === 'head_diverged_from_pull_request' ? 'diverged' : undefined);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [request, worktreeId, enabled, reads]);
  const update = async (): Promise<string | undefined> => {
    try {
      const response = await request(`/api/worktrees/${encodeURIComponent(worktreeId)}/update-pr-head`, { method: 'POST' });
      if (!response.ok) return (await response.json().catch(() => undefined) as { error?: string } | undefined)?.error ?? 'The Worktree could not be updated.';
    } catch { return 'The console could not be reached.'; }
    setReads(count => count + 1);
    return undefined;
  };
  return { sinceReview, update };
}

// Start a guided review: the Comparison (scope, base, Tests, Docs) and the tour's effort. Opened from
// the Review button when the Worktree has no tour, from an open tour's New review…, or from a commit in
// the flyout's commit list, which fixes the scope to that commit; `prBase` is the flyout's PR base. The All PR base
// can be picked from origin's branches; Start saves a changed pick as the branch's `gh-merge-base`,
// which outranks a pull request's base, before launching. Cancel saves nothing.
// Tests, Docs and the AI Code review open as last started; `codeReview` absent hides the review.
// `confirmation` is asked before Start does anything, when starting would discard work.
export function ReviewStartSheet({ target, prBase, request, tour, codeReview, confirmation, onStart, onCancel }: { target: ReviewTarget; prBase?: string; request: (url: string, init?: RequestInit) => Promise<Response>; tour?: ReviewTourCapability; codeReview?: CodeReviewCapability; confirmation?: string; onStart: (launch: ReviewLaunch) => void; onCancel: () => void }) {
  // a commit target fixes its scope; this is the operator's pick otherwise
  const [scope, setScope] = useState<'working' | 'pr' | 'since-review'>(target.scope === 'pr' && prBase !== undefined ? 'pr' : 'working');
  // a just-launched Agent's PR base can arrive after the sheet opens; take the asked-for All PR then
  const awaitingPrBase = useRef(target.scope === 'pr' && prBase === undefined);
  useEffect(() => {
    if (!awaitingPrBase.current || prBase === undefined) return;
    awaitingPrBase.current = false;
    setScope(current => current === 'working' ? 'pr' : current);
  }, [prBase]);
  const [remembered] = useState(readStartChecks);
  const { sinceReview, update } = useSinceReview(request, target.worktreeId, target.scope !== 'commit');
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string>();
  const updateToHead = async () => {
    setUpdating(true);
    setUpdateError(await update());
    setUpdating(false);
  };
  // offered once I have a submitted review on a commit other than HEAD
  const reviewed = typeof sinceReview === 'object' && sinceReview.reviewedCommit !== sinceReview.head ? sinceReview : undefined;
  const [includeTests, setIncludeTests] = useState(remembered.tests);
  const [includeDocs, setIncludeDocs] = useState(remembered.docs);
  const tourEfforts = effortList(tour?.efforts);
  const [tourEffort, setTourEffort] = useState('');
  const choice = useCodeReviewChoice(codeReview);
  // a remembered review opens checked only while one of its presets can run
  const [reviewEnabled, setReviewEnabled] = useState(remembered.codeReview && choice.preset !== undefined);
  // a scope the operator picks outranks the late switch to All PR; Since my review checks the AI
  // review, which judges the earlier comments, and leaving it restores the remembered box
  const chooseScope = (next: 'working' | 'pr' | 'since-review') => {
    awaitingPrBase.current = false;
    if ((next === 'since-review') !== (scope === 'since-review')) setReviewEnabled((next === 'since-review' || remembered.codeReview) && choice.preset !== undefined);
    setScope(next);
  };
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
    if (confirmation !== undefined && !window.confirm(confirmation)) return;
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
    // a hidden review box, or one Since my review checked, keeps its remembered state
    saveStartChecks({ tests: includeTests, docs: includeDocs, codeReview: codeReview === undefined || scope === 'since-review' ? remembered.codeReview : reviewEnabled });
    onStart({ worktreeId: target.worktreeId, ...(target.scope === 'commit' ? { scope: 'commit', commit: target.commit } : scope === 'since-review' ? { scope, reviewedCommit: reviewed!.reviewedCommit, baseBranch: reviewed!.baseBranch } : { scope }), includeTests, includeDocs, ...(tourEffort === '' ? {} : { effort: tourEffort }), ...(reviewOptions === undefined ? {} : { codeReview: reviewOptions }) });
  };
  return <StartSheetFrame title="Start guided review" eyebrow="Guided review" submitLabel="Start" submitDisabled={(reviewEnabled && reviewOptions === undefined) || (scope === 'pr' && !prReady) || (scope === 'since-review' && reviewed === undefined)} pending={saving} {...(saveError === undefined ? {} : { error: saveError })} onSubmit={() => void start()} onCancel={onCancel}>
    {target.scope === 'commit' ? <div className="review-start-row"><span>Commit</span><span className="review-start-commit" title={target.commit}><code>{target.commit.slice(0, 7)}</code>{target.commitSubject}</span></div> : <div className="review-start-row"><span id="review-start-scope">Scope</span><span className="git-status-mode" role="group" aria-labelledby="review-start-scope"><button type="button" aria-pressed={scope === 'working'} onClick={() => chooseScope('working')}>Working</button><button type="button" aria-pressed={scope === 'pr'} disabled={prBase === undefined && !pickable} title={prBase === undefined ? pickable ? 'Pick a base to compare with' : 'Merge target unavailable' : `Compare with ${prBase}`} onClick={() => chooseScope('pr')}>All PR</button>{(reviewed !== undefined || sinceReview === 'head_behind' || sinceReview === 'diverged') && <button type="button" aria-pressed={scope === 'since-review'} disabled={reviewed === undefined} title={reviewed === undefined ? undefined : `What changed since your review of ${reviewed.reviewedCommit.slice(0, 7)}`} onClick={() => chooseScope('since-review')}>Since my review{reviewed === undefined ? '' : ` (${reviewed.reviewedCommit.slice(0, 7)})`}</button>}</span></div>}
    {target.scope !== 'commit' && sinceReview === 'head_behind' && <div className="review-start-update"><p className="review-start-base-note">{sinceReviewHeadText}</p><WriteButton busy={updating} disabled={updating} onClick={() => void updateToHead()}>Update to PR head</WriteButton>{updateError !== undefined && <p className="review-start-error" role="alert">{updateError}</p>}</div>}
    {target.scope !== 'commit' && sinceReview === 'diverged' && <p className="review-start-base-note">{sinceReviewDivergedText}</p>}
    {scope === 'pr' && <div className={`review-start-base${choices === undefined ? ' progress-border progress-blue progress-loading' : ''}`} aria-busy={choices === undefined || undefined}>{choices === undefined && <span className="update-progress-ring" aria-hidden="true" />}<label htmlFor="review-start-base">Compare with</label>{pickable
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
