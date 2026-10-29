import { createContext, type CSSProperties, type ReactNode, useContext } from 'react';
import { ConfiguredButtonIcon } from '../configured-buttons.js';
import type { SettingsSchema, SettingsSource } from './contracts.js';

const ButtonStyleContext = createContext<'outline' | 'solid'>('outline');

// identify application and project button entries without matching unrelated icons
export function isConfiguredButtonPath(path: readonly string[]): boolean {
  const parts = path[0] === 'projects' && /^\d+$/u.test(path[1] ?? '') ? path.slice(2) : path;
  const slot = parts[1];
  return parts[0] === 'buttons' && /^\d+$/u.test(parts.at(-1) ?? '') && (
    parts.length === 3 && ['tabLead', 'leftNav', 'rightNav', 'navMenu', 'pullRequest'].includes(slot ?? '')
    || parts.length === 4 && slot === 'splits' && ['agent', 'terminal', 'note', 'browser', 'files', 'code', 'review', 'stack', 'settings'].includes(parts[2] ?? '')
  );
}

// resolve application buttons not already replaced in this project slot
export function inheritedProjectButtons(source: SettingsSource, path: readonly string[], projectButtons: readonly unknown[]): Array<Record<string, unknown> & { text: string }> {
  // restrict inheritance to direct and panel button lists inside projects
  if (source.id !== 'app' || path[0] !== 'projects' || !isConfiguredButtonPath([...path, '0'])) return [];
  let value = source.value;
  let schema = source.schema;
  // follow authored application values and schema defaults without staging them
  for (const part of path.slice(2)) {
    value = value === undefined ? schema?.default : value;
    value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    schema = schema?.properties?.[part];
  }
  value = value === undefined ? schema?.default : value;
  // leave invalid application lists to their own validation controls
  if (!Array.isArray(value)) return [];
  const replaced = new Set(projectButtons.map(button => button !== null && typeof button === 'object' && 'text' in button && typeof button.text === 'string' ? button.text.trim() : undefined));
  // compare the normalized text identity used by runtime project merging
  return value.filter((button): button is Record<string, unknown> & { text: string } => button !== null && typeof button === 'object' && typeof button.text === 'string' && button.text.trim() !== '' && !replaced.has(button.text.trim()));
}

// keep staged style available to editor swatches without a second preview
export function SettingsButtonFields({ value, children }: { value: Record<string, unknown>; children: ReactNode }) {
  return <ButtonStyleContext.Provider value={value.style === 'solid' ? 'solid' : 'outline'}>{children}</ButtonStyleContext.Provider>;
}

// replace collection summaries with live appearance without executing the action
export function SettingsButtonPreview({ value, schema }: { value: unknown; schema: SettingsSchema }) {
  const button = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const style = button.style === 'solid' ? 'solid' : 'outline';
  const color = typeof button.color === 'string' && schema.properties?.color?.options?.includes(button.color) ? button.color : 'mauve';
  const text = typeof button.text === 'string' && button.text !== '' ? button.text : 'Button text';
  return <span className="settings-button-preview" role="group" aria-label="Button preview">
    <button type="button" disabled className={`configured-button configured-button-${style} configured-button-${color}`} style={{ '--configured-button-color': `var(--${color})` } as CSSProperties}>
      {typeof button.icon === 'string' && <ConfiguredButtonIcon path={button.icon} />}
      <span className="configured-button-label">{text}</span>
    </button>
  </span>;
}

// show the current button style in both selected and available palette swatches
export function SettingsButtonColorSwatch({ color }: { color: string }) {
  const style = useContext(ButtonStyleContext);
  return <span className="settings-button-color-swatch" style={{ borderColor: `var(--${color})`, backgroundColor: style === 'solid' ? `var(--${color})` : 'transparent' }} />;
}
