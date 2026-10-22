import { realpathSync } from 'node:fs';
import { consoleRepositoryRoot } from '../adapters/files.js';
import type { Project } from '../domain/models.js';

/**
 * The server's own checkout — where the console keeps its `.data` files and where
 * host-side update scripts live. Deployments used to hard-code it as `/workspace`
 * (the Docker mount); it now comes from `RAC_SERVER_CHECKOUT` — compose sets that
 * to the mount, because the packaged image runs from `/app`, not from a checkout —
 * defaulting to the repository this server actually runs from (systemd, dev). The
 * host-side view resolves through an explicit env override or the configured
 * Project that declares this checkout (ADR 0003).
 *
 * `adapters/files.ts` has a sibling resolver (`hostVisibleRepoRoot`) for rendered
 * adapter files: env-only and fail-closed under the bridge, with no Project
 * fallback — deliberately different, because it gates Adapter launchability while
 * the config (and its Projects) is still being loaded.
 */

// the server's own checkout as this process sees it, canonicalised to match the
// realpath'd `Project.path` the config loader records
export function serverCheckout(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.RAC_SERVER_CHECKOUT?.trim();
  const root = named !== undefined && named.length > 0 ? named : consoleRepositoryRoot();
  try { return realpathSync(root); } catch { return root; }
}

// the server's own checkout as the command-running host sees it: the env override
// (`RAC_HOST_WORKSPACE` / `RAC_HOST_REPOSITORY`), else through the Project declared
// at this checkout — its `hostPath` when mounted from the host, else its own
// `path` (the `worktreeHostRoot` precedence) — and undefined when neither names it
export function serverCheckoutOnHost(projects: ReadonlyArray<Pick<Project, 'path' | 'hostPath'>>, override: string | undefined, checkout: string = serverCheckout()): string | undefined {
  const named = override?.trim();
  if (named !== undefined && named.length > 0) return named;
  const project = projects.find(candidate => candidate.path === checkout);
  return project === undefined ? undefined : project.hostPath ?? project.path;
}
