import { createContext, type KeyboardEvent, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useViewportFlyout } from '../viewport-flyout.js';
import type { SettingsSearchResult } from './search-index.js';

// reveal collection editors without editing their underlying settings
export const SettingsSearchPath = createContext<readonly string[] | undefined>(undefined);
export type SettingsSearchDestination = { result: SettingsSearchResult; request: number };

// highlight literal query words without interpreting settings metadata as markup
function SearchMatch({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/u).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const pattern = words.length === 0 ? undefined : new RegExp(`(${words.join('|')})`, 'giu');
  return <>{pattern === undefined ? text : text.split(pattern).map((part, index) => index % 2 === 1 ? <mark key={index}>{part}</mark> : part)}</>;
}

// search safe metadata while keeping every settings page in navigation
export function SettingsSearch({ index, onSelect, active }: { index: SettingsSearchResult[]; onSelect: (result: SettingsSearchResult) => void; active: boolean }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const listId = `settings-search-${useId().replaceAll(':', '')}`;
  const results = useMemo(() => {
    const words = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    // keep the closed empty query free of a full catalog dump
    if (words.length === 0) return [];
    return index.filter(result => {
      const text = `${result.label} ${result.breadcrumbs.join(' ')} ${result.keywords ?? ''}`.toLocaleLowerCase();
      return words.every(word => text.includes(word));
    }).sort((left, right) => {
      // prefer exact names before broader description and breadcrumb matches
      const score = (result: SettingsSearchResult) => result.label.toLocaleLowerCase() === query.trim().toLocaleLowerCase() ? 0 : words.every(word => result.label.toLocaleLowerCase().includes(word)) ? 1 : 2;
      return score(left) - score(right) || (left.kind === right.kind ? 0 : left.kind === 'page' ? -1 : 1);
    });
  }, [index, query]);
  const expanded = open && active && query.trim() !== '';
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLDivElement>(expanded, { align: 'start', matchAnchorWidth: true });
  const close = useCallback(() => { setOpen(false); setActiveIndex(-1); }, []);

  // dismiss a search that belongs to a hidden settings split
  useEffect(() => { if (!active) close(); }, [active, close]);

  // dismiss without consuming the operator's interaction with another control
  useEffect(() => {
    // listen only while results are displayed
    if (!expanded) return;
    const dismissOutside = (event: Event) => {
      const target = event.target;
      // retain typing and result interactions inside the attached search
      if (target instanceof Node && !anchorRef.current?.contains(target) && !flyoutRef.current?.contains(target)) close();
    };
    document.addEventListener('pointerdown', dismissOutside);
    document.addEventListener('focusin', dismissOutside);
    return () => { document.removeEventListener('pointerdown', dismissOutside); document.removeEventListener('focusin', dismissOutside); };
  }, [anchorRef, close, expanded, flyoutRef]);

  // keep keyboard-selected results inside the popup's own scrollport
  useLayoutEffect(() => {
    const popup = flyoutRef.current;
    const option = popup?.querySelector<HTMLElement>(`[data-result-index="${activeIndex}"]`);
    // ignore an inactive or unavailable option
    if (!expanded || popup === null || popup === undefined || option === null || option === undefined) return;
    const top = option.offsetTop;
    // scroll only the results rather than the settings split or document
    if (top < popup.scrollTop) popup.scrollTop = top;
    else if (top + option.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = top + option.offsetHeight - popup.clientHeight;
  }, [activeIndex, expanded, flyoutRef]);

  // navigate only after an explicit click or keyboard selection
  const choose = (result: SettingsSearchResult | undefined) => {
    // loading pages remain discoverable without opening invented data
    if (result === undefined || result.disabled) return;
    close();
    onSelect(result);
  };
  // retain focus in the searchbox while navigating attached results
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // close without clearing the query or closing the settings split
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    // move only between ready search destinations
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const enabled = results.flatMap((result, index) => result.disabled ? [] : [index]);
      const current = enabled.indexOf(activeIndex);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0 ? step > 0 ? 0 : enabled.length - 1 : (current + step + enabled.length) % enabled.length;
      setActiveIndex(enabled[next] ?? -1);
    // enter commits a result only while its popup is visible
    } else if (event.key === 'Enter' && expanded) {
      event.preventDefault();
      choose(results[activeIndex] ?? results.find(result => !result.disabled));
    }
  };
  return <div className="settings-search" ref={anchorRef}>
    <input ref={input} type="search" aria-label="Search settings" placeholder="Search all settings" value={query} autoComplete="off" spellCheck={false} aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && activeIndex >= 0 && results[activeIndex] !== undefined ? `${listId}-${activeIndex}` : undefined} onChange={event => { /* search metadata as each character is entered */ setQuery(event.target.value); setActiveIndex(-1); setOpen(true); }} onFocus={() => { /* reopen retained results without changing the current page */ setOpen(true); }} onKeyDown={onKeyDown} />
    {expanded && createPortal(<div ref={flyoutRef} id={listId} className="settings-search-results" role="listbox" aria-label="Settings search results" style={{ ...style, maxHeight: `min(26rem, ${style.maxHeight ?? '26rem'})` }}>
      {results.length === 0 ? <div className="settings-search-empty" role="status">No matching settings.</div> : results.map((result, resultIndex) => <div id={`${listId}-${resultIndex}`} key={result.id} data-result-index={resultIndex} className="settings-search-result" role="option" aria-selected={activeIndex === resultIndex} aria-disabled={result.disabled || undefined} onPointerMove={() => { /* follow the pointer without moving textbox focus */ setActiveIndex(resultIndex); }} onMouseDown={event => { /* retain textbox focus until navigation commits */ event.preventDefault(); }} onClick={() => { /* visit this exact page or field */ choose(result); }}>
        <span className="settings-search-result-title"><strong><SearchMatch text={result.label} query={query} /></strong><small>{result.kind === 'page' ? 'Page' : 'Field'}{result.disabled && ' · Unavailable'}</small></span>
        <span className="settings-search-breadcrumb">{result.kind === 'field' && <SearchMatch text={result.breadcrumbs.join(' › ')} query={query} />}</span>
      </div>)}
    </div>, document.body)}
  </div>;
}

