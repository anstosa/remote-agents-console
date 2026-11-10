import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeHistory } from '../src/transports/claude.js';

// session JSONL as Claude Code 2.1.319 writes it (sanitized from the probes' sessions), and an Edit
// and a Write in the shape it keeps them
const records = (name: string): string[] => readFileSync(new URL(`./fixtures/claude/structured/${name}`, import.meta.url), 'utf8').split('\n');

describe('a Claude Conversation reloaded from its session JSONL', () => {
  it('groups each prompt with the steer it folded in, its tool calls and answers, and keeps notices for /rename and /compact', () => {
    const items = claudeHistory(records('session-steer-compact.jsonl'));
    expect(items.map(item => [item.kind, item.id])).toEqual([
      ['message', '2b13aa18-d4df-4843-8ed2-dc7ea6aeff5a'],
      ['tool', 'toolu_01S35pdxTGVzeWngjpyXvf7K'],
      // by the id the prompt was sent under
      ['message', '49ea2223-c697-42bf-909c-f6dca7832186'],
      ['message', '6351ef64-938d-4b92-aae7-b06173353553:0'],
      ['settled', '2b13aa18-d4df-4843-8ed2-dc7ea6aeff5a:end'],
      ['message', '2bb06ebb-452a-40fb-999c-5728bbea32ed'],
      ['tool', 'toolu_01XuGQ7G4PnMnHwGi8gAqPXk'],
      ['message', '7fcae708-4250-4c41-bbaf-334032338767:0'],
      ['notice', '09fbba19-f1d7-4377-84f4-6be3b2d7976b'],
      ['settled', '2bb06ebb-452a-40fb-999c-5728bbea32ed:end'],
      ['message', '36450ae2-1431-478a-8ca8-440cb2110586'],
      ['message', 'a7b7d1b3-e771-4b28-918c-94a1f84b2b55:0'],
      ['notice', 'b38738c9-4c3d-4227-8834-aaed5b0c2e64'],
      ['settled', '36450ae2-1431-478a-8ca8-440cb2110586:end']
    ]);
    expect(items[1]).toEqual({ id: 'toolu_01S35pdxTGVzeWngjpyXvf7K', kind: 'tool', name: 'Run', summary: 'sleep 8; echo done', state: 'done', durationMs: 8824, output: 'done' });
    expect(items[2]).toEqual({ id: '49ea2223-c697-42bf-909c-f6dca7832186', kind: 'message', role: 'user', text: 'Also: end your final reply with the word BANANA.', steer: true });
    expect(items[4]).toEqual({ id: '2b13aa18-d4df-4843-8ed2-dc7ea6aeff5a:end', kind: 'settled', outcome: 'done', toolCalls: 1 });
    expect(items[8]).toEqual({ id: '09fbba19-f1d7-4377-84f4-6be3b2d7976b', kind: 'notice', text: 'Session renamed to: rac-probe', tone: 'info' });
    expect(items[12]).toEqual({ id: 'b38738c9-4c3d-4227-8834-aaed5b0c2e64', kind: 'notice', text: 'Compacted the conversation: 30k → 11k tokens of context', tone: 'info', detail: expect.stringMatching(/^This session is being continued/u) });
  });

  it('ends an interrupted Turn cancelled, and the steer the CLI ran after it as a prompt of its own', () => {
    const items = claudeHistory(records('session-interrupt.jsonl'));
    expect(items.filter(item => item.kind === 'settled').map(item => item.kind === 'settled' && item.outcome)).toEqual(['done', 'done', 'cancelled', 'done']);
    expect(items.find(item => item.id === 'toolu_016xjQYPe3NXNTPj4fmeiagK')).toMatchObject({ state: 'failed', output: expect.stringContaining('Read-only file system') });
    expect(items.slice(-3)).toEqual([
      { id: 'cb95ae88-0ba0-468f-932c-f37ba7e73295', kind: 'message', role: 'user', text: 'Then also say PEAR.' },
      { id: '2067a848-f28c-4c86-ab7e-5b1a3d478ebd:0', kind: 'message', role: 'assistant', text: expect.stringMatching(/^PEAR/u) },
      { id: 'cb95ae88-0ba0-468f-932c-f37ba7e73295:end', kind: 'settled', outcome: 'done', toolCalls: 0 }
    ]);
  });

  it('shows an edit\'s patch and a created file as a diff', () => {
    const items = claudeHistory(records('session-edit.jsonl'));
    expect(items.filter(item => item.kind === 'tool')).toEqual([
      { id: 'toolu_edit', kind: 'tool', name: 'Edit', summary: '/work/project/notes.txt', state: 'done', durationMs: 250, output: 'The file /work/project/notes.txt has been updated successfully.', diff: { path: '/work/project/notes.txt', patch: '--- /work/project/notes.txt\n+++ /work/project/notes.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n' } },
      { id: 'toolu_write', kind: 'tool', name: 'Write', summary: '/work/project/todo.txt', state: 'done', durationMs: 100, output: 'File created successfully at: /work/project/todo.txt', diff: { path: '/work/project/todo.txt', patch: '--- /work/project/todo.txt\n+++ /work/project/todo.txt\n@@ -0,0 +1,1 @@\n+ship it\n' } }
    ]);
  });

  it('leaves the last prompt\'s Turn open while it still runs', () => {
    const items = claudeHistory(records('session-interrupt.jsonl'), { running: true });
    expect(items.at(-1)).toMatchObject({ kind: 'message', role: 'assistant' });
  });
});
