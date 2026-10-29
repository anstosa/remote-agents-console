import { afterEach, describe, expect, it, vi } from 'vitest';
import { piClient } from '../src/transports/pi.js';
import type { LineChannel, StructuredEvent } from '../src/transports/structured.js';

// The Pi client over an in-memory channel: the test plays Pi, feeding it RPC records shaped as
// Pi 1.4.0 sends them (docs/rpc-extension-ui.md, rpc-commands.md) and reading what it sends back.
function piOverChannel(attached?: { dropped: number }) {
  const sent: Array<Record<string, unknown>> = [];
  const events: StructuredEvent[] = [];
  let listener: (line: string) => void = () => {};
  const channel: LineChannel = { send: line => sent.push(JSON.parse(line) as Record<string, unknown>), onLine: next => { listener = next; }, onClose: () => {}, close: () => {} };
  const connection = piClient(channel, event => events.push(event), attached);
  const pi = (record: object) => listener(JSON.stringify(record));
  const questions = () => events.flatMap(event => event.type === 'question' ? [event.question] : []);
  const closed = () => events.flatMap(event => event.type === 'question-closed' ? [event.id] : []);
  const responses = () => sent.filter(record => record.type === 'extension_ui_response');
  return { connection, sent, events, pi, questions, closed, responses };
}

afterEach(() => { vi.useRealTimers(); });

