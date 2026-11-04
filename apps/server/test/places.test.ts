import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { accountHome, configuredPlaces, folderNoteKey, placeForRoot, placeLaunchScope, placeNoteKey, scratchHome } from '../src/places/places.js';
import type { Project, Worktree } from '../src/domain/models.js';

const worktree = (over: Partial<Worktree> = {}): Worktree => ({ id: 'ferry:/code/ferry', projectId: 'ferry', label: 'Ferry', path: '/code/ferry', identity: '/code/ferry', available: true, pinned: true, main: true, detached: false, locked: false, ...over });
const project = (over: Partial<Project> = {}): Project => ({ id: 'notes', label: 'Notes', path: '/data/notes', identity: '/data/notes', mode: 'directory', worktreesDirectory: '/data/notes-worktrees', available: true, push: { label: 'Push', prompt: '$push' }, ...over });

describe('configuredPlaces', () => {
  it('lists every Worktree, every available directory Project and the configured Scratch folder', () => {
    const places = configuredPlaces([worktree()], [
      project(),
      project({ id: 'gone', path: '/data/gone', identity: '/data/gone', available: false }),
      project({ id: 'ferry', mode: 'repository', path: '/code/ferry', identity: '/code/ferry/.git' })
    ], '/home/me/scratch');

    expect(places).toEqual([
      { id: 'ferry:/code/ferry', kind: 'worktree', projectId: 'ferry', label: 'Ferry', home: '/code/ferry' },
      { id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes' },
      { id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/home/me/scratch' }
    ]);
  });

  it('carries the bridge host path of a Main worktree and of a directory Project', () => {
    const places = configuredPlaces([worktree({ hostPath: '/host/ferry' })], [project({ hostPath: '/host/notes' })], '/home/me');
    expect(places.map(place => place.hostPath)).toEqual(['/host/ferry', '/host/notes', undefined]);
  });
});

describe('placeForRoot', () => {
  const places = configuredPlaces([
    worktree(),
    worktree({ id: 'ferry:/code/ferry/.claude/worktrees/3', label: 'Ferry · agent', path: '/code/ferry/.claude/worktrees/3', identity: '/code/ferry/.claude/worktrees/3', main: false, pinned: false })
  ], [project(), project({ id: 'inbox', label: 'Inbox', path: '/home/me/inbox', identity: '/home/me/inbox', hostPath: '/host/me/inbox' })], '/home/me');

  it('places a root at a Place home in that Place', () => {
    expect(placeForRoot(places, '/code/ferry').id).toBe('ferry:/code/ferry');
    expect(placeForRoot(places, '/data/notes').id).toBe('notes:/data/notes');
    expect(placeForRoot(places, '/home/me').id).toBe('scratch:/home/me');
  });

  it('places a subfolder of a directory Project or of the Scratch folder in it', () => {
    expect(placeForRoot(places, '/data/notes/2026/september')).toMatchObject({ id: 'notes:/data/notes', home: '/data/notes' });
    expect(placeForRoot(places, '/home/me/tmp/probe')).toMatchObject({ id: 'scratch:/home/me', home: '/home/me' });
  });

  it('places a nested, unconfigured git checkout inside a Worktree in that Worktree', () => {
    expect(placeForRoot(places, '/code/ferry/vendor/lib').id).toBe('ferry:/code/ferry');
  });

  it('lets the deepest Place win, so a nested checkout that is itself a Worktree stays its own', () => {
    expect(placeForRoot(places, '/code/ferry/.claude/worktrees/3').id).toBe('ferry:/code/ferry/.claude/worktrees/3');
    expect(placeForRoot(places, '/code/ferry/.claude/worktrees/3/src').id).toBe('ferry:/code/ferry/.claude/worktrees/3');
    // a directory Project inside the Scratch folder is deeper than Scratch
    expect(placeForRoot(places, '/home/me/inbox/today').id).toBe('inbox:/home/me/inbox');
  });

  it('matches a Place by its bridge host path', () => {
    expect(placeForRoot(places, '/host/me/inbox/today')).toMatchObject({ id: 'inbox:/home/me/inbox', home: '/home/me/inbox' });
  });

  it('never matches by a bare string prefix', () => {
    // `/data/notes-archive` shares a prefix with `/data/notes` but is not inside it
    expect(placeForRoot(places, '/data/notes-archive')).toEqual({ id: 'scratch:/data/notes-archive', kind: 'scratch', projectId: 'scratch', label: 'notes-archive', home: '/data/notes-archive', adhoc: true });
  });

  it('makes a root inside no configured Place its own Scratch Place', () => {
    expect(placeForRoot(places, '/srv/tools')).toEqual({ id: 'scratch:/srv/tools', kind: 'scratch', projectId: 'scratch', label: 'tools', home: '/srv/tools', adhoc: true });
    expect(placeForRoot(places, '/')).toMatchObject({ id: 'scratch:/', label: '/', home: '/' });
  });
});

describe('placeLaunchScope', () => {
  it('keys a Worktree by its id, a directory Project by its Project id and a Scratch Place by its id', () => {
    expect(placeLaunchScope({ id: 'ferry:/code/ferry', kind: 'worktree', projectId: 'ferry' })).toBe('ferry:/code/ferry');
    expect(placeLaunchScope({ id: 'notes:/data/notes', kind: 'directory', projectId: 'notes' })).toBe('notes');
    expect(placeLaunchScope({ id: 'scratch:/srv/tools', kind: 'scratch', projectId: 'scratch' })).toBe('scratch:/srv/tools');
  });
});

describe('placeNoteKey', () => {
  it('keys a Place by the folder a console launch runs its Agent in, never by the Place id', () => {
    // a directory Project launches in its bridge host path when it has one, else its home
    expect(placeNoteKey({ kind: 'directory', projectId: 'notes', home: '/data/notes', hostPath: '/host/notes' })).toBe(folderNoteKey('/host/notes'));
    expect(placeNoteKey({ kind: 'scratch', projectId: 'scratch', home: '/home/me/scratch' })).toBe(folderNoteKey('/home/me/scratch'));
    // a note key cannot hold `:`, so it is an opaque hash of the folder
    expect(placeNoteKey({ kind: 'scratch', projectId: 'scratch', home: '/home/me/scratch' })).toMatch(/^scratch_[A-Za-z0-9_-]{40}$/u);
  });

  it("keys a Worktree's notes by its Project, shared across its checkouts", () => {
    expect(placeNoteKey({ kind: 'worktree', projectId: 'ferry', home: '/worktrees/ferry', hostPath: '/host/ferry' })).toBe('ferry');
  });
});

describe('scratchHome', () => {
  it('resolves the configured Scratch folder to its realpath, as pane roots are, else falls back to the account home', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'rac-scratch-')));
    try {
      await mkdir(join(directory, 'real'));
      await symlink(join(directory, 'real'), join(directory, 'link'));
      await expect(scratchHome(join(directory, 'link'), [])).resolves.toBe(join(directory, 'real'));
      // a folder the console cannot resolve (a host path under the bridge) is taken as written
      await expect(scratchHome('/host/only/scratch', [])).resolves.toBe('/host/only/scratch');
      await expect(scratchHome(undefined, [project({ hostPath: '/host/me/notes' })])).resolves.toBe('/host/me');
      await expect(scratchHome(undefined, [project({ hostPath: '/srv/repos/project' })], '/accounts/actual')).resolves.toBe('/accounts/actual');
      await expect(scratchHome(undefined, [project({ hostPath: '/srv/repos/project' })], null)).resolves.toBeUndefined();
      // an explicit Scratch folder remains ahead of the runtime account home
      await expect(scratchHome('/host/only/scratch', [project({ hostPath: '/srv/repos/project' })], '/accounts/actual')).resolves.toBe('/host/only/scratch');
      await expect(scratchHome('/host/only/scratch', [project({ hostPath: '/srv/repos/project' })], null)).resolves.toBe('/host/only/scratch');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('accountHome', () => {
  it('is $HOME natively and the parent of a bridged Project host path under Docker', () => {
    const previous = process.env.HOME;
    process.env.HOME = '/home/me';
    try {
      expect(accountHome([project()])).toBe('/home/me');
      expect(accountHome([project(), project({ id: 'ferry', hostPath: '/home/ubuntu/ferry' })])).toBe('/home/ubuntu');
      expect(accountHome([project({ id: 'a', hostPath: '/home/a/x' }), project({ id: 'b', hostPath: '/home/b/y' })], 'b')).toBe('/home/b');
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    }
  });
});
