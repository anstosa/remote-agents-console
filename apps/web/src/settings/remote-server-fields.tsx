import { useId, type ReactNode } from 'react';
import type { SettingsPatch } from './contracts.js';
import './remote-server-fields.css';

// retain the published name separately from the configured navigation override
export type RemoteServerDefaults = { url: string; name: string; defaultName?: string };
// a remote's icon is set only on that server, so the deprecated icon override is not offered
type RemoteField = 'url' | 'name';

// match known peers without fetching arbitrary unsaved URLs
const parsedRemoteUrl = (value: unknown): URL | undefined => {
  // invalid and incomplete drafts have no inherited peer identity
  if (typeof value !== 'string') return undefined;
  try { return new URL(value); }
  catch { return undefined; }
};

// pair one inherited identity with the field that supplied it
const sourcedPlaceholder = (value: string, source: string): string => `${value} (from ${source})`;

// keep inherited identity controls present even when optional overrides are absent
export function RemoteServerFields({ value, path, defaults, disabled, onPatch, renderIssues, renderProtected }: { value: unknown; path: string[]; defaults: readonly RemoteServerDefaults[]; disabled: boolean; onPatch: (patch: SettingsPatch) => void; renderIssues: (path: string[]) => ReactNode; renderProtected: (key: RemoteField) => ReactNode }) {
  const id = useId();
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const url = parsedRemoteUrl(record.url);
  const peer = defaults.find(candidate => url !== undefined && parsedRemoteUrl(candidate.url)?.origin === url.origin);
  const peerName = [peer?.defaultName, peer?.name].find(candidate => candidate?.trim());
  const defaultName = peerName !== undefined
    ? sourcedPlaceholder(peerName, 'Remote server identity')
    : url === undefined ? 'Server name' : sourcedPlaceholder(url.hostname, 'URL hostname');
  const protectedUrl = renderProtected('url');
  const protectedName = renderProtected('name');
  // clearing an override restores inheritance without removing its visible control
  const stage = (key: RemoteField, next: string) => {
    // reject events preceding a read-only or busy render
    if (disabled) return;
    const fieldPath = [...path, key];
    // never persist an invalid blank name
    if (key === 'name' && !next.trim()) onPatch({ op: 'remove', path: fieldPath });
    else onPatch({ op: 'set', path: fieldPath, value: next });
  };
  return <div className="settings-remote-server-fields" data-settings-path={path.join('.')} data-settings-search-path={JSON.stringify(path)}>
    {protectedUrl ?? <div className="settings-field settings-remote-server-url" data-settings-path={[...path, 'url'].join('.')} data-settings-search-path={JSON.stringify([...path, 'url'])}><label htmlFor={`${id}-url`}><strong>URL</strong></label><input id={`${id}-url`} type="text" value={typeof record.url === 'string' ? record.url : ''} placeholder="Required; no default" disabled={disabled} autoCapitalize="off" spellCheck={false} onChange={event => { /* stage the canonical server address for shared validation */ stage('url', event.target.value); }} />{renderIssues([...path, 'url'])}</div>}
    <div className="settings-remote-server-identity">
      {protectedName ?? <div className="settings-field" data-settings-path={[...path, 'name'].join('.')} data-settings-search-path={JSON.stringify([...path, 'name'])}><label htmlFor={`${id}-name`}><strong>Name</strong></label><input id={`${id}-name`} type="text" value={typeof record.name === 'string' ? record.name : ''} placeholder={defaultName} maxLength={80} disabled={disabled} onChange={event => { /* retain only an explicitly authored local name */ stage('name', event.target.value); }} />{renderIssues([...path, 'name'])}</div>}
    </div>
    {renderIssues(path)}
  </div>;
}
