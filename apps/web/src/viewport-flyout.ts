import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';

type ViewportFlyoutPlacement = 'vertical'|'above'|'left';
// align vertical flyouts at the anchor's left, centre or right
// matchContainerWidth keeps a flyout within its ancestor panel
// trackAnchor exposes viewport coordinates for a pointer within clipped anchor bounds
type ViewportFlyoutOptions = { placement?: ViewportFlyoutPlacement; align?: 'start'|'center'|'end'; boundarySelector?: string; boundaryRootSelector?: string; contentSized?: boolean; matchAnchorWidth?: boolean; matchContainerWidth?: string; trackAnchor?: { clippingSelector: string; halfWidth: number } };
type ViewportFlyoutStyle = CSSProperties & { '--flyout-available-height'?: string; '--flyout-anchor-x'?: string; '--flyout-anchor-top'?: string };

// position one portal flyout within the viewport
export function useViewportFlyout<T extends HTMLElement = HTMLSpanElement>(open: boolean, options: ViewportFlyoutOptions = {}) {
  const { placement = 'vertical', align = 'end', boundarySelector, boundaryRootSelector, contentSized = false, matchAnchorWidth = false, matchContainerWidth, trackAnchor } = options;
  const pointerClippingSelector = trackAnchor?.clippingSelector;
  const pointerHalfWidth = trackAnchor?.halfWidth;
  const anchorRef = useRef<T | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<ViewportFlyoutStyle>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    // clear the last direction when the flyout closes
    if (!open) { anchorRef.current?.removeAttribute('data-flyout-side'); setStyle({ visibility: 'hidden' }); return; }
    const position = () => {
      const anchor = anchorRef.current;
      const flyout = flyoutRef.current;
      if (!anchor || !flyout) return;
      const { top, right, bottom, left: anchorLeft } = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const container = matchContainerWidth === undefined ? undefined : anchor.closest(matchContainerWidth)?.getBoundingClientRect();
      const containerLeft = Math.max(margin, (container?.left ?? 0) + margin);
      const containerWidth = container && Math.min(window.innerWidth - margin, container.right - margin) - containerLeft;
      const width = Math.max(1, Math.min(containerWidth ?? (matchAnchorWidth ? right - anchorLeft : flyout.offsetWidth), window.innerWidth - margin * 2));
      // keep side flyouts top-aligned until their lower boundary
      if (placement === 'left') {
        anchor.dataset.flyoutSide = 'left';
        const boundaryRoot = boundaryRootSelector === undefined ? anchor.ownerDocument : anchor.closest(boundaryRootSelector);
        const boundary = boundarySelector === undefined ? undefined : boundaryRoot?.querySelector(boundarySelector);
        const boundaryBounds = boundary?.getBoundingClientRect();
        const upperEdge = Math.max(margin, boundaryBounds?.top ?? margin);
        const lowerEdge = Math.min(window.innerHeight - margin, boundaryBounds?.bottom ?? window.innerHeight - margin);
        const availableHeight = Math.max(1, lowerEdge - upperEdge);
        const leftEdge = Math.max(margin, boundaryBounds?.left ?? margin);
        const availableWidth = Math.max(1, anchorLeft - gap - leftEdge);
        const sideWidth = Math.min(width, availableWidth);
        const height = Math.min(flyout.getBoundingClientRect().height, availableHeight);
        const flyoutTop = Math.max(upperEdge, Math.min(top, lowerEdge - height));
        const left = Math.max(leftEdge, anchorLeft - sideWidth - gap);
        setStyle({ position: 'fixed', top: flyoutTop, left, right: 'auto', bottom: 'auto', width: contentSized ? 'max-content' : sideWidth, maxWidth: `${contentSized ? availableWidth : window.innerWidth - margin * 2}px`, '--flyout-available-height': `${availableHeight}px`, visibility: 'visible' });
        return;
      }
      const below = window.innerHeight - bottom - gap;
      const above = top - gap;
      const side = placement === 'above' || below < above ? 'above' : 'below';
      // match the trigger's caret to the actual opening edge
      anchor.dataset.flyoutSide = side;
      const maxHeight = Math.max(1, side === 'below' ? below : above);
      // a content-sized flyout keeps its own CSS width and height cap, told only the room it has
      const height = Math.min(contentSized ? flyout.offsetHeight : flyout.scrollHeight, maxHeight);
      const flyoutTop = side === 'below' ? bottom + gap : top - height - gap;
      // centre the split chooser over its full-width trigger when requested
      const preferredLeft = align === 'start' ? anchorLeft : align === 'center' ? (anchorLeft + right - width) / 2 : right - width;
      const left = containerWidth === undefined ? Math.max(margin, Math.min(preferredLeft, window.innerWidth - width - margin)) : containerLeft;
      let pointer: Pick<ViewportFlyoutStyle, '--flyout-anchor-x' | '--flyout-anchor-top'> = {};
      // point to the visible portion without detaching from the flyout edge
      if (pointerClippingSelector !== undefined && pointerHalfWidth !== undefined) {
        const clip = anchor.closest(pointerClippingSelector)?.getBoundingClientRect();
        const visibleLeft = Math.max(anchorLeft, clip?.left ?? 0, 0);
        const visibleRight = Math.min(right, clip?.right ?? window.innerWidth, window.innerWidth);
        // a completely clipped anchor or too narrow flyout has no usable pointer
        if (visibleRight > visibleLeft && width >= pointerHalfWidth * 2) {
          const center = Math.max(left + pointerHalfWidth, Math.min((visibleLeft + visibleRight) / 2, left + width - pointerHalfWidth));
          pointer = { '--flyout-anchor-x': `${center}px`, '--flyout-anchor-top': `${top}px` };
        }
      }
      setStyle({ position: 'fixed', top: flyoutTop, left, right: 'auto', bottom: 'auto', width: contentSized ? 'max-content' : width, maxWidth: `${window.innerWidth - margin * 2}px`, ...(contentSized ? { '--flyout-available-height': `${maxHeight}px` } : { maxHeight: `${maxHeight}px` }), ...pointer, visibility: 'visible' });
    };
    position();
    const observer = new ResizeObserver(position);
    if (anchorRef.current) observer.observe(anchorRef.current);
    if (flyoutRef.current) observer.observe(flyoutRef.current);
    // a container resized without the window (a dragged panel divider) moves the flyout's edges
    const container = matchContainerWidth === undefined ? undefined : anchorRef.current?.closest(matchContainerWidth);
    if (container) observer.observe(container);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [align, boundaryRootSelector, boundarySelector, contentSized, matchAnchorWidth, matchContainerWidth, open, placement, pointerClippingSelector, pointerHalfWidth]);
  return { anchorRef, flyoutRef, style };
}
