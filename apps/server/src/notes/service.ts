import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { maxStoredAttachmentFootprintBytes, promptAttachmentBytes, promptAttachmentName, promptAttachmentsStorageFootprint, validPromptAttachments, type PromptAttachment } from '../prompts/validation.js';
import { type Schedule, type ScheduleLastRun, validSchedule } from '../schedule/types.js';

// `source`: a queued prompt saved as the Note, or the Conductor, which owns the Note until the operator saves it (ADR 0018)
export type NoteSource = 'queued-prompt' | 'conductor';
/** Who changes a Note: the operator, or the Conductor, which may change only its own. */
export type NoteAuthor = 'operator' | 'conductor';
export type WorktreeNote = { id: string; text: string; title?: string; source?: NoteSource; schedule?: Schedule; attachments?: PromptAttachment[]; locked?: boolean; allWorkspaces?: boolean };
export type WorktreeNoteLocation = { key: string; note: WorktreeNote };
export type WorktreeNoteDeletion = { note: WorktreeNote; undoToken: string };
export type WorktreeNoteUndo = WorktreeNote | 'gone' | 'conflict' | 'limit';
type StoredNotes = Record<string, WorktreeNote[]>;
type NoteDeletionSnapshot = { key: string; note: WorktreeNote; expiresAt: number };

const maxNotesPerWorktree = 50;
const maxWorktrees = 100;
const maxNoteLength = 30_000;
const defaultAttachmentStorageLimit = 100 * 1024 * 1024;
// the note-title cap; exported so the saved-prompts boot migration truncates to the same limit
export const maxNoteTitleLength = 120;
const maxTotalNoteLength = 300_000;
const maxUndoSnapshots = 100;
const undoRetentionMs = 60_000;
const validWorktreeId = (value: string) => /^[A-Za-z0-9_-]{1,80}$/u.test(value);
const validNoteId = (value: string) => /^[A-Za-z0-9_-]{12,64}$/u.test(value);
const validText = (value: string) => value.length <= maxNoteLength && !value.includes('\0');
const validTitle = (value: string) => value.trim().length > 0 && value.length <= maxNoteTitleLength && !value.includes('\0');
// canonicalize names before persistence
const normalizedAttachments = (attachments: PromptAttachment[]): PromptAttachment[] | undefined => {
  const normalized: PromptAttachment[] = [];
  // normalize every stored filename
  for (const attachment of attachments) {
    const name = promptAttachmentName(attachment.name);
    // reject malformed filenames
    if (name === undefined) return undefined;
    normalized.push({ name, data: attachment.data });
  }
  // enforce prompt attachment limits
  return validPromptAttachments(normalized) ? normalized : undefined;
};
// validate persisted note data
const validNote = (value: unknown): value is WorktreeNote => {
  if (value === null || typeof value !== 'object') return false;
  const note = value as { id?: unknown; text?: unknown; title?: unknown; source?: unknown; schedule?: unknown; attachments?: unknown; locked?: unknown; allWorkspaces?: unknown };
  const attachments = note.attachments === undefined ? [] : note.attachments;
  return typeof note.id === 'string' && validNoteId(note.id) && typeof note.text === 'string' && validText(note.text) && (note.title === undefined || typeof note.title === 'string' && validTitle(note.title)) && (note.source === undefined || note.source === 'queued-prompt' || note.source === 'conductor') && (note.schedule === undefined || validSchedule(note.schedule)) && (note.locked === undefined || typeof note.locked === 'boolean') && (note.allWorkspaces === undefined || typeof note.allWorkspaces === 'boolean') && Array.isArray(attachments) && attachments.every(attachment => attachment !== null && typeof attachment === 'object' && typeof (attachment as { name?: unknown }).name === 'string' && typeof (attachment as { data?: unknown }).data === 'string') && validPromptAttachments(attachments as PromptAttachment[]) && (attachments as PromptAttachment[]).every(attachment => promptAttachmentName(attachment.name) === attachment.name);
};
const totalNoteLength = (stored: StoredNotes) => Object.values(stored).flat().reduce((total, note) => total + note.text.length + (note.title?.length ?? 0), 0);
// total decoded attachment bytes
const totalAttachmentBytes = (stored: StoredNotes) => Object.values(stored).flat().reduce((total, note) => total + (note.attachments ?? []).reduce((sum, attachment) => sum + (promptAttachmentBytes(attachment) ?? 0), 0), 0);
// total serialized attachment json bytes
const totalAttachmentFootprint = (stored: StoredNotes) => Object.values(stored).flat().reduce((total, note) => total + promptAttachmentsStorageFootprint(note.attachments ?? []), 0);
// approximate one retained snapshot's serialized content footprint
const noteStorageFootprint = (note: WorktreeNote) => Buffer.byteLength(note.text) + Buffer.byteLength(note.title ?? '') + promptAttachmentsStorageFootprint(note.attachments ?? []);

