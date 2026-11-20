import { appendFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexConversationName, codexConversationSummaries, codexLatestMessage, latestCodexMessageFromRecords, discoverCodexConversation, openPaneThreads, validCodexThreadId } from '../../src/adapters/codex-conversations.js';
import { codexHome, fakeProc, tempDir } from '../helpers/codex-fixtures.js';

// write one representative Codex rollout, returning its absolute path
async function writeSession(home: string, name: string, session: { id: string; cwd: string; prompt: string; parentThreadId?: string }): Promise<string> {
  const directory = join(home, 'sessions', '2026', '08', '20');
  await mkdir(directory, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { id: session.id, cwd: session.cwd, timestamp: '2026-08-20T19:00:00.000Z', originator: 'codex-tui', ...(session.parentThreadId === undefined ? {} : { parent_thread_id: session.parentThreadId }) } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: session.prompt }] } }
  ];
  const file = join(directory, `${name}-${session.id}.jsonl`);
  await writeFile(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

// write the account-global session_index.jsonl sidecar, one line per name change
async function writeSessionIndex(home: string, entries: Array<{ id: string; thread_name: string }>): Promise<void> {
  const lines = entries.map(entry => JSON.stringify({ id: entry.id, thread_name: entry.thread_name, updated_at: '2026-09-02T20:53:25.975357809Z' }));
  await writeFile(join(home, 'session_index.jsonl'), `${lines.join('\n')}\n`);
}

// mirror the held file and ownership record in a private proc fixture
async function fakeWriterProc(home: string, ids: readonly string[], { owner = 123, open = [] }: { owner?: number; open?: string[] } = {}): Promise<string> {
  const lockDir = join(home, 'thread-writer-locks');
  await mkdir(lockDir, { recursive: true });
  const files = ids.map(id => join(lockDir, `${id}.lock`));
  await Promise.all(files.map(file => writeFile(file, '')));
  const proc = await fakeProc(123, [...files, ...open]);
  const info = join(proc, '123', 'fdinfo');
  await mkdir(info);
  await Promise.all(ids.map((_, index) => writeFile(join(info, String(index + 3)), `lock:\t1: FLOCK  ADVISORY  WRITE ${owner} 08:30:123 0 EOF\n`)));
  return proc;
}

describe('Codex conversation lookup', () => {
  it('validates exact thread ids', () => {
    expect(validCodexThreadId('0198c333-3333-7333-8333-333333333333')).toBe(true);
    expect(validCodexThreadId('not-a-uuid')).toBe(false);
    expect(validCodexThreadId('0198c333-3333-7333-8333')).toBe(false);
  });

  it('discovers the pane top-level conversation and its title', async () => {
    const home = await codexHome();
    const current = await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c333-3333-7333-8333-333333333333', cwd: '/home/ubuntu/cora', prompt: 'Add a shared worktree control with a useful title' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [current]);

    await expect(discoverCodexConversation({ pid: 123 })).resolves.toEqual({ id: '0198c333-3333-7333-8333-333333333333', title: 'Add a shared worktree control with a useful title' });
  });

  it('ignores child threads and keeps the single top-level rollout', async () => {
    const home = await codexHome();
    const parent = await writeSession(home, 'rollout-2026-08-20T10-00-00', { id: '0198c111-1111-7111-8111-111111111111', cwd: '/home/ubuntu/cora', prompt: 'Top level' });
    const child = await writeSession(home, 'rollout-2026-08-20T11-00-00', { id: '0198c222-2222-7222-8222-222222222222', cwd: '/home/ubuntu/cora', prompt: 'Child task', parentThreadId: '0198c111-1111-7111-8111-111111111111' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [parent, child]);

    await expect(discoverCodexConversation({ pid: 123 })).resolves.toMatchObject({ id: '0198c111-1111-7111-8111-111111111111' });
  });

  it('falls back to the working-directory match when the fd-walk is blocked', async () => {
    const home = await codexHome();
    await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c666-6666-7666-8666-666666666666', cwd: '/home/ubuntu/cora', prompt: 'Resolve me from a confined service' });
    process.env.CODEX_HOME = home;
    // no descriptors: a confined service cannot readlink the pane's fds
    process.env.RAC_HOST_PROC = await fakeProc(123, []);

    await expect(discoverCodexConversation({ pid: 123, cwd: '/home/ubuntu/cora' })).resolves.toEqual({ id: '0198c666-6666-7666-8666-666666666666', title: 'Resolve me from a confined service' });
    // a non-matching directory resolves nothing rather than a stranger's conversation
    await expect(discoverCodexConversation({ pid: 123, cwd: '/home/ubuntu/other' })).resolves.toBeUndefined();
    await expect(discoverCodexConversation({ pid: 123 })).resolves.toBeUndefined();
  });

  // a new writer can exist before codex saves its first turn
  it('does not label an unwritten conversation with older history from its directory', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/adsb';
    const id = '0198c777-7777-7777-8777-777777777777';
    await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c666-6666-7666-8666-666666666666', cwd, prompt: 'Older conversation' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeWriterProc(home, [id]);

    await expect(discoverCodexConversation({ pid: 123, cwd })).resolves.toBeUndefined();
  });

  // paginated history need not hold the rollout file open
  it('follows the live writer id even when another saved conversation is newer', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/adsb';
    const id = '0198c777-7777-7777-8777-777777777777';
    await writeSession(home, 'rollout-2026-08-20T11-00-00', { id, cwd, prompt: 'Resumed conversation' });
    await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c666-6666-7666-8666-666666666666', cwd, prompt: 'Unrelated conversation' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeWriterProc(home, [id]);

    await expect(discoverCodexConversation({ pid: 123, cwd })).resolves.toEqual({ id, title: 'Resumed conversation' });
  });

  // multiple writers do not say which conversation is foreground
  it('does not guess using the directory when several writers are active', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/adsb';
    const first = '0198c666-6666-7666-8666-666666666666';
    const second = '0198c777-7777-7777-8777-777777777777';
    await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: first, cwd, prompt: 'One of several threads' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeWriterProc(home, [first, second]);

    await expect(discoverCodexConversation({ pid: 123, cwd })).resolves.toBeUndefined();
  });

  // a known child writer does not obscure its sole parent
  it('resolves the sole top-level conversation when a subagent also holds a writer lock', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/adsb';
    const id = '0198c666-6666-7666-8666-666666666666';
    const child = '0198c777-7777-7777-8777-777777777777';
    const primary = await writeSession(home, 'rollout-2026-08-20T11-00-00', { id, cwd, prompt: 'Parent conversation' });
    await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: child, cwd, prompt: 'Child conversation', parentThreadId: id });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeWriterProc(home, [id, child], { open: [primary] });

    await expect(discoverCodexConversation({ pid: 123, cwd })).resolves.toEqual({ id, title: 'Parent conversation' });
  });

  // a previous rollout can stay open while the new thread is unwritten
  it('does not let a stale rollout descriptor override the new writer', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/adsb';
    const stale = await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c666-6666-7666-8666-666666666666', cwd, prompt: 'Previous conversation' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeWriterProc(home, ['0198c777-7777-7777-8777-777777777777'], { open: [stale] });

    await expect(discoverCodexConversation({ pid: 123, cwd })).resolves.toBeUndefined();
  });

  // an observed descriptor is not a writer lock without exclusive ownership
  it('keeps the legacy fallback when a lock is not owned by the pane process', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/adsb';
    const id = '0198c666-6666-7666-8666-666666666666';
    await writeSession(home, 'rollout-2026-08-20T12-00-00', { id, cwd, prompt: 'Legacy history' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeWriterProc(home, ['0198c777-7777-7777-8777-777777777777'], { owner: 456 });

    await expect(discoverCodexConversation({ pid: 123, cwd })).resolves.toEqual({ id, title: 'Legacy history' });
  });

  // a valid owner and filename cannot authorize a different profile's inode
  it('ignores a matching writer lock from another Codex profile', async () => {
    const home = await codexHome();
    const foreign = await codexHome();
    const cwd = '/home/ubuntu/adsb';
    const id = '0198c666-6666-7666-8666-666666666666';
    const writer = '0198c777-7777-7777-8777-777777777777';
    await writeSession(home, 'rollout-2026-08-20T12-00-00', { id, cwd, prompt: 'Local history' });
    const localLocks = join(home, 'thread-writer-locks');
    await mkdir(localLocks);
    await writeFile(join(localLocks, `${writer}.lock`), '');
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeWriterProc(foreign, [writer]);

    await expect(discoverCodexConversation({ pid: 123, cwd })).resolves.toEqual({ id, title: 'Local history' });
  });

  it('fails closed when the pane holds two top-level rollouts', async () => {
    const home = await codexHome();
    const first = await writeSession(home, 'rollout-2026-08-20T10-00-00', { id: '0198c111-1111-7111-8111-111111111111', cwd: '/home/ubuntu/cora', prompt: 'First open chat' });
    const second = await writeSession(home, 'rollout-2026-08-20T11-00-00', { id: '0198c333-3333-7333-8333-333333333333', cwd: '/home/ubuntu/cora', prompt: 'Second open chat' });
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [first, second]);

    await expect(discoverCodexConversation({ pid: 123 })).resolves.toBeUndefined();
  });

  it('reads open rollout identities from the fd table', async () => {
    const home = await codexHome();
    const file = await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c444-4444-7444-8444-444444444444', cwd: '/home/ubuntu/cora', prompt: 'Held open' });
    process.env.RAC_HOST_PROC = await fakeProc(123, [file]);

    await expect(openPaneThreads(123)).resolves.toEqual({ rollouts: [{ id: '0198c444-4444-7444-8444-444444444444', relativePath: 'sessions/2026/08/20/rollout-2026-08-20T12-00-00-0198c444-4444-7444-8444-444444444444.jsonl' }], writers: new Set() });
  });

  it('reads a conversation name from the session_index sidecar, last write wins', async () => {
    const home = await codexHome();
    await writeSessionIndex(home, [
      { id: '0198c555-5555-7555-8555-555555555555', thread_name: 'Hello' },
      { id: '0198c111-1111-7111-8111-111111111111', thread_name: 'A different thread' },
      { id: '0198c555-5555-7555-8555-555555555555', thread_name: 'Respond to greeting' },
    ]);
    process.env.CODEX_HOME = home;

    // the newest line for the id wins over its earlier provisional name
    await expect(codexConversationName('0198c555-5555-7555-8555-555555555555')).resolves.toBe('Respond to greeting');
    // an id whose only line is not the file's last still resolves (not just the final line)
    await expect(codexConversationName('0198c111-1111-7111-8111-111111111111')).resolves.toBe('A different thread');
    // an id with no line yields no name
    await expect(codexConversationName('0198c999-9999-7999-8999-999999999999')).resolves.toBeUndefined();
  });

  it('tolerates a missing session_index sidecar and rejects a malformed id', async () => {
    const home = await codexHome();
    process.env.CODEX_HOME = home;
    // a fresh CODEX_HOME with no sidecar is unnamed rather than an error
    await expect(codexConversationName('0198c555-5555-7555-8555-555555555555')).resolves.toBeUndefined();
    // an invalid id never reaches the filesystem
    await expect(codexConversationName('not-a-uuid')).resolves.toBeUndefined();
  });

  it('falls back to no title when the latest prompt is outside the bounded tail', async () => {
    const home = await codexHome();
    const file = await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c888-8888-7888-8888-888888888888', cwd: '/home/ubuntu/cora', prompt: 'Prompt outside the bounded tail' });
    await appendFile(file, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(4_300_000) }] } })}\n`);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [file]);

    await expect(discoverCodexConversation({ pid: 123 })).resolves.toEqual({ id: '0198c888-8888-7888-8888-888888888888' });
  });

  it('reads the latest assistant text from the pane rollout', async () => {
    const home = await codexHome();
    const file = await writeSession(home, 'rollout-2026-08-20T12-00-00', { id: '0198c777-7777-7777-8777-777777777777', cwd: '/home/ubuntu/cora', prompt: 'Initial prompt' });
    await appendFile(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Do you want me to continue?' } })}\n`);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, [file]);

    await expect(codexLatestMessage({ pid: 123 })).resolves.toBe('Do you want me to continue?');
    process.env.RAC_HOST_PROC = await fakeProc(456, []);
    await expect(codexLatestMessage({ pid: 456, cwd: '/home/ubuntu/cora' })).resolves.toBe('Do you want me to continue?');
    await expect(codexLatestMessage({ pid: 456, cwd: '/home/ubuntu/cora', conversationId: '0198c888-8888-7888-8888-888888888888' })).resolves.toBeUndefined();
  });
});

