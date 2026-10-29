import { describe, expect, it } from 'vitest';
import { piHistory } from '../src/transports/pi.js';

// Pi's messages (`get_messages`) in the shapes the pinned Pi writes them, trimmed to the fields read
const usage = (total: number) => ({ input: 1000, output: 50, totalTokens: 1050, cost: { total } });
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });

describe('a Pi Conversation reloaded from its messages', () => {
  it('groups each prompt with its steers, answers, thinking and tool calls, and ends it with its cost and calls', () => {
    const messages = [
      { role: 'system', content: '', sections: { preamble: 'You are an expert coding assistant' } },
      user('Tidy the notes'),
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Look at the file first.' }, { type: 'text', text: 'Checking.' }, { type: 'toolCall', id: 'call_0', name: 'grep', arguments: { pattern: 'a', path: '.' } }, { type: 'toolCall', id: 'call_1', name: 'edit', arguments: { path: 'docs/notes.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] } }], usage: usage(0.0011), stopReason: 'toolUse' },
      { role: 'toolResult', toolCallId: 'call_0', toolName: 'grep', content: [{ type: 'text', text: 'notes.txt:1: alpha\nnotes.txt-2- beta\nnotes.txt:3: gamma\n\n[2 matches limit reached. Use limit=4 for more]' }], isError: false, durationMs: 20 },
      { role: 'toolResult', toolCallId: 'call_1', toolName: 'edit', content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in docs/notes.txt.' }], details: { patch: '--- docs/notes.txt\n+++ docs/notes.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n' }, isError: false, durationMs: 11 },
      user('Also keep gamma'),
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: usage(0.0021), stopReason: 'stop' },
      user('Now run the tests'),
      { role: 'assistant', content: [], usage: usage(0.001), stopReason: 'error', errorMessage: 'rate limited' }
    ];

    expect(piHistory(messages)).toEqual([
      { id: 'h0', kind: 'message', role: 'user', text: 'Tidy the notes' },
      { id: 'h1', kind: 'thinking', text: 'Look at the file first.' },
      { id: 'h2', kind: 'message', role: 'assistant', text: 'Checking.' },
      { id: 'call_0', kind: 'tool', name: 'Search', summary: 'a', state: 'done', durationMs: 20, output: 'notes.txt:1: alpha\nnotes.txt-2- beta\nnotes.txt:3: gamma\n\n[2 matches limit reached. Use limit=4 for more]', result: '2 matches' },
      { id: 'call_1', kind: 'tool', name: 'Edit', summary: 'docs/notes.txt', state: 'done', durationMs: 11, output: 'Successfully replaced 1 block(s) in docs/notes.txt.', diff: { path: 'docs/notes.txt', patch: '--- docs/notes.txt\n+++ docs/notes.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n' } },
      // a prompt that follows a tool's result reached the Agent mid-Turn: a steer
      { id: 'h5', kind: 'message', role: 'user', text: 'Also keep gamma', steer: true },
      { id: 'h6', kind: 'message', role: 'assistant', text: 'Done.' },
      { id: 'h7', kind: 'settled', outcome: 'done', cost: expect.closeTo(0.0032, 6), toolCalls: 2 },
      { id: 'h8', kind: 'message', role: 'user', text: 'Now run the tests' },
      { id: 'h9', kind: 'message', role: 'assistant', text: 'Error: rate limited' },
      { id: 'h10', kind: 'settled', outcome: 'failed', cost: 0.001, toolCalls: 0 }
    ]);
  });

  it('nests a script\'s calls under it, without their results, and ends an aborted Turn as cancelled', () => {
    const messages = [
      user('Check every badge'),
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call_0', name: 'codemode', arguments: { code: 'await tools.read({ path: "notes.txt" });' } }], usage: usage(0.002), stopReason: 'toolUse' },
      { role: 'toolResult', toolCallId: 'call_0', toolName: 'codemode', content: [{ type: 'text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'text', text: 'ok' }], isError: false, durationMs: 104, nestedCalls: { calls: [{ id: 'call_0/1', name: 'read', status: 'ok', arguments: { path: 'notes.txt' }, durationMs: 2.3 }, { id: 'call_0/2', name: 'bash', status: 'error', arguments: { command: 'false' }, durationMs: 6 }], complete: true } },
      { role: 'assistant', content: [], usage: usage(0.001), stopReason: 'aborted' }
    ];

    expect(piHistory(messages)).toEqual([
      { id: 'h0', kind: 'message', role: 'user', text: 'Check every badge' },
      { id: 'call_0', kind: 'tool', name: 'Script', summary: '2 tool calls', state: 'done', source: 'await tools.read({ path: "notes.txt" });', durationMs: 104, output: 'Script completed\nWall time 0.1 seconds\nOutput:\nok', result: 'Script completed' },
      { id: 'call_0/1', kind: 'tool', name: 'Read', summary: 'notes.txt', state: 'done', parentId: 'call_0', durationMs: 2, kept: false },
      { id: 'call_0/2', kind: 'tool', name: 'Run', summary: 'false', state: 'failed', parentId: 'call_0', durationMs: 6, kept: false },
      { id: 'h4', kind: 'settled', outcome: 'cancelled', cost: 0.003, toolCalls: 3 }
    ]);
  });
});
