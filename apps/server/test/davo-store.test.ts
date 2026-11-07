import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLiveContext } from '../src/davo/context.js';
import { DavoAdmissionPendingError, DavoStore, DavoStoreError, type DavoStoreFileSystem } from '../src/davo/store.js';

const fixtures: string[] = [];

type MemoryFileSystem = {
  fileSystem: DavoStoreFileSystem;
  files: Map<string, string>;
  failNextSetMode: boolean;
  failNextSync: boolean;
  failNextSyncAfterRename: boolean;
  failNextWrite: boolean;
  failRemovals: boolean;
  removalCalls: number;
};

// create one path-aware fault-injectable private filesystem
function memoryFileSystem(): MemoryFileSystem {
  const files = new Map<string, string>();
  const control = { files, failNextSetMode: false, failNextSync: false, failNextSyncAfterRename: false, failNextWrite: false, failRemovals: false, removalCalls: 0 } as MemoryFileSystem;
  let renamedSinceSync = false;
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  control.fileSystem = {
    read: async path => files.get(path) ?? Promise.reject(missing()),
    size: async path => {
      const value = files.get(path);
      // classify only absent paths as missing
      if (value === undefined) throw missing();
      return Buffer.byteLength(value);
    },
    ensureDirectory: async () => undefined,
    writeAndSync: async (path, contents) => {
      // inject one exact write failure
      if (control.failNextWrite) { control.failNextWrite = false; throw new Error('write unavailable'); }
      files.set(path, contents);
    },
    rename: async (from, to) => {
      const value = files.get(from);
      // require the exact source candidate
      if (value === undefined) throw missing();
      files.set(to, value);
      files.delete(from);
      renamedSinceSync = true;
    },
    syncDirectory: async () => {
      // inject one directory failure at any phase
      if (control.failNextSync) { control.failNextSync = false; throw new Error('directory sync unavailable'); }
      // fail only after one successful rename effect
      if (renamedSinceSync && control.failNextSyncAfterRename) {
        renamedSinceSync = false;
        control.failNextSyncAfterRename = false;
        throw new Error('directory sync unavailable');
      }
      renamedSinceSync = false;
    },
    remove: async path => {
      control.removalCalls += 1;
      // retain files across one cleanup fault window
      if (control.failRemovals) throw new Error('remove unavailable');
      files.delete(path);
    },
    setMode: async () => {
      // fail the next requested mode change before promotion
      if (control.failNextSetMode) { control.failNextSetMode = false; throw new Error('mode unavailable'); }
    }
  };
  return control;
}

type DurableFaults = {
  failMarkerAfterSync: boolean;
  failRemovals: boolean;
  removalCalls: number;
};

// wrap real synced files with one after-effect marker failure
function durableFaultFileSystem(markerPath: string, faults: DurableFaults): DavoStoreFileSystem {
  return {
    read: async path => readFile(path, 'utf8'),
    size: async path => (await stat(path)).size,
    ensureDirectory: async path => { await mkdir(path, { recursive: true, mode: 0o700 }); },
    writeAndSync: async (path, contents) => {
      const handle = await open(path, 'w', 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // throw only after marker bytes and inode metadata are synced
      if (path === markerPath && faults.failMarkerAfterSync) {
        faults.failMarkerAfterSync = false;
        throw new Error('marker write reported failure after sync');
      }
    },
    rename: async (from, to) => { await rename(from, to); },
    syncDirectory: async path => {
      const handle = await open(path, 'r');
      try { await handle.sync(); }
      finally { await handle.close(); }
    },
    remove: async path => {
      faults.removalCalls += 1;
      // prove cleanup would fail inside the injected window
      if (faults.failRemovals) throw new Error('remove unavailable');
      await unlink(path).catch(error => {
        // ignore only an absent selected file
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
      });
    },
    setMode: async (path, mode) => { await chmod(path, mode); }
  };
}

// create one isolated store path
async function fixtureFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'rac-davo-store-'));
  fixtures.push(directory);
  return join(directory, 'state.json');
}

