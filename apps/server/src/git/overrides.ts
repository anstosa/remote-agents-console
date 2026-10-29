/**
 * What the console's own git never takes from a repository it runs in (ADR 0004). A Sandboxed
 * Agent may write to a Worktree, so nothing there may make the console's git run code: no
 * fsmonitor or hooks, no look inside a submodule (whose own configuration a command may have
 * written; its recorded commit still shows), no fetch into one, and no bare repository git would
 * discover at the Worktree root once its `.git` is broken. Passed in the environment, these take precedence
 * over every configuration file, and reach any git the console's git starts.
 */
const overrides: ReadonlyArray<[key: string, value: string]> = [
  ['safe.bareRepository', 'explicit'],
  ['diff.ignoreSubmodules', 'dirty'],
  ['fetch.recurseSubmodules', 'false'],
  ['submodule.recurse', 'false'],
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null']
];

/** The environment that sets the overrides for a git process. */
export const gitOverrideEnv = (): Record<string, string> => Object.fromEntries([
  ['GIT_CONFIG_COUNT', String(overrides.length)],
  ...overrides.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])
]);
