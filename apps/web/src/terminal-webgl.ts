import type { Terminal } from '@xterm/xterm';
import type { WebglAddon } from '@xterm/addon-webgl';
import { booleanPreference } from './browser-preference.js';

// Per-browser opt-in to draw streamed terminals with WebGL instead of the DOM renderer.
// It is read at mount, so a change applies to terminals opened afterwards.
const webglTerminals = booleanPreference('rac.terminal-webgl', false);

export const setWebglTerminals = webglTerminals.set;
export const useWebglTerminals = webglTerminals.use;

// WebGL rendering is broken in WebKit (xtermjs/xterm.js#5816); revisit once that closes.
// Chromium UAs also say "Safari", so exclude them; every iOS browser is WebKit and stays matched.
const isSafari = () => /^((?!chrome|chromium|android).)*safari/iu.test(navigator.userAgent);

// Set once creating a renderer throws: this browser cannot run it, so stop trying for the
// rest of the page session, as VS Code does.
let unavailable = false;

// Phones keep the DOM renderer for its screenReaderMode text, even when opted in.
export const wantsWebglRenderer = (coarsePointer: boolean): boolean =>
  webglTerminals.get() && !coarsePointer && !isSafari() && !unavailable;

// Load the WebGL renderer into an opened terminal, staying on (or returning to) DOM if it
// fails. `onRendererChange` runs after each swap, since the cell size can differ between
// renderers. The addon is disposed with the terminal; the returned function only stops
// pending work.
export const attachWebglRenderer = (terminal: Terminal, onRendererChange: () => void): (() => void) => {
  let released = false;
  let addon: WebglAddon | undefined;
  // Glyphs rasterised before the web font arrived are cached in the fallback font.
  const refreshGlyphs = () => addon?.clearTextureAtlas();
  const stopFontWatch = () => document.fonts.removeEventListener('loadingdone', refreshGlyphs);

  import('@xterm/addon-webgl').then(addonModule => {
    if (released) return;
    let next: WebglAddon | undefined;
    try {
      next = new addonModule.WebglAddon();
      terminal.loadAddon(next);
    } catch (error) {
      unavailable = true;
      try { next?.dispose(); } catch { /* partially activated; the DOM renderer is still in place */ }
      console.warn('WebGL terminal renderer unavailable; using DOM for this page session', error);
      return;
    }
    addon = next;
    // Disposing the addon restores xterm's DOM renderer; the stream is untouched.
    next.onContextLoss(() => {
      stopFontWatch();
      addon = undefined;
      next.dispose();
      onRendererChange();
    });
    document.fonts.addEventListener('loadingdone', refreshGlyphs);
    void document.fonts.ready.then(() => { if (!released) refreshGlyphs(); });
    onRendererChange();
  }).catch((error: unknown) => {
    // A failed chunk load leaves the DOM renderer in place; a later mount may retry.
    console.warn('WebGL terminal renderer failed to load', error);
  });

  return () => {
    released = true;
    addon = undefined;
    stopFontWatch();
  };
};
