import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { run } from '../tmux/command.js';

// accept one real account path without terminal or record delimiters
const absoluteHome = (value: string | undefined): value is string => value !== undefined && isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);

/** blank adapter HOME means inheritance rather than an empty process home. */
export function inheritedHomeEnvironment(environment: Record<string, string> = {}, fallback?: string): Record<string, string> {
  const resolved = { ...environment };
  // preserve explicit overrides and every unrelated environment value
  if (resolved.HOME === undefined || resolved.HOME.trim() === '') {
    delete resolved.HOME;
    // materialize only a known runtime default, never a persisted source value
    if (fallback !== undefined) resolved.HOME = fallback;
  }
  return resolved;
}

/** resolve the launch user without inferring identity from repository paths. */
export async function resolveLaunchUserHome(environment: NodeJS.ProcessEnv = process.env, command: typeof run = run): Promise<string | undefined> {
  // Docker's HOME is not authority for the account behind the host bridge
  if (environment.RAC_HOST_TMUX_DIR !== undefined) {
    try {
      const result = await command(environment.RAC_TMUX_BIN ?? '/usr/bin/tmux', ['-S', join(environment.RAC_HOST_TMUX_DIR, 'default'), 'show-environment', '-g', 'HOME'], undefined, 1_500);
      // reject failed, truncated, or substituted environment records
      if (result.code !== 0 || result.timedOut || result.stdoutTruncated || !result.stdout.startsWith('HOME=')) return undefined;
      const home = result.stdout.slice(5).replace(/\r?\n$/u, '');
      return absoluteHome(home) ? home : undefined;
    } catch { return undefined; }
  }
  // native deployments inherit their own account environment
  if (absoluteHome(environment.HOME)) return environment.HOME;
  try {
    const home = userInfo().homedir;
    return absoluteHome(home) ? home : undefined;
  } catch { return undefined; }
}
