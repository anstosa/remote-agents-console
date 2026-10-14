// The unified-vs-split choice both diff renderers (the Code panel and the Review tour) offer, and the
// one width rule that gates it: a split diff needs a wide column, so below SPLIT_MIN_WIDTH — a phone,
// or a squeezed desktop column — the choice is hidden and the diff renders unified. The width is the
// renderer's own (not the viewport's), measured with useObservedWidth. Library-free, so it adds
// nothing to either lazy chunk beyond these few lines.
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';

// Below this width a diff is always unified (the Code panel also folds its file rail into a drawer here).
export const SPLIT_MIN_WIDTH = 640;

// The last Unified / Split pick, shared by every diff on this browser and remembered across reloads.
// It is only the preference: a diff too narrow for split still renders unified without changing it.
const diffSplitKey = 'rac.diff-split';
const splitListeners = new Set<() => void>();
const readDiffSplit = (): boolean => {
  try { return localStorage.getItem(diffSplitKey) === 'split'; }
  catch { return false; }
};
const subscribeDiffSplit = (listener: () => void): (() => void) => {
  splitListeners.add(listener);
  return () => { splitListeners.delete(listener); };
};
const setDiffSplit = (split: boolean): void => {
  try {
    if (split) localStorage.setItem(diffSplitKey, 'split');
    else localStorage.removeItem(diffSplitKey);
  } catch { /* private-mode storage is non-fatal */ }
  splitListeners.forEach(listener => listener());
};
export const useDiffSplit = (): [boolean, (split: boolean) => void] =>
  [useSyncExternalStore(subscribeDiffSplit, readDiffSplit, readDiffSplit), setDiffSplit];

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
