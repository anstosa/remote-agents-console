import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsSelect, type SettingsSelectOption } from '../src/settings/select.js';

const choiceIcon = (path: string) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;

const twoWayOptions: SettingsSelectOption[] = [
  { value: 'left', label: 'Key tables', group: 'First group', icon: choiceIcon('M5 12h14M5 12l5-5m-5 5 5 5'), hasIssues: true },
  { value: 'right', label: 'Command shortcuts', group: 'Second group', icon: choiceIcon('M5 12h14m0 0-5-5m5 5-5 5') }
];

const threeWayOptions: SettingsSelectOption[] = [
  { value: 'alpha', label: 'Alpha', icon: choiceIcon('M5 19 12 5l7 14') },
  { value: 'beta', label: 'Beta', icon: choiceIcon('M6 4h7a5 5 0 0 1 0 10H6zm0 10h8a3 3 0 0 1 0 6H6') },
  { value: 'gamma', label: 'Gamma', disabled: true, icon: choiceIcon('M19 7a7 7 0 1 0 0 10') }
];

// mount focused selector states without application settings dependencies
function SettingsSelectControlFixture() {
  const [twoWay, setTwoWay] = useState('left');
  const [unknown, setUnknown] = useState('legacy');
  const [threeWay, setThreeWay] = useState('beta');
  const [changes, setChanges] = useState<string[]>([]);

  // record only explicit selector callbacks
  const change = (name: string, value: string, apply: (next: string) => void) => {
    apply(value);
    setChanges(current => [...current, `${name}:${value}`]);
  };

  return <main style={{ width: '230px' }}>
    <label>Two way<SettingsSelect label="Two-way mode" value={twoWay} options={twoWayOptions} onChange={value => { /* record an explicit two-way choice */ change('two-way', value, setTwoWay); }} /></label>
    <output aria-label="Two-way value">{twoWay}</output>
    <label>Unknown<SettingsSelect label="Unknown mode" value={unknown} options={[twoWayOptions[0]!, { ...twoWayOptions[1]!, disabled: true }]} onChange={value => { /* record recovery from an unknown value */ change('unknown', value, setUnknown); }} /></label>
    <output aria-label="Unknown value">{unknown}</output>
    <label>Blocked<SettingsSelect label="Blocked destination" value="left" options={[twoWayOptions[0]!, { ...twoWayOptions[1]!, disabled: true }]} onChange={value => { /* expose an unexpected blocked callback */ change('blocked', value, () => { /* keep the fixed fixture value */ }); }} /></label>
    <label>Locked<SettingsSelect label="Locked mode" value="left" options={twoWayOptions} disabled onChange={value => { /* expose an unexpected locked callback */ change('locked', value, () => { /* keep the fixed fixture value */ }); }} /></label>
    <label>Three way<SettingsSelect label="Three-way mode" value={threeWay} options={threeWayOptions} onChange={value => { /* record an explicit dropdown choice */ change('three-way', value, setThreeWay); }} /></label>
    <output aria-label="Three-way value">{threeWay}</output>
    <output aria-label="Change log">{changes.join(',')}</output>
  </main>;
}

// replace the inert application with the focused control fixture
export function renderSettingsSelectControlFixture(root: HTMLElement) {
  createRoot(root).render(<SettingsSelectControlFixture />);
}