// scroll and mark a destination after any nested collection editors have opened
export function useSettingsSearchNavigation(panel: RefObject<HTMLDivElement | null>, destination: SettingsSearchDestination | undefined) {
  useLayoutEffect(() => {
    const container = panel.current;
    // wait for a requested destination in a mounted content pane
    if (container === null || destination === undefined) return;
    let marked: HTMLElement | undefined;
    let addedTabIndex = false;
    let frame = 0;
    const path = destination.result.path;
    const reveal = () => {
      const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-settings-path]'));
      const exact = path === undefined ? undefined : nodes.find(node => node.dataset.settingsSearchPath === JSON.stringify(path)) ?? nodes.find(node => node.dataset.settingsSearchPath === undefined && node.dataset.settingsPath === path.join('.'));
      const target = path === undefined ? container.querySelector<HTMLElement>('.settings-source-header') ?? container : exact;
      // wait for an exact field while existing collection editors mount
      if (target === undefined) return;
      // open only non-mutating file disclosure containers around an existing target
      for (let parent = target.parentElement; parent !== null && parent !== container; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
      }
      // preserve focus and scroll when unrelated descendants rerender
      if (target === marked || target.getClientRects().length === 0) return;
      marked?.removeAttribute('data-settings-search-highlight');
      // retire the previous temporary focus target
      if (addedTabIndex) marked?.removeAttribute('tabindex');
      marked = target;
      marked.dataset.settingsSearchHighlight = 'true';
      addedTabIndex = !marked.hasAttribute('tabindex');
      // make the highlighted group focusable without adding a tab stop
      if (addedTabIndex) marked.tabIndex = -1;
      marked.focus({ preventScroll: true });
      const offset = marked.getBoundingClientRect().top - container.getBoundingClientRect().top;
      container.scrollTo({ top: Math.max(0, container.scrollTop + offset - 20), behavior: 'instant' });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(reveal); };
    const observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, subtree: true });
    schedule();
    // keep the destination visible without a distracting indefinite highlight
    const timer = window.setTimeout(() => {
      observer.disconnect();
      marked?.removeAttribute('data-settings-search-highlight');
      // retire temporary programmatic focus when the highlight expires
      if (addedTabIndex) marked?.removeAttribute('tabindex');
      addedTabIndex = false;
    }, 5000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      observer.disconnect();
      marked?.removeAttribute('data-settings-search-highlight');
      // restore the original keyboard navigation order
      if (addedTabIndex) marked?.removeAttribute('tabindex');
    };
  }, [destination, panel]);
}
