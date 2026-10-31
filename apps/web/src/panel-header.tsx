import { createContext, isValidElement, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode, type RefObject, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ConfiguredButtonIcon, openConfiguredButtonMenu, type ButtonSlot, useConfiguredButtons } from './configured-buttons.js';
import { FlyoutPortal } from './flyout-portal.js';
import { useViewportFlyout } from './viewport-flyout.js';
import { preserveContextMenuPress } from './selection-context-menu.js';
import type { ProgressKind } from './progress-animation.js';

// The app-wide phone breakpoint. A phone shows a Workspace's panels one per screen, in a swipe
// carousel, and expanding a panel there hides the tab row and toolbar instead.
const phoneQuery = '(max-width: 768px)';
// Below this panel width a header's secondary actions fold into its ⋮.
const panelFoldWidth = 620;
// the header's shared glyphs, for panels to reuse in their own actions
export const panelIcons = {
  expand: 'M9 3H3v6m18 6v6h-6M3 3l6 6m6 6 6 6',
  restore: 'M9 3v6H3m18 6h-6v6M3 9l6-6m6 18 6-6',
  close: 'm6 6 12 12M18 6 6 18',
  copy: 'M9 9h10v10H9zM5 15H4V5h10v1',
  check: 'm5 12 4 4L19 6',
  save: 'M4 3h13l4 4v14H3V3h1Zm3 0v6h10V3M7 21v-8h10v8',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  moveUp: 'M12 19V5m-6 6 6-6 6 6',
  moveDown: 'M12 5v14m-6-6 6 6 6-6',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v6M14 11v6',
  editor: 'm4 20 4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  eyeClosed: 'm3 3 18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c7 0 10 7 10 7a16.1 16.1 0 0 1-3.1 4.1M6.5 6.5A15.4 15.4 0 0 0 2 12s3 7 10 7a10.4 10.4 0 0 0 5.5-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2',
  format: 'M4 5h16M9 10h11M9 15h11M4 20h16m-16-10 3 2.5L4 15'
};

