import { booleanPreference } from './browser-preference.js';

// per-browser launcher density, on by default
const dynamicWorktrees = booleanPreference('rac.dynamic-worktrees', true);

export const setDynamicWorktrees = dynamicWorktrees.set;
export const useDynamicWorktrees = dynamicWorktrees.use;
