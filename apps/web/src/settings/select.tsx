import { Fragment, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { FlyoutPortal } from '../flyout-portal.js';
import { PanelIcon, panelIcons } from '../panel-header.js';
import { useViewportFlyout } from '../viewport-flyout.js';
import './select.css';

export type SettingsSelectOption = {
  value: string;
  label: string;
  icon?: ReactNode;
  group?: string;
  disabled?: boolean;
  busy?: boolean;
  hasIssues?: boolean;
};

type IndexedOption = { option: SettingsSelectOption; index: number };
type OptionSegment = { group?: string; entries: IndexedOption[] };

// render one visible endpoint of a two-way switch
function TwoWayChoice({ option, selected }: { option: SettingsSelectOption; selected: boolean }) {
  return <span className="settings-select-switch-choice" data-selected={selected || undefined} data-has-issues={option.hasIssues || undefined} aria-disabled={option.disabled || undefined} title={option.group === undefined ? option.label : `${option.group}: ${option.label}`}>
    {option.busy === true && <span className="update-progress-ring" aria-hidden="true" />}
    {option.icon !== undefined && <span className="settings-select-switch-icon" aria-hidden="true">{option.icon}</span>}
    <span>{option.label}</span>
  </span>;
}

// find the first enabled choice
const firstIndex = (entries: readonly IndexedOption[]): number => entries.find(entry => entry.option.disabled !== true)?.index ?? -1;

// find the selected enabled choice
const initialIndex = (entries: readonly IndexedOption[], value: string): number => {
  const selected = entries.find(entry => entry.option.value === value && entry.option.disabled !== true)?.index ?? -1;
  // prefer the current choice
  if (selected >= 0) return selected;
  return firstIndex(entries);
};

// find the last enabled choice
const finalIndex = (entries: readonly IndexedOption[]): number => {
  return entries.filter(entry => entry.option.disabled !== true).at(-1)?.index ?? -1;
};

// step among enabled choices
const steppedIndex = (entries: readonly IndexedOption[], current: number, direction: -1 | 1): number => {
  const enabled = entries.filter(entry => entry.option.disabled !== true).map(entry => entry.index);
  // keep an empty menu inactive
  if (enabled.length === 0) return -1;
  const position = enabled.indexOf(current);
  // enter from the requested edge
  if (position < 0) return direction > 0 ? enabled[0]! : enabled.at(-1)!;
  return enabled[(position + direction + enabled.length) % enabled.length]!;
};

// match one enabled typeahead choice
const matchedIndex = (entries: readonly IndexedOption[], current: number, query: string): number => {
  const enabled = entries.filter(entry => entry.option.disabled !== true);
  // keep an empty menu inactive
  if (enabled.length === 0) return -1;
  const position = enabled.findIndex(entry => entry.index === current);
  const start = position < 0 ? 0 : position + 1;
  const ordered = [...enabled.slice(start), ...enabled.slice(0, start)];
  const normalized = query.toLocaleLowerCase();
  return ordered.find(entry => entry.option.label.trim().toLocaleLowerCase().startsWith(normalized))?.index ?? -1;
};

// retain option order within labelled groups
const optionSegments = (entries: readonly IndexedOption[]): OptionSegment[] => entries.reduce<OptionSegment[]>((segments, entry) => {
  const last = segments.at(-1);
  // extend only an adjacent group
  if (last !== undefined && last.group === entry.option.group) {
    last.entries.push(entry);
    return segments;
  }
  segments.push({ group: entry.option.group, entries: [entry] });
  return segments;
}, []);

// provide one accessible custom settings selector
export function SettingsSelect({ label, value, options, disabled = false, searchable = false, onChange }: { label: string; value: string; options: readonly SettingsSelectOption[]; disabled?: boolean; searchable?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const typeahead = useRef({ value: '', at: 0 });
  const generatedId = useId().replaceAll(':', '');
  const listboxId = `settings-select-${generatedId}`;
  const searchId = `${listboxId}-search`;
  const switchDescriptionId = `${listboxId}-switch-description`;
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLButtonElement>(open, { align: 'start', matchAnchorWidth: true });
  const selected = options.find(option => option.value === value);
  const shown: SettingsSelectOption = selected ?? { value, label: value };
  const twoWay = !searchable && options.length === 2 && selected !== undefined;
  const first = twoWay ? options[0]! : undefined;
  const second = twoWay ? options[1]! : undefined;
  const switchChecked = second?.value === value;
  const switchTarget = switchChecked ? first : second;
  const switchDisabled = disabled || switchTarget?.disabled === true;
  const busy = shown.busy === true;
  const hasIcons = options.some(option => option.icon !== undefined);
  // retain source indexes through filtering
  const entries = options.map((option, index) => ({ option, index }));
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  // filter authored option metadata without changing its value
  const visibleEntries = !searchable || normalizedSearch === '' ? entries : entries.filter(({ option }) => `${option.label}\n${option.value}\n${option.group ?? ''}`.toLocaleLowerCase().includes(normalizedSearch));
  const segments = optionSegments(visibleEntries);

  // clear transient navigation state
  const closeMenu = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    setSearchQuery('');
    typeahead.current = { value: '', at: 0 };
  }, []);

  // open at the current choice
  const openMenu = useCallback((edge?: 'first' | 'last') => {
    // ignore unavailable controls
    if (disabled) return;
    setActiveIndex(edge === 'first' ? firstIndex(entries) : edge === 'last' ? finalIndex(entries) : initialIndex(entries, value));
    setOpen(true);
  }, [disabled, entries, value]);

  // commit one enabled choice
  const commitOption = useCallback((index: number) => {
    const option = options[index];
    // reject missing or disabled choices
    if (option === undefined || option.disabled === true) return;
    onChange(option.value);
    closeMenu();
  }, [closeMenu, onChange, options]);

  // keep the active choice visible
  useLayoutEffect(() => {
    // wait for an active open choice
    if (!open || activeIndex < 0) return;
    flyoutRef.current?.querySelector<HTMLElement>(`#${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, flyoutRef, listboxId, open]);

  // move searchable menus directly into their filter
  useEffect(() => {
    // preserve trigger focus for ordinary dropdowns
    if (!open || !searchable) return;
    const frame = window.requestAnimationFrame(() => { searchInput.current?.focus(); });
    return () => window.cancelAnimationFrame(frame);
  }, [open, searchable]);

  // close when the trigger becomes unavailable
  useEffect(() => {
    // retire dropdown state when this control becomes a switch
    if (twoWay) {
      // close only a menu left open by a prior option set
      if (open) closeMenu();
      return;
    }
    // close immediately when disabled
    if (disabled) {
      closeMenu();
      return;
    }
    // observe only while open
    if (!open) return;
    const trigger = anchorRef.current;
    // close a missing trigger
    if (trigger === null) {
      closeMenu();
      return;
    }
    // detect hidden ancestors without moving focus
    const closeIfUnavailable = () => {
      const bounds = trigger.getBoundingClientRect();
      const computed = window.getComputedStyle(trigger);
      const hiddenAncestor = trigger.closest('[hidden], [inert], [aria-hidden="true"]');
      // close without committing stale state
      if (!trigger.isConnected || trigger.disabled || hiddenAncestor !== null || computed.display === 'none' || computed.visibility === 'hidden' || bounds.width === 0 || bounds.height === 0) closeMenu();
    };
    closeIfUnavailable();
    const resizeObserver = new ResizeObserver(closeIfUnavailable);
    resizeObserver.observe(trigger);
    const mutationObserver = new MutationObserver(closeIfUnavailable);
    let ancestor: HTMLElement | null = trigger;
    // watch the trigger's visibility chain
    while (ancestor !== null) {
      mutationObserver.observe(ancestor, { attributes: true, attributeFilter: ['class', 'disabled', 'hidden', 'inert', 'style', 'aria-hidden'] });
      ancestor = ancestor.parentElement;
    }
    window.addEventListener('resize', closeIfUnavailable);
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', closeIfUnavailable);
    };
  }, [anchorRef, closeMenu, disabled, open, twoWay]);

  // toggle only after explicit pointer or keyboard activation
  const toggleTwoWay = () => {
    // reject unavailable destinations without changing the authored value
    if (switchTarget === undefined || switchTarget.disabled === true || disabled) return;
    onChange(switchTarget.value);
  };

  // handle select-only keyboard navigation
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    // close without changing the value
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }
    // let focus continue naturally
    if (event.key === 'Tab' && open) {
      closeMenu();
      return;
    }
    // navigate to the next choice
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      // open before moving further
      if (!open) openMenu();
      else setActiveIndex(current => steppedIndex(entries, current, 1));
      return;
    }
    // navigate to the previous choice
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      // open before moving further
      if (!open) openMenu();
      else setActiveIndex(current => steppedIndex(entries, current, -1));
      return;
    }
    // jump to the first choice
    if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      openMenu('first');
      return;
    }
    // jump to the last choice
    if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      openMenu('last');
      return;
    }
    // open or commit explicitly
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      // commit only an open choice
      if (open && activeIndex >= 0) commitOption(activeIndex);
      else openMenu();
      return;
    }
    const printable = event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey;
    // ignore command keys
    if (!printable) return;
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    const continued = now - typeahead.current.at <= 700 ? `${typeahead.current.value}${event.key}` : event.key;
    const repeated = new Set(continued.toLocaleLowerCase()).size === 1;
    const query = repeated ? event.key : continued;
    typeahead.current = { value: query, at: now };
    const match = matchedIndex(entries, activeIndex, query);
    // open only for a valid match
    if (match >= 0) {
      setActiveIndex(match);
      setOpen(true);
    }
  };

  // toggle without committing
  const toggleMenu = () => {
    // close the current menu
    if (open) closeMenu();
    else openMenu();
  };

  // navigate filtered choices without committing search text
  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // close and restore the owning trigger
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      anchorRef.current?.focus();
      return;
    }
    // leave the menu through the normal tab order
    if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    // navigate to the next visible choice
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex(current => steppedIndex(visibleEntries, current, 1));
      return;
    }
    // navigate to the previous visible choice
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      setActiveIndex(current => steppedIndex(visibleEntries, current, -1));
      return;
    }
    // commit the active or first enabled visible choice
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const target = visibleEntries.find(entry => entry.index === activeIndex && entry.option.disabled !== true) ?? visibleEntries.find(entry => entry.option.disabled !== true);
      // keep an empty result set read-only
      if (target === undefined) return;
      commitOption(target.index);
      anchorRef.current?.focus();
    }
  };

  const listbox = <div
    ref={searchable ? undefined : flyoutRef}
    id={listboxId}
    className={`settings-select-listbox${searchable ? '' : ' more-menu flyout-menu'}`}
    role="listbox"
    aria-label={`${label} options`}
    data-has-icons={hasIcons || undefined}
    style={searchable ? undefined : style}
  >
    {visibleEntries.length === 0 && <span className="settings-select-empty" role="status">{options.length === 0 ? 'No options' : 'No matching options'}</span>}
    {/* render adjacent accessible groups */}
    {segments.map((segment, segmentIndex) => {
      const choices = <>{/* render every visible source choice */}{segment.entries.map(({ option, index }) => {
        const active = index === activeIndex;
        const chosen = option.value === value;
        return <div
          key={`${option.value}:${index}`}
          id={`${listboxId}-option-${index}`}
          className={`settings-select-option${option.busy === true ? ' progress-border progress-blue' : ''}`}
          role="option"
          aria-selected={chosen}
          aria-busy={option.busy || undefined}
          aria-disabled={option.disabled || undefined}
          data-active={active || undefined}
          data-value={option.value}
          data-has-issues={option.hasIssues || undefined}
          onMouseDown={event => { /* preserve trigger or search focus */ event.preventDefault(); }}
          onPointerMove={() => { /* follow enabled pointer choices */ if (option.disabled !== true) setActiveIndex(index); }}
          onClick={() => { /* commit one pointer choice */ commitOption(index); }}
        >
          {option.busy === true && <span className="update-progress-ring" aria-hidden="true" />}
          {hasIcons && <span className="settings-select-option-icon" aria-hidden="true">{option.icon}</span>}
          <span className="settings-select-option-label">{option.label}</span>
          <span className="settings-select-option-check" aria-hidden="true">{chosen && <PanelIcon path={panelIcons.check} />}</span>
        </div>;
      })}</>;
      // expose labelled groups to assistive technology
      if (segment.group !== undefined) return <div key={`${segment.group}:${segmentIndex}`} className="settings-select-group" role="group" aria-label={segment.group}><small aria-hidden="true">{segment.group}</small>{choices}</div>;
      return <Fragment key={`ungrouped:${segmentIndex}`}>{choices}</Fragment>;
    })}
  </div>;

  // exactly two choices use the compact binary control
  if (first !== undefined && second !== undefined) return <span className="settings-select settings-select-binary">
    <button
      ref={anchorRef}
      type="button"
      role="switch"
      className={`settings-select-two-way${busy ? ' progress-border progress-blue' : ''}`}
      aria-label={label}
      aria-describedby={switchDescriptionId}
      aria-checked={switchChecked}
      aria-busy={busy || undefined}
      data-value={value}
      data-has-issues={shown.hasIssues || undefined}
      disabled={switchDisabled}
      onClick={toggleTwoWay}
    >
      <TwoWayChoice option={first} selected={first.value === value} />
      <span className="settings-select-switch-track" aria-hidden="true"><span /></span>
      <TwoWayChoice option={second} selected={second.value === value} />
    </button>
    <span id={switchDescriptionId} className="sr-only">Unchecked selects {first.label}{first.group === undefined ? '' : ` in ${first.group}`}. Checked selects {second.label}{second.group === undefined ? '' : ` in ${second.group}`}.</span>
  </span>;

  return <span className="settings-select">
    <button
      ref={anchorRef}
      type="button"
      role="combobox"
      className={`settings-select-trigger${busy ? ' progress-border progress-blue' : ''}`}
      aria-label={label}
      aria-busy={busy || undefined}
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-controls={listboxId}
      aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
      data-value={value}
      data-has-issues={shown.hasIssues || undefined}
      disabled={disabled}
      onClick={toggleMenu}
      onKeyDown={handleKeyDown}
    >
      {busy && <span className="update-progress-ring" aria-hidden="true" />}
      {shown.icon !== undefined && <span className="settings-select-current-icon" aria-hidden="true">{shown.icon}</span>}
      <span className="settings-select-current-label">{shown.label}</span>
      <svg className="settings-select-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <FlyoutPortal onDismiss={closeMenu}>
      {searchable ? <div ref={flyoutRef} className="settings-select-searchable-menu more-menu flyout-menu" style={style}>
        <label className="settings-select-search" htmlFor={searchId}><span className="sr-only">Search {label} options</span><input
          ref={searchInput}
          id={searchId}
          type="search"
          value={searchQuery}
          placeholder="Search options"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
          onChange={event => { /* filter without changing the selected value */ setSearchQuery(event.target.value); setActiveIndex(-1); }}
          onKeyDown={handleSearchKeyDown}
        /></label>
        {listbox}
      </div> : listbox}
    </FlyoutPortal>}
  </span>;
}