const matchesPhone = () => typeof window !== 'undefined' && window.matchMedia(phoneQuery).matches;
const subscribePhone = (listener: () => void) => {
  const media = window.matchMedia(phoneQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
};
// Whether the phone layout applies now.
export const usePhoneLayout = (): boolean => useSyncExternalStore(subscribePhone, matchesPhone, () => false);

// Which panel of a Workspace fills it, by split key ('agent', 'note', 'browser', 'code', or a
// Terminal's pane id). One key at most; the split hides every sibling of the expanded panel. On a
// phone the expansion is `immersive` instead: whichever panel is in view fills the screen, and the
// tab row and toolbar fold away.
export type PanelExpansion = {
  expanded: string | undefined;
  immersive: boolean;
  setExpanded: (key: string, on: boolean) => void;
  toggle: (key: string) => void;
  restore: () => void;
};

// Hold one Workspace's expansion. It is transient (a panel that wants its expansion back after a
// reload, like the note, restores it itself through setExpanded, which a phone ignores), and
// crossing the phone breakpoint either way restores.
export function usePanelExpansion(): PanelExpansion {
  const [expanded, setExpandedKey] = useState<string>();
  const [immersive, setImmersive] = useState(false);
  const phone = useRef(matchesPhone());
  useLayoutEffect(() => {
    const media = window.matchMedia(phoneQuery);
    const sync = () => {
      phone.current = media.matches;
      setExpandedKey(undefined);
      setImmersive(false);
    };
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const setExpanded = useCallback((key: string, on: boolean) => {
    if (on) { if (!phone.current) setExpandedKey(key); }
    else setExpandedKey(current => current === key ? undefined : current);
  }, []);
  const toggle = useCallback((key: string) => {
    if (phone.current) setImmersive(current => !current);
    else setExpandedKey(current => current === key ? undefined : key);
  }, []);
  const restore = useCallback(() => {
    setExpandedKey(undefined);
    setImmersive(false);
  }, []);
  return { expanded, immersive, setExpanded, toggle, restore };
}

// What the split hands its panels: the expanded key (only while that panel is open) and the
// controls. Panels read it by their own key through usePanelExpand.
export const PanelExpandContext = createContext<Omit<PanelExpansion, 'setExpanded' | 'immersive'> | undefined>(undefined);

// Scope an expansion to the panels a container holds (`openKeys`, in any order). The expanded key
// counts only while its panel is open: a panel that has not mounted yet (a note still loading)
// keeps its request without hiding its siblings, and closing the expanded panel restores the
// rest, so reopening it does not expand it again. While immersive (a phone), the expanded panel is
// the one in view (`visibleKey`), so it follows a swipe, and closing that panel restores. `onKeyDown`
// goes on the container: Esc restores, except inside a pane's canvas (a shell app needs its Escape)
// or the agent panel's composer, after a handler that already used the key, or from a flyout
// portaled out of the container.
export function useExpansionScope(expansion: PanelExpansion, openKeys: readonly string[], containerRef: RefObject<HTMLElement | null>, visibleKey?: string) {
  const { expanded: requested, immersive, toggle, restore } = expansion;
  const expanded = immersive
    ? visibleKey !== undefined && openKeys.includes(visibleKey) ? visibleKey : undefined
    : requested !== undefined && openKeys.includes(requested) ? requested : undefined;
  const signature = openKeys.join('|');
  const previousKeys = useRef(openKeys);
  const request = useRef({ requested, immersive });
  request.current = { requested, immersive };
  // the panel in view at the last commit, which a close may just have taken away
  const shown = useRef(visibleKey);
  useLayoutEffect(() => {
    const previous = previousKeys.current;
    previousKeys.current = signature.split('|');
    const closed = previous.filter(key => !previousKeys.current.includes(key));
    // full screen ends with the panel it was showing, not with a shell exiting off screen
    const { requested: key, immersive: full } = request.current;
    const ended = full ? shown.current : key;
    if (ended !== undefined && closed.includes(ended)) restore();
  }, [signature, restore]);
  useLayoutEffect(() => { shown.current = visibleKey; });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || expanded === undefined || event.defaultPrevented) return;
    const target = event.target as Element;
    if (!containerRef.current?.contains(target) || target.closest('.log-canvas, .terminal-canvas, .prompt') !== null) return;
    event.preventDefault();
    restore();
  };
  const context = useMemo(() => ({ expanded, toggle, restore }), [expanded, toggle, restore]);
  return { expanded, context, onKeyDown };
}

// One panel's view of the shared expansion; undefined outside a split.
export function usePanelExpand(key: string) {
  const context = useContext(PanelExpandContext);
  if (context === undefined) return undefined;
  return { expanded: context.expanded === key, anyExpanded: context.expanded !== undefined, toggle: () => context.toggle(key), restore: context.restore };
}

export type ProgressColor = 'rosewater' | 'flamingo' | 'pink' | 'mauve' | 'red' | 'maroon' | 'peach' | 'yellow' | 'green' | 'teal' | 'sky' | 'sapphire' | 'blue' | 'lavender';

// One header action. Inline it is an icon button labelled by `label`; folded into the ⋮ it is a
// row showing the icon and the label.
export type PanelAction = {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  // custom actions may stage their bytes instead of executing them
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  title?: string;
  className?: string;
  disabled?: boolean;
  pressed?: boolean;
  progress?: ProgressColor;
  // select data-read motion while busy
  progressKind?: ProgressKind;
  showLabel?: boolean;
  style?: CSSProperties;
  // aria-expanded, for an action that opens a popup of its own
  popupOpen?: boolean;
};

// mark action-owned menus before generic panel context handlers
const actionButton = (action: PanelAction, row = false) => {
  // keep the action glyph stable while its border reports progress
  const busy = action.progress !== undefined;
  return <button key={action.key} type="button" className={`panel-header-action${row ? ' panel-header-row' : ''}${action.className === undefined ? '' : ` ${action.className}`}${busy ? ` progress-border progress-${action.progress}` : ''}${busy && action.progressKind === 'loading' ? ' progress-loading' : ''}`} style={action.style} disabled={action.disabled} aria-busy={busy || undefined} aria-label={action.label} aria-pressed={action.pressed} data-context-flyout={action.popupOpen === undefined ? undefined : true} aria-expanded={action.popupOpen} title={action.title ?? action.label} onPointerDownCapture={action.onContextMenu === undefined ? undefined : preserveContextMenuPress} onMouseDownCapture={action.onContextMenu === undefined ? undefined : preserveContextMenuPress} onContextMenu={action.onContextMenu} onClick={action.onSelect}>{busy && <span className="update-progress-ring" aria-hidden="true" />}{action.icon}{!row && action.popupOpen !== undefined && <span className="flyout-caret" aria-hidden="true" />}{(row || action.showLabel === true || action.icon === undefined) && <span>{action.label}</span>}</button>;
};

export function PanelIcon({ path }: { path: string }) {
  return <svg className="panel-header-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;
}

type PanelHeaderProps = {
  // the panel's split key, which the expand control promotes
  panelKey: string;
  // names the panel in the expand control's label ("Expand note", "Restore terminal build")
  label: string;
  // always-visible actions, before the secondary ones
  actions?: ReactNode;
  // actions that fold into the ⋮ when the panel is narrow
  secondary?: PanelAction[];
  // panel-specific rows rendered directly in the shared ⋮ flyout with a dismiss action
  menuContent?: (closeMenu: () => void) => ReactNode;
  // the trailing action: close, minimize for a Terminal, or a control that opens a popup of its
  // own (the agent panel's power menu)
  close?: PanelAction | ReactElement;
  expandDisabled?: boolean;
  configuredSlot?: ButtonSlot;
  configuredFilesDirectoryToken?: string;
} & (
  // preserve the default left pill without accepting a second representation
  { title: ReactNode; titleControl?: never }
  // require the full control when replacing the default pill
  | { title?: never; titleControl: ReactNode }
);

// The floating header every panel shares: a title pill top-left and an action pill top-right,
// over the panel's content. No bar sits behind them. The action pill ends with expand (which
// fills the Workspace with this panel) and the panel's close.
export function PanelHeader({ panelKey, label, title, titleControl, actions, secondary = [], menuContent, close, expandDisabled = false, configuredSlot, configuredFilesDirectoryToken }: PanelHeaderProps) {
  const expand = usePanelExpand(panelKey);
  const phone = usePhoneLayout();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [folded, setFolded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLButtonElement>(moreOpen);
  const automaticSlot = ['agent', 'note', 'browser', 'files', 'code', 'review', 'stack', 'github', 'settings'].includes(panelKey) ? `split:${panelKey}` as ButtonSlot : undefined;
  const configured = useConfiguredButtons(configuredSlot ?? automaticSlot, configuredFilesDirectoryToken);
  const configuredActions: PanelAction[] = configured.map(action => ({
    key: `configured-${action.id}`,
    label: action.text,
    title: action.disabledReason ?? action.text,
    icon: action.icon === undefined ? undefined : <ConfiguredButtonIcon path={action.icon} className="panel-header-icon" />,
    className: `configured-button configured-button-${action.style} configured-button-${action.color}`,
    style: { '--configured-button-color': `var(--${action.color})` } as CSSProperties,
    disabled: action.disabled,
    progress: action.busy ? action.color : undefined,
    showLabel: true,
    onSelect: () => action.run(),
    // preserve the exact originating terminal when its header owns the action
    onContextMenu: event => openConfiguredButtonMenu(event, action, closeMore, panelKey)
  }));
  // fold by the panel's own width, so a squeezed split column folds as a phone does
  useLayoutEffect(() => {
    const panel = wrapRef.current?.parentElement;
    if (panel === null || panel === undefined) return;
    const measure = () => {
      const width = panel.getBoundingClientRect().width;
      // a hidden panel measures zero; keep its last layout
      if (width > 0) setFolded(width < panelFoldWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!folded) setMoreOpen(false); }, [folded]);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  // keep custom menu controls available at every panel width
  const configuredMenuBusy = folded && configured.some(action => action.busy);
  const configuredMenuColor = configured.find(action => action.busy)?.color;
  const showMore = menuContent !== undefined || folded && (configuredActions.length > 0 || secondary.length > 0);
  return <div ref={wrapRef} className="panel-header">
    {titleControl ?? <div className="panel-header-pill panel-header-title">{title}</div>}
    <div className="panel-header-pill panel-header-actions" role="toolbar" aria-label={`${label[0].toUpperCase()}${label.slice(1)} actions`}>
      {!folded && configuredActions.map(action => actionButton(action))}
      {actions}
      {!folded && secondary.map(action => actionButton(action))}
      {showMore && <button ref={anchorRef} type="button" className={`panel-header-action panel-header-more${moreOpen ? ' active' : ''}${configuredMenuBusy && configuredMenuColor !== undefined ? ` progress-border progress-${configuredMenuColor}` : ''}`} aria-busy={configuredMenuBusy || undefined} aria-label={`More ${label} actions`} data-context-flyout aria-expanded={moreOpen} title="More" onClick={() => setMoreOpen(value => !value)} onKeyDown={event => { if (event.key === 'Escape' && moreOpen) { event.preventDefault(); event.stopPropagation(); closeMore(); } }}>{configuredMenuBusy && <span className="update-progress-ring" aria-hidden="true" />}<svg className="panel-header-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg><span className="flyout-caret" aria-hidden="true" /></button>}
      {expand !== undefined && <button type="button" className="panel-header-action panel-header-expand" disabled={expandDisabled} aria-label={`${expand.expanded ? 'Restore' : 'Expand'} ${label}`} aria-pressed={expand.expanded} title={phone ? expand.expanded ? 'Show the tabs and toolbar' : 'Full screen' : expand.expanded ? 'Restore the other panels' : 'Fill the Workspace'} onClick={expand.toggle}><PanelIcon path={expand.expanded ? panelIcons.restore : panelIcons.expand} /></button>}
      {close === undefined || isValidElement(close) ? close : actionButton(close)}
    </div>
    {showMore && moreOpen && <FlyoutPortal onDismiss={closeMore}><div ref={flyoutRef} className="more-menu panel-header-menu" role="group" aria-label={`More ${label} actions`} style={style} onClick={closeMore} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeMore(); } }}>{folded && configuredActions.map(action => actionButton(action, true))}{folded && secondary.map(action => actionButton(action, true))}{menuContent?.(closeMore)}</div></FlyoutPortal>}
  </div>;
}
