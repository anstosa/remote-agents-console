import { createContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PanelIcon, panelIcons } from './panel-header.js';
import { LaunchSplitButton, type LaunchChoice, type LaunchResolution } from './launch-profile.js';

// a folder the console opened before, newest first (GET /api/folders/recent)
export type RecentFolder = { path: string; openedAt: string; kind: 'git' | 'folder' };
// What a listed Place says about a folder: its label, and its Launch profile resolution when
// the dashboard already lists it. A folder it does not list launches with the server's resolution.
export type ListedFolder = { label: string; resolution?: LaunchResolution };
// how a folder opens: an Agent there, a Terminal there, or its Workspace with no panels
export type FolderAction = 'agent' | 'terminal' | 'empty';
// what POST /api/folders/open reports: the Place to switch to, and what it started there
export type FolderOpened = { placeId: string; agentId?: string; paneId?: string; needsOperator?: string };

// Open the Other locations modal, optionally with a folder path filled in. Provided by the
// dashboard, so the Files panel can offer Open as Workspace.
export const OpenFolderContext = createContext<((path?: string) => void) | undefined>(undefined);

const folderIcon = 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z';
const gitIcon = 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9';
export const terminalIconPath = 'M4 5h16v14H4V5Zm3 4 3 3-3 3m5 0h4';
export const FolderIcon = () => <svg className="launcher-icon-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={folderIcon} /></svg>;
export const EmptyWorkspaceIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" /></svg>;

// the last path segment, which names a folder the dashboard does not list
const baseName = (path: string): string => path.replace(/\/+$/u, '').split('/').at(-1) || path;

type Pending = { path: string; action: FolderAction };

// One folder's three ways to open: the launch split the + rows use (so its remembered kind and
// Sandboxed carry over), Terminal, and Empty workspace. Labels give way to tooltips when narrow.
function FolderActions({ path, label, resolution, pending, onOpen }: { path: string; label: string; resolution: LaunchResolution | undefined; pending: Pending | undefined; onOpen: (action: FolderAction, choice?: LaunchChoice) => void }) {
  const busy = (action: FolderAction) => pending?.path === path && pending.action === action;
  const action = (kind: 'terminal' | 'empty', text: string, icon: ReactNode) => <button type="button" className={`open-folder-action${busy(kind) ? ' progress-border progress-blue' : ''}`} aria-label={text} aria-busy={busy(kind) || undefined} title={`${text} at ${label}`} disabled={pending !== undefined} onClick={() => onOpen(kind)}>{busy(kind) && <span className="update-progress-ring" aria-hidden="true" />}{icon}<span className="open-folder-action-label">{text}</span></button>;
  return <span className="open-folder-actions" role="group" aria-label={`Open ${label}`}>
    <LaunchSplitButton label={label} resolution={resolution} compact placeActions alwaysShowMenu launchDisabled={pending !== undefined} pending={busy('agent')} onLaunch={choice => onOpen('agent', choice)} />
    {action('terminal', 'Terminal', <svg viewBox="0 0 24 24" aria-hidden="true"><path d={terminalIconPath} /></svg>)}
    {action('empty', 'Empty workspace', <EmptyWorkspaceIcon />)}
  </span>;
}

