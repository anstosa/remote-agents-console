import { type FormEvent, type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type ColorTheme, setColorTheme, useColorTheme } from '../color-theme.js';
import { setDynamicWorktrees, useDynamicWorktrees } from '../dynamic-worktrees.js';
import { setFlyoutMarkers, useFlyoutMarkers } from '../flyout-markers.js';
import { setNotificationSounds, useNotificationSounds } from '../notification-sounds.js';
import { PanelIcon, panelIcons } from '../panel-header.js';
import { setReducedMotion, useReducedMotion } from '../reduced-motion.js';
import { defaultTerminalFontSize, maxTerminalFontSize, minTerminalFontSize, setTerminalFontSize, useTerminalFontSize } from '../terminal-font-size.js';

export type BrowserSettingsIdentity = {
  deviceName: string;
  renameClient: (name: string) => Promise<string | undefined>;
};

type BrowserSettingsValues = {
  deviceName: string;
  terminalFontSize: number;
  colorTheme: ColorTheme;
  reducedMotion: boolean;
  notificationSounds: boolean;
  flyoutMarkers: boolean;
  dynamicWorktrees: boolean;
};

export type BrowserDraft = Partial<BrowserSettingsValues>;

// retain staged browser preferences across settings split remounts
export function useSettingsBrowserDraftState() {
  return useState<BrowserDraft>({});
}

// validate one staged browser identity
const browserNameError = (name: string): string | undefined => {
  const normalized = name.trim();
  // preserve the existing visible-name validation
  if (normalized.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) return 'Enter a name without control characters.';
  // keep programmatic drafts inside the input bound
  if (normalized.length > 64) return 'Client name must be between 1 and 64 visible characters.';
  return undefined;
};

