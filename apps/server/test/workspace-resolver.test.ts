import { describe, expect, it } from 'vitest';

import { configuredWorktreeForWorkspace, worktreeHostRoot, worktreeMatchesWorkspace, worktreePrBase } from '../src/workspaces/resolver.js';
import type { Dashboard, Worktree } from '../src/domain/models.js';

const worktree = (over: Partial<Worktree> = {}): Worktree => ({ id: 'cora', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: false, command: 'codex', ...over });

describe('worktreeMatchesWorkspace', () => {
  it('matches the console-side git toplevel exactly', () => {
    expect(worktreeMatchesWorkspace(worktree(), '/worktrees/cora')).toBe(true);
  });

  it('matches the bridge host path when the worktree is mounted from the host', () => {
    expect(worktreeMatchesWorkspace(worktree({ hostPath: '/home/ubuntu/cora' }), '/home/ubuntu/cora')).toBe(true);
  });

  it('never associates a nested checkout or subdirectory by prefix', () => {
    // a `.claude/worktrees/<n>` created by the agent's own tool is its own toplevel
    expect(worktreeMatchesWorkspace(worktree({ hostPath: '/home/ubuntu/cora' }), '/home/ubuntu/cora/.claude/worktrees/3')).toBe(false);
    // an ordinary subdirectory reports the toplevel, not itself, so it should never reach here — but if it does, no match
    expect(worktreeMatchesWorkspace(worktree(), '/worktrees/cora/packages/app')).toBe(false);
    // a submodule pane resolves to the submodule's own toplevel, which is not this worktree
    expect(worktreeMatchesWorkspace(worktree(), '/worktrees/cora/vendor/lib')).toBe(false);
  });
});

describe('configuredWorktreeForWorkspace', () => {
  const worktrees = [worktree(), worktree({ id: 'nova', label: 'Nova', path: '/worktrees/nova', identity: '/worktrees/nova', hostPath: '/home/ubuntu/nova' })];

  it('resolves an unambiguous worktree by identity or host path', () => {
    expect(configuredWorktreeForWorkspace(worktrees, '/worktrees/cora')?.id).toBe('cora');
    expect(configuredWorktreeForWorkspace(worktrees, '/home/ubuntu/nova')?.id).toBe('nova');
  });

  it('returns undefined for a workspace no configured worktree owns', () => {
    expect(configuredWorktreeForWorkspace(worktrees, '/worktrees/cora/src')).toBeUndefined();
    expect(configuredWorktreeForWorkspace(worktrees, '/some/scratch/dir')).toBeUndefined();
  });
});

describe('worktreePrBase', () => {
  const dashboard = (over: Partial<Dashboard> = {}): Dashboard => ({ generation: 0, places: [], adapters: {}, agents: [], projects: [], ...over });
  const idleProject = (base?: string) => ({ id: 'p1', label: 'P', mode: 'repository' as const, available: true, manageWorktrees: false, stalePaths: [], worktrees: [{ id: 'w1', projectId: 'p1', label: 'W', path: '/w1', available: true, pinned: false, main: false, detached: false, locked: false, order: 0, ...(base === undefined ? {} : { gitPrStatus: { base, files: 0 } }) }] });

  it('reads a live agent resolved base for its worktree', () => {
    const board = dashboard({ agents: [{ id: 'a1', pane: { paneId: '%1', sessionId: 's', socketFingerprint: 'sf' }, home: '/w1', kind: 'codex', attention: 'finished', title: 'Ready', worktreeId: 'w1', gitPrStatus: { base: 'origin/main', files: 0 } }] });
    expect(worktreePrBase(board, 'w1')).toBe('origin/main');
  });

  it('falls back to the idle worktree view when no agent carries the base', () => {
    expect(worktreePrBase(dashboard({ projects: [idleProject('origin/dev')] }), 'w1')).toBe('origin/dev');
  });

  it('prefers the live agent base over the idle worktree view', () => {
    const board = dashboard({
      agents: [{ id: 'a1', pane: { paneId: '%1', sessionId: 's', socketFingerprint: 'sf' }, home: '/w1', kind: 'codex', attention: 'finished', title: 'Ready', worktreeId: 'w1', gitPrStatus: { base: 'origin/main', files: 0 } }],
      projects: [idleProject('origin/dev')]
    });
    expect(worktreePrBase(board, 'w1')).toBe('origin/main');
  });

  it('returns undefined when neither the agent nor the worktree view resolved a base', () => {
    expect(worktreePrBase(dashboard({ projects: [idleProject()] }), 'w1')).toBeUndefined();
    expect(worktreePrBase(dashboard(), 'missing')).toBeUndefined();
  });

  // distinguish a known but unavailable PR base from an ordinary branch fallback
  it('preserves unavailable PR bases for live and idle workspaces', () => {
    const pullRequest = { number: 1, title: 'Unavailable', status: 'open' as const, url: 'https://github.com/acme/app/pull/1', baseBranch: 'release' };
    const live = dashboard({ agents: [{ id: 'a1', pane: { paneId: '%1', sessionId: 's', socketFingerprint: 'sf' }, home: '/w1', kind: 'codex', attention: 'finished', title: 'Ready', worktreeId: 'w1', pullRequest }] });
    expect(worktreePrBase(live, 'w1')).toBeNull();
    const idle = idleProject();
    expect(worktreePrBase(dashboard({ projects: [{ ...idle, worktrees: [{ ...idle.worktrees[0]!, pullRequest }] }] }), 'w1')).toBeNull();
  });
});

describe('worktreeHostRoot', () => {
  it('prefers the bridge host path when the worktree is mounted from the host', () => {
    expect(worktreeHostRoot(worktree({ hostPath: '/home/ubuntu/cora' }))).toBe('/home/ubuntu/cora');
  });

  it('falls back to the console git toplevel when no host path is configured', () => {
    expect(worktreeHostRoot(worktree())).toBe('/worktrees/cora');
  });
});
