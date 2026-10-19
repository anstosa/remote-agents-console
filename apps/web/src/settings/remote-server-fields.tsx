import { useId, type ReactNode } from 'react';
import type { SettingsPatch } from './contracts.js';
import { InstanceIconPreview, instanceIcons, isInstanceIconName, type InstanceIconName } from './icon-preview.js';
import { SettingsSelect } from './select.js';
import './remote-server-fields.css';

// retain published defaults separately from configured navigation overrides
export type RemoteServerDefaults = { url: string; name: string; icon?: InstanceIconName; defaultName?: string; defaultIcon?: InstanceIconName };
type RemoteField = 'url' | 'name' | 'icon';

// match known peers without fetching arbitrary unsaved URLs
const parsedRemoteUrl = (value: unknown): URL | undefined => {
  // invalid and incomplete drafts have no inherited peer identity
  if (typeof value !== 'string') return undefined;
  try { return new URL(value); }
  catch { return undefined; }
};

// keep inherited identity controls present even when optional overrides are absent
export function RemoteServerFields({ value, path, defaults, disabled, onPatch, renderIssues, renderProtected }: { value: unknown; path: string[]; defaults: readonly RemoteServerDefaults[]; disabled: boolean; onPatch: (patch: SettingsPatch) => void; renderIssues: (path: string[]) => ReactNode; renderProtected: (key: RemoteField) => ReactNode }) {
  const id = useId();
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const url = parsedRemoteUrl(record.url);
  const peer = defaults.find(candidate => url !== undefined && parsedRemoteUrl(candidate.url)?.origin === url.origin);
  const defaultName = peer?.defaultName ?? peer?.name ?? url?.hostname ?? 'Server name';
  const inheritedIcon = peer?.defaultIcon ?? peer?.icon;
  const defaultIcon = isInstanceIconName(inheritedIcon) ? inheritedIcon : 'terminal';
  const icon = isInstanceIconName(record.icon) ? record.icon : 'server-default';
  const protectedUrl = renderProtected('url');
  const protectedName = renderProtected('name');
  const protectedIcon = renderProtected('icon');
  // clearing an override restores inheritance without removing its visible control
  const stage = (key: RemoteField, next: string) => {
    // reject events preceding a read-only or busy render
    if (disabled) return;
    const fieldPath = [...path, key];
    // never persist the default sentinel or an invalid blank name
    if (key === 'name' && !next.trim() || key === 'icon' && next === 'server-default') onPatch({ op: 'remove', path: fieldPath });
    else onPatch({ op: 'set', path: fieldPath, value: next });
  };
  return <div className="settings-remote-server-fields" data-settings-path={path.join('.')}>
    {protectedUrl ?? <div className="settings-field settings-remote-server-url" data-settings-path={[...path, 'url'].join('.')}><label htmlFor={`${id}-url`}><strong>URL</strong></label><input id={`${id}-url`} type="text" value={typeof record.url === 'string' ? record.url : ''} disabled={disabled} autoCapitalize="off" spellCheck={false} onChange={event => { /* stage the canonical server address for shared validation */ stage('url', event.target.value); }} />{renderIssues([...path, 'url'])}</div>}
    <div className="settings-remote-server-identity">
      {protectedName ?? <div className="settings-field" data-settings-path={[...path, 'name'].join('.')}><label htmlFor={`${id}-name`}><strong>Name</strong></label><input id={`${id}-name`} type="text" value={typeof record.name === 'string' ? record.name : ''} placeholder={defaultName} maxLength={80} disabled={disabled} onChange={event => { /* retain only an explicitly authored local name */ stage('name', event.target.value); }} /><small>Leave blank to use the other server’s name.</small>{renderIssues([...path, 'name'])}</div>}
      {protectedIcon ?? <div className="settings-field" data-settings-path={[...path, 'icon'].join('.')}><strong>Icon</strong><SettingsSelect label="Icon" value={icon} disabled={disabled} options={[{ value: 'server-default', label: 'Server Default', icon: <InstanceIconPreview name={defaultIcon} /> }, ...instanceIcons.map(name => ({ value: name, label: name[0]!.toUpperCase() + name.slice(1), icon: <InstanceIconPreview name={name} /> }))]} onChange={next => { /* explicit default selection removes only the local override */ stage('icon', next); }} /><small>Server Default uses the other server’s icon.</small>{renderIssues([...path, 'icon'])}</div>}
    </div>
    {renderIssues(path)}
  </div>;
}
