import { useId, useState } from 'react';
import { SplitConfirmation } from '../split-confirmation.js';
import type { SettingsChange, SettingsSource } from './contracts.js';

export type SettingsHandoverChoices = Record<string, NonNullable<SettingsChange['migration']>['mode']>;

const handoverModes = [
  { mode: 'copy', label: 'Copy current', description: 'Copy the currently effective source into a new empty target.' },
  { mode: 'adopt', label: 'Adopt existing', description: 'Keep and validate bytes already present at the target.' },
  { mode: 'empty', label: 'Initialize empty', description: 'Create an empty optional source only where the server allows it.' }
] as const;

// collect explicit source ownership choices for one captured save only
export function SettingsSourceHandover({ target, sources, onConfirm, onCancel }: { target: HTMLElement; sources: Pick<SettingsSource, 'id' | 'label'>[]; onConfirm: (choices: SettingsHandoverChoices) => void; onCancel: () => void }) {
  const id = useId();
  const [choices, setChoices] = useState<SettingsHandoverChoices>({});
  // never submit an unanswered source group
  const complete = sources.every(source => Object.hasOwn(choices, source.id));
  return <SplitConfirmation target={target} title="Choose source handover" description="These changes move configuration or credential sources. How should the new locations be prepared? Nothing is saved until you choose; the server validates each choice before saving." confirmLabel="Continue and save" confirmDisabled={!complete} tone="normal" onCancel={onCancel} onConfirm={() => { /* resume only with every explicit choice */ onConfirm({ ...choices }); }}>
    <div className="settings-handover-fields">
      {/* keep independent choices for every required source */}
      {sources.map(source => <fieldset key={source.id} className="settings-handover-options"><legend>{source.label}</legend>{handoverModes.map(option => <label key={option.mode}><input type="radio" name={`${id}-${source.id}`} value={option.mode} aria-label={option.label} aria-describedby={`${id}-${source.id}-${option.mode}-description`} checked={choices[source.id] === option.mode} onChange={() => { /* retain consent only inside this prompt */ setChoices(current => ({ ...current, [source.id]: option.mode })); }} /><span><strong>{option.label}</strong><small id={`${id}-${source.id}-${option.mode}-description`}>{option.description}</small></span></label>)}</fieldset>)}
    </div>
  </SplitConfirmation>;
}
