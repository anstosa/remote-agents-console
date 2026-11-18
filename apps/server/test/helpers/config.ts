import type { ValidatedConfig } from '../../src/config/schema.js';
import type { Project, PromptAction, Worktree } from '../../src/domain/models.js';

const defaultPush: PromptAction = { label: 'Commit/Push', prompt: 'review, commit, and push' };

/**
 * The canonical validated config every HTTP-layer test starts from. Spread
 * overrides for the fields a test cares about, e.g.
 * `testConfig({ projects: [testProject()] })`.
 */
export function testConfig(overrides: Partial<ValidatedConfig> = {}): ValidatedConfig {
  return {
    name: 'Remote Agents',
    remoteServers: [],
    listen: { host: '127.0.0.1', port: 8787 },
    publicOrigin: new URL('https://agents.example.com'),
    trustedProxyIps: new Set(['127.0.0.1']),
    pollIntervalMs: 500,
    adapters: {},
    replySuggestions: false,
    resourceMonitoring: false,
    projects: [],
    ...overrides,
  };
}

/** A configured Project (config `projects[]`). Override any field. */
export function testProject(overrides: Partial<Project> = {}): Project {
  const path = overrides.path ?? '/repo';
  return { id: 'proj', label: 'Proj', path, identity: `${path}/.git`, mode: 'repository', worktreesDirectory: `${path}-worktrees`, available: true, push: defaultPush, ...overrides };
}

/**
 * One discovered Worktree, as `DiscoveryService.worktreesNow()`/`dashboard()` would
 * report it. The wire id defaults to `<projectId>:<path>`; override `main`/`branch`
 * etc. for a Linked or detached checkout.
 */
export function testWorktree(overrides: Partial<Worktree> = {}): Worktree {
  const projectId = overrides.projectId ?? 'proj';
  const path = overrides.path ?? '/repo';
  return { id: overrides.id ?? `${projectId}:${path}`, projectId, label: overrides.label ?? 'Proj', path, identity: path, available: true, pinned: true, main: true, detached: false, locked: false, push: defaultPush, ...overrides };
}