export class WorktreeNoteService {
  private mutation = Promise.resolve();
  private readonly deletions = new Map<string, NoteDeletionSnapshot>();
  private readonly deletionOrders = new Map<string, string[]>();

  // bind note storage and its decoded and serialized attachment budgets
  constructor(private readonly file = process.env.RAC_NOTES_FILE ?? '.data/notes.json', private readonly attachmentStorageLimit = defaultAttachmentStorageLimit, private readonly attachmentFootprintLimit = maxStoredAttachmentFootprintBytes, private readonly now = () => Date.now()) {}

  // list owned notes first, followed by notes shared from other keys
  async list(worktreeId: string): Promise<WorktreeNote[] | undefined> {
    // reject invalid persistence keys
    if (!validWorktreeId(worktreeId)) return undefined;
    await this.mutation;
    const stored = await this.read();
    const own = stored[worktreeId] ?? [];
    const shared: WorktreeNote[] = [];
    // append shared notes from every other persistence key
    for (const [key, notes] of Object.entries(stored)) {
      // keep original notes in their existing leading position
      if (key === worktreeId) continue;
      shared.push(...notes.filter(note => note.allWorkspaces === true));
    }
    return [...own, ...shared];
  }

  // resolve one note visible from a persistence key to its original storage key
  async resolve(worktreeId: string, noteId: string): Promise<WorktreeNoteLocation | undefined> {
    // reject malformed identifiers before reading storage
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    await this.mutation;
    return this.visibleNote(await this.read(), worktreeId, noteId);
  }

  // every scheduled note across all keys, paired with its persistence key — the scheduler's
  // enumeration for one tick. Only notes that carry a Schedule are returned.
  async scheduled(): Promise<Array<{ key: string; note: WorktreeNote }>> {
    await this.mutation;
    const stored = await this.read();
    return Object.entries(stored).flatMap(([key, notes]) =>
      notes.filter(note => note.schedule !== undefined).map(note => ({ key, note })));
  }

