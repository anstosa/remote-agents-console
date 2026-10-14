import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeNoteService, type WorktreeNote, type WorktreeNoteDeletion } from '../src/notes/service.js';

// narrow successful deletions for restoration fixtures
function requireDeletion(deletion: WorktreeNoteDeletion | 'locked' | undefined): WorktreeNoteDeletion {
  // fail before reading a token from a refused deletion
  if (deletion === undefined || deletion === 'locked') throw new Error('expected note deletion');
  return deletion;
}

describe('worktree notes', () => {
  // preserve attachment bytes across ordinary note mutations and reloads
  it('persists, appends and removes normalized attachments without autosave data loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-attachments-'));
    const file = join(directory, 'notes.json');
    const first = { name: ' context.txt ', data: Buffer.from('context').toString('base64') };
    const second = { name: 'diagram.png', data: Buffer.from('image').toString('base64') };
    try {
      const service = new WorktreeNoteService(file);
      const note = await service.createWithText('cora', 'Attached note', '', undefined, [first]);
      expect(note?.attachments).toEqual([{ ...first, name: 'context.txt' }]);
      await expect(service.appendAttachments('cora', note!.id, [second])).resolves.toMatchObject({ attachments: [{ ...first, name: 'context.txt' }, second] });
      await service.update('cora', note!.id, 'Review both files');
      const daily = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
      await service.setSchedule('cora', note!.id, daily);
      await expect(new WorktreeNoteService(file).attachments('cora', note!.id)).resolves.toEqual([{ ...first, name: 'context.txt' }, second]);
      await expect(service.removeAttachment('cora', note!.id, ' context.txt ')).resolves.toMatchObject({ text: 'Review both files', schedule: daily, attachments: [second] });
      await service.removeSchedule('cora', note!.id);
      await expect(service.attachments('cora', note!.id)).resolves.toEqual([second]);
      await expect(service.deleteWithUndo('cora', note!.id)).resolves.toMatchObject({ note: { attachments: [second] } });
      await expect(service.attachments('cora', note!.id)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // reject malformed, duplicate and over-budget attachment mutations atomically
  it('enforces attachment validation and the aggregate storage budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-attachment-limits-'));
    const file = join(directory, 'notes.json');
    try {
      const service = new WorktreeNoteService(file, 10);
      const first = { name: 'first.txt', data: Buffer.from('12345678').toString('base64') };
      const note = await service.createWithText('cora', 'Bounded', '', undefined, [first]);
      await expect(service.appendAttachments('cora', note!.id, [{ name: 'bad.txt', data: 'not base64' }])).resolves.toBe('invalid');
      await expect(service.appendAttachments('cora', note!.id, [{ name: 'first.txt', data: Buffer.from('x').toString('base64') }])).resolves.toBe('invalid');
      await expect(service.createWithText('owen', 'Overflow', '', undefined, [{ name: 'overflow.txt', data: Buffer.from('123').toString('base64') }])).resolves.toBeUndefined();
      await expect(service.attachments('cora', note!.id)).resolves.toEqual([{ name: 'first.txt', data: first.data }]);
      await expect(service.list('owen')).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // retain every valid file across note persistence without a count cap
  it('persists more than ten attachments within the note byte budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-many-note-attachments-'));
    const file = join(directory, 'notes.json');
    // create distinct one-byte files beyond the former count cap
    const attachments = Array.from({ length: 11 }, (_, index) => ({ name: `context-${index}.txt`, data: 'eA==' }));
    try {
      const service = new WorktreeNoteService(file);
      const note = await service.createWithText('cora', 'Many files', '', undefined, attachments);
      expect(note?.attachments).toHaveLength(11);
      await expect(new WorktreeNoteService(file).attachments('cora', note!.id)).resolves.toEqual(attachments);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // reject metadata-heavy attachment growth without changing the durable note
  it('enforces the serialized attachment footprint on writes and reloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-attachment-footprint-'));
    const file = join(directory, 'notes.json');
    // create valid tiny payloads with large serialized filenames
    const attachments = Array.from({ length: 2 }, (_, index) => ({ name: `${'a'.repeat(200)}-${index}.txt`, data: 'eA==' }));
    try {
      const service = new WorktreeNoteService(file, 100, 750);
      const note = await service.createWithText('cora', 'Keep this note', '', undefined, attachments);
      await expect(service.appendAttachments('cora', note!.id, attachments.map((attachment, index) => ({ ...attachment, name: `${'b'.repeat(200)}-${index}.txt` })))).resolves.toBe('invalid');
      await expect(service.createWithText('owen', 'Reject this note', '', undefined, attachments)).resolves.toBeUndefined();
      await expect(service.attachments('cora', note!.id)).resolves.toEqual(attachments);
      await expect(service.list('owen')).resolves.toEqual([]);
      await expect(new WorktreeNoteService(file, 100, 750).attachments('cora', note!.id)).resolves.toEqual(attachments);
      await expect(new WorktreeNoteService(file, 100, 400).list('cora')).rejects.toThrow('notes file exceeds storage limits');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // accept legacy note records without attachments or deletion locks
  it('loads legacy note records without attachment or lock fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-legacy-notes-'));
    const file = join(directory, 'notes.json');
    try {
      await writeFile(file, JSON.stringify({ cora: [{ id: 'note-identifier-000', title: 'Legacy', text: 'Still here' }] }));
      const [legacy] = (await new WorktreeNoteService(file).list('cora'))!;
      expect(legacy).toEqual({ id: 'note-identifier-000', title: 'Legacy', text: 'Still here' });
      expect(legacy?.locked).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // serialize lock transitions with deletion while preserving every other note field
  it('persists deletion locks and requires an atomic unlock before deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-locks-'));
    const file = join(directory, 'notes.json');
    const attachment = { name: 'context.txt', data: Buffer.from('context').toString('base64') };
    const daily = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
    try {
      const service = new WorktreeNoteService(file);
      const note = await service.createWithText('cora', 'Protected note', 'Original text', 'queued-prompt', [attachment]);
      await service.setSchedule('cora', note!.id, daily);

      const [locked, refused] = await Promise.all([
        service.setLocked('cora', note!.id, true),
        service.deleteWithUndo('cora', note!.id)
      ]);
      expect(locked).toMatchObject({ ...note, schedule: daily, locked: true });
      expect(refused).toBe('locked');

      const restarted = new WorktreeNoteService(file);
      await expect(restarted.list('cora')).resolves.toMatchObject([{ ...note, schedule: daily, locked: true }]);
      await expect(restarted.update('cora', note!.id, 'Edited while locked')).resolves.toMatchObject({ text: 'Edited while locked', locked: true });
      await expect(restarted.rename('cora', note!.id, 'Renamed while locked')).resolves.toMatchObject({ title: 'Renamed while locked', locked: true });
      await expect(restarted.removeSchedule('cora', note!.id)).resolves.toMatchObject({ attachments: [attachment], locked: true });

      const [unlocked, deleted] = await Promise.all([
        restarted.setLocked('cora', note!.id, false),
        restarted.deleteWithUndo('cora', note!.id)
      ]);
      expect(unlocked).toMatchObject({ text: 'Edited while locked', title: 'Renamed while locked', attachments: [attachment] });
      expect(unlocked).not.toHaveProperty('locked');
      expect(deleted).toMatchObject({ note: unlocked });
      await expect(new WorktreeNoteService(file).list('cora')).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // reject malformed persisted deletion locks
  it('rejects persisted non-boolean lock fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-note-lock-'));
    const file = join(directory, 'notes.json');
    try {
      await writeFile(file, JSON.stringify({ cora: [{ id: 'note-identifier-000', title: 'Invalid', text: '', locked: 'yes' }] }));
      await expect(new WorktreeNoteService(file).list('cora')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // reject malformed persisted attachment fields at the storage boundary
  it('rejects persisted null attachment fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-note-attachments-'));
    const file = join(directory, 'notes.json');
    try {
      await writeFile(file, JSON.stringify({ cora: [{ id: 'note-identifier-000', title: 'Invalid', text: '', attachments: null }] }));
      await expect(new WorktreeNoteService(file).list('cora')).rejects.toThrow('invalid notes file');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });


  it('persists isolated notes and serializes concurrent autosaves', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-notes-'));
    const file = join(directory, 'notes.json');
    try {
      const service = new WorktreeNoteService(file);
      const first = await service.create('cora', 'Assistant setup');
      const second = await service.create('cora');
      await service.create('owen');
      await Promise.all([
        service.update('cora', first!.id, 'First draft'),
        service.update('cora', first!.id, 'Latest draft')
      ]);
      await service.rename('cora', first!.id, 'Deployment checklist');

      await expect(service.list('cora')).resolves.toEqual([second, { ...first, text: 'Latest draft', title: 'Deployment checklist' }]);
      await expect(new WorktreeNoteService(file).list('owen')).resolves.toMatchObject([{ text: '' }]);
      await expect(service.deleteWithUndo('cora', second!.id)).resolves.toMatchObject({ note: second });
      await expect(service.list('cora')).resolves.toEqual([{ ...first, text: 'Latest draft', title: 'Deployment checklist' }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid identifiers and oversized content', async () => {
    const service = new WorktreeNoteService(join(tmpdir(), `rac-notes-${Date.now()}.json`));
    const note = await service.create('cora');
    await expect(service.list('bad/id')).resolves.toBeUndefined();
    await expect(service.update('cora', note!.id, 'x'.repeat(30_001))).resolves.toBeUndefined();
    await expect(service.update('cora', note!.id, 'bad\0note')).resolves.toBeUndefined();
    await expect(service.rename('cora', note!.id, '')).resolves.toBeUndefined();
    await expect(service.rename('cora', note!.id, 'x'.repeat(121))).resolves.toBeUndefined();
  });

  it('preserves a corrupt file instead of overwriting it during a mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-corrupt-notes-'));
    const file = join(directory, 'notes.json');
    try {
      await writeFile(file, '{not valid json');
      const service = new WorktreeNoteService(file);
      await expect(service.create('cora')).rejects.toThrow();
      await expect(readFile(file, 'utf8')).resolves.toBe('{not valid json');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('sets, replaces and removes a note Schedule, and drops it when the note is deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-schedule-notes-'));
    const file = join(directory, 'notes.json');
    try {
      const service = new WorktreeNoteService(file);
      const note = await service.create('cora', 'Morning triage');
      const daily = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
      await expect(service.setSchedule('cora', note!.id, daily)).resolves.toMatchObject({ id: note!.id, schedule: daily });
      // a persisted Schedule survives a fresh service reading the same file
      await expect(new WorktreeNoteService(file).list('cora')).resolves.toMatchObject([{ id: note!.id, schedule: daily }]);
      const paused = { ...daily, enabled: false, updatedAt: '2026-09-06T10:00:00-07:00' } as const;
      await expect(service.setSchedule('cora', note!.id, paused)).resolves.toMatchObject({ schedule: paused });
      await expect(service.removeSchedule('cora', note!.id)).resolves.toEqual({ id: note!.id, text: '', title: 'Morning triage' });
      // re-create a Schedule, then confirm deleting the note removes it
      await service.setSchedule('cora', note!.id, daily);
      await service.deleteWithUndo('cora', note!.id);
      await expect(service.list('cora')).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects a structurally invalid Schedule and an unknown note', async () => {
    const service = new WorktreeNoteService(join(tmpdir(), `rac-schedule-bad-${Date.now()}.json`));
    const note = await service.create('cora');
    const daily = { cron: '0 9 * * *', kind: 'claude', target: { scratch: true }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
    await expect(service.setSchedule('cora', note!.id, { ...daily, kind: 'nope' } as never)).resolves.toBeUndefined();
    await expect(service.setSchedule('cora', note!.id, { ...daily, target: { worktreeId: '' } } as never)).resolves.toBeUndefined();
    await expect(service.setSchedule('cora', 'note-identifier-000', daily)).resolves.toBeUndefined();
    await expect(service.removeSchedule('cora', 'note-identifier-000')).resolves.toBeUndefined();
  });

  it('enforces the aggregate note text budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-bounded-notes-'));
    try {
      const service = new WorktreeNoteService(join(directory, 'notes.json'));
      const notes = await Promise.all(Array.from({ length: 11 }, () => service.create('cora')));
      for (const note of notes.slice(0, 10)) await expect(service.update('cora', note!.id, 'x'.repeat(30_000))).resolves.toBeDefined();
      await expect(service.update('cora', notes[10]!.id, 'overflow')).resolves.toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('creates a titled note with initial text in one mutation, respecting the aggregate budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-with-text-'));
    try {
      const service = new WorktreeNoteService(join(directory, 'notes.json'));
      const note = await service.createWithText('cora', 'Queued prompt in Cora · 9:41 AM', 'Draft the release notes.', 'queued-prompt');
      expect(note).toMatchObject({ title: 'Queued prompt in Cora · 9:41 AM', text: 'Draft the release notes.', source: 'queued-prompt' });
      await expect(new WorktreeNoteService(join(directory, 'notes.json')).list('cora')).resolves.toEqual([note]);
      await expect(service.rename('cora', note!.id, 'Release draft')).resolves.toMatchObject({ title: 'Release draft', source: 'queued-prompt' });
      // a blank title or over-budget text is refused, writing nothing
      await expect(service.createWithText('cora', '   ', 'text')).resolves.toBeUndefined();
      await expect(service.createWithText('cora', 'Too big', 'x'.repeat(300_000))).resolves.toBeUndefined();
      await expect(service.list('cora')).resolves.toEqual([{ ...note, title: 'Release draft' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('enumerates every scheduled note across all keys, and only scheduled ones', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-scheduled-notes-'));
    try {
      const service = new WorktreeNoteService(join(directory, 'notes.json'));
      const daily = { cron: '0 9 * * *', kind: 'claude', target: { scratch: true }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
      const coraScheduled = await service.create('cora', 'Morning triage');
      await service.setSchedule('cora', coraScheduled!.id, daily);
      await service.create('cora', 'Plain note');
      const owenScheduled = await service.create('owen', 'Nightly summary');
      await service.setSchedule('owen', owenScheduled!.id, daily);
      const scheduled = await service.scheduled();
      expect(scheduled).toHaveLength(2);
      expect(scheduled.map(entry => ({ key: entry.key, id: entry.note.id })).sort((a, b) => a.key.localeCompare(b.key)))
        .toEqual([{ key: 'cora', id: coraScheduled!.id }, { key: 'owen', id: owenScheduled!.id }]);
      expect(scheduled.every(entry => entry.note.schedule !== undefined)).toBe(true);
      // an empty store enumerates to nothing
      await expect(new WorktreeNoteService(join(directory, 'empty.json')).scheduled()).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // expose shared notes after local notes while retaining one canonical stored record
  it('persists all-workspace visibility without duplicating the original note', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-shared-notes-'));
    const file = join(directory, 'notes.json');
    try {
      const service = new WorktreeNoteService(file);
      const shared = await service.create('cora', 'Shared note');
      const local = await service.create('owen', 'Local note');
      await expect(service.setVisibility('cora', shared!.id, true)).resolves.toEqual({ key: 'cora', note: { ...shared, allWorkspaces: true } });

      await expect(service.list('cora')).resolves.toEqual([{ ...shared, allWorkspaces: true }]);
      await expect(service.list('owen')).resolves.toEqual([local, { ...shared, allWorkspaces: true }]);
      await expect(new WorktreeNoteService(file).list('owen')).resolves.toEqual([local, { ...shared, allWorkspaces: true }]);

      const persisted = JSON.parse(await readFile(file, 'utf8')) as Record<string, Array<{ id: string }>>;
      expect(persisted.cora?.map(note => note.id)).toEqual([shared!.id]);
      expect(persisted.owen?.map(note => note.id)).toEqual([local!.id]);
      expect(Object.values(persisted).flat().filter(note => note.id === shared!.id)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // mutate one shared note through an alias while preserving its original key and schedule identity
  it('resolves shared note operations to the original persistence key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-shared-note-operations-'));
    const file = join(directory, 'notes.json');
    const attachment = { name: 'context.txt', data: Buffer.from('context').toString('base64') };
    const daily = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
    try {
      const service = new WorktreeNoteService(file);
      const note = await service.create('cora', 'Original title');
      await service.setVisibility('cora', note!.id, true);

      await expect(service.update('owen', note!.id, 'Edited elsewhere')).resolves.toMatchObject({ text: 'Edited elsewhere', allWorkspaces: true });
      await expect(service.rename('owen', note!.id, 'Renamed elsewhere')).resolves.toMatchObject({ title: 'Renamed elsewhere', allWorkspaces: true });
      await expect(service.appendAttachments('owen', note!.id, [attachment])).resolves.toMatchObject({ attachments: [attachment], allWorkspaces: true });
      await expect(service.attachments('owen', note!.id)).resolves.toEqual([attachment]);
      await expect(service.setSchedule('owen', note!.id, daily)).resolves.toMatchObject({ schedule: daily, allWorkspaces: true });
      await expect(service.setLocked('owen', note!.id, true)).resolves.toMatchObject({ locked: true, allWorkspaces: true });
      await expect(service.deleteWithUndo('owen', note!.id)).resolves.toBe('locked');
      await service.setLocked('owen', note!.id, false);

      await expect(service.resolve('owen', note!.id)).resolves.toMatchObject({ key: 'cora', note: { id: note!.id } });
      await expect(service.scheduled()).resolves.toMatchObject([{ key: 'cora', note: { id: note!.id, schedule: daily } }]);
      await expect(service.setVisibility('owen', note!.id, false)).resolves.toMatchObject({ key: 'cora', note: { id: note!.id } });
      await expect(service.list('owen')).resolves.toEqual([]);
      await expect(service.update('owen', note!.id, 'Hidden edit')).resolves.toBeUndefined();
      await expect(service.list('cora')).resolves.toMatchObject([{ id: note!.id, text: 'Edited elsewhere', title: 'Renamed elsewhere', schedule: daily, attachments: [attachment] }]);

      await service.setVisibility('cora', note!.id, true);
      await expect(service.removeAttachment('owen', note!.id, 'context.txt')).resolves.toMatchObject({ allWorkspaces: true });
      await expect(service.removeSchedule('owen', note!.id)).resolves.toMatchObject({ allWorkspaces: true });
      await expect(service.deleteWithUndo('owen', note!.id)).resolves.toMatchObject({ note: { id: note!.id, allWorkspaces: true } });
      await expect(service.list('cora')).resolves.toEqual([]);
      await expect(service.list('owen')).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // restore every note field at its canonical key and original list position
  it('undoes a shared deletion without losing metadata, attachments or ordering', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-deletion-undo-'));
    const file = join(directory, 'notes.json');
    const attachment = { name: 'context.txt', data: Buffer.from('context').toString('base64') };
    const daily = { cron: '0 9 * * *', kind: 'claude', target: { worktreeId: 'wt-main' }, enabled: true, updatedAt: '2026-09-06T09:00:00-07:00' } as const;
    try {
      const service = new WorktreeNoteService(file);
      const older = await service.create('cora', 'Older');
      const target = await service.createWithText('cora', 'Queued plan', 'Preserve everything', 'queued-prompt', [attachment]);
      const newer = await service.create('cora', 'Newer');
      await service.setSchedule('cora', target!.id, daily);
      await service.setVisibility('cora', target!.id, true);

      const deletion = requireDeletion(await service.deleteWithUndo('owen', target!.id));
      expect(deletion).toMatchObject({ note: { ...target, schedule: daily, allWorkspaces: true }, undoToken: expect.any(String) });
      const latest = await service.create('cora', 'Latest');
      await expect(service.list('cora')).resolves.toEqual([latest, newer, older]);

      const restored = await service.undoDeletion(deletion.undoToken);
      expect(restored).toEqual({ ...target, schedule: daily, allWorkspaces: true });
      await expect(service.list('cora')).resolves.toEqual([latest, newer, restored, older]);
      await expect(service.resolve('owen', target!.id)).resolves.toMatchObject({ key: 'cora', note: restored });
      await expect(service.attachments('owen', target!.id)).resolves.toEqual([attachment]);
      await expect(service.undoDeletion(deletion.undoToken)).resolves.toBe('gone');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // preserve original order when adjacent deletions are undone in either order
  it('restores multiple pending deletions in stable list order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-deletion-order-'));
    try {
      const cases = [
        { labels: ['Alpha', 'Beta'], undo: ['Alpha', 'Beta'] },
        { labels: ['Alpha', 'Beta'], undo: ['Beta', 'Alpha'] },
        { labels: ['Alpha', 'Beta', 'Gamma'], undo: ['Alpha', 'Beta'] },
        { labels: ['Alpha', 'Beta', 'Gamma'], undo: ['Beta', 'Alpha'] }
      ];
      // exercise two- and three-note lists in both undo orders
      for (const [caseIndex, fixture] of cases.entries()) {
        const service = new WorktreeNoteService(join(directory, `notes-${caseIndex}.json`));
        const notesByTitle = new Map<string, WorktreeNote>();
        // reverse creation because new notes are prepended
        for (const label of [...fixture.labels].reverse()) {
          notesByTitle.set(label, (await service.create('cora', label))!);
        }
        const tokens = new Map<string, string>();
        // delete the same adjacent pair each time
        for (const label of ['Alpha', 'Beta']) {
          const deletion = requireDeletion(await service.deleteWithUndo('cora', notesByTitle.get(label)!.id));
          tokens.set(label, deletion.undoToken);
        }
        // restore through the requested ordering
        for (const label of fixture.undo) await service.undoDeletion(tokens.get(label)!);
        expect((await service.list('cora'))?.map(note => note.title)).toEqual(fixture.labels);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // expire tokens in memory and lose them across service restarts
  it('refuses invalid, expired and restart-lost deletion tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-deletion-expiry-'));
    const file = join(directory, 'notes.json');
    let now = Date.parse('2026-10-12T12:00:00.000Z');
    try {
      const service = new WorktreeNoteService(file, 100 * 1024 * 1024, 100 * 1024 * 1024, () => now);
      const expiring = await service.create('cora', 'Expiring');
      const deletion = requireDeletion(await service.deleteWithUndo('cora', expiring!.id));
      await expect(service.undoDeletion('not-a-deletion-token')).resolves.toBe('gone');
      await expect(new WorktreeNoteService(file).undoDeletion(deletion.undoToken)).resolves.toBe('gone');
      now += 60_001;
      await expect(service.undoDeletion(deletion.undoToken)).resolves.toBe('gone');
      await expect(service.list('cora')).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // bound retained deletion content independently of the live note store
  it('evicts oldest undo snapshots above the serialized content budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-deletion-memory-'));
    const file = join(directory, 'notes.json');
    try {
      const service = new WorktreeNoteService(file, 100 * 1024 * 1024, 100);
      const tokens: string[] = [];
      // retain enough deleted text to exceed the aggregate snapshot cap
      for (let index = 0; index < 11; index += 1) {
        const note = await service.createWithText('cora', `Note ${index}`, 'x'.repeat(30_000));
        const deletion = requireDeletion(await service.deleteWithUndo('cora', note!.id));
        tokens.push(deletion.undoToken);
      }
      await expect(service.undoDeletion(tokens[0]!)).resolves.toBe('gone');
      await expect(service.undoDeletion(tokens.at(-1)!)).resolves.toMatchObject({ title: 'Note 10' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // retain retryable tokens when a conflict or storage budget blocks restoration
  it('refuses conflicting and over-budget undo without consuming the token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-note-deletion-limits-'));
    const conflictFile = join(directory, 'conflict.json');
    const budgetFile = join(directory, 'budget.json');
    try {
      const conflictService = new WorktreeNoteService(conflictFile);
      const original = await conflictService.createWithText('cora', 'Original', 'Keep me');
      const conflictDeletion = requireDeletion(await conflictService.deleteWithUndo('cora', original!.id));
      await writeFile(conflictFile, JSON.stringify({ owen: [conflictDeletion.note] }));
      await expect(conflictService.undoDeletion(conflictDeletion.undoToken)).resolves.toBe('conflict');
      await writeFile(conflictFile, '{}');
      await expect(conflictService.undoDeletion(conflictDeletion.undoToken)).resolves.toEqual(original);

      const budgetService = new WorktreeNoteService(budgetFile, 10);
      const firstAttachment = { name: 'first.txt', data: Buffer.from('123456').toString('base64') };
      const secondAttachment = { name: 'second.txt', data: Buffer.from('abcdef').toString('base64') };
      const bounded = await budgetService.createWithText('cora', 'Bounded', '', undefined, [firstAttachment]);
      const budgetDeletion = requireDeletion(await budgetService.deleteWithUndo('cora', bounded!.id));
      const filler = await budgetService.createWithText('owen', 'Filler', '', undefined, [secondAttachment]);
      await expect(budgetService.undoDeletion(budgetDeletion.undoToken)).resolves.toBe('limit');
      await budgetService.deleteWithUndo('owen', filler!.id);
      await expect(budgetService.undoDeletion(budgetDeletion.undoToken)).resolves.toEqual(bounded);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // reject malformed visibility metadata at the persistence boundary
  it('rejects persisted non-boolean all-workspace flags', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-invalid-note-visibility-'));
    const file = join(directory, 'notes.json');
    try {
      await writeFile(file, JSON.stringify({ cora: [{ id: 'note-identifier-000', title: 'Invalid', text: '', allWorkspaces: 'yes' }] }));
      await expect(new WorktreeNoteService(file).list('cora')).rejects.toThrow('invalid notes file');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