// stage browser-only preferences for the shared settings transaction
export function useBrowserSettingsDraft(identity: BrowserSettingsIdentity, locked: boolean, operationPending: RefObject<boolean>, browserDraft: ReturnType<typeof useSettingsBrowserDraftState>): { content: ReactNode; interfaceContent: ReactNode; projectsContent: ReactNode; dirtyPageIds: ReadonlySet<string>; dirty: boolean; validate: () => string | undefined; save: () => Promise<string | undefined>; discard: () => void } {
  const liveTerminalFontSize = useTerminalFontSize();
  const liveColorTheme = useColorTheme();
  const liveReducedMotion = useReducedMotion();
  const liveNotificationSounds = useNotificationSounds();
  const liveFlyoutMarkers = useFlyoutMarkers();
  const liveDynamicWorktrees = useDynamicWorktrees();
  const [draft, setDraft] = browserDraft;
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(identity.deviceName);
  const [renameTouched, setRenameTouched] = useState(false);
  const [renameError, setRenameError] = useState('');
  const renameBaseline = useRef(identity.deviceName);
  const renameButton = useRef<HTMLButtonElement>(null);
  const controlsLocked = locked || operationPending.current;
  const deviceName = draft.deviceName ?? identity.deviceName;
  const terminalFontSize = draft.terminalFontSize ?? liveTerminalFontSize;
  const colorTheme = draft.colorTheme ?? liveColorTheme;
  const reducedMotion = draft.reducedMotion ?? liveReducedMotion;
  const notificationSounds = draft.notificationSounds ?? liveNotificationSounds;
  const flyoutMarkers = draft.flyoutMarkers ?? liveFlyoutMarkers;
  const dynamicWorktrees = draft.dynamicWorktrees ?? liveDynamicWorktrees;
  const shownRenameValue = renameTouched ? renameValue : deviceName;
  const terminalFontIsDefault = terminalFontSize === defaultTerminalFontSize();

  // let cross-tab values take ownership after satisfying a staged choice
  useEffect(() => {
    setDraft(current => {
      const next = { ...current };
      let changed = false;
      // remove only drafts that now equal their applied values
      for (const [key, live] of Object.entries({ deviceName: identity.deviceName, terminalFontSize: liveTerminalFontSize, colorTheme: liveColorTheme, reducedMotion: liveReducedMotion, notificationSounds: liveNotificationSounds, flyoutMarkers: liveFlyoutMarkers, dynamicWorktrees: liveDynamicWorktrees }) as Array<[keyof BrowserSettingsValues, BrowserSettingsValues[keyof BrowserSettingsValues]]>) {
        if (next[key] !== live) continue;
        delete next[key];
        changed = true;
      }
      return changed ? next : current;
    });
  }, [identity.deviceName, liveColorTheme, liveDynamicWorktrees, liveFlyoutMarkers, liveNotificationSounds, liveReducedMotion, liveTerminalFontSize]);

  // retain only an explicit staged value
  const stage = useCallback(<Key extends keyof BrowserSettingsValues>(key: Key, value: BrowserSettingsValues[Key], live: BrowserSettingsValues[Key]) => {
    // reject events already in flight
    if (locked || operationPending.current) return;
    setDraft(current => {
      const next = { ...current };
      // remove direct reversions from the transaction
      if (value === live) delete next[key];
      else next[key] = value;
      return next;
    });
  }, [locked, operationPending]);

  // validate staged browser identity without changing it
  const validate = useCallback((): string | undefined => {
    // validate only a remaining rename
    if (draft.deviceName !== undefined && draft.deviceName !== identity.deviceName) return browserNameError(draft.deviceName);
    return undefined;
  }, [draft.deviceName, identity.deviceName]);

  // commit the server rename first, then the infallible local preferences
  const save = useCallback(async (): Promise<string | undefined> => {
    const validationError = validate();
    // preserve every draft when validation fails
    if (validationError !== undefined) return validationError;
    const rename = draft.deviceName !== undefined && draft.deviceName !== identity.deviceName ? draft.deviceName.trim() : undefined;
    // do not apply local preferences when the server rename fails
    if (rename !== undefined) {
      try {
        const failure = await identity.renameClient(rename);
        if (failure !== undefined) return failure;
      } catch {
        return 'Unable to rename this client. Try again.';
      }
    }
    // apply only fields still different from their live values
    if (draft.terminalFontSize !== undefined && draft.terminalFontSize !== liveTerminalFontSize) setTerminalFontSize(draft.terminalFontSize);
    if (draft.colorTheme !== undefined && draft.colorTheme !== liveColorTheme) setColorTheme(draft.colorTheme);
    if (draft.reducedMotion !== undefined && draft.reducedMotion !== liveReducedMotion) setReducedMotion(draft.reducedMotion);
    if (draft.notificationSounds !== undefined && draft.notificationSounds !== liveNotificationSounds) setNotificationSounds(draft.notificationSounds);
    if (draft.flyoutMarkers !== undefined && draft.flyoutMarkers !== liveFlyoutMarkers) setFlyoutMarkers(draft.flyoutMarkers);
    if (draft.dynamicWorktrees !== undefined && draft.dynamicWorktrees !== liveDynamicWorktrees) setDynamicWorktrees(draft.dynamicWorktrees);
    setDraft({});
    setRenameOpen(false);
    setRenameTouched(false);
    setRenameError('');
    return undefined;
  }, [draft, identity, liveColorTheme, liveDynamicWorktrees, liveFlyoutMarkers, liveNotificationSounds, liveReducedMotion, liveTerminalFontSize, validate]);

  // reset drafts against the newest external browser state
  const discard = useCallback(() => {
    setDraft({});
    setRenameValue(identity.deviceName);
    setRenameTouched(false);
    setRenameError('');
    setRenameOpen(false);
  }, [identity.deviceName]);

  // open the bounded browser-name editor
  const beginRename = () => {
    // do not open a dialog during another settings operation
    if (locked || operationPending.current) return;
    renameBaseline.current = deviceName;
    setRenameValue(deviceName);
    setRenameTouched(false);
    setRenameError('');
    setRenameOpen(true);
  };

  // close the draft editor without changing the staged name
  const closeRename = () => {
    // keep the dialog stable during a shared transaction
    if (locked || operationPending.current) return;
    setRenameOpen(false);
    setRenameTouched(false);
    setRenameError('');
    requestAnimationFrame(() => renameButton.current?.focus());
  };

  // stage the edited identity for the shared Save action
  const finishRename = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // ignore stale dialog submissions
    if (locked || operationPending.current) return;
    const failure = browserNameError(shownRenameValue);
    if (failure !== undefined) { setRenameError(failure); return; }
    const normalized = shownRenameValue.trim();
    // ignore pristine and normalization-only edits from an older identity
    if (renameTouched && normalized !== renameBaseline.current.trim()) stage('deviceName', normalized, identity.deviceName);
    setRenameError('');
    setRenameOpen(false);
    setRenameTouched(false);
    requestAnimationFrame(() => renameButton.current?.focus());
  };

  // keep keyboard navigation within the staged rename dialog
  const renameKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRename(); return; }
    // preserve ordinary input keys
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')).filter(control => control.offsetParent !== null);
    event.preventDefault();
    // retain focus while the shared transaction disables every control
    if (controls.length === 0) return;
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? controls.indexOf(active) : -1;
    const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
    controls.at(next)?.focus();
  };

  const terminalFontSetting = <div className="client-settings-setting client-settings-terminal-font" data-settings-path="terminalFontSize" role="group" aria-label="Terminal font"><div className="client-settings-setting-copy"><header><small>TERMINAL FONT</small></header><span className="client-settings-terminal-preview" aria-label="Terminal font preview" style={{ fontSize: `${terminalFontSize}px` }}>Aa ~/agent $</span></div><div className="client-settings-terminal-control client-settings-setting-control"><div className="client-settings-stepper"><button className={`client-settings-font-reset${terminalFontIsDefault ? ' reserved' : ''}`} type="button" aria-label="Reset terminal font" aria-hidden={terminalFontIsDefault} tabIndex={terminalFontIsDefault ? -1 : undefined} disabled={controlsLocked || terminalFontIsDefault} onClick={() => { /* stage the browser font default */ stage('terminalFontSize', defaultTerminalFontSize(), liveTerminalFontSize); }}>Reset</button><button type="button" aria-label="Smaller terminal font" disabled={controlsLocked || terminalFontSize <= minTerminalFontSize} onClick={() => { /* stage a smaller terminal size */ stage('terminalFontSize', Math.max(minTerminalFontSize, terminalFontSize - 1), liveTerminalFontSize); }}>−</button><strong aria-live="polite">{terminalFontSize}px</strong><button type="button" aria-label="Larger terminal font" disabled={controlsLocked || terminalFontSize >= maxTerminalFontSize} onClick={() => { /* stage a larger terminal size */ stage('terminalFontSize', Math.min(maxTerminalFontSize, terminalFontSize + 1), liveTerminalFontSize); }}>+</button></div></div></div>;
  const themeSetting = <div className="client-settings-setting client-settings-color-theme" data-settings-path="colorTheme" role="group" aria-label="Theme"><div className="client-settings-setting-copy"><header><small>THEME</small></header><span>Use a dark or light appearance in this browser.</span></div><div className="client-settings-segmented client-settings-setting-control" role="radiogroup" aria-label="Theme">{/* render each staged theme choice */}{([['mocha', 'Dark'], ['latte', 'Light']] as const).map(([theme, label]) => <button key={theme} type="button" role="radio" aria-checked={colorTheme === theme} aria-label={`${label} theme`} className={colorTheme === theme ? 'active' : undefined} disabled={controlsLocked} onClick={() => { /* stage this browser's appearance */ stage('colorTheme', theme, liveColorTheme); }}>{label}</button>)}</div></div>;
  const reducedMotionSetting = <div className="client-settings-setting client-settings-reduced-motion" data-settings-path="reducedMotion" role="group" aria-label="Reduced motion setting"><div className="client-settings-setting-copy"><header><small>REDUCED MOTION</small></header><span>Keep status colours, use compact spinners, and stop shimmers and pulses.</span></div><label className="client-settings-toggle client-settings-setting-control"><input aria-label="Reduced motion" role="switch" type="checkbox" checked={reducedMotion} disabled={controlsLocked} onChange={event => { /* stage this browser's motion preference */ stage('reducedMotion', event.currentTarget.checked, liveReducedMotion); }} /><span className="client-settings-switch-state">{reducedMotion ? 'On' : 'Off'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label></div>;
  const notificationSoundsSetting = <div className="client-settings-setting client-settings-notification-sounds" data-settings-path="notificationSounds" role="group" aria-label="Notification sounds setting"><div className="client-settings-setting-copy"><header><small>NOTIFICATION SOUNDS</small></header><span>Play a sound with agent alerts. Notifications still show when this is off.</span></div><label className="client-settings-toggle client-settings-setting-control"><input aria-label="Notification sounds" role="switch" type="checkbox" checked={notificationSounds} disabled={controlsLocked} onChange={event => { /* stage this browser's alert sounds */ stage('notificationSounds', event.currentTarget.checked, liveNotificationSounds); }} /><span className="client-settings-switch-state">{notificationSounds ? 'On' : 'Off'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label></div>;
  const flyoutMarkersSetting = <div className="client-settings-setting client-settings-flyout-markers" data-settings-path="flyoutMarkers" role="group" aria-label="Flyout markers setting"><div className="client-settings-setting-copy"><header><small>FLYOUT MARKERS</small></header><span>Show little carets on buttons that open flyouts.</span></div><label className="client-settings-toggle client-settings-setting-control"><input aria-label="Flyout markers" role="switch" type="checkbox" checked={flyoutMarkers} disabled={controlsLocked} onChange={event => { /* stage this browser's markers */ stage('flyoutMarkers', event.currentTarget.checked, liveFlyoutMarkers); }} /><span className="client-settings-switch-state">{flyoutMarkers ? 'On' : 'Off'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label></div>;
  const dynamicWorktreesSetting = <div className="client-settings-setting client-settings-dynamic-worktrees" data-settings-path="dynamicWorktrees" role="group" aria-label="Dynamic worktrees setting"><div className="client-settings-setting-copy"><header><small>DYNAMIC WORKTREES</small></header><span>Create and manage multiple worktrees from the launcher in this browser.</span></div><label className="client-settings-toggle client-settings-setting-control"><input aria-label="Dynamic worktrees" role="switch" type="checkbox" checked={dynamicWorktrees} disabled={controlsLocked} onChange={event => { /* stage the browser launcher mode */ stage('dynamicWorktrees', event.currentTarget.checked, liveDynamicWorktrees); }} /><span className="client-settings-switch-state">{dynamicWorktrees ? 'On' : 'Off'}</span><span className="client-settings-switch-track" aria-hidden="true" /></label></div>;
  const renameDialog = !renameOpen ? null : createPortal(<div className="dialog client-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="browser-settings-rename-title" onKeyDown={renameKey}><div><header><div><small>GLOBAL SETTINGS</small><h2 id="browser-settings-rename-title">Rename browser</h2></div><button type="button" aria-label="Close rename browser" disabled={controlsLocked} onClick={closeRename}><PanelIcon path={panelIcons.close} /></button></header><form onSubmit={finishRename}><label>Name<input autoFocus type="text" value={shownRenameValue} maxLength={64} autoComplete="off" disabled={controlsLocked} onChange={event => { /* retain only an explicit browser-name edit */ if (!locked && !operationPending.current) { setRenameValue(event.target.value); setRenameTouched(true); } }} /></label>{renameError && <span className="auth-error" role="alert">{renameError}</span>}<footer><button type="button" disabled={controlsLocked} onClick={closeRename}>Cancel</button><button type="submit" disabled={controlsLocked || !shownRenameValue.trim()}>Done</button></footer></form></div></div>, document.body);
  const content = <><div className="client-settings-overview">
    <div className="client-settings-setting client-settings-identity" data-settings-path="deviceName" role="group" aria-label="Name">
      <div className="client-settings-setting-copy"><header><small>NAME</small></header><strong>{deviceName}</strong></div>
      <span className="client-settings-setting-actions client-settings-setting-control"><button ref={renameButton} type="button" aria-label="Rename browser name" disabled={controlsLocked} onClick={beginRename}>Rename</button></span>
    </div>
  </div>{renameDialog}</>;
  // share one transaction while rendering each preference on its owning page
  const interfaceContent = <><p className="settings-preference-description">Interface preferences apply only to this browser.</p><div className="client-settings-overview">{terminalFontSetting}{themeSetting}{reducedMotionSetting}{notificationSoundsSetting}{flyoutMarkersSetting}</div></>;
  const projectsContent = <div className="client-settings-overview">{dynamicWorktreesSetting}</div>;
  const browserDirty = draft.deviceName !== undefined && draft.deviceName !== identity.deviceName;
  const interfaceDirty = draft.terminalFontSize !== undefined && draft.terminalFontSize !== liveTerminalFontSize
    || draft.colorTheme !== undefined && draft.colorTheme !== liveColorTheme
    || draft.reducedMotion !== undefined && draft.reducedMotion !== liveReducedMotion
    || draft.notificationSounds !== undefined && draft.notificationSounds !== liveNotificationSounds
    || draft.flyoutMarkers !== undefined && draft.flyoutMarkers !== liveFlyoutMarkers;
  const projectsDirty = draft.dynamicWorktrees !== undefined && draft.dynamicWorktrees !== liveDynamicWorktrees;
  // mark the visible owner of each staged browser preference
  const dirtyPageIds = new Set<string>();
  // keep identity changes on this browser
  if (browserDirty) dirtyPageIds.add('browser');
  // keep appearance changes on interface
  if (interfaceDirty) dirtyPageIds.add('interface');
  // keep launcher changes on projects
  if (projectsDirty) dirtyPageIds.add('projects');
  return { content, interfaceContent, projectsContent, dirtyPageIds, dirty: dirtyPageIds.size > 0, validate, save, discard };
}
