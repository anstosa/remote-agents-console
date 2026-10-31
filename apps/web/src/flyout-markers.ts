import { booleanPreference } from './browser-preference.js';

// include portaled controls in the preference
const apply = (enabled: boolean): void => {
  if (typeof document === 'undefined') return;
  if (enabled) document.documentElement.dataset.flyoutMarkers = 'enabled';
  else delete document.documentElement.dataset.flyoutMarkers;
};

// per-browser flyout marker opt-in
const flyoutMarkers = booleanPreference('rac.flyout-markers', false, apply);

export const setFlyoutMarkers = flyoutMarkers.set;
export const useFlyoutMarkers = flyoutMarkers.use;

// apply stored markers and consume an explicit opt-in link
export const applyFlyoutMarkers = (): void => {
  const url = new URL(window.location.href);
  // allow a settings link to enable this browser only
  if (url.searchParams.get('flyout-markers') === 'enabled') {
    setFlyoutMarkers(true);
    url.searchParams.delete('flyout-markers');
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  apply(flyoutMarkers.get());
};