// The Other locations modal: a path field, then the recently opened folders.
export function OpenFolderDialog({ initialPath = '', request, placeFor, onClose, onOpened }: { initialPath?: string; request: (url: string, init?: RequestInit) => Promise<Response>; placeFor: (path: string) => ListedFolder | undefined; onClose: () => void; onOpened: (opened: FolderOpened, action: FolderAction, label: string) => void | Promise<void> }) {
  const [path, setPath] = useState(initialPath);
  const [recents, setRecents] = useState<RecentFolder[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void (async () => {
      const response = await request('/api/folders/recent');
      const payload = await response.json().catch(() => undefined) as { folders?: unknown } | undefined;
      if (!live) return;
      if (!response.ok || !Array.isArray(payload?.folders)) return setRecents([]);
      setRecents((payload.folders as Partial<RecentFolder>[]).filter((folder): folder is RecentFolder => typeof folder?.path === 'string'));
    })();
    return () => { live = false; };
  }, [request]);
  const [pending, setPending] = useState<Pending>();
  const label = (folder: string) => placeFor(folder)?.label ?? baseName(folder);
  // open one folder; a refusal (a bad path, a failed launch) shows under the field
  const open = async (folder: string, action: FolderAction, choice?: LaunchChoice) => {
    if (pending !== undefined || folder.trim() === '') return;
    setPending({ path: folder, action });
    setError(undefined);
    try {
      const response = await request('/api/folders/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder, action, ...choice }) });
      const payload = await response.json().catch(() => undefined) as Partial<FolderOpened> & { error?: unknown } | undefined;
      if (!response.ok || typeof payload?.placeId !== 'string') return setError(typeof payload?.error === 'string' ? payload.error : 'That folder could not be opened.');
      await onOpened(payload as FolderOpened, action, label(folder));
    } finally { setPending(undefined); }
  };
  // forget one recent folder; its Place and anything running there stay
  const forget = async (folder: string) => {
    const response = await request('/api/folders/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }) });
    if (!response.ok) return setError('That folder could not be forgotten.');
    setRecents(current => current?.filter(entry => entry.path !== folder));
  };
  const typed = path.trim();
  return createPortal(<div className="dialog open-folder-dialog" role="dialog" aria-modal="true" aria-labelledby="open-folder-title" onKeyDown={event => { /* the first Escape closes an open launch menu, not the modal */ if (event.key === 'Escape' && document.querySelector('body > .launch-menu') === null) onClose(); }}><div>
    <header><h2 id="open-folder-title">Other locations</h2><button type="button" aria-label="Close other locations" onClick={onClose}><PanelIcon path={panelIcons.close} /></button></header>
    <form className="open-folder-path" onSubmit={event => { event.preventDefault(); void open(path.trim(), 'agent'); }}>
      <label>Folder path<input autoFocus type="text" value={path} placeholder="~/code/project" maxLength={4096} autoComplete="off" spellCheck={false} onChange={event => { setPath(event.target.value); setError(undefined); }} /></label>
      {typed !== '' && <FolderActions path={typed} label={label(typed)} resolution={placeFor(typed)?.resolution} pending={pending} onOpen={(action, choice) => void open(typed, action, choice)} />}
      {error !== undefined && <p className="open-folder-error" role="alert">{error}</p>}
    </form>
    <section className="open-folder-recents"><h3>Recent</h3>{recents === undefined ? <p className="open-folder-empty">Loading…</p> : recents.length === 0 ? <p className="open-folder-empty">No folders opened yet.</p> : <ul aria-label="Recent folders">{recents.map(folder => <li key={folder.path} className="open-folder-entry">
      <span className="open-folder-marker" role="img" aria-label={folder.kind === 'git' ? 'Git repository' : 'Folder'} title={folder.kind === 'git' ? 'Git repository' : 'Folder'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={folder.kind === 'git' ? gitIcon : folderIcon} /></svg></span>
      <span className="open-folder-copy"><strong>{label(folder.path)}</strong><small title={folder.path}>{folder.path}</small></span>
      <FolderActions path={folder.path} label={label(folder.path)} resolution={placeFor(folder.path)?.resolution} pending={pending} onOpen={(action, choice) => void open(folder.path, action, choice)} />
      <button type="button" className="open-folder-forget" aria-label={`Forget ${label(folder.path)}`} title="Forget this folder" disabled={pending !== undefined} onClick={() => void forget(folder.path)}><PanelIcon path={panelIcons.close} /></button>
    </li>)}</ul>}</section>
  </div></div>, document.body);
}