describe('the Pi client', () => {
  it('maps a confirm to a Yes/No choice and answers Yes as confirmed, No as not', async () => {
    const { connection, pi, questions, responses } = piOverChannel();
    pi({ type: 'extension_ui_request', id: 'c1', method: 'confirm', title: 'Clear session?', message: 'All messages will be lost.' });
    pi({ type: 'extension_ui_request', id: 'c2', method: 'confirm', title: 'Proceed?', message: '' });
    expect(questions()).toEqual([
      { id: 'c1', text: 'Clear session?\n\nAll messages will be lost.', field: { kind: 'choice', choices: ['Yes', 'No'] } },
      { id: 'c2', text: 'Proceed?', field: { kind: 'choice', choices: ['Yes', 'No'] } }
    ]);
    expect(await connection.answer('c1', 0)).toBe(true);
    expect(await connection.answer('c2', 1)).toBe(true);
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'c1', confirmed: true }, { type: 'extension_ui_response', id: 'c2', confirmed: false }]);
  });

  it('maps input to one line of text and editor to several with a prefill; text answers as its value, Dismiss as cancelled', async () => {
    const { connection, pi, questions, closed, responses } = piOverChannel();
    pi({ type: 'extension_ui_request', id: 'i1', method: 'input', title: 'Name?', placeholder: 'your name' });
    pi({ type: 'extension_ui_request', id: 'e1', method: 'editor', title: 'Edit', prefill: 'line 1\nline 2' });
    expect(questions()).toEqual([
      { id: 'i1', text: 'Name?', field: { kind: 'text', multiline: false, placeholder: 'your name' } },
      { id: 'e1', text: 'Edit', field: { kind: 'text', multiline: true, prefill: 'line 1\nline 2' } }
    ]);
    // a choice index is no answer to a text question
    expect(await connection.answer('i1', 0)).toBe(false);
    expect(await connection.answer('i1', 'Tony')).toBe(true);
    expect(await connection.answer('e1', { dismiss: true })).toBe(true);
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 'i1', value: 'Tony' }, { type: 'extension_ui_response', id: 'e1', cancelled: true }]);
    expect(closed()).toEqual(['i1', 'e1']);
    expect(await connection.answer('e1', 'again')).toBe(false);
  });

  it('answers a select with the option itself and drops a question whose timeout lapsed', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const { connection, pi, questions, closed, responses } = piOverChannel();
    pi({ type: 'extension_ui_request', id: 's1', method: 'select', title: 'Allow?', options: ['Allow', 'Block'], timeout: 10_000 });
    expect(questions()).toEqual([{ id: 's1', text: 'Allow?', field: { kind: 'choice', choices: ['Allow', 'Block'] }, expiresAt: 11_000 }]);
    vi.advanceTimersByTime(10_000);
    expect(closed()).toEqual(['s1']);
    expect(await connection.answer('s1', 0)).toBe(false);

    pi({ type: 'extension_ui_request', id: 's2', method: 'select', title: 'Allow?', options: ['Allow', 'Block'] });
    expect(await connection.answer('s2', 1)).toBe(true);
    expect(responses()).toEqual([{ type: 'extension_ui_response', id: 's2', value: 'Block' }]);
  });

  it('closes the questions still open when the Turn settles', () => {
    const { pi, closed } = piOverChannel();
    pi({ type: 'agent_start' });
    pi({ type: 'extension_ui_request', id: 'q1', method: 'input', title: 'Name?' });
    pi({ type: 'agent_settled', aborted: true });
    expect(closed()).toEqual(['q1']);
  });

  it('offers set_editor_text as a draft and reports the pending steers', () => {
    const { pi, events } = piOverChannel();
    pi({ type: 'extension_ui_request', id: 'd1', method: 'set_editor_text', text: 'prefilled text' });
    pi({ type: 'queue_update', steering: ['Use tabs'], followUp: [] });
    expect(events).toEqual([{ type: 'draft', text: 'prefilled text' }, { type: 'steers', pending: ['Use tabs'] }]);
  });

  it('reads a prompt Pi handled without a Turn, one it refused while working, and one it refused outright', async () => {
    const { connection, sent, pi } = piOverChannel();
    const handled = connection.deliver('/rac-status');
    pi({ type: 'response', id: sent.at(-1)!.id, command: 'prompt', success: true, data: { disposition: 'handled' } });
    expect(await handled).toBe('handled');
    const busy = connection.deliver('Second');
    pi({ type: 'response', id: sent.at(-1)!.id, command: 'prompt', success: false, error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message." });
    expect(await busy).toBe('busy');
    const refused = connection.deliver('Third');
    pi({ type: 'response', id: sent.at(-1)!.id, command: 'prompt', success: false, error: 'No API key found for openai.' });
    expect(await refused).toBe('refused');
  });

  it('cancels by clearing the queue before aborting, and gives back the steers it cleared', async () => {
    const { connection, sent, pi } = piOverChannel();
    const cancelled = connection.cancel();
    expect(sent.at(-1)).toMatchObject({ type: 'clear_queue' });
    pi({ type: 'response', id: sent.at(-1)!.id, command: 'clear_queue', success: true, data: { steering: ['Never mind'], followUp: [] } });
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ type: 'abort' }));
    pi({ type: 'response', id: sent.at(-1)!.id, command: 'abort', success: true });
    expect(await cancelled).toEqual(['Never mind']);
  });

  it('closes a dialog once the tool call it names has ended, as a replayed dialog answered before a restart has', () => {
    const { pi, questions, closed } = piOverChannel();
    pi({ type: 'agent_start' });
    pi({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'ask_user', args: { question: 'Which colour?' } });
    pi({ type: 'extension_ui_request', id: 'q1', method: 'select', title: JSON.stringify({ rac: 'dialog', toolCallId: 'call_1', text: 'Which colour?' }), options: ['red', 'blue'] });
    expect(questions()).toHaveLength(1);
    pi({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'ask_user', result: { content: [{ type: 'text', text: 'blue' }] }, isError: false });
    expect(closed()).toEqual(['q1']);
  });

  it('gives each request an id no other client used, so a response replayed from before a restart answers nothing', async () => {
    const first = piOverChannel();
    const second = piOverChannel();
    void first.connection.models();
    void second.connection.models();
    expect(first.sent[0]!.id).not.toEqual(second.sent[0]!.id);
  });

  it('reattached, reads the Conversation, its history and usage afresh, without waiting for a launch report', () => {
    const { sent, events, pi } = piOverChannel({ dropped: 0 });
    expect(sent.map(record => record.type)).toEqual(expect.arrayContaining(['get_state', 'get_messages', 'get_session_stats']));
    // the replay holds the rest of the Turn in flight, which settles as it would have
    pi({ type: 'agent_start' });
    pi({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' } });
    pi({ type: 'agent_settled', aborted: false });
    expect(events.filter(event => event.type === 'turn')).toEqual([{ type: 'turn', turn: { type: 'started' } }, { type: 'turn', turn: { type: 'settled', message: 'Done' } }]);
    expect(events.some(event => event.type === 'report')).toBe(false);
  });

  it('after an overflowed replay, settles a Turn whose start it missed', async () => {
    const { sent, events, pi } = piOverChannel({ dropped: 40 });
    pi({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }], stopReason: 'stop' } });
    pi({ type: 'agent_settled', aborted: false });
    expect(events.filter(event => event.type === 'turn')).toEqual([{ type: 'turn', turn: { type: 'settled', message: 'Done' } }]);
    // Pi works on: the state it reports decides that the Agent is working, and a dialog it opened in the lines missed is unknown
    pi({ type: 'agent_start' });
    const { id } = sent.find(record => record.type === 'get_state')!;
    pi({ type: 'response', id, command: 'get_state', success: true, data: { sessionId: 's1', isStreaming: true } });
    expect(events.filter(event => event.type === 'turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'started' } });
  });

  it('after an overflowed replay in the middle of a Turn, takes the Agent to be working when Pi says it is', async () => {
    const { sent, events, pi } = piOverChannel({ dropped: 40 });
    const { id } = sent.find(record => record.type === 'get_state')!;
    pi({ type: 'response', id, command: 'get_state', success: true, data: { sessionId: 's1', isStreaming: true } });
    await vi.waitFor(() => expect(events.filter(event => event.type === 'turn')).toEqual([{ type: 'turn', turn: { type: 'started' } }]));
    pi({ type: 'agent_settled', aborted: false });
    expect(events.filter(event => event.type === 'turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'settled', message: '' } });
  });
});