describe('Codex latest assistant message', () => {
  // create one rollout record
  const line = (type: string, payload: object) => JSON.stringify({ type, payload });

  it('accepts native assistant record variants without ordinals', () => {
    expect(latestCodexMessageFromRecords([
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'response item' }] }),
    ])).toBe('response item');
    expect(latestCodexMessageFromRecords([
      line('event_msg', { type: 'agent_message', message: 'agent event' }),
      line('event_msg', { type: 'task_complete', last_agent_message: 'completed event' }),
    ])).toBe('completed event');
  });

  it('clears stale text at later user, task, abort, and empty-assistant boundaries', () => {
    const old = line('event_msg', { type: 'agent_message', message: 'Still need an answer?' });
    expect(latestCodexMessageFromRecords([old, line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] })])).toBeUndefined();
    expect(latestCodexMessageFromRecords([old, line('event_msg', { type: 'task_started' })])).toBeUndefined();
    expect(latestCodexMessageFromRecords([old, line('event_msg', { type: 'turn_aborted' })])).toBeUndefined();
    expect(latestCodexMessageFromRecords([old, line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }] })])).toBeUndefined();
  });

  it('returns a newer non-question reply instead of an older question', () => {
    expect(latestCodexMessageFromRecords([
      line('event_msg', { type: 'agent_message', message: 'Which option should I use?' }),
      line('event_msg', { type: 'agent_message', message: 'Implemented and verified.' }),
    ])).toBe('Implemented and verified.');
  });

  it('ignores malformed and non-record json values', () => {
    expect(latestCodexMessageFromRecords([
      'null',
      '[]',
      '42',
      '{bad json',
      line('event_msg', { type: 'agent_message', message: 'Valid reply' }),
    ])).toBe('Valid reply');
  });
});

