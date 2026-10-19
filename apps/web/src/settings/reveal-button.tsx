import { PanelIcon, panelIcons } from '../panel-header.js';
import './reveal-button.css';

// keep disclosure explicit while allowing masking even after write authority changes
export function SettingsRevealButton({ label, revealed, disabled, onToggle }: { label: string; revealed: boolean; disabled: boolean; onToggle: () => void | Promise<void> }) {
  const name = `${revealed ? 'Mask' : 'Reveal'} ${label}`;
  return <button type="button" className="settings-reveal-button" aria-label={name} title={name} aria-pressed={revealed} disabled={disabled && !revealed} onPointerDown={event => { /* retain the editing caret while toggling visibility */ event.preventDefault(); }} onClick={() => { /* delegate disclosure authority to the settings owner */ void onToggle(); }}><PanelIcon path={revealed ? panelIcons.eye : panelIcons.eyeClosed} /></button>;
}
