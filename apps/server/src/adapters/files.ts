import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, structuredAdapters } from './registry.js';
import type { AdapterFileContext, AgentKind, SandboxSettings } from './types.js';

/**
 * Boot-time rendering of the console-owned files each Adapter declares through its
 * `files` capability (ADR 0001/0002). The console writes each into
 * `<RAC_ADAPTER_FILES_DIR ?? <repoRoot>/.data/adapters>/<kind>/<name>` (0644,
 * rewritten every boot) and hands the absolute paths back to the launch layer,
 * which passes them to `Adapter.launch` through `LaunchInput.files`.
 */

/** The absolute paths of one kind's rendered files, keyed by name. */
export type RenderedAdapterFiles = Partial<Record<AgentKind, Record<string, string>>>;

// replace one rendered path without following a preseeded destination link
async function replaceRenderedFile(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(16).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(content);
    await handle.chmod(0o644);
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    created = false;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // remove only a temporary file this call created
    if (created) await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

// under the host bridge the agent runs on the host, outside this container
function isBridged(env: NodeJS.ProcessEnv): boolean {
  return env.RAC_HOST_TMUX_DIR !== undefined;
}

// The console's own checkout root — where `scripts/hooks/rac-attention` lives —
// derived from this module's location (`apps/server/{src,dist}/adapters` → four up),
// with the trailing slash trimmed.
export function consoleRepositoryRoot(): string {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  return root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
}

/**
 * The host-visible checkout root the rendered content and file paths are named
 * against. Under the host bridge the agent runs on the host, so it must be a host
 * path (`RAC_HOST_REPOSITORY`); without one, `undefined` — which leaves every
 * file-rendering kind unlaunchable. Off the bridge it defaults to the console's own
 * checkout. `workspaces/server-checkout.ts` answers the sibling question for stack
 * files and server updates with a Project fallback this resolver deliberately
 * lacks: this one gates launchability while the config is still being loaded.
 */
export function hostVisibleRepoRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const hostRepo = env.RAC_HOST_REPOSITORY?.trim();
  const named = hostRepo !== undefined && hostRepo.length > 0 ? hostRepo : undefined;
  return isBridged(env) ? named : named ?? consoleRepositoryRoot();
}

/**
 * The boot rendering context (the host-visible `repoRoot`, and the tmux binary to
 * bake into hooks — omitted under the bridge) and the directory to write into, or
 * `undefined` when no host-visible repo root exists (a bridge without
 * `RAC_HOST_REPOSITORY`).
 */
export function adapterFileContext(env: NodeJS.ProcessEnv = process.env): { context: AdapterFileContext; filesDir: string } | undefined {
  const repoRoot = hostVisibleRepoRoot(env);
  if (repoRoot === undefined) return undefined;
  const filesDir = env.RAC_ADAPTER_FILES_DIR ?? join(repoRoot, '.data', 'adapters');
  const tmuxBin = isBridged(env) ? undefined : env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  return { context: { repoRoot, ...(tmuxBin === undefined ? {} : { tmuxBin }) }, filesDir };
}

/**
 * Render every Adapter's `files`, each given its kind's sandbox settings when `sandbox` has
 * them, and return the absolute paths, keyed by kind and
 * name, for `LaunchInput.files`. Returns `{}` when no host-visible repo root exists
 * (a bridge without `RAC_HOST_REPOSITORY`), matching the launchability gate.
 */
export async function renderAdapterFiles(env: NodeJS.ProcessEnv = process.env, sandbox: (kind: AgentKind) => SandboxSettings | undefined = () => undefined): Promise<RenderedAdapterFiles> {
  const resolved = adapterFileContext(env);
  if (resolved === undefined) return {};
  const { context, filesDir } = resolved;
  const rendered: RenderedAdapterFiles = {};
  for (const adapter of [...adapters, ...structuredAdapters]) {
    if (adapter.files === undefined) continue;
    const dir = join(filesDir, adapter.kind);
    await mkdir(dir, { recursive: true });
    const paths: Record<string, string> = {};
    const settings = sandbox(adapter.kind);
    for (const [name, content] of Object.entries(adapter.files({ ...context, ...(settings === undefined ? {} : { sandbox: settings }) }))) {
      const path = join(dir, name);
      await replaceRenderedFile(path, content);
      paths[name] = path;
    }
    // a kind registered for both Transports renders into one directory
    rendered[adapter.kind] = { ...rendered[adapter.kind], ...paths };
  }
  return rendered;
}