// write one listable Codex rollout under a date partition, with a top-level `timestamp` per
// record (the last of which is its last-active time), returning its absolute path
async function writeListRollout(home: string, ymd: [string, string, string], id: string, session: { cwd: string; lastActiveAt: string; parentThreadId?: string }): Promise<string> {
  const directory = join(home, 'sessions', ...ymd);
  await mkdir(directory, { recursive: true });
  const lines = [
    { timestamp: '2026-08-01T00:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id, cwd: session.cwd, originator: 'codex-tui', ...(session.parentThreadId === undefined ? {} : { parent_thread_id: session.parentThreadId }) } },
    { timestamp: session.lastActiveAt, ordinal: 1, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } },
  ];
  const file = join(directory, `rollout-${ymd.join('-')}T00-00-00-${id}.jsonl`);
  await writeFile(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

describe('Codex conversation listing', () => {
  it('finds an older named conversation behind a full pane scan of newer child rollouts', async () => {
    const home = await codexHome();
    const cwd = '/wt/cora';
    const parent = '0198c111-1111-7111-8111-111111111111';
    const lastActiveAt = '2026-08-18T10:00:00.000Z';
    await writeListRollout(home, ['2026', '08', '18'], parent, { cwd, lastActiveAt });
    const names = [{ id: parent, thread_name: 'Older conversation' }];
    // fill the whole live-pane window with newer named children in the same folder
    for (let index = 0; index < 512; index++) {
      const id = `0198c222-2222-7222-8222-${index.toString(16).padStart(12, '0')}`;
      await writeListRollout(home, ['2026', '09', '02'], id, { cwd, lastActiveAt: '2026-09-02T10:00:00.000Z', parentThreadId: parent });
      names.push({ id, thread_name: 'Child conversation' });
    }
    await writeSessionIndex(home, names);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(123, []);

    await expect(discoverCodexConversation({ pid: 123, cwd })).resolves.toBeUndefined();
    await expect(codexConversationSummaries([cwd])).resolves.toEqual([
      { id: parent, name: 'Older conversation', lastActiveAt: Date.parse(lastActiveAt), directory: cwd }
    ]);
  });

  it('lists Named top-level conversations under the given directories, newest-active first', async () => {
    const home = await codexHome();
    process.env.CODEX_HOME = home;
    // two in-scope named rollouts across separate date partitions
    await writeListRollout(home, ['2026', '08', '18'], '0198c111-1111-7111-8111-111111111111', { cwd: '/wt/cora', lastActiveAt: '2026-08-18T10:00:00.000Z' });
    await writeListRollout(home, ['2026', '09', '02'], '0198c222-2222-7222-8222-222222222222', { cwd: '/wt/owen', lastActiveAt: '2026-09-02T10:00:00.000Z' });
    // a rollout started outside the requested directories is excluded despite its sidecar name
    await writeListRollout(home, ['2026', '09', '03'], '0198c333-3333-7333-8333-333333333333', { cwd: '/elsewhere', lastActiveAt: '2026-09-03T10:00:00.000Z' });
    // a child thread is excluded even though its cwd matches and it has a name
    await writeListRollout(home, ['2026', '09', '04'], '0198c444-4444-7444-8444-444444444444', { cwd: '/wt/cora', lastActiveAt: '2026-09-04T10:00:00.000Z', parentThreadId: '0198c111-1111-7111-8111-111111111111' });
    // an unnamed rollout (no sidecar line) is excluded, however recent
    await writeListRollout(home, ['2026', '09', '05'], '0198c555-5555-7555-8555-555555555555', { cwd: '/wt/cora', lastActiveAt: '2026-09-05T10:00:00.000Z' });
    // superseded sidecar lines: the last name for an id wins
    await writeSessionIndex(home, [
      { id: '0198c111-1111-7111-8111-111111111111', thread_name: 'Cora provisional' },
      { id: '0198c222-2222-7222-8222-222222222222', thread_name: 'Owen chat' },
      { id: '0198c333-3333-7333-8333-333333333333', thread_name: 'Stranger' },
      { id: '0198c444-4444-7444-8444-444444444444', thread_name: 'Child task' },
      { id: '0198c111-1111-7111-8111-111111111111', thread_name: 'Cora renamed' },
    ]);

    await expect(codexConversationSummaries(['/wt/cora', '/wt/owen'])).resolves.toEqual([
      { id: '0198c222-2222-7222-8222-222222222222', name: 'Owen chat', lastActiveAt: Date.parse('2026-09-02T10:00:00.000Z'), directory: '/wt/owen' },
      { id: '0198c111-1111-7111-8111-111111111111', name: 'Cora renamed', lastActiveAt: Date.parse('2026-08-18T10:00:00.000Z'), directory: '/wt/cora' },
    ]);
  });

  it('matches a rollout recorded under a directory\'s canonical path and reports the given path', async () => {
    const home = await codexHome();
    process.env.CODEX_HOME = home;
    const real = await tempDir('rac-real-');
    const link = join(await tempDir('rac-link-'), 'checkout');
    await symlink(real, link);
    // Codex records the host-canonical cwd; the console scans the symlinked Worktree path
    await writeListRollout(home, ['2026', '09', '02'], '0198c111-1111-7111-8111-111111111111', { cwd: real, lastActiveAt: '2026-09-02T10:00:00.000Z' });
    await writeSessionIndex(home, [{ id: '0198c111-1111-7111-8111-111111111111', thread_name: 'Linked chat' }]);

    await expect(codexConversationSummaries([link])).resolves.toEqual([
      { id: '0198c111-1111-7111-8111-111111111111', name: 'Linked chat', lastActiveAt: Date.parse('2026-09-02T10:00:00.000Z'), directory: link },
    ]);
  });

  it('lists nothing for no directories or an absent sessions tree', async () => {
    const home = await codexHome();
    process.env.CODEX_HOME = home;
    // no directories requested — no walk at all
    await expect(codexConversationSummaries([])).resolves.toEqual([]);
    // a fresh CODEX_HOME with no sessions tree contributes nothing rather than throwing
    await expect(codexConversationSummaries(['/wt/cora'])).resolves.toEqual([]);
  });

  it('clamps a long or whitespace-laden sidecar name to the shared UI bound', async () => {
    const home = await codexHome();
    process.env.CODEX_HOME = home;
    await writeListRollout(home, ['2026', '09', '02'], '0198c111-1111-7111-8111-111111111111', { cwd: '/wt/cora', lastActiveAt: '2026-09-02T10:00:00.000Z' });
    // a name Codex generated from a long first message reaches the sidecar unbounded and with
    // surrounding whitespace; the reader must collapse and clamp it as every other Codex string
    await writeSessionIndex(home, [{ id: '0198c111-1111-7111-8111-111111111111', thread_name: `  ${'x'.repeat(200)}  ` }]);

    const [row] = await codexConversationSummaries(['/wt/cora']);
    expect(row?.name).toBe(`${'x'.repeat(119)}…`);
    expect(row?.name.length).toBe(120);
  });
});
