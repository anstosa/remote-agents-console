import { appendFile, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { codexConversationName, codexConversationSummaries, codexLatestMessage, codexLatestResponse, codexLatestWriterResponse, codexProcessOwnsConversation, latestCodexMessageFromRecords, latestCodexResponseFromRecords, discoverCodexConversation, openPaneThreads, validCodexThreadId } from '../../src/adapters/codex-conversations.js';
import { codexHome, fakeProc, tempDir } from '../helpers/codex-fixtures.js';

// observe only the filesystem boundaries that govern catalog work
const catalogRead = vi.hoisted(() => vi.fn((_phase: 'head' | 'tail', _file: string, read: () => Promise<string[]>) => read()));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, readdir: vi.fn(fs.readdir) };
});
vi.mock('../../src/adapters/bounded-file.js', async importOriginal => {
  const bounded = await importOriginal<typeof import('../../src/adapters/bounded-file.js')>();
  return {
    ...bounded,
    // keep real reads behind the controllable test seam
    readFileHead: (file: string, bytes: number) => catalogRead('head', file, () => bounded.readFileHead(file, bytes)),
    readFileTail: (file: string, bytes: number) => catalogRead('tail', file, () => bounded.readFileTail(file, bytes))
  };
});

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
    await expect(codexProcessOwnsConversation(123, id)).resolves.toBe(true);
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
    await expect(codexProcessOwnsConversation(123, first)).resolves.toBe(false);
    await expect(codexProcessOwnsConversation(123, second)).resolves.toBe(false);
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
    await expect(codexProcessOwnsConversation(123, '0198c777-7777-7777-8777-777777777777')).resolves.toBe(false);
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

  // preview selection must obey the current writer even while old history remains open
  it('reads completed output only from the writer-owned current conversation', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    const currentId = '0198c777-7777-7777-8777-777777777777';
    const oldId = '0198c888-8888-7888-8888-888888888888';
    const current = await writeSession(home, 'rollout-current', { id: currentId, cwd, prompt: 'Current prompt' });
    const old = await writeSession(home, 'rollout-old', { id: oldId, cwd, prompt: 'Old prompt' });
    await appendFile(current, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Current response' } })}\n`);
    await appendFile(old, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Old response' } })}\n`);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeWriterProc(home, [currentId], { open: [old] });

    await expect(codexLatestResponse({ pid: 123, cwd, conversationId: currentId })).resolves.toBe('Current response');
    await expect(codexLatestWriterResponse(123, currentId)).resolves.toBe('Current response');
    await expect(codexLatestResponse({ pid: 123, cwd, conversationId: oldId })).resolves.toBeUndefined();

    // losing the writer cannot fall back to a still-open rollout descriptor
    process.env.RAC_HOST_PROC = await fakeProc(123, [current]);
    await expect(codexLatestWriterResponse(123, currentId)).resolves.toBeUndefined();
  });

  // a writer can precede its first persisted rollout and is authoritative over old cwd history
  it('does not return an older response for an unwritten current writer', async () => {
    const home = await codexHome();
    const cwd = '/home/ubuntu/cora';
    const old = await writeSession(home, 'rollout-old', { id: '0198c888-8888-7888-8888-888888888888', cwd, prompt: 'Old prompt' });
    await appendFile(old, `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Old response' } })}\n`);
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeWriterProc(home, ['0198c777-7777-7777-8777-777777777777'], { open: [old] });

    await expect(codexLatestResponse({ pid: 123, cwd })).resolves.toBeUndefined();
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

describe('Codex latest completed response', () => {
  // create one native event under the current thread
  const event = (payload: object) => JSON.stringify({ type: 'event_msg', payload });

  it('publishes prose only after its matching terminal completion', () => {
    const incomplete = [
      event({ type: 'task_started' }),
      event({ type: 'agent_message', phase: 'final_answer', message: 'not completed yet' })
    ];
    expect(latestCodexResponseFromRecords(incomplete)).toBeUndefined();
    expect(latestCodexResponseFromRecords([...incomplete, event({ type: 'task_complete', last_agent_message: null })])).toBe('not completed yet');
  });

  it('does not promote prose on another native turn terminal', () => {
    const incomplete = [
      event({ type: 'task_started', turn_id: 'turn-one' }),
      event({ type: 'agent_message', turn_id: 'turn-one', phase: 'final_answer', message: 'matching answer' }),
      event({ type: 'task_complete', turn_id: 'turn-two', last_agent_message: null })
    ];
    expect(latestCodexResponseFromRecords(incomplete)).toBeUndefined();
    expect(latestCodexResponseFromRecords([...incomplete, event({ type: 'task_complete', turn_id: 'turn-one', last_agent_message: null })])).toBe('matching answer');
  });

  it('correlates nested assistant items with their enclosing native turn', () => {
    const start = event({ type: 'task_started', turn_id: 'turn-one' });
    const matching = event({ type: 'item_completed', turn_id: 'turn-one', item: { type: 'AgentMessage', turn_id: 'turn-one', phase: 'final_answer', content: 'matching nested answer' } });
    const conflicting = event({ type: 'item_completed', turn_id: 'turn-two', item: { type: 'AgentMessage', turn_id: 'turn-one', phase: 'final_answer', content: 'foreign nested answer' } });
    const complete = event({ type: 'task_complete', turn_id: 'turn-one', last_agent_message: null });
    expect(latestCodexResponseFromRecords([start, matching, complete])).toBe('matching nested answer');
    expect(latestCodexResponseFromRecords([start, conflicting, complete])).toBeUndefined();
  });

  it('retains the earlier completed answer across failed, aborted and empty turns', () => {
    const completed = [event({ type: 'agent_message', message: 'Proven answer' }), event({ type: 'task_complete', last_agent_message: null })];
    expect(latestCodexResponseFromRecords([...completed, event({ type: 'task_started' }), event({ type: 'agent_message', message: 'partial' }), event({ type: 'turn_aborted' })])).toBe('Proven answer');
    expect(latestCodexResponseFromRecords([...completed, event({ type: 'task_started' }), event({ type: 'task_complete', last_agent_message: null })])).toBe('Proven answer');
  });

  it('ignores other threads and commentary at completion', () => {
    expect(latestCodexResponseFromRecords([
      event({ type: 'agent_message', thread_id: 'child', message: 'Child answer' }),
      event({ type: 'task_complete', thread_id: 'child', last_agent_message: 'Child answer' }),
      event({ type: 'agent_message', thread_id: 'parent', phase: 'commentary', message: 'Progress' }),
      event({ type: 'task_complete', thread_id: 'parent', last_agent_message: null })
    ], 'parent')).toBeUndefined();
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

  // leave one slot after the full batches and stop at the next eligible candidate
  it('stops scanning at the last eligible catalog slot before sorting by activity', async () => {
    const home = await codexHome();
    const cwd = '/wt/cora';
    const names = [];
    // leave the two hottest entries near the cutoff in newest-first filename order
    for (let index = 0; index <= 513; index++) {
      const id = `0198c222-2222-7222-8222-${index.toString(16).padStart(12, '0')}`;
      names.push({ id, thread_name: `Conversation ${index}` });
      const lastActiveAt = index <= 2 ? '2026-09-05T00:00:00Z' : '2026-09-02T00:00:00Z';
      await writeListRollout(home, ['2026', '09', '02'], id, { cwd: index === 256 ? '/other' : cwd, lastActiveAt });
    }
    const older = '0198c222-2222-7222-8222-111111111111';
    await writeListRollout(home, ['2026', '08', '20'], older, { cwd, lastActiveAt: '2026-09-06T00:00:00Z' });
    names.push({ id: older, thread_name: 'Older conversation' });
    await writeSessionIndex(home, names);

    catalogRead.mockClear();
    vi.mocked(readdir).mockClear();
    const rows = await codexConversationSummaries([cwd], { CODEX_HOME: home });
    // protect the exact cap and stable tie ordering even beside a newer activity timestamp
    const expected = [names[2], names[1], ...names.slice(3, -1).reverse().filter(({ id }) => id !== names[256].id)];
    expect(rows.map(row => row.id)).toEqual(expected.map(({ id }) => id));
    expect(catalogRead.mock.calls.some(([, file]) => file.endsWith(`-${names[0].id}.jsonl`))).toBe(false);
    expect(readdir).not.toHaveBeenCalledWith(join(home, 'sessions', '2026', '08'), expect.anything());
  }, 30_000);

  // hold reads at the storage boundary instead of depending on filesystem speed
  it('bounds overlapping rollout reads and isolates failures without changing tie order', async () => {
    const home = await codexHome();
    const cwd = '/wt/cora';
    const lastActiveAt = '2026-09-02T00:00:00Z';
    const names = [];
    const files = [];
    // supply more candidates than one full batch can launch
    for (let index = 0; index < 18; index++) {
      const id = `0198c444-4444-7444-8444-${index.toString(16).padStart(12, '0')}`;
      names.push({ id, thread_name: `Conversation ${index}` });
      files.push(await writeListRollout(home, ['2026', '09', '02'], id, { cwd, lastActiveAt }));
    }
    await writeSessionIndex(home, names);
    const heads = Promise.withResolvers<void>();
    const firstTail = Promise.withResolvers<void>();
    let pending = 0;
    let peak = 0;
    let siblingFinished = false;
    let unreadableHeadHasTail = false;
    catalogRead.mockClear();
    // observe rollout reads only and let the sidecar use real storage
    catalogRead.mockImplementation(async (phase, file, read) => {
      // ignore sidecar and other non-rollout reads
      if (!files.includes(file)) return read();
      peak = Math.max(peak, ++pending);
      try {
        // let enough heads pile up to observe the actual batch width
        if (phase === 'head') await heads.promise;
        // keep the first tail behind a healthy sibling
        if (phase === 'tail' && file === files[17]) await firstTail.promise;
        // both failure kinds must be local to their own rollout
        if ((phase === 'head' && file === files[16]) || (phase === 'tail' && file === files[15])) throw new Error('unreadable rollout');
        // the failed head must not trigger any tail read
        if (phase === 'tail' && file === files[16]) unreadableHeadHasTail = true;
        const lines = await read();
        // release scan order only after a later tie has finished
        if (phase === 'tail' && file === files[14]) siblingFinished = true;
        return lines;
      } finally {
        pending -= 1;
      }
    });
    const listing = codexConversationSummaries([cwd], { CODEX_HOME: home });
    // observe early rejection while still asserting the original promise below
    void listing.catch(() => {});
    try {
      await vi.waitFor(() => { /* require full-width overlap without clock assertions */ expect(pending).toBeGreaterThanOrEqual(16); }, { timeout: 5_000 });
      heads.resolve();
      await vi.waitFor(() => { /* prove a later tie really completes first */ expect(siblingFinished).toBe(true); }, { timeout: 5_000 });
    } finally {
      heads.resolve();
      firstTail.resolve();
      try { await listing; } finally { catalogRead.mockReset(); }
    }
    const rows = await listing;
    const expected = [names[17], ...names.slice(0, 15).reverse(), names[15]];
    expect(rows.map(({ id, lastActiveAt: activity }) => [id, activity])).toEqual(expected.map(({ id }) => {
      // an unreadable tail ranks last but does not lose its row
      return [id, id === names[15].id ? 0 : Date.parse(lastActiveAt)];
    }));
    expect(peak).toBe(16);
    expect(unreadableHeadHasTail).toBe(false);
  }, 15_000);

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
