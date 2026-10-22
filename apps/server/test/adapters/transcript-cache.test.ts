import { appendFile, mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexHome as makeCodexHome, fakeProc, tempDir } from '../helpers/codex-fixtures.js';

const boundedReads = vi.hoisted(() => ({ head: vi.fn(), tail: vi.fn() }));

// count bounded content reads while retaining the production implementation
vi.mock('../../src/adapters/bounded-file.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/adapters/bounded-file.js')>();
  return {
    ...original,
    readFileHead: async (path: string, maxBytes: number) => {
      boundedReads.head(path, maxBytes);
      return original.readFileHead(path, maxBytes);
    },
    readFileTail: async (path: string, maxBytes: number) => {
      boundedReads.tail(path, maxBytes);
      return original.readFileTail(path, maxBytes);
    }
  };
});

import {
  claudeConversationLatestMessage,
  claudeConversationName,
  claudeConversationSummaries,
  claudeLastAssistantMessage
} from '../../src/adapters/claude-conversations.js';
import {
  codexConversationName,
  codexConversationSummaries,
  codexLatestMessage,
  discoverCodexConversation
} from '../../src/adapters/codex-conversations.js';

const claudeId = '11111111-2222-4333-8444-555555555555';
const codexId = '0198c333-3333-7333-8333-333333333333';
const claudeCwd = '/workspace/cache';
const claudeProject = '-workspace-cache';

// reset only per-test observations; fixture cleanup is registered by codex-fixtures
afterEach(() => { boundedReads.head.mockClear(); boundedReads.tail.mockClear(); });

