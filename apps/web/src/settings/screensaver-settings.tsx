import { useRef } from 'react';
import type { SettingsDraft } from './draft-changes.js';
import type { SettingsIssue, SettingsPatch, SettingsSource } from './contracts.js';

type ScreensaverSettingsProps = {
  source: SettingsSource;
  draft?: SettingsDraft;
  issues: SettingsIssue[];
  disabled: boolean;
  onPatch: (source: SettingsSource, patch: SettingsPatch) => void;
};

// read one own nested value without following inherited properties
const valueAt = (value: unknown, path: string[]): unknown => {
  let current = value;
  // stop before traversing an absent or scalar branch
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

// project the newest exact field edit over the saved application value
const stagedValue = (source: SettingsSource, draft: SettingsDraft | undefined, path: string[], fallback: unknown): unknown => {
  // search backward so the most recent edit wins
  for (let index = (draft?.patches.length ?? 0) - 1; index >= 0; index -= 1) {
    const patch = draft!.patches[index]!;
    // ignore patches belonging to another setting
    if (patch.path.length !== path.length || !path.every((segment, part) => patch.path[part] === segment)) continue;
    // an exact removal restores the schema default
    return patch.op === 'set' ? patch.value : patch.op === 'remove' ? fallback : valueAt(source.value, path) ?? fallback;
  }
  return valueAt(source.value, path) ?? fallback;
};

// render validation problems for one composite setting path
const SettingIssues = ({ issues, sourceId, path }: { issues: SettingsIssue[]; sourceId: string; path: string[] }) => {
  const matches = issues.filter(issue => issue.sourceId === sourceId && issue.path.length === path.length && issue.path.every((segment, index) => segment === path[index]));
  // omit empty validation space
  if (matches.length === 0) return null;
  return <>{matches.map(issue => <span key={`${issue.code}:${issue.message}`} className="settings-field-error" role="alert">{issue.message}</span>)}</>;
};

// edit the server-wide feature gate and zero-disabled idle threshold together
export function ScreensaverSettings({ source, draft, issues, disabled, onPatch }: ScreensaverSettingsProps) {
  const enabled = stagedValue(source, draft, ['screensaver', 'enabled'], false) === true;
  const stagedMinutes = stagedValue(source, draft, ['screensaver', 'idleMinutes'], 0);
  const idleMinutes = typeof stagedMinutes === 'number' && Number.isInteger(stagedMinutes) && stagedMinutes > 0 ? stagedMinutes : 0;
  const rememberedMinutes = useRef(idleMinutes > 0 ? idleMinutes : 5);
  // retain the latest valid positive value while automatic start is enabled
  if (idleMinutes > 0) rememberedMinutes.current = idleMinutes;
  const automatic = idleMinutes > 0;
  const shownMinutes = automatic ? idleMinutes : rememberedMinutes.current;
  const stage = (path: string[], value: unknown) => onPatch(source, { op: 'set', path, value });
  return <section className="settings-schema-section settings-screensaver" data-settings-path="screensaver" data-settings-search-path='["screensaver"]' aria-label="Screensaver">
    <header><div><h3>Screensaver</h3><p>Show a passive overview of every open workspace and its agents.</p></div><label className="client-settings-toggle" data-settings-path="screensaver.enabled"><input aria-label="Enable screensaver" role="switch" type="checkbox" checked={enabled} disabled={disabled} onChange={event => { /* stage the server-wide feature gate */ stage(['screensaver', 'enabled'], event.currentTarget.checked); }} /><span className="client-settings-switch-state">{enabled ? 'On' : 'Off'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label></header>
    <div className="settings-screensaver-auto" data-settings-path="screensaver.idleMinutes" role="group" aria-label="Automatic screensaver">
      <label className="settings-screensaver-auto-toggle"><input aria-label="Start screensaver automatically" type="checkbox" checked={automatic} disabled={disabled || !enabled} onChange={event => { /* map automatic start directly to the numeric threshold */ stage(['screensaver', 'idleMinutes'], event.currentTarget.checked ? rememberedMinutes.current : 0); }} /><span><strong>Start automatically</strong><small>Start after this browser has no keyboard, pointer, or touch activity.</small></span></label>
      <label className="settings-screensaver-minutes">Idle minutes<input aria-label="Screensaver idle minutes" type="number" min={1} step={1} inputMode="numeric" value={shownMinutes} disabled={disabled || !enabled || !automatic} onChange={event => { /* stage only complete positive minute values */ const minutes = event.currentTarget.valueAsNumber; if (Number.isInteger(minutes) && minutes > 0) { rememberedMinutes.current = minutes; stage(['screensaver', 'idleMinutes'], minutes); } }} /></label>
    </div>
    <SettingIssues issues={issues} sourceId={source.id} path={['screensaver']} />
    <SettingIssues issues={issues} sourceId={source.id} path={['screensaver', 'enabled']} />
    <SettingIssues issues={issues} sourceId={source.id} path={['screensaver', 'idleMinutes']} />
  </section>;
}
