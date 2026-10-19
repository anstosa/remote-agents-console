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
};

type IndexedOption = { option: SettingsSelectOption; index: number };
type OptionSegment = { group?: string; entries: IndexedOption[] };

// find the first enabled choice
const firstIndex = (options: readonly SettingsSelectOption[]): number => options.findIndex(option => option.disabled !== true);

// find the selected enabled choice
const initialIndex = (options: readonly SettingsSelectOption[], value: string): number => {
  const selected = options.findIndex(option => option.value === value && option.disabled !== true);
  // prefer the current choice
  if (selected >= 0) return selected;
  return firstIndex(options);
};

// find the last enabled choice
const finalIndex = (options: readonly SettingsSelectOption[]): number => {
  return options.map((option, index) => option.disabled === true ? -1 : index).filter(index => index >= 0).at(-1) ?? -1;
};

// step among enabled choices
const steppedIndex = (options: readonly SettingsSelectOption[], current: number, direction: -1 | 1): number => {
  const enabled = options.map((option, index) => option.disabled === true ? -1 : index).filter(index => index >= 0);
  // keep an empty menu inactive
  if (enabled.length === 0) return -1;
  const position = enabled.indexOf(current);
  // enter from the requested edge
  if (position < 0) return direction > 0 ? enabled[0]! : enabled.at(-1)!;
  return enabled[(position + direction + enabled.length) % enabled.length]!;
};

// match one enabled typeahead choice
const matchedIndex = (options: readonly SettingsSelectOption[], current: number, query: string): number => {
  const enabled = options.map((option, index) => option.disabled === true ? -1 : index).filter(index => index >= 0);
  // keep an empty menu inactive
  if (enabled.length === 0) return -1;
  const position = enabled.indexOf(current);
  const start = position < 0 ? 0 : position + 1;
  const ordered = [...enabled.slice(start), ...enabled.slice(0, start)];
  const normalized = query.toLocaleLowerCase();
  return ordered.find(index => options[index]!.label.trim().toLocaleLowerCase().startsWith(normalized)) ?? -1;
};

// retain option order within labelled groups
const optionSegments = (options: readonly SettingsSelectOption[]): OptionSegment[] => options.reduce<OptionSegment[]>((segments, option, index) => {
  const last = segments.at(-1);
  // extend only an adjacent group
  if (last !== undefined && last.group === option.group) {
    last.entries.push({ option, index });
    return segments;
  }
  segments.push({ group: option.group, entries: [{ option, index }] });
  return segments;
}, []);

// provide one accessible custom settings selector
export function SettingsSelect({ label, value, options, disabled = false, onChange }: { label: string; value: string; options: readonly SettingsSelectOption[]; disabled?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const typeahead = useRef({ value: '', at: 0 });
  const generatedId = useId().replaceAll(':', '');
  const listboxId = `settings-select-${generatedId}`;
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLButtonElement>(open, { align: 'start', matchAnchorWidth: true });
  const selected = options.find(option => option.value === value);
  const shown = selected ?? { value, label: value };
  const hasIcons = options.some(option => option.icon !== undefined);
  const segments = optionSegments(options);

  // clear transient navigation state
  const closeMenu = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    typeahead.current = { value: '', at: 0 };
  }, []);

  // open at the current choice
  const openMenu = useCallback((edge?: 'first' | 'last') => {
    // ignore unavailable controls
    if (disabled) return;
    setActiveIndex(edge === 'first' ? firstIndex(options) : edge === 'last' ? finalIndex(options) : initialIndex(options, value));
    setOpen(true);
  }, [disabled, options, value]);

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

  // close when the trigger becomes unavailable
  useEffect(() => {
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
  }, [anchorRef, closeMenu, disabled, open]);

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
      else setActiveIndex(current => steppedIndex(options, current, 1));
      return;
    }
    // navigate to the previous choice
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      // open before moving further
      if (!open) openMenu();
      else setActiveIndex(current => steppedIndex(options, current, -1));
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
    const match = matchedIndex(options, activeIndex, query);
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

  return <span className="settings-select">
    <button
      ref={anchorRef}
      type="button"
      role="combobox"
      className="settings-select-trigger"
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-controls={listboxId}
      aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
      data-value={value}
      disabled={disabled}
      onClick={toggleMenu}
      onKeyDown={handleKeyDown}
    >
      {shown.icon !== undefined && <span className="settings-select-current-icon" aria-hidden="true">{shown.icon}</span>}
      <span className="settings-select-current-label">{shown.label}</span>
      <svg className="settings-select-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <FlyoutPortal onDismiss={closeMenu}>
      <div ref={flyoutRef} id={listboxId} className="settings-select-listbox more-menu flyout-menu" role="listbox" aria-label={`${label} options`} data-has-icons={hasIcons || undefined} style={style}>
        {options.length === 0 && <span className="settings-select-empty">No options</span>}
        {/* render adjacent accessible groups */}
        {segments.map((segment, segmentIndex) => {
          const choices = <>{/* render every source choice */}{segment.entries.map(({ option, index }) => {
            const active = index === activeIndex;
            const chosen = option.value === value;
            return <div
              key={`${option.value}:${index}`}
              id={`${listboxId}-option-${index}`}
              className="settings-select-option"
              role="option"
              aria-selected={chosen}
              aria-disabled={option.disabled || undefined}
              data-active={active || undefined}
              data-value={option.value}
              onMouseDown={event => { /* preserve trigger focus */ event.preventDefault(); }}
              onPointerMove={() => { /* follow enabled pointer choices */ if (option.disabled !== true) setActiveIndex(index); }}
              onClick={() => { /* commit one pointer choice */ commitOption(index); }}
            >
              {hasIcons && <span className="settings-select-option-icon" aria-hidden="true">{option.icon}</span>}
              <span className="settings-select-option-label">{option.label}</span>
              <span className="settings-select-option-check" aria-hidden="true">{chosen && <PanelIcon path={panelIcons.check} />}</span>
            </div>;
          })}</>;
          // expose labelled groups to assistive technology
          if (segment.group !== undefined) return <div key={`${segment.group}:${segmentIndex}`} className="settings-select-group" role="group" aria-label={segment.group}><small aria-hidden="true">{segment.group}</small>{choices}</div>;
          return <Fragment key={`ungrouped:${segmentIndex}`}>{choices}</Fragment>;
        })}
      </div>
    </FlyoutPortal>}
  </span>;
}
