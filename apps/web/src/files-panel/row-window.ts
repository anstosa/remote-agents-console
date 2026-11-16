import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

const overscan = 8;
type RowWindow = { start: number; end: number; rowHeight: number };

// window fixed-height file rows while retaining one offscreen keyboard focus target
export function useFileRowWindow(count: number, resetKey: string) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const rowHeight = useRef(34);
  const pendingFocus = useRef<{ index: number; last: boolean } | undefined>(undefined);
  const [focused, setFocused] = useState<number>();
  const [range, setRange] = useState<RowWindow>({ start: 0, end: overscan, rowHeight: rowHeight.current });

  // a new folder, read or order starts at the beginning rather than a stale offset
  useLayoutEffect(() => {
    gridRef.current?.scrollTo({ top: 0 });
    pendingFocus.current = undefined;
    setFocused(undefined);
  }, [resetKey]);

  // measure real css geometry and coalesce native scrolling and split resizes
  useLayoutEffect(() => {
    const grid = gridRef.current;
    // an unmounted panel has no viewport to observe
    if (grid === null) return;
    let frame: number | undefined;
    const header = grid.querySelector<HTMLElement>('.files-grid-head');
    // keep spacer math tied to the rendered rem-based row height
    const measure = () => {
      const row = grid.querySelector<HTMLElement>('[data-file-index]');
      const height = row?.getBoundingClientRect().height;
      // hidden panels retain their last usable row measurement
      if (height !== undefined && height > 0) rowHeight.current = height;
      const available = Math.max(0, grid.clientHeight - (header?.getBoundingClientRect().height ?? 0));
      const first = Math.min(Math.max(0, count - 1), Math.floor(grid.scrollTop / rowHeight.current));
      const start = Math.max(0, first - overscan);
      const end = Math.min(count, Math.ceil((grid.scrollTop + available) / rowHeight.current) + overscan);
      // avoid rerendering rows while scrolling within the same window
      setRange(current => current.start === start && current.end === end && current.rowHeight === rowHeight.current ? current : { start, end, rowHeight: rowHeight.current });
    };
    // native scroll and resize callbacks share one pending frame
    const schedule = () => {
      // retain the already queued measurement
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => { frame = undefined; measure(); });
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(grid);
    // rem/font changes also resize the sticky header when the panel height stays fixed
    if (header !== null) observer.observe(header);
    grid.addEventListener('scroll', schedule, { passive: true });
    // detach all viewport work with the panel or listing
    return () => {
      observer.disconnect();
      grid.removeEventListener('scroll', schedule);
      // discard an obsolete measurement after unmount or reset
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [count, resetKey]);

  // focus only after the requested offscreen row has mounted
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    // ordinary pointer scrolling never moves keyboard focus
    if (target === undefined) return;
    const row = gridRef.current?.querySelector<HTMLElement>(`[data-file-index="${target.index}"]`);
    // retain the request until its row commits
    if (row === null || row === undefined) return;
    pendingFocus.current = undefined;
    const controls = row.querySelectorAll<HTMLElement>('button:not(:disabled)');
    (target.last ? controls.item(controls.length - 1) ?? row : row).focus({ preventScroll: true });
  });

  // pin only the currently focused row rather than the entire scrolled interval
  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-file-index]');
    setFocused(row === null ? undefined : Number(row.dataset.fileIndex));
  };
  // release offscreen focus when it leaves the grid for a menu or another panel
  const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    // moving between controls in this grid retains the incoming row's focus
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(undefined);
  };
  // preserve native row/name/actions tab order across an unmounted interval
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // leave activation and selection keys with their existing handlers
    if (event.key !== 'Tab') return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-file-index]');
    // column headers and other grid controls keep native navigation
    if (row === null) return;
    const controls = row.querySelectorAll<HTMLElement>('button:not(:disabled)');
    const boundary = event.shiftKey ? row : controls.item(controls.length - 1) ?? row;
    const index = Number(row.dataset.fileIndex) + (event.shiftKey ? -1 : 1);
    // native tabbing handles row interiors and entry/exit at the table ends
    if (event.target !== boundary || index < 0 || index >= count) return;
    event.preventDefault();
    pendingFocus.current = { index, last: event.shiftKey };
    setFocused(index);
    const grid = event.currentTarget;
    const available = grid.clientHeight - (grid.querySelector('.files-grid-head')?.getBoundingClientRect().height ?? 0);
    const top = index * rowHeight.current;
    // bring the logical neighboring row below the sticky header without horizontal panning
    if (top < grid.scrollTop) grid.scrollTop = top;
    else if (top + rowHeight.current > grid.scrollTop + available) grid.scrollTop = top + rowHeight.current - available;
  };

  const start = Math.min(count, range.start);
  const end = Math.max(start, Math.min(count, range.end));
  const indices = Array.from({ length: end - start }, (_, index) => start + index);
  // retain at most one focused row outside the viewport and overscan
  if (focused !== undefined && focused >= 0 && focused < count) {
    // preserve document order before the visible slice
    if (focused < start) indices.unshift(focused);
    // preserve document order after the visible slice
    else if (focused >= end) indices.push(focused);
  }
  return { gridRef, indices, rowHeight: range.rowHeight, onFocusCapture, onBlurCapture, onKeyDown };
}
