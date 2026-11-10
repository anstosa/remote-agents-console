import { booleanPreference } from './browser-preference.js';

// per-browser opt-out from account limit usage against an even pace through the window
const usagePace = booleanPreference('rac.usage-pace', true);

export const setUsagePace = usagePace.set;
export const useUsagePace = usagePace.use;