// verify durable davo storage
describe('davo store', () => {
  // remove every temporary store
  afterEach(async () => {
    // clear isolated fixtures
    for (const directory of fixtures.splice(0)) await rm(directory, { force: true, recursive: true });
  });

  // retain one conversation across reopen and sweep
  it('keeps one logical conversation and strictly expires anchored derivatives', async () => {
    const file = await fixtureFile();
    const monday = new Date('2026-11-03T10:00:00.000Z');
    const store = new DavoStore({ file, now: () => monday });
    await store.ensureCurrent();
    const user = await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'finish the task' });
    await store.appendMessage({
      kind: 'status',
      text: 'still working',
      retentionAnchorAt: user.retentionAnchorAt,
      retentionAnchorLocalDate: user.retentionAnchorLocalDate,
      source: { kind: 'request-status', statusKey: 'progress-1' }
    });
    const before = await store.read();
    const reopened = new DavoStore({ file, now: () => new Date('2026-11-06T11:00:00.000Z') });
    const sweep = await reopened.ensureCurrent();
    const after = await reopened.read();
    expect(sweep.swept).toBe(true);
    expect(after.logicalConversationId).toBe(before.logicalConversationId);
    expect(after.messages).toEqual([]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  // return the same transcript for an exact retry
  it('deduplicates transcript keys and rejects conflicting text', async () => {
    const file = await fixtureFile();
    const store = new DavoStore({ file, now: () => new Date('2026-11-05T12:00:00.000Z') });
    const input = { voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'same' };
    const first = await store.appendUserTranscript(input);
    const second = await store.appendUserTranscript(input);
    expect(second).toEqual(first);
    await expect(store.appendUserTranscript({ ...input, text: 'different' })).rejects.toMatchObject({ code: 'davo_idempotency_conflict' });
    expect((await store.read()).messages).toHaveLength(1);
  });

  // fail closed on corrupt canonical state
  it('does not reset or archive corrupt state', async () => {
    const file = await fixtureFile();
    await writeFile(file, '{bad', { mode: 0o600 });
    const store = new DavoStore({ file });
    await expect(store.ensureCurrent()).rejects.toEqual(expect.objectContaining<DavoStoreError>({ code: 'davo_store_unavailable' }));
    expect(await readFile(file, 'utf8')).toBe('{bad');
  });

  // serialize concurrent message mutations
  it('assigns unique monotonic sequences to simultaneous appends', async () => {
    const file = await fixtureFile();
    const store = new DavoStore({ file, now: () => new Date('2026-11-05T12:00:00.000Z') });
    const messages = await Promise.all(Array.from({ length: 12 }, (_, index) => store.appendUserTranscript({
      voiceSessionId: 'voice-1',
      providerSessionId: 'provider-1',
      providerItemId: `item-${index}`,
      text: `message-${index}`
    })));
    expect(messages.map(message => message.sequence).sort((left, right) => left - right)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect((await store.read()).messages).toHaveLength(12);
  });

  // reject a mode failure before promotion and permit one clean exact retry
  it('never publishes a transcript when private mode setup fails before rename', async () => {
    const memory = memoryFileSystem();
    const file = '/memory/pre-rename.json';
    const store = new DavoStore({ file, fileSystem: memory.fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    await store.ensureCurrent();
    const canonical = memory.files.get(file);
    const input = { voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'commit once' };
    memory.failNextSetMode = true;

    await expect(store.appendUserTranscript(input)).rejects.toMatchObject({ code: 'davo_store_unavailable' });
    expect(memory.files.get(file)).toBe(canonical);
    expect(memory.files.has(`${file}.admission-commit`)).toBe(false);
    const reopened = new DavoStore({ file, fileSystem: memory.fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    expect((await reopened.read()).messages).toEqual([]);
    const first = await reopened.appendUserTranscript(input);
    expect(await reopened.appendUserTranscript(input)).toEqual(first);
    expect((await reopened.read()).messages).toHaveLength(1);
  });

  // report pending when pre-marker rollback cannot be proven
  it('never ordinarily rejects an unconfirmed pre-marker rollback', async () => {
    const memory = memoryFileSystem();
    const file = '/memory/pre-marker-cleanup.json';
    const store = new DavoStore({ file, fileSystem: memory.fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    await store.ensureCurrent();
    const input = { voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-cleanup', text: 'rollback or remain pending' };
    memory.failNextSetMode = true;
    memory.failRemovals = true;

    const pending = await store.appendUserTranscript(input).then(() => undefined, error => error as unknown);
    expect(pending).toEqual(expect.objectContaining<DavoAdmissionPendingError>({ code: 'davo_admission_pending' }));
    expect(store.available).toBe(false);
    expect(memory.files.has(`${file}.admission-commit`)).toBe(false);
    await expect(store.read()).rejects.toMatchObject({ code: 'davo_store_unavailable' });
    memory.failRemovals = false;

    const reopened = new DavoStore({ file, fileSystem: memory.fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    expect((await reopened.read()).messages).toEqual([]);
    await reopened.appendUserTranscript(input);
    expect((await reopened.read()).messages).toHaveLength(1);
  });

  // return the exact receipt while startup reconciles a post-rename sync failure
  it('recovers an ambiguously synced admission without rejecting or duplicating it', async () => {
    const memory = memoryFileSystem();
    const file = '/memory/post-rename.json';
    const store = new DavoStore({ file, fileSystem: memory.fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    await store.ensureCurrent();
    const input = { voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'recover exactly' };
    memory.failNextSyncAfterRename = true;

    const receipt = await store.appendUserTranscript(input);
    expect(receipt.text).toBe(input.text);
    expect(store.available).toBe(false);
    await expect(store.read()).rejects.toMatchObject({ code: 'davo_store_unavailable' });
    expect(JSON.parse(memory.files.get(file)!)).toMatchObject({ messages: [expect.objectContaining({ id: receipt.id })] });
    const marker = memory.files.get(`${file}.admission-commit`)!;
    expect(Buffer.byteLength(marker)).toBeLessThanOrEqual(256);
    expect(marker).not.toContain(input.text);

    const reopened = new DavoStore({ file, fileSystem: memory.fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    const recovered = await reopened.read();
    expect(recovered.messages).toEqual([receipt]);
    expect(buildLiveContext(recovered, { currentTurn: 'continue' })).toMatchObject({ sourceMessageIds: [receipt.id] });
    expect(await reopened.appendUserTranscript(input)).toEqual(receipt);
    expect((await reopened.read()).messages).toHaveLength(1);
    expect(memory.files.has(`${file}.admission-commit`)).toBe(false);
  });

  // return pending once a marker may survive before durable proof
  it('never rejects a published marker that can recover after directory and cleanup failures', async () => {
    const memory = memoryFileSystem();
    const file = '/memory/marker-sync.json';
    const store = new DavoStore({ file, fileSystem: memory.fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    await store.ensureCurrent();
    const input = { voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-marker', text: 'survive marker uncertainty' };
    const priorRemovalCalls = memory.removalCalls;
    memory.failNextSync = true;
    memory.failRemovals = true;

    const pending = await store.appendUserTranscript(input).then(() => undefined, error => error as unknown);
    expect(pending).toEqual(expect.objectContaining<DavoAdmissionPendingError>({ code: 'davo_admission_pending' }));
    expect(store.available).toBe(false);
    await expect(store.read()).rejects.toMatchObject({ code: 'davo_store_unavailable' });
    expect(memory.removalCalls).toBe(priorRemovalCalls);
    expect(memory.files.has(`${file}.next`)).toBe(true);
    expect(memory.files.get(`${file}.admission-commit`)).not.toContain(input.text);
    memory.failRemovals = false;

    const reopened = new DavoStore({ file, fileSystem: memory.fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    const recovered = await reopened.read();
    expect(recovered.messages).toEqual([expect.objectContaining({ id: (pending as DavoAdmissionPendingError).messageId, text: input.text })]);
    expect(buildLiveContext(recovered, { currentTurn: 'continue' })).toMatchObject({ sourceMessageIds: [(pending as DavoAdmissionPendingError).messageId] });
    expect(await reopened.appendUserTranscript(input)).toEqual(recovered.messages[0]);
    expect((await reopened.read()).messages).toHaveLength(1);
  });

  // treat an after-effect marker write error as pending rather than unsent
  it('returns pending when synced marker publication reports failure', async () => {
    const file = await fixtureFile();
    const marker = `${file}.admission-commit`;
    const faults: DurableFaults = { failMarkerAfterSync: false, failRemovals: false, removalCalls: 0 };
    const fileSystem = durableFaultFileSystem(marker, faults);
    const store = new DavoStore({ file, fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    await store.ensureCurrent();
    const input = { voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-after-effect', text: 'accept ambiguous marker write' };
    const priorRemovalCalls = faults.removalCalls;
    faults.failMarkerAfterSync = true;
    faults.failRemovals = true;

    const pending = await store.appendUserTranscript(input).then(() => undefined, error => error as unknown);
    expect(pending).toEqual(expect.objectContaining<DavoAdmissionPendingError>({ code: 'davo_admission_pending' }));
    expect(store.available).toBe(false);
    await expect(store.read()).rejects.toMatchObject({ code: 'davo_store_unavailable' });
    expect(faults.removalCalls).toBe(priorRemovalCalls);
    expect(await readFile(marker, 'utf8')).not.toContain(input.text);
    faults.failRemovals = false;

    const reopened = new DavoStore({ file, fileSystem, now: () => new Date('2026-11-05T12:00:00.000Z') });
    const recovered = await reopened.read();
    expect(recovered.messages).toEqual([expect.objectContaining({ id: (pending as DavoAdmissionPendingError).messageId, text: input.text })]);
    expect(buildLiveContext(recovered, { currentTurn: 'continue' })).toMatchObject({ sourceMessageIds: [(pending as DavoAdmissionPendingError).messageId] });
    expect(await reopened.appendUserTranscript(input)).toEqual(recovered.messages[0]);
    expect((await reopened.read()).messages).toHaveLength(1);
  });

  // persist erasure and exact effect claims before provider cutoff dispatch
  it('recovers a failed cutoff finalization without restoring expired content or replaying hangup claims', async () => {
    const memory = memoryFileSystem();
    const file = '/memory/davo.json';
    let now = new Date('2026-11-05T12:00:00.000Z');
    let observedFence = false;
    const store = new DavoStore({
      file,
      now: () => now,
      fileSystem: memory.fileSystem,
      onFence: async fence => {
        const durable = JSON.parse(memory.files.get(file)!) as { messages: unknown[]; providerCalls: Array<{ hangup: { state: string } }> };
        expect(durable.messages).toEqual([]);
        expect(durable.providerCalls[0]?.hangup.state).toBe('dispatching');
        expect(fence.providerCalls[0]?.hangup.state).toBe('dispatching');
        observedFence = true;
        memory.failNextWrite = true;
        return { closedCallIds: [] };
      }
    });
    await store.ensureCurrent();
    await store.appendUserTranscript({ voiceSessionId: 'voice-1', providerSessionId: 'provider-1', providerItemId: 'item-1', text: 'expire me' });
    await store.transact(state => {
      state.providerCalls.push({
        callId: 'rtc_cutoff123',
        voiceSessionId: 'voice-1',
        ownerHash: 'a'.repeat(64),
        generation: state.retention.generation,
        hardCutoffAt: '2026-11-09T11:00:00.000Z',
        createdAt: '2026-11-05T12:00:00.000Z',
        providerMaximumEndsAt: '2026-11-09T12:00:00.000Z',
        hangup: { state: 'ready', definitelyNotSentRetries: 0 }
      });
    });
    now = new Date('2026-11-09T11:00:00.000Z');

    await expect(store.ensureCurrent()).rejects.toMatchObject({ code: 'davo_store_unavailable' });
    expect(observedFence).toBe(true);
    const durable = JSON.parse(memory.files.get(file)!) as { messages: unknown[]; providerCalls: Array<{ hangup: { state: string } }> };
    expect(durable.messages).toEqual([]);
    expect(durable.providerCalls).toEqual([expect.objectContaining({ callId: 'rtc_cutoff123', hangup: expect.objectContaining({ state: 'dispatching' }) })]);
    const reopened = new DavoStore({ file, now: () => now, fileSystem: memory.fileSystem });
    expect((await reopened.read()).providerCalls[0]?.hangup.state).toBe('dispatching');
  });

  // recovered in-flight effects become quarantine without another provider send
  it('never redispatches a provider claim already marked in flight at cutoff', async () => {
    const file = await fixtureFile();
    let now = new Date('2026-11-05T12:00:00.000Z');
    const fences: unknown[] = [];
    const store = new DavoStore({ file, now: () => now, onFence: async fence => { fences.push(fence.providerCalls); return { closedCallIds: [] }; } });
    await store.ensureCurrent();
    await store.transact(state => {
      state.providerCalls.push({
        callId: 'rtc_already_sent',
        voiceSessionId: 'voice-1',
        ownerHash: 'b'.repeat(64),
        generation: state.retention.generation,
        hardCutoffAt: '2026-11-09T11:00:00.000Z',
        createdAt: '2026-11-05T12:00:00.000Z',
        providerMaximumEndsAt: '2026-11-09T12:00:00.000Z',
        hangup: { state: 'dispatching', attemptId: 'attempt-1', attemptedAt: '2026-11-05T12:01:00.000Z', definitelyNotSentRetries: 0 }
      });
    });
    now = new Date('2026-11-09T11:00:00.000Z');

    await expect(store.ensureCurrent()).resolves.toMatchObject({ swept: true });
    expect(fences).toEqual([[]]);
    expect(await store.read()).toMatchObject({ providerCalls: [], providerQuarantineUntil: '2026-11-09T12:00:00.000Z' });
  });
});
