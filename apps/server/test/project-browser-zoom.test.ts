import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { projectBrowserZoom } from '../src/project-browser-zoom.js';

const origin = 'https://console.example.com';
type Point = { screenX: number; screenY: number; clientX: number; clientY: number };

// execute the real bridge with controlled window and touch events
const setup = () => {
  const messages: unknown[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const parent = { postMessage: (message: unknown, target: string) => messages.push({ message, target }) };
  const window = {
    parent,
    // retain a single listener per event type
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    // detach the active listener
    removeEventListener: (type: string) => listeners.delete(type)
  };
  runInNewContext(projectBrowserZoom(origin), { window });
  // simulate a parent state update
  const state = (data: object, trusted = true, senderOrigin = origin) => listeners.get('message')?.({
    source: trusted ? parent : {},
    origin: senderOrigin,
    data: { type: 'rac-browser-zoom-state', generation: 1, ...data }
  });
  // dispatch one touch event and report whether its native action was suppressed
  const touch = (type: string, ...touches: Point[]) => {
    let prevented = false;
    listeners.get(type)?.({ touches, cancelable: true, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { messages, listeners, state, touch };
};

// use distinct screen and iframe-local coordinate spaces
const point = (x: number, y: number): Point => ({ screenX: x, screenY: y, clientX: x * 2, clientY: y * 2 });

describe('project browser zoom bridge', () => {
  it('only intercepts gestures when enabled by the owning console', () => {
    const bridge = setup();
    bridge.state({ zoomed: false }, false);
    expect(bridge.listeners.has('touchstart')).toBe(false);
    bridge.state({ zoomed: false }, true, 'https://unrelated.example.com');
    expect(bridge.listeners.has('touchstart')).toBe(false);
    bridge.state({ zoomed: false });
    expect(bridge.touch('touchstart', point(100, 100))).toBe(false);
    expect(bridge.touch('touchmove', point(100, 120))).toBe(false);
    expect(bridge.touch('touchstart', point(100, 100), point(200, 100))).toBe(true);
    expect(bridge.touch('touchmove', point(50, 110), point(250, 110))).toBe(true);
    expect(bridge.messages.slice(-2)).toEqual([
      { target: origin, message: { type: 'rac-browser-zoom-start', generation: 1, x: 300, y: 200 } },
      { target: origin, message: { type: 'rac-browser-zoom-move', generation: 1, x: 0, y: 10, ratio: 2 } }
    ]);
    bridge.touch('touchcancel');
    expect(bridge.messages.at(-1)).toEqual({ target: origin, message: { type: 'rac-browser-zoom-end', generation: 1 } });
    bridge.state({ disabled: true });
    expect(bridge.listeners.has('touchmove')).toBe(false);
  });

  it('pans a zoomed view without intercepting taps or vertical scrolling at a boundary', () => {
    const bridge = setup();
    bridge.state({ zoomed: true, canPanUp: false, canPanDown: true });
    expect(bridge.touch('touchstart', point(100, 100))).toBe(false);
    expect(bridge.touch('touchend')).toBe(false);
    bridge.touch('touchstart', point(100, 100));
    expect(bridge.touch('touchmove', point(100, 80))).toBe(false);
    bridge.touch('touchend');
    bridge.touch('touchstart', point(100, 100));
    expect(bridge.touch('touchmove', point(100, 98))).toBe(false);
    expect(bridge.touch('touchmove', point(80, 100))).toBe(true);
    expect(bridge.messages.at(-1)).toEqual({ target: origin, message: { type: 'rac-browser-zoom-move', generation: 1, x: -20, y: 0, ratio: 1 } });
  });
  it('cancels active gestures on reset and accepts a fresh pinch', () => {
    const bridge = setup();
    bridge.state({ zoomed: false });
    expect(bridge.touch('touchstart', point(100, 100), point(200, 100))).toBe(true);
    bridge.state({ zoomed: false, reset: true, generation: 2 });
    expect(bridge.touch('touchmove', point(50, 100), point(250, 100))).toBe(false);
    expect(bridge.touch('touchstart', point(100, 100), point(200, 100))).toBe(true);
    expect(bridge.messages.at(-1)).toMatchObject({ message: { generation: 2 } });
  });

  it('disables interception while a document is cached and waits for fresh state', () => {
    const bridge = setup();
    bridge.state({ zoomed: true });
    bridge.touch('touchstart', point(100, 100));
    bridge.listeners.get('pagehide')?.({});
    expect(bridge.listeners.has('touchstart')).toBe(false);
    bridge.listeners.get('pageshow')?.({ persisted: true });
    expect(bridge.messages.at(-1)).toMatchObject({ message: { type: 'rac-browser-zoom-ready' } });
    expect(bridge.listeners.has('touchstart')).toBe(false);
    bridge.state({ zoomed: false, generation: 2 });
    expect(bridge.listeners.has('touchstart')).toBe(true);
  });

  it('waits for the settled viewport before continuing with one finger', () => {
    const bridge = setup();
    bridge.state({ zoomed: false });
    bridge.touch('touchstart', point(100, 100), point(200, 100));
    bridge.touch('touchmove', point(50, 100), point(250, 100));
    bridge.touch('touchend', point(50, 100));
    expect(bridge.messages.at(-1)).toEqual({ target: origin, message: { type: 'rac-browser-zoom-end', generation: 1, continuing: 1 } });
    expect(bridge.touch('touchmove', point(40, 100))).toBe(false);
    bridge.state({ zoomed: true, continuing: 1, canPanUp: true, canPanDown: true });
    expect(bridge.touch('touchmove', point(20, 100))).toBe(true);
    bridge.touch('touchend');
    bridge.touch('touchstart', point(100, 100), point(200, 100));
    bridge.touch('touchend', point(100, 100));
    bridge.state({ zoomed: false, continuing: 2 });
    expect(bridge.touch('touchmove', point(80, 100))).toBe(false);
  });
});
