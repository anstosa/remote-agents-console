import { execFile } from 'node:child_process';
import type { ReplacedFlagValue, ReviewRuns, ReviewRunSettings } from '../adapters/types.js';
import { safeEnv } from '../tmux/command.js';

// the operator flags one interactive Review run drops: always its kind's read-only ones, the model
// and effort ones only when the run sets its own
export function reviewReplacedFlags(interactive: ReviewRuns['interactive'], run: ReviewRunSettings): ReadonlyMap<string, ReplacedFlagValue> {
  const replaced = [...(run.model === undefined ? [] : interactive.modelFlags), ...(run.effort === undefined ? [] : interactive.effortFlags)];
  return new Map<string, ReplacedFlagValue>([...interactive.readOnlyFlags, ...replaced.map((flag): [string, ReplacedFlagValue] => [flag, 'one'])]);
}

// The arguments that keep an interactive Review run off every MCP server its kind would load in a
// directory, whose tools run outside the read-only policy: the servers listed as the launch's
// environment (the restricted pane environment with the Adapter's own overlaid) would see them,
// each disabled by name. Undefined when they cannot be listed or a name cannot be addressed safely:
// the run must not launch.
export async function mcpDisableArgs(mcp: NonNullable<ReviewRuns['interactive']['mcp']>, program: string, cwd: string, env: Record<string, string>, timeoutMs = 10_000): Promise<string[] | undefined> {
  const listed = await new Promise<string | undefined>(resolve => {
    execFile(program, [...mcp.list], { cwd, env: { ...safeEnv(), ...env }, timeout: timeoutMs, maxBuffer: 1_000_000 }, (error, stdout) => { resolve(error === null ? stdout : undefined); });
  });
  const names = listed === undefined ? undefined : mcp.servers(listed);
  return names === undefined ? undefined : mcp.disable(names);
}