// serialize JSONL records with a terminal newline
function jsonl(records: readonly object[]): string {
  return `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
}

// create one Claude transcript under an isolated config root
async function claudeFixture(records: readonly object[]): Promise<{ configDir: string; transcript: string; sidecar: string }> {
  const configDir = await tempDir('rac-transcript-cache-claude-');
  const project = join(configDir, 'projects', claudeProject);
  await mkdir(project, { recursive: true });
  const transcript = join(project, `${claudeId}.jsonl`);
  await writeFile(transcript, jsonl(records));
  return { configDir, transcript, sidecar: join(project, claudeId, 'custom-title.json') };
}

// write one Codex rollout and its account-global name index
async function codexFixture(home: string, name: string): Promise<{ rollout: string; index: string }> {
  const directory = join(home, 'sessions', '2026', '10', '07');
  await mkdir(directory, { recursive: true });
  const rollout = join(directory, `rollout-2026-10-07T12-00-00-${codexId}.jsonl`);
  await writeFile(rollout, jsonl([
    { timestamp: '2026-10-07T12:00:00.000Z', type: 'session_meta', payload: { id: codexId, cwd: '/workspace/codex', timestamp: '2026-10-07T12:00:00.000Z', originator: 'codex-tui' } },
    { timestamp: '2026-10-07T12:01:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Index this rollout' }] } },
    { timestamp: '2026-10-07T12:02:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Cached answer' } }
  ]));
  const index = join(home, 'session_index.jsonl');
  await writeFile(index, jsonl([{ id: codexId, thread_name: name }]));
  return { rollout, index };
}

// select calls that opened one exact file through a bounded reader
function callsFor(reader: typeof boundedReads.head, path: string): unknown[][] {
  return reader.mock.calls.filter(call => call[0] === path);
}

describe('transcript parsed-result caches', () => {
  it('reuses unchanged Claude title, summary and message parses', async () => {
    const fixture = await claudeFixture([
      { type: 'custom-title', customTitle: 'Cached Claude title', timestamp: '2026-10-07T12:00:00.000Z' },
      { type: 'assistant', message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Cached Claude answer' }] }, timestamp: '2026-10-07T12:01:00.000Z' }
    ]);
    const env = { RAC_CLAUDE_CONFIG_DIR: fixture.configDir } as NodeJS.ProcessEnv;
    const pane = { pid: 1, cwd: claudeCwd, conversationId: claudeId };

    await expect(claudeConversationName(claudeId, claudeCwd, env)).resolves.toBe('Cached Claude title');
    await expect(claudeConversationName(claudeId, claudeCwd, env)).resolves.toBe('Cached Claude title');
    await expect(claudeConversationSummaries([claudeCwd], env)).resolves.toHaveLength(1);
    await expect(claudeConversationSummaries([claudeCwd], env)).resolves.toHaveLength(1);
    await expect(claudeConversationLatestMessage(pane, env)).resolves.toBe('Cached Claude answer');
    await expect(claudeConversationLatestMessage(pane, env)).resolves.toBe('Cached Claude answer');
    await expect(claudeLastAssistantMessage(claudeId, claudeCwd, env)).resolves.toMatchObject({ text: 'Cached Claude answer' });
    await expect(claudeLastAssistantMessage(claudeId, claudeCwd, env)).resolves.toMatchObject({ text: 'Cached Claude answer' });

    expect(callsFor(boundedReads.head, fixture.transcript)).toHaveLength(2);
    expect(callsFor(boundedReads.tail, fixture.transcript)).toHaveLength(2);
  });

  it('invalidates Claude message results across transcript mutations and recovery', async () => {
    const first = { type: 'assistant', message: { id: 'first', role: 'assistant', content: [{ type: 'text', text: 'first' }] } };
    const fixture = await claudeFixture([first]);
    const env = { RAC_CLAUDE_CONFIG_DIR: fixture.configDir } as NodeJS.ProcessEnv;
    const pane = { pid: 1, cwd: claudeCwd, conversationId: claudeId };

    await expect(claudeConversationLatestMessage(pane, env)).resolves.toBe('first');
    await appendFile(fixture.transcript, jsonl([{ type: 'assistant', message: { id: 'second', role: 'assistant', content: [{ type: 'text', text: 'second' }] } }]));
    await expect(claudeConversationLatestMessage(pane, env)).resolves.toBe('second');
    await writeFile(fixture.transcript, jsonl([{ type: 'assistant', message: { id: 'short', role: 'assistant', content: 'short' } }]));
    await expect(claudeConversationLatestMessage(pane, env)).resolves.toBe('short');

    const beforeRewrite = await stat(fixture.transcript);
    const sameSize = jsonl([{ type: 'assistant', message: { id: 'short', role: 'assistant', content: 'other' } }]);
    await writeFile(fixture.transcript, sameSize);
    await utimes(fixture.transcript, beforeRewrite.atime, beforeRewrite.mtime);
    await expect(claudeConversationLatestMessage(pane, env)).resolves.toBe('other');

    const replacement = `${fixture.transcript}.replacement`;
    await writeFile(replacement, jsonl([{ type: 'assistant', message: { id: 'newer', role: 'assistant', content: 'newer' } }]));
    await rename(replacement, fixture.transcript);
    await expect(claudeConversationLatestMessage(pane, env)).resolves.toBe('newer');
    await rm(fixture.transcript);
    await expect(claudeConversationLatestMessage(pane, env)).resolves.toBeUndefined();
    await writeFile(fixture.transcript, jsonl([{ type: 'assistant', message: { id: 'again', role: 'assistant', content: 'again' } }]));
    await expect(claudeConversationLatestMessage(pane, env)).resolves.toBe('again');

    expect(callsFor(boundedReads.tail, fixture.transcript)).toHaveLength(6);
  });

  it('consults Claude sidecars independently from cached transcript fields', async () => {
    const fixture = await claudeFixture([
      { type: 'ai-title', aiTitle: 'Generated fallback', timestamp: '2026-10-07T12:00:00.000Z' }
    ]);
    await mkdir(join(fixture.configDir, 'projects', claudeProject, claudeId), { recursive: true });
    await writeFile(fixture.sidecar, JSON.stringify({ customTitle: 'Human title one' }));
    const env = { RAC_CLAUDE_CONFIG_DIR: fixture.configDir } as NodeJS.ProcessEnv;

    await expect(claudeConversationName(claudeId, claudeCwd, env)).resolves.toBe('Human title one');
    await expect(claudeConversationSummaries([claudeCwd], env)).resolves.toEqual([
      { id: claudeId, name: 'Human title one', automatic: false, lastActiveAt: Date.parse('2026-10-07T12:00:00.000Z'), directory: claudeCwd }
    ]);
    await writeFile(fixture.sidecar, JSON.stringify({ customTitle: 'Human title two' }));
    await expect(claudeConversationName(claudeId, claudeCwd, env)).resolves.toBe('Human title two');
    await rm(fixture.sidecar);
    await expect(claudeConversationName(claudeId, claudeCwd, env)).resolves.toBe('Generated fallback');
    await writeFile(fixture.sidecar, JSON.stringify({ customTitle: 'Human title new' }));
    await expect(claudeConversationName(claudeId, claudeCwd, env)).resolves.toBe('Human title new');

    expect(callsFor(boundedReads.head, fixture.transcript)).toHaveLength(2);
    expect(callsFor(boundedReads.head, fixture.sidecar)).toHaveLength(3);
  });

  it('reuses Codex metadata, title, recency, latest-message and shared index parses', async () => {
    const home = await makeCodexHome();
    const fixture = await codexFixture(home, 'Cached Codex name');
    process.env.CODEX_HOME = home;
    process.env.RAC_HOST_PROC = await fakeProc(321, [fixture.rollout]);
    const pane = { pid: 321, cwd: '/workspace/codex', conversationId: codexId };

    await expect(discoverCodexConversation(pane)).resolves.toEqual({ id: codexId, title: 'Index this rollout' });
    await expect(discoverCodexConversation(pane)).resolves.toEqual({ id: codexId, title: 'Index this rollout' });
    await expect(codexLatestMessage(pane)).resolves.toBe('Cached answer');
    await expect(codexLatestMessage(pane)).resolves.toBe('Cached answer');
    await expect(codexConversationName(codexId)).resolves.toBe('Cached Codex name');
    await expect(codexConversationName(codexId)).resolves.toBe('Cached Codex name');
    await expect(codexConversationSummaries(['/workspace/codex'])).resolves.toEqual([
      { id: codexId, name: 'Cached Codex name', lastActiveAt: Date.parse('2026-10-07T12:02:00.000Z'), directory: '/workspace/codex' }
    ]);
    await expect(codexConversationSummaries(['/workspace/codex'])).resolves.toHaveLength(1);

    expect(callsFor(boundedReads.head, fixture.rollout)).toHaveLength(1);
    expect(callsFor(boundedReads.tail, fixture.rollout)).toHaveLength(3);
    expect(callsFor(boundedReads.tail, fixture.index)).toHaveLength(1);
  });

  it('invalidates the shared Codex name index and isolates account roots', async () => {
    const firstHome = await makeCodexHome();
    const first = await codexFixture(firstHome, 'First account');
    const secondHome = await makeCodexHome();
    const second = await codexFixture(secondHome, 'Second account');

    process.env.CODEX_HOME = firstHome;
    await expect(codexConversationName(codexId)).resolves.toBe('First account');
    await appendFile(first.index, jsonl([{ id: codexId, thread_name: 'First renamed' }]));
    await expect(codexConversationName(codexId)).resolves.toBe('First renamed');
    await rm(first.index);
    await expect(codexConversationName(codexId)).resolves.toBeUndefined();
    await writeFile(first.index, jsonl([{ id: codexId, thread_name: 'First recovered' }]));
    await expect(codexConversationName(codexId)).resolves.toBe('First recovered');

    process.env.CODEX_HOME = secondHome;
    await expect(codexConversationName(codexId)).resolves.toBe('Second account');
    process.env.CODEX_HOME = firstHome;
    await expect(codexConversationName(codexId)).resolves.toBe('First recovered');

    expect(callsFor(boundedReads.tail, first.index)).toHaveLength(3);
    expect(callsFor(boundedReads.tail, second.index)).toHaveLength(1);
  });

  it('shares the Codex index while preserving by-id and listing whitespace semantics', async () => {
    const home = await makeCodexHome();
    const fixture = await codexFixture(home, 'Useful name');
    await appendFile(fixture.index, jsonl([{ id: codexId, thread_name: '   ' }]));
    process.env.CODEX_HOME = home;

    await expect(codexConversationName(codexId)).resolves.toBeUndefined();
    await expect(codexConversationSummaries(['/workspace/codex'])).resolves.toEqual([
      { id: codexId, name: 'Useful name', lastActiveAt: Date.parse('2026-10-07T12:02:00.000Z'), directory: '/workspace/codex' }
    ]);

    expect(callsFor(boundedReads.tail, fixture.index)).toHaveLength(1);
  });

  it('isolates identical Claude transcript identities across config roots', async () => {
    const first = await claudeFixture([{ type: 'custom-title', customTitle: 'First root' }]);
    const second = await claudeFixture([{ type: 'custom-title', customTitle: 'Second root' }]);

    await expect(claudeConversationName(claudeId, claudeCwd, { RAC_CLAUDE_CONFIG_DIR: first.configDir } as NodeJS.ProcessEnv)).resolves.toBe('First root');
    await expect(claudeConversationName(claudeId, claudeCwd, { RAC_CLAUDE_CONFIG_DIR: second.configDir } as NodeJS.ProcessEnv)).resolves.toBe('Second root');
    await expect(claudeConversationName(claudeId, claudeCwd, { RAC_CLAUDE_CONFIG_DIR: first.configDir } as NodeJS.ProcessEnv)).resolves.toBe('First root');

    expect(callsFor(boundedReads.head, first.transcript)).toHaveLength(1);
    expect(callsFor(boundedReads.head, second.transcript)).toHaveLength(1);
  });
});
