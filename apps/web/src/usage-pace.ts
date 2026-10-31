import { booleanPreference } from './browser-preference.js';

// per-browser opt-in to show account limit usage against an even pace through the window
const usagePace = booleanPreference('rac.usage-pace', false);

export const setUsagePace = usagePace.set;
export const useUsagePace = usagePace.use;
