import type { Terminal } from '@xterm/xterm';
import type { WebglAddon } from '@xterm/addon-webgl';
import { booleanPreference } from './browser-preference.js';

// per-browser opt-out from drawing streamed terminals with WebGL instead of the DOM renderer
// It is read at mount, so a change applies to terminals opened afterwards.
const webglTerminals = booleanPreference('rac.terminal-webgl', true);

export const setWebglTerminals = webglTerminals.set;
export const useWebglTerminals = webglTerminals.use;

// WebGL rendering is broken in WebKit (xtermjs/xterm.js#5816); revisit once that closes.
// Chromium UAs also say "Safari", so exclude them; every iOS browser is WebKit and stays matched.
const isSafari = () => /^((?!chrome|chromium|android).)*safari/iu.test(navigator.userAgent);

// Set once creating a renderer throws: this browser cannot run it, so stop trying for the
// rest of the page session, as VS Code does.
let unavailable = false;

// phones keep the DOM renderer for its screenReaderMode text, even when enabled
export const wantsWebglRenderer = (coarsePointer: boolean): boolean =>
  webglTerminals.get() && !coarsePointer && !isSafari() && !unavailable;

// load every terminal face before glyphs enter the shared gpu atlas
const loadTerminalFonts = async (terminal: Terminal): Promise<void> => {
  const { fontFamily, fontSize, fontWeight, fontWeightBold } = terminal.options;
  const face = `${fontSize}px ${fontFamily}`;
  const glyphs = 'W\ue0b0';
  const faces = await Promise.allSettled([
    document.fonts.load(`${fontWeight} ${face}`, glyphs),
    document.fonts.load(`italic ${fontWeight} ${face}`, glyphs),
    document.fonts.load(`${fontWeightBold} ${face}`, glyphs),
    document.fonts.load(`italic ${fontWeightBold} ${face}`, glyphs)
  ]);
  await document.fonts.ready;
  // propagate preload failures only after the remaining faces have settled
  const failed = faces.find(face => face.status === 'rejected');
  // failed faces select the dom fallback rather than entering the gpu atlas
  if (failed) throw failed.reason;
};

// settle the initial renderer selection and report later fallback swaps
// the terminal owns addon disposal; release only cancels pending initialization
export const attachWebglRenderer = (terminal: Terminal, onRendererChange: () => void): (() => void) => {
  let released = false;

  // addon 0.19 shares atlases without safely invalidating sibling glyph models (#6014)
  // preload instead of clearing shared textures; revisit with a fixed stable addon
  Promise.allSettled([import('@xterm/addon-webgl'), loadTerminalFonts(terminal)]).then(([addon, fonts]) => {
    // disposed terminals must not acquire a renderer after async loading
    if (released) return;
    // a failed download must still wait for font preparation before fallback
    if (addon.status === 'rejected') throw addon.reason;
    // a failed face must not create a partially prepared gpu atlas
    if (fonts.status === 'rejected') throw fonts.reason;
    let next: WebglAddon | undefined;
    try {
      next = new addon.value.WebglAddon();
      terminal.loadAddon(next);
    } catch (error) {
      unavailable = true;
      try { next?.dispose(); } catch { /* partially activated; the DOM renderer is still in place */ }
      console.warn('WebGL terminal renderer unavailable; using DOM for this page session', error);
      onRendererChange();
      return;
    }
    // Disposing the addon restores xterm's DOM renderer; the stream is untouched.
    next.onContextLoss(() => {
      next.dispose();
      onRendererChange();
    });
    onRendererChange();
  }).catch((error: unknown) => {
    // ignore late failures after the terminal has been disposed
    if (released) return;
    // failed assets leave the dom renderer usable rather than a permanent skeleton
    console.warn('WebGL terminal renderer failed to load', error);
    onRendererChange();
  });

  // prevent late renderer activation after unmount
  return () => { released = true; };
};