  // create an optionally titled note
  async create(worktreeId: string, title?: string): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || title !== undefined && !validTitle(title)) return undefined;
    return await this.mutate(stored => {
      const notes = stored[worktreeId] ?? [];
      if (notes.length >= maxNotesPerWorktree) return undefined;
      if (stored[worktreeId] === undefined && Object.keys(stored).length >= maxWorktrees) return undefined;
      const note: WorktreeNote = { id: randomBytes(18).toString('base64url'), text: '', ...(title === undefined ? {} : { title }) };
      if (totalNoteLength(stored) + (title?.length ?? 0) > maxTotalNoteLength) return undefined;
      stored[worktreeId] = [note, ...notes];
      return note;
    });
  }

  // create a titled note with initial text in one mutation — the save-as-note and halt-drain
  // paths write the note atomically before consuming the queued prompt, so a two-step
  // create-then-update (which could leave a blank titled note on failure) will not do
  async createWithText(worktreeId: string, title: string, text: string, source?: NoteSource, attachments: PromptAttachment[] = []): Promise<WorktreeNote | undefined> {
    const normalized = normalizedAttachments(attachments);
    // reject invalid note content
    if (!validWorktreeId(worktreeId) || !validTitle(title) || !validText(text) || normalized === undefined) return undefined;
    return await this.mutate(stored => {
      const notes = stored[worktreeId] ?? [];
      if (notes.length >= maxNotesPerWorktree) return undefined;
      if (stored[worktreeId] === undefined && Object.keys(stored).length >= maxWorktrees) return undefined;
      if (totalNoteLength(stored) + title.length + text.length > maxTotalNoteLength) return undefined;
      // enforce the global byte budget
      if (totalAttachmentBytes(stored) + normalized.reduce((sum, attachment) => sum + promptAttachmentBytes(attachment)!, 0) > this.attachmentStorageLimit) return undefined;
      // enforce the serialized attachment footprint budget
      if (totalAttachmentFootprint(stored) + promptAttachmentsStorageFootprint(normalized) > this.attachmentFootprintLimit) return undefined;
      const note: WorktreeNote = { id: randomBytes(18).toString('base64url'), text, title, ...(source === undefined ? {} : { source }), ...(normalized.length === 0 ? {} : { attachments: normalized }) };
      stored[worktreeId] = [note, ...notes];
      return note;
    });
  }

  // read full attachment payloads for one note
  async attachments(worktreeId: string, noteId: string): Promise<PromptAttachment[] | undefined> {
    // reject invalid identifiers
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    await this.mutation;
    const resolved = this.visibleNote(await this.read(), worktreeId, noteId);
    return resolved === undefined ? undefined : [...(resolved.note.attachments ?? [])];
  }

  // append attachments atomically
  async appendAttachments(worktreeId: string, noteId: string, attachments: PromptAttachment[]): Promise<WorktreeNote | 'invalid' | undefined> {
    const normalized = normalizedAttachments(attachments);
    // reject malformed additions
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || normalized === undefined || normalized.length === 0) return 'invalid';
    return await this.mutate(stored => {
      const note = this.visibleNote(stored, worktreeId, noteId)?.note;
      // require an existing note
      if (note === undefined) return undefined;
      const combined = normalizedAttachments([...(note.attachments ?? []), ...normalized]);
      // enforce per-note limits and duplicate names
      if (combined === undefined) return 'invalid';
      const previousBytes = (note.attachments ?? []).reduce((sum, attachment) => sum + promptAttachmentBytes(attachment)!, 0);
      const nextBytes = combined.reduce((sum, attachment) => sum + promptAttachmentBytes(attachment)!, 0);
      // enforce the global byte budget
      if (totalAttachmentBytes(stored) - previousBytes + nextBytes > this.attachmentStorageLimit) return 'invalid';
      // enforce the serialized attachment footprint budget
      if (totalAttachmentFootprint(stored) - promptAttachmentsStorageFootprint(note.attachments ?? []) + promptAttachmentsStorageFootprint(combined) > this.attachmentFootprintLimit) return 'invalid';
      this.claim(note, 'operator');
      note.attachments = combined;
      return { ...note };
    });
  }

  // remove one canonical attachment name atomically
  async removeAttachment(worktreeId: string, noteId: string, name: string): Promise<WorktreeNote | undefined> {
    const normalizedName = promptAttachmentName(name);
    // reject invalid identifiers and names
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || normalizedName === undefined) return undefined;
    return await this.mutate(stored => {
      const note = this.visibleNote(stored, worktreeId, noteId)?.note;
      // require an existing matching attachment
      if (note === undefined || note.attachments === undefined) return undefined;
      const next = note.attachments.filter(attachment => attachment.name !== normalizedName);
      if (next.length === note.attachments.length) return undefined;
      this.claim(note, 'operator');
      // omit empty attachment arrays
      if (next.length === 0) delete note.attachments;
      else note.attachments = next;
      return { ...note };
    });
  }

  // Whether `by` may change the note: the Conductor only its own. Any change of the operator's
  // (text, title, attachments, lock, visibility, Schedule) makes it the operator's.
  private claim(note: WorktreeNote, by: NoteAuthor): boolean {
    if (by === 'conductor') return note.source === 'conductor';
    if (note.source === 'conductor') delete note.source;
    return true;
  }

  // update one owned or shared note at its canonical storage location
  async update(worktreeId: string, noteId: string, text: string, by: NoteAuthor = 'operator'): Promise<WorktreeNote | undefined> {
    // reject malformed identifiers and content
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || !validText(text)) return undefined;
    return await this.mutate(stored => {
      const note = this.visibleNote(stored, worktreeId, noteId)?.note;
      // hide notes outside the requesting scope
      if (note === undefined || !this.claim(note, by)) return undefined;
      // preserve the aggregate text budget
      if (totalNoteLength(stored) - note.text.length + text.length > maxTotalNoteLength) return undefined;
      note.text = text;
      return { ...note };
    });
  }

  // rename one note
  async rename(worktreeId: string, noteId: string, title: string, by: NoteAuthor = 'operator'): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || !validTitle(title)) return undefined;
    return await this.mutate(stored => {
      const note = this.visibleNote(stored, worktreeId, noteId)?.note;
      if (note === undefined || !this.claim(note, by)) return undefined;
      if (totalNoteLength(stored) - (note.title?.length ?? 0) + title.length > maxTotalNoteLength) return undefined;
      note.title = title;
      return { ...note };
    });
  }

  // set one note's deletion lock without changing its editable content or metadata
  async setLocked(worktreeId: string, noteId: string, locked: boolean): Promise<WorktreeNote | undefined> {
    // reject invalid identifiers
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.mutate(stored => {
      const note = this.visibleNote(stored, worktreeId, noteId)?.note;
      // require an existing note
      if (note === undefined) return undefined;
      this.claim(note, 'operator');
      // omit the false default for legacy-compatible storage
      if (locked) note.locked = true;
      else delete note.locked;
      return { ...note };
    });
  }

  // delete one note and retain an exact, short-lived restoration snapshot
  async deleteWithUndo(worktreeId: string, noteId: string, by: NoteAuthor = 'operator'): Promise<WorktreeNoteDeletion | 'locked' | undefined> {
    // reject malformed identifiers before entering the mutation queue
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.serialize(async () => {
      this.trimDeletions();
      const stored = await this.read();
      const resolved = this.visibleNote(stored, worktreeId, noteId);
      // hide notes outside the requesting scope
      if (resolved === undefined) return undefined;
      const notes = stored[resolved.key] ?? [];
      const index = notes.findIndex(note => note.id === noteId);
      if (index < 0) return undefined;
      // refuse locks before changing the stored collection
      if (notes[index]!.locked === true) return 'locked';
      if (!this.claim(notes[index]!, by)) return undefined;
      const existingOrder = this.deletionOrders.get(resolved.key);
      const newIds = existingOrder === undefined ? [] : notes.map(note => note.id).filter(id => !existingOrder.includes(id));
      const deletionOrder = existingOrder === undefined ? notes.map(note => note.id) : [...newIds, ...existingOrder];
      const [note] = notes.splice(index, 1);
      if (notes.length === 0) delete stored[resolved.key];
      const undoToken = this.undoToken();
      await this.write(stored);
      // expose a token only after the deletion is durable
      this.deletionOrders.set(resolved.key, deletionOrder);
      this.deletions.set(undoToken, { key: resolved.key, note: structuredClone(note!), expiresAt: this.now() + undoRetentionMs });
      this.trimDeletions();
      return { note: structuredClone(note!), undoToken };
    });
  }

  // restore one deletion at its canonical key and original list position
  async undoDeletion(token: string): Promise<WorktreeNoteUndo> {
    return await this.serialize(async () => {
      this.trimDeletions();
      const snapshot = this.deletions.get(token);
      // fail closed for invalid, expired, consumed or restart-lost tokens
      if (snapshot === undefined) return 'gone';
      const stored = await this.read();
      // never overwrite a note whose identifier has since appeared
      if (Object.values(stored).some(notes => notes.some(note => note.id === snapshot.note.id))) return 'conflict';
      const notes = stored[snapshot.key] ?? [];
      // enforce collection and key-count budgets
      if (notes.length >= maxNotesPerWorktree || stored[snapshot.key] === undefined && Object.keys(stored).length >= maxWorktrees) return 'limit';
      // enforce aggregate text and attachment budgets
      if (totalNoteLength(stored) + snapshot.note.text.length + (snapshot.note.title?.length ?? 0) > maxTotalNoteLength) return 'limit';
      if (totalAttachmentBytes(stored) + (snapshot.note.attachments ?? []).reduce((sum, attachment) => sum + promptAttachmentBytes(attachment)!, 0) > this.attachmentStorageLimit) return 'limit';
      if (totalAttachmentFootprint(stored) + promptAttachmentsStorageFootprint(snapshot.note.attachments ?? []) > this.attachmentFootprintLimit) return 'limit';
      const restored = structuredClone(snapshot.note);
      notes.splice(this.restorationIndex(snapshot, notes), 0, restored);
      stored[snapshot.key] = notes;
      await this.write(stored);
      // consume only after the restoration is durable
      this.deletions.delete(token);
      this.releaseDeletionOrder(snapshot.key);
      return structuredClone(restored);
    });
  }

  // set global visibility while retaining the note under its original persistence key
  async setVisibility(worktreeId: string, noteId: string, allWorkspaces: boolean): Promise<WorktreeNoteLocation | undefined> {
    // reject malformed identifiers before entering the mutation queue
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.mutate(stored => {
      const resolved = this.visibleNote(stored, worktreeId, noteId);
      // hide notes outside the requesting scope
      if (resolved === undefined) return undefined;
      this.claim(resolved.note, 'operator');
      // omit the false default for legacy-compatible storage
      if (allWorkspaces) resolved.note.allWorkspaces = true;
      else delete resolved.note.allWorkspaces;
      return { key: resolved.key, note: { ...resolved.note } };
    });
  }

  // set or replace one note's Schedule; validates the record's shape (the route validates
  // target existence and cron parseability, which this store cannot see)
  async setSchedule(worktreeId: string, noteId: string, schedule: Schedule, by: NoteAuthor = 'operator'): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId) || !validSchedule(schedule)) return undefined;
    return await this.mutate(stored => {
      const note = this.visibleNote(stored, worktreeId, noteId)?.note;
      if (note === undefined || !this.claim(note, by)) return undefined;
      note.schedule = schedule;
      return { ...note };
    });
  }

  // record the outcome of one Run on a note's Schedule; a note without a Schedule is left
  // untouched (undefined), since only a scheduled note has a `lastRun` to write
  async recordLastRun(worktreeId: string, noteId: string, lastRun: ScheduleLastRun): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.mutate(stored => {
      const note = this.visibleNote(stored, worktreeId, noteId)?.note;
      if (note === undefined || note.schedule === undefined) return undefined;
      note.schedule = { ...note.schedule, lastRun };
      return { ...note };
    });
  }

  // remove one note's Schedule, keeping the note
  async removeSchedule(worktreeId: string, noteId: string): Promise<WorktreeNote | undefined> {
    if (!validWorktreeId(worktreeId) || !validNoteId(noteId)) return undefined;
    return await this.mutate(stored => {
      const note = this.visibleNote(stored, worktreeId, noteId)?.note;
      if (note === undefined) return undefined;
      delete note.schedule;
      return { ...note };
    });
  }

  // prefer a note owned by the requesting key, then allow shared notes from other keys
  private visibleNote(stored: StoredNotes, worktreeId: string, noteId: string): WorktreeNoteLocation | undefined {
    const own = stored[worktreeId]?.find(candidate => candidate.id === noteId);
    // preserve owner access regardless of visibility
    if (own !== undefined) return { key: worktreeId, note: own };
    // search only explicitly shared foreign notes
    for (const [key, notes] of Object.entries(stored)) {
      // skip the already-searched owner collection
      if (key === worktreeId) continue;
      const shared = notes.find(candidate => candidate.id === noteId && candidate.allWorkspaces === true);
      // return the canonical persistence key with the note
      if (shared !== undefined) return { key, note: shared };
    }
    return undefined;
  }

  private async mutate<T>(change: (stored: StoredNotes) => T | Promise<T>): Promise<T> {
    return await this.serialize(async () => {
      const stored = await this.read();
      const result = await change(stored);
      await this.write(stored);
      return result;
    });
  }

  // serialize reads and durable writes across every note mutation
  private async serialize<T>(change: () => Promise<T>): Promise<T> {
    const operation = this.mutation.then(change);
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  // mint a token without replacing any live deletion snapshot
  private undoToken(): string {
    let token: string;
    do token = randomBytes(24).toString('base64url');
    while (this.deletions.has(token));
    return token;
  }

  // resolve one note against the retained logical order
  private restorationIndex(snapshot: NoteDeletionSnapshot, notes: WorktreeNote[]): number {
    const order = this.deletionOrders.get(snapshot.key) ?? [];
    const target = order.indexOf(snapshot.note.id);
    // insert before the first surviving original successor
    for (const [index, note] of notes.entries()) {
      const position = order.indexOf(note.id);
      if (position > target) return index;
    }
    return notes.length;
  }

  // discard one tombstone and close its gap for later snapshots
  private discardDeletion(token: string): NoteDeletionSnapshot | undefined {
    const removed = this.deletions.get(token);
    if (removed === undefined) return undefined;
    this.deletions.delete(token);
    const order = this.deletionOrders.get(removed.key);
    if (order !== undefined) this.deletionOrders.set(removed.key, order.filter(id => id !== removed.note.id));
    this.releaseDeletionOrder(removed.key);
    return removed;
  }

  // release ordering data once its last tombstone is gone
  private releaseDeletionOrder(key: string): void {
    if (![...this.deletions.values()].some(snapshot => snapshot.key === key)) this.deletionOrders.delete(key);
  }

  // expire old snapshots and bound retained deletion data
  private trimDeletions(): void {
    const now = this.now();
    // discard every expired snapshot
    for (const [token, snapshot] of this.deletions) {
      if (snapshot.expiresAt <= now) this.discardDeletion(token);
    }
    // discard oldest snapshots above the count or storage cap
    let footprint = [...this.deletions.values()].reduce((total, snapshot) => total + noteStorageFootprint(snapshot.note), 0);
    while (this.deletions.size > maxUndoSnapshots || footprint > this.attachmentFootprintLimit + maxTotalNoteLength) {
      const oldest = this.deletions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const removed = this.discardDeletion(oldest)!;
      footprint -= noteStorageFootprint(removed.note);
    }
  }

  private async read(): Promise<StoredNotes> {
    let serialized: string;
    try { serialized = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const raw = JSON.parse(serialized) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid notes file');
    const stored: StoredNotes = {};
    for (const [worktreeId, notes] of Object.entries(raw)) {
      if (!validWorktreeId(worktreeId) || !Array.isArray(notes) || notes.length > maxNotesPerWorktree || notes.some(note => !validNote(note))) throw new Error('invalid notes file');
      stored[worktreeId] = notes;
    }
    // reject persisted data outside any aggregate storage budget
    if (Object.keys(stored).length > maxWorktrees || totalNoteLength(stored) > maxTotalNoteLength || totalAttachmentBytes(stored) > this.attachmentStorageLimit || totalAttachmentFootprint(stored) > this.attachmentFootprintLimit) throw new Error('notes file exceeds storage limits');
    return stored;
  }

  private async write(value: StoredNotes): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
