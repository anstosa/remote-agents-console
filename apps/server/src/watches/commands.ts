import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AdapterConfigs, AgentKind } from '../adapters/types.js';
import { structuredAdapterFor } from '../adapters/registry.js';
import type { HolderRef, HolderStatus, HolderWindows } from '../transports/structured-agents.js';
import { connectHolder } from '../transports/structured.js';
import type { CommandWindows } from './service.js';

// the sandboxed command runner beside this module: compiled in a build, its source under tsx otherwise
const runner = (): string[] => {
  const compiled = fileURLToPath(new URL('./sandboxed-command.js', import.meta.url));
  return existsSync(compiled) ? [compiled] : ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, compiled.replace(/\.js$/u, '.ts')];
};

/**
 * Command Watches' windows (ADR 0019): each runs its command under the holder (ADR 0016) in a
 * window of the Place's Workspace session, sandboxed as its owner's kind sandboxes the model's
 * commands, with the kind's configured environment for the allowlist to pick from. A kind with no
 * sandbox runs none.
 */
export function commandWindows(windows: HolderWindows & { holderStatus(holder: HolderRef): Promise<HolderStatus | undefined> }, configs: AdapterConfigs, files: (kind: AgentKind) => Promise<Record<string, string> | undefined>): CommandWindows {
  return {
    async open(place, watchId, command, kind) {
      const adapter = structuredAdapterFor(kind);
      const env = configs[kind]?.env ?? {};
      const policy = (await files(kind))?.['sandbox.json'];
      if (adapter?.sandbox !== true || adapter.stateDir === undefined || policy === undefined) return undefined;
      return await windows.openHolderWindow(place, watchId, { program: process.execPath, args: [...runner(), command], env: { ...env, RAC_SANDBOX_POLICY: policy, RAC_SANDBOX_STATE_DIR: adapter.stateDir(env) } });
    },
    async connect(holder, from) {
      const connected = await connectHolder(holder.socket, { from });
      return connected === undefined ? undefined : { channel: connected.channel, from: connected.hello.from };
    },
    status: holder => windows.holderStatus(holder),
    close: holder => windows.closeHolder(holder)
  };
}
