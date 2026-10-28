// The display choices both diff renderers (the Code panel and the Review tour) offer — unified vs
// split, and ignoring whitespace — and the one width rule that gates split: it needs a wide column, so
// below SPLIT_MIN_WIDTH — a phone, or a squeezed desktop column — that choice is hidden and the diff
// renders unified. The width is the renderer's own (not the viewport's), measured with
// useObservedWidth. Library-free, so it adds nothing to either lazy chunk beyond these few lines.
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

// Below this width a diff is always unified (the Code panel also folds its file rail into a drawer here).
export const SPLIT_MIN_WIDTH = 640;

// A diff display choice shared by every diff on this browser and remembered across reloads: on while
// `key` holds `value`, off while it is absent.
const storedFlag = (key: string, value: string): (() => [boolean, (on: boolean) => void]) => {
  const listeners = new Set<() => void>();
  const read = (): boolean => {
    try { return localStorage.getItem(key) === value; }
    catch { return false; }
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const write = (on: boolean): void => {
    try {
      if (on) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch { /* private-mode storage is non-fatal */ }
    listeners.forEach(listener => listener());
  };
  const useFlag = (): [boolean, (on: boolean) => void] => [useSyncExternalStore(subscribe, read, read), write];
  return useFlag;
};

// The last Unified / Split pick. It is only the preference: a diff too narrow for split still renders
// unified without changing it.
export const useDiffSplit = storedFlag('rac.diff-split', 'split');
// Whether diffs hide changes that are only whitespace (see withoutWhitespaceChanges).
export const useIgnoreWhitespace = storedFlag('rac.diff-ignore-whitespace', 'ignore');

// Track an element's own content width through a callback ref, so the observer re-attaches whenever
// the element remounts. Reports +Infinity until the first measurement.
export const useObservedWidth = (): [(node: HTMLElement | null) => void, number] => {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    if (node === null) { observer.current = undefined; return; }
    observer.current = new ResizeObserver(entries => setWidth(entries[0]?.contentRect.width ?? node.clientWidth));
    observer.current.observe(node);
  }, []);
  return [ref, width];
};

// The Unified / Split segmented control; the caller decides whether there is room to show it.
export const DiffLayoutSegment = ({ split, onChange }: { split: boolean; onChange: (split: boolean) => void }) => (
  <span className="code-pane-segment" role="group" aria-label="Diff layout">
    <button type="button" aria-pressed={!split} onClick={() => onChange(false)}>Unified</button>
    <button type="button" aria-pressed={split} onClick={() => onChange(true)}>Split</button>
  </span>
);
