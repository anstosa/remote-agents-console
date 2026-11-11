import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { askUser } from '../src/adapters/ask-user.js';
import { claudeClient } from '../src/transports/claude.js';
import type { ClientContext, LineChannel, StructuredEvent } from '../src/transports/structured.js';

// The Claude client over an in-memory channel: the test plays Claude Code 2.1.319, feeding it the
// stream-json lines the probes recorded (`fixtures/claude/structured/`, sanitized) and reading what
// it sends back. A fixture's response to one of the client's control requests names that
// request's subtype in place of its id. Claude's config directory is a temporary one, empty
// unless a test writes the Conversation's session JSONL into it.
const session = '5473282c-2da5-4785-8dd4-9a885abe8453';
const fixture = (name: string): Array<Record<string, unknown>> => readFileSync(new URL(`./fixtures/claude/structured/${name}`, import.meta.url), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>);
// a fixture's lines with the ids our prompts were sent under in place of the probe's
const sentAs = (records: Array<Record<string, unknown>>, ids: Record<string, string>) => records.map(record => JSON.parse(Object.entries(ids).reduce((line, [from, to]) => line.replaceAll(from, to), JSON.stringify(record))) as Record<string, unknown>);
const probePrompt = '60975d3b-ccfe-40c9-bc32-f5d59b27ee8f';
const probeSteer = 'a7758563-2799-4d2e-992d-fa59e2d59099';
const lifecycle = (command: string, state: 'queued' | 'started' | 'completed' | 'cancelled') => ({ type: 'command_lifecycle', command_uuid: command, state, uuid: `l-${Math.random()}`, session_id: session });
const result = (fields: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.01, session_id: session, uuid: `r-${Math.random()}`, ...fields });

type Sent = Record<string, any>;
function claudeOverChannel(context: Partial<ClientContext> = {}) {
  const sent: Sent[] = [];
  const events: StructuredEvent[] = [];
  let listener: (line: string) => void = () => {};
  let closed: () => void = () => {};
  const channel: LineChannel = { send: line => sent.push(JSON.parse(line) as Sent), onLine: next => { listener = next; }, onClose: next => { closed = next; }, close: () => {} };
  const connection = claudeClient(channel, event => events.push(event), { cwd: '/work/project', ...context });
  const claude = (record: Record<string, any>) => {
    if (record.type === 'control_response' && !String(record.response.request_id).startsWith('rac-')) {
      const request = [...sent].reverse().find(line => line.type === 'control_request' && line.request.subtype === record.response.request_id);
      record = { ...record, response: { ...record.response, request_id: request?.request_id } };
    }
    listener(JSON.stringify(record));
  };
  const play = (records: Array<Record<string, unknown>>) => { for (const record of records) claude(record); };
  const of = <T extends StructuredEvent['type']>(type: T) => events.filter((event): event is Extract<StructuredEvent, { type: T }> => event.type === type);
  const items = () => of('transcript').map(event => event.item);
  // the transcript as the console keeps it: a later item replaces an earlier one with its id
  const shown = () => [...new Map(items().map(item => [item.id, item])).values()];
  const replies = () => sent.filter(line => line.type === 'control_response').map(line => line.response);
  return { connection, sent, events, claude, play, of, items, shown, replies, close: () => closed() };
}

const dirs: string[] = [];
let config = '';
beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), 'rac-claude-client-'));
  dirs.push(config);
  vi.stubEnv('RAC_CLAUDE_CONFIG_DIR', config);
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
// the Conversation's session JSONL, as the CLI writes it for `/work/project`
async function sessionFrom(name: string): Promise<void> {
  await mkdir(join(config, 'projects', '-work-project'), { recursive: true });
  await writeFile(join(config, 'projects', '-work-project', `${session}.jsonl`), await readFile(new URL(`./fixtures/claude/structured/${name}`, import.meta.url), 'utf8'));
}
// a client that has reported in, its launch's handshake played
const launched = async (context?: Partial<ClientContext>) => {
  const client = claudeOverChannel(context);
  client.play(fixture('launch.jsonl'));
  await vi.waitFor(() => expect(client.of('report')).toHaveLength(1));
  return client;
};

describe('the Claude client', () => {
  it('reads the lines a channel replays as the client attaches', () => {
    // a holder channel hands its early lines to the listener inside `onLine`
    const early = JSON.stringify({ type: 'system', subtype: 'init', session_id: session, model: 'claude-haiku-4-5' });
    const channel: LineChannel = { send: () => {}, onLine: listener => listener(early), onClose: () => {}, close: () => {} };
    expect(() => claudeClient(channel, () => {}, { cwd: '/work/project' })).not.toThrow();
  });

  it('initialises with its SDK MCP server, serves the handshake, and reports in with the hook\'s nonce once it knows the version', async () => {
    await sessionFrom('session-steer-compact.jsonl');
    const { sent, of } = await launched({ model: { model: 'haiku', effort: 'low' } });
    expect(sent[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize', sdkMcpServers: ['rac'] } });
    expect(sent.slice(1).map(line => line.response.response.mcp_response)).toEqual([
      { jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'rac', version: '1' } } },
      { jsonrpc: '2.0', result: {} },
      { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'ask_user', description: askUser.description, inputSchema: askUser.parameters }] } }
    ]);
    // the hook's line came before the initialize response: one report, after it
    expect(of('report')).toEqual([{ type: 'report', report: { loaded: true, sandbox: { engaged: false, reason: expect.stringContaining('does not sandbox Claude') }, version: '2.1.319', nonce: 'nonce-1' } }]);
    // the model the launch named, before any Turn, so the console can hold it to the Allowed models
    expect(of('model')).toEqual([{ type: 'model', current: { model: 'haiku', effort: 'low' } }]);
    // the Conversation the hook named, and its history from the session JSONL
    await vi.waitFor(() => expect(of('history')).toHaveLength(1));
    expect(of('conversation')).toEqual([{ type: 'conversation', id: session, name: 'rac-probe' }]);
  });

  it('reports every nonce a SessionStart hook printed, so another hook\'s cannot hide the launch\'s', async () => {
    const { claude, play, of } = claudeOverChannel();
    const records = fixture('launch.jsonl');
    claude({ ...records[1], stdout: '{"rac":"someone-else"}\n' });
    play(records);
    await vi.waitFor(() => expect(of('report')).toHaveLength(2));
    expect(of('report').map(event => event.report.nonce)).toEqual(['someone-else', 'nonce-1']);
  });

  it('runs a Turn with a tool call, folds a steer in when the CLI starts it, and settles it with its cost and context', async () => {
    const { connection, sent, play, of, items } = await launched();
    expect(await connection.deliver('Use the Bash tool to run exactly `sleep 6; echo done`, then tell me what it printed.')).toBe('started');
    const prompt = sent.at(-1)!;
    expect(prompt).toMatchObject({ type: 'user', message: { role: 'user', content: expect.stringContaining('sleep 6') }, parent_tool_use_id: null, session_id: '' });
    expect(await connection.deliver('Another')).toBe('busy');
    expect(await connection.steer('Also: end your reply with the word PEAR.')).toBe(true);
    const steer = sent.at(-1)!;
    const records = sentAs(fixture('turn-steer-replay.jsonl'), { [probePrompt]: prompt.uuid, [probeSteer]: steer.uuid });
    // up to the tool's result and the steer's echo: queued, not yet read
    play(records.slice(0, 10));
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: ['Also: end your reply with the word PEAR.'] });
    // the echo of a steer arrives as the CLI folds it in, before its lifecycle says so
    play(records.slice(10, 11));
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: [] });
    play(records.slice(11));
    expect(of('turn')).toEqual([{ type: 'turn', turn: { type: 'started' } }, { type: 'turn', turn: { type: 'settled', message: 'The command printed:\n\n```\ndone\n```\n\nPEAR' } }]);
    // the echoes of the prompt and the steer show nothing twice
    expect(items()).toEqual([
      { id: prompt.uuid, kind: 'message', role: 'user', text: prompt.message.content },
      { id: steer.uuid, kind: 'message', role: 'user', text: 'Also: end your reply with the word PEAR.', steer: true },
      { id: 'toolu_01UFKkL413VXQJkniUSWZ4xM', kind: 'tool', name: 'Run', summary: 'sleep 6; echo done', state: 'running' },
      { id: 'toolu_01UFKkL413VXQJkniUSWZ4xM', kind: 'tool', name: 'Run', summary: 'sleep 6; echo done', state: 'done', durationMs: expect.any(Number), output: 'done' },
      { id: '8dc34249-2421-4bea-86a4-32904b4f1f7f:0', kind: 'message', role: 'assistant', text: 'The command printed:\n\n```\ndone\n```\n\nPEAR' },
      // under the id the Conversation's history gives the Turn's end
      { id: `${prompt.uuid}:end`, kind: 'settled', outcome: 'done', cost: expect.any(Number), toolCalls: 1 }
    ]);
    const end = records.find(record => record.type === 'result') as { total_cost_usd: number };
    expect(of('usage').at(-1)).toEqual({ type: 'usage', usage: { cost: end.total_cost_usd, contextTokens: expect.any(Number), contextPercent: expect.any(Number) } });
    expect(await connection.deliver('Next')).toBe('started');
  });

  it('reports the Effort a Turn ran at from the session JSONL, which the stream never names', async () => {
    await sessionFrom('session-interrupt.jsonl');
    const { connection, claude, of } = await launched();
    expect(await connection.deliver('Go')).toBe('started');
    claude({ ...fixture('turn-steer.jsonl')[0]!, model: 'claude-haiku-5-5' });
    expect(of('model').at(-1)).toEqual({ type: 'model', current: { model: 'haiku' } });
    claude(result());
    await vi.waitFor(() => expect(of('model').at(-1)).toEqual({ type: 'model', current: { model: 'haiku', effort: 'medium' } }));
  });

  it('keeps a steer pending until the CLI starts it, and drops one it completed without starting', async () => {
    const { connection, sent, claude, of } = await launched();
    const records = fixture('turn-steer-replay.jsonl');
    await connection.deliver('Go');
    await connection.steer('Early');
    const early = sent.at(-1)!.uuid as string;
    await connection.steer('Late');
    const late = sent.at(-1)!.uuid as string;
    // a tool's result and the model's next answer read no steer the CLI has not started
    claude(records[9]!);
    claude(records[12]!);
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: ['Early', 'Late'] });
    claude(lifecycle(early, 'started'));
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: ['Late'] });
    claude(result());
    claude(lifecycle(late, 'completed'));
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: [] });
    expect(await connection.deliver('Next')).toBe('started');
  });

  // `interrupt.jsonl` predates `--replay-user-messages`, so the steer's lifecycle here is synthetic
  // (`lifecycle`), in the order probe 4 recorded it for a steer folded in mid-Turn
  it('cancels a Turn with a steer sent, which the CLI then runs as a Turn of its own', async () => {
    const { connection, sent, play, claude, of, items } = await launched();
    const records = fixture('interrupt.jsonl');
    await connection.deliver('Use the Bash tool to run exactly `sleep 20; echo late`, then reply OK.');
    play(records.slice(0, 2));
    await connection.steer('Then also say PEAR.');
    const steer = sent.at(-1)!;
    const cancelled = connection.cancel();
    expect(sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    claude(records[2]!);
    // nothing came back: the CLI keeps the steer
    expect(await cancelled).toEqual([]);
    play(records.slice(3, 6));
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'aborted' } });
    expect(items().filter(item => item.kind === 'settled').at(-1)).toMatchObject({ outcome: 'cancelled', cost: 0.00038983, toolCalls: 1 });
    expect(items().find(item => item.id === 'toolu_0177eHTLzGc7JqfeKBvW64ad' && item.kind === 'tool' && item.state !== 'running')).toMatchObject({ state: 'failed' });
    // the steer is the CLI's to run: nothing else goes in first
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: ['Then also say PEAR.'] });
    expect(await connection.deliver('Something else')).toBe('busy');
    expect(await connection.renameConversation('Later')).toBe(false);
    claude(lifecycle(steer.uuid, 'started'));
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'started' } });
    expect(items().at(-1)).toEqual({ id: steer.uuid, kind: 'message', role: 'user', text: 'Then also say PEAR.' });
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: [] });
    play(records.slice(6));
    expect(of('turn').filter(event => event.turn.type === 'started')).toHaveLength(2);
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'settled', message: expect.stringMatching(/^PEAR/u) } });
    expect(items().at(-1)).toMatchObject({ id: `${steer.uuid}:end`, kind: 'settled', outcome: 'done' });
  });

  it('takes a Turn the CLI starts with no lifecycle line before it as the first waiting steer\'s', async () => {
    const { connection, sent, play, claude, of, items } = await launched();
    const records = fixture('interrupt.jsonl');
    await connection.deliver('Go');
    await connection.steer('Then also say PEAR.');
    const steer = sent.at(-1)!;
    play(records.slice(3, 6));
    claude(records[6]!);
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'started' } });
    expect(items().at(-1)).toEqual({ id: steer.uuid, kind: 'message', role: 'user', text: 'Then also say PEAR.' });
  });

  // as probe 5 recorded it: the interrupt names the steer by its uuid, the prompt is cancelled, and
  // the CLI then starts the steer as a Turn of its own
  it('gives back nothing the interrupt says it still had queued, as the CLI runs it after', async () => {
    const { connection, sent, claude, of } = await launched();
    await connection.deliver('Go');
    const prompt = sent.at(-1)!.uuid as string;
    await connection.steer('Then also say PEAR.');
    const steer = sent.at(-1)!.uuid as string;
    const cancelled = connection.cancel();
    claude({ type: 'control_response', response: { subtype: 'success', request_id: sent.at(-1)!.request_id, response: { still_queued: [steer] } } });
    expect(await cancelled).toEqual([]);
    claude(result({ subtype: 'error_during_execution', is_error: true }));
    claude(lifecycle(prompt, 'cancelled'));
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'aborted' } });
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: ['Then also say PEAR.'] });
    claude(lifecycle(steer, 'started'));
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'started' } });
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: [] });
  });

  it('says a steer was not read when the CLI completes it unstarted, or stays quiet and idle with it left over, so none keeps the Agent busy', async () => {
    const { connection, sent, claude, items } = await launched();
    await connection.deliver('Go');
    await connection.steer('Dropped');
    claude(lifecycle(sent.at(-1)!.uuid as string, 'completed'));
    expect(items().at(-1)).toMatchObject({ kind: 'notice', tone: 'warning', text: expect.stringContaining('Dropped') });
    await connection.steer('Cancelled');
    claude(lifecycle(sent.at(-1)!.uuid as string, 'cancelled'));
    expect(items().at(-1)).toMatchObject({ kind: 'notice', tone: 'warning', text: expect.stringContaining('Cancelled') });
    vi.useFakeTimers();
    await connection.steer('Lost');
    claude(result());
    // its start line lost: the CLI says nothing more for a minute
    vi.advanceTimersByTime(59_000);
    expect(await connection.deliver('Too soon')).toBe('busy');
    vi.advanceTimersByTime(2_000);
    expect(items().at(-1)).toMatchObject({ kind: 'notice', text: expect.stringContaining('Lost') });
    expect(await connection.deliver('Next')).toBe('started');
  });

  it('keeps a second leftover steer pending while the CLI runs the first as a Turn of its own', async () => {
    const { connection, sent, claude, of, items } = await launched();
    await connection.deliver('Go');
    await connection.steer('One');
    const one = sent.at(-1)!.uuid as string;
    await connection.steer('Two');
    const two = sent.at(-1)!.uuid as string;
    claude(result());
    claude(lifecycle(one, 'started'));
    claude(result());
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: ['Two'] });
    expect(items().some(item => item.kind === 'notice')).toBe(false);
    claude(lifecycle(two, 'started'));
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'started' } });
    claude(result());
    expect(of('steers').at(-1)).toEqual({ type: 'steers', pending: [] });
    expect(await connection.deliver('Next')).toBe('started');
  });

  it('takes a Turn an earlier console\'s prompt starts under that prompt\'s id, so its end matches its history', async () => {
    const { claude, of, items } = await launched();
    claude(lifecycle('11111111-1111-4111-8111-111111111111', 'started'));
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'started' } });
    claude(result());
    expect(items().at(-1)).toMatchObject({ id: '11111111-1111-4111-8111-111111111111:end', kind: 'settled' });
  });

  it('renames the Conversation with /rename, between Turns and as no Turn', async () => {
    const { connection, sent, play, of, items } = await launched();
    const renamed = connection.renameConversation('rac-probe');
    expect(sent.at(-1)).toMatchObject({ type: 'user', message: { content: '/rename rac-probe' } });
    play(fixture('rename.jsonl'));
    expect(await renamed).toBe(true);
    expect(of('conversation').at(-1)).toEqual({ type: 'conversation', id: session, name: 'rac-probe' });
    expect(items()).toEqual([{ id: '09fbba19-f1d7-4377-84f4-6be3b2d7976b', kind: 'notice', text: 'Session renamed to: rac-probe', tone: 'info' }]);
    expect(of('turn')).toEqual([]);
  });

  it('compacts with /compact, marking the transcript with what it freed and its summary', async () => {
    const { connection, sent, play, of, shown } = await launched();
    const compacted = connection.compact({ instructions: 'Keep the plan' });
    expect(sent.at(-1)).toMatchObject({ type: 'user', message: { content: '/compact Keep the plan' } });
    play(fixture('compact.jsonl'));
    expect(await compacted).toBeUndefined();
    expect(shown()).toEqual([{ id: 'b38738c9-4c3d-4227-8834-aaed5b0c2e64', kind: 'notice', tone: 'info', text: 'Compacted the conversation: 30k → 11k tokens of context', detail: expect.stringMatching(/^This session is being continued/u) }]);
    expect(of('usage').at(-1)).toMatchObject({ usage: { cost: 0.010003635, contextTokens: 10895 } });
    expect(of('turn')).toEqual([]);
    // the hook answering after the result reports the same nonce: nothing new
    expect(of('report')).toHaveLength(1);

    // one that ended without compacting says why
    const refused = connection.compact({});
    expect(sent.at(-1)).toMatchObject({ message: { content: '/compact' } });
    play([result({ result: 'Not enough messages to compact.' })]);
    expect(await refused).toBe('Not enough messages to compact.');
  });

  it('lists the models initialize gave with their Efforts, and switches with set_model, but not the Effort, which stays the launch\'s', async () => {
    const { connection, sent, play, claude, of, items } = await launched({ model: { model: 'haiku', effort: 'low' } });
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect((await connection.models()).map(model => [model.id, model.name, model.provider, model.efforts])).toEqual([
      ['default', 'Default (recommended)', 'anthropic', efforts],
      ['sonnet', 'Sonnet 5.5', 'anthropic', efforts],
      ['haiku', 'Haiku 5.5', 'anthropic', efforts]
    ]);
    // a change of the Effort alone would change nothing
    expect(await connection.setModel({ model: 'haiku', effort: 'high' })).toBe(false);
    const switched = connection.setModel({ model: 'sonnet', effort: 'high' });
    expect(sent.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'set_model', model: 'sonnet' } });
    play(fixture('set-model.jsonl'));
    expect(await switched).toBe(true);
    expect(of('model').at(-1)).toEqual({ type: 'model', current: { model: 'sonnet', effort: 'low' } });
    expect(items()).toEqual([]);
    // a Turn's start names the model by its full id: the same one says nothing, another by its alias
    const init = fixture('turn-steer.jsonl')[0]!;
    const before = of('model').length;
    claude({ ...init, model: 'claude-sonnet-5-5' });
    claude(result());
    claude({ ...init, model: 'claude-haiku-5-5' });
    expect(of('model').slice(before)).toEqual([{ type: 'model', current: { model: 'haiku', effort: 'low' } }]);
  });

  it('waits for the Turn to end before switching a model asked for mid-Turn', async () => {
    const { connection, sent, claude } = await launched();
    await connection.deliver('Go');
    let switched: boolean | undefined;
    void connection.setModel({ model: 'sonnet' }).then(value => { switched = value; });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(sent.some(line => line.request?.subtype === 'set_model')).toBe(false);
    claude(result());
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ request: { subtype: 'set_model', model: 'sonnet' } }));
    claude({ type: 'control_response', response: { subtype: 'success', request_id: 'set_model', response: { model: 'claude-sonnet-5-5' } } });
    await vi.waitFor(() => expect(switched).toBe(true));
  });

  it('serves ask_user end to end: a question the operator answers, which the CLI gets as the tool\'s result', async () => {
    const { connection, play, of, items, replies } = await launched();
    const records = fixture('ask-user.jsonl');
    await connection.deliver('Call the mcp__rac__ask_user tool with question "Red or blue?", then tell me exactly what it returned.');
    play(records.slice(0, 3));
    const request = records[2] as { request_id: string };
    expect(of('question')).toEqual([{ type: 'question', question: { id: request.request_id, text: 'Red or blue?', field: { kind: 'text', multiline: false } } }]);
    expect(items().filter(item => item.kind === 'tool')).toEqual([
      { id: 'toolu_019WwsWzbdgfuZMZB8aJPSFh', kind: 'tool', name: 'Ask', summary: '', state: 'running' },
      { id: 'toolu_019WwsWzbdgfuZMZB8aJPSFh', kind: 'tool', name: 'Ask', summary: 'waiting for your answer below', state: 'running' }
    ]);
    expect(await connection.answer(request.request_id, 'Blue')).toBe(true);
    expect(replies().at(-1)).toEqual({ subtype: 'success', request_id: request.request_id, response: { mcp_response: { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Blue' }] } } } });
    expect(of('question-closed')).toEqual([{ type: 'question-closed', id: request.request_id }]);
    expect(await connection.answer(request.request_id, 'Again')).toBe(false);
    play(records.slice(3));
    expect(items().filter(item => item.kind === 'tool').at(-1)).toMatchObject({ summary: '', state: 'done', result: expect.stringContaining('The operator answered: Blue') });
    expect(of('turn').at(-1)).toMatchObject({ turn: { type: 'settled' } });
  });

  it('takes an ask_user choice, a reply in the operator\'s own words, or a dismissal, and refuses other tools and methods', async () => {
    const { connection, claude, of, replies } = await launched();
    const call = (id: string, rpc: number, params: Record<string, unknown>) => claude({ type: 'control_request', request_id: id, request: { subtype: 'mcp_message', server_name: 'rac', message: { method: 'tools/call', params, jsonrpc: '2.0', id: rpc } } });
    const text = (id: string) => replies().find(reply => reply.request_id === id)?.response.mcp_response;
    call('q1', 3, { name: 'ask_user', arguments: { question: 'Which colour?', choices: ['red', 'blue'] } });
    call('q2', 4, { name: 'ask_user', arguments: { question: 'Which colour?', choices: ['red', 'blue'] } });
    call('q3', 5, { name: 'ask_user', arguments: { question: 'Anything else?' } });
    expect(of('question').map(event => event.question.field)).toEqual([{ kind: 'choice', choices: ['red', 'blue'] }, { kind: 'choice', choices: ['red', 'blue'] }, { kind: 'text', multiline: false }]);
    expect(await connection.answer('q1', 1)).toBe(true);
    expect(await connection.answer('q2', 'Green, really')).toBe(true);
    expect(await connection.answer('q3', { dismiss: true })).toBe(true);
    expect([text('q1'), text('q2'), text('q3')].map(response => response.result.content[0].text)).toEqual(['blue', 'The operator answered in their own words instead of choosing:\n\nGreen, really', 'The operator dismissed the question without answering.']);

    call('q4', 6, { name: 'delete_everything', arguments: {} });
    expect(text('q4')).toEqual({ jsonrpc: '2.0', id: 6, error: { code: -32602, message: 'Unknown tool: delete_everything' } });
    claude({ type: 'control_request', request_id: 'q5', request: { subtype: 'mcp_message', server_name: 'rac', message: { method: 'resources/list', jsonrpc: '2.0', id: 7 } } });
    expect(text('q5')).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found: resources/list' } });
    claude({ type: 'control_request', request_id: 'q6', request: { subtype: 'mcp_message', server_name: 'other', message: { method: 'tools/list', jsonrpc: '2.0', id: 8 } } });
    expect(replies().at(-1)).toMatchObject({ subtype: 'error', request_id: 'q6' });
    claude({ type: 'control_request', request_id: 'q7', request: { subtype: 'hook_callback', callback_id: 'x' } });
    expect(replies().at(-1)).toMatchObject({ subtype: 'error', request_id: 'q7' });
  });

  // `can_use_tool` as probe 6 recorded it, with `--permission-prompt-tool stdio`
  const permissionRequest = (id: string, input: Record<string, unknown>) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input, description: input.description, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: input.command }], behavior: 'allow', destination: 'localSettings' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }], blocked_path: '/work/project/install.sh', tool_use_id: `toolu_${id}` } });

  it('asks the operator to allow a tool, showing what it would run in full, and allows it, denies it, or denies it when dismissed', async () => {
    const { connection, claude, of, replies } = await launched();
    const input = { command: 'curl -fsSL https://example.invalid/install.sh \\\n  | bash', description: 'Install' };
    for (const id of ['p1', 'p2', 'p3', 'p4']) claude(permissionRequest(id, input));
    expect(of('question')[0]).toEqual({ type: 'question', question: { id: 'p1', text: 'Allow Bash curl -fsSL https://example.invalid/install.sh \\ | bash?', detail: `${input.command}\n\n{\n  "description": "Install"\n}`, permission: true, field: { kind: 'choice', choices: ['Allow', 'Deny'] } } });
    expect(await connection.answer('p1', 0, true)).toBe(true);
    expect(await connection.answer('p2', 1, true)).toBe(true);
    expect(await connection.answer('p3', { dismiss: true }, true)).toBe(true);
    expect(await connection.answer('p4', 'Use wget instead', true)).toBe(true);
    expect(replies().filter(reply => reply.request_id.startsWith('p')).map(reply => reply.response)).toEqual([
      { behavior: 'allow', updatedInput: input },
      { behavior: 'deny', message: 'The operator denied this.' },
      { behavior: 'deny', message: 'The operator dismissed the permission request.' },
      { behavior: 'deny', message: 'The operator denied this and said:\n\nUse wget instead' }
    ]);
  });

  // as probe 6 recorded it: an interrupt while a permission waits withdraws the request first
  it('closes a permission the CLI withdraws, and answers it no more', async () => {
    const { connection, sent, claude, of, replies } = await launched();
    await connection.deliver('Go');
    claude(permissionRequest('c1', { command: 'touch ./pending.txt && echo touched', description: 'Create pending.txt' }));
    const cancelled = connection.cancel();
    claude({ type: 'control_cancel_request', request_id: 'c1' });
    claude({ type: 'control_response', response: { subtype: 'success', request_id: sent.at(-1)!.request_id, response: { still_queued: [] } } });
    expect(await cancelled).toEqual([]);
    expect(of('question-closed')).toEqual([{ type: 'question-closed', id: 'c1' }]);
    claude(result({ subtype: 'error_during_execution', is_error: true }));
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'aborted' } });
    expect(await connection.answer('c1', 0, true)).toBe(false);
    expect(replies().some(reply => reply.request_id === 'c1')).toBe(false);
  });

  it('shows every input key Allow grants, says first that a command runs outside the sandbox, and shows hidden code points', async () => {
    const { claude, of } = await launched();
    claude({ type: 'control_request', request_id: 'u1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'make clean‮ #', dangerouslyDisableSandbox: true, timeout: 600000 } } });
    claude({ type: 'control_request', request_id: 'e1', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: '/work/project/a.ts', old_string: 'a', new_string: 'b', replace_all: true } } });
    const [bash, edit] = of('question').map(event => event.question);
    expect(bash!.text).toBe('Runs OUTSIDE Claude\'s sandbox. Allow Bash make clean<U+202E> #?');
    expect(bash!.detail).toBe('make clean<U+202E> #\n\n{\n  "dangerouslyDisableSandbox": true,\n  "timeout": 600000\n}');
    expect(edit!.detail).toBe('/work/project/a.ts\n\n-a\n+b\n\n{\n  "replace_all": true\n}');
  });

  it('words a refusal that is not the operator\'s own as nobody\'s', async () => {
    const { connection, claude, replies } = await launched();
    for (const id of ['n1', 'n2', 'n3']) claude({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'make deploy' } } });
    expect(await connection.answer('n1', 1)).toBe(true);
    expect(await connection.answer('n2', 'Not now')).toBe(true);
    expect(await connection.answer('n3', { dismiss: true })).toBe(true);
    expect(replies().filter(reply => reply.request_id.startsWith('n')).map(reply => reply.response)).toEqual([
      { behavior: 'deny', message: 'This was denied.' },
      { behavior: 'deny', message: 'This was denied, with the reply:\n\nNot now' },
      { behavior: 'deny', message: 'The permission request was dismissed.' }
    ]);
  });

  it('offers only Deny for a permission too long to show in full, since what is granted must be what is shown', async () => {
    const { connection, claude, of, replies } = await launched();
    const input = { command: `echo ${'x'.repeat(20_000)}` };
    claude({ type: 'control_request', request_id: 'big', request: { subtype: 'can_use_tool', tool_name: 'Bash', input } });
    const { question } = of('question')[0]!;
    expect(question).toMatchObject({ field: { kind: 'choice', choices: ['Deny'] }, detail: expect.stringMatching(/more characters not shown$/u) });
    expect(question.permission).toBeUndefined();
    expect(question.text).toContain('can only be denied');
    expect(await connection.answer('big', 0, true)).toBe(true);
    expect(replies().find(reply => reply.request_id === 'big')!.response).toEqual({ behavior: 'deny', message: 'The operator denied this.' });
  });

  it('shows a Write\'s content in full, marking where a long one is cut', async () => {
    const { claude, of } = await launched();
    claude({ type: 'control_request', request_id: 'w1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/work/project/big.txt', content: 'x'.repeat(20_000) } } });
    const { detail } = of('question')[0]!.question;
    expect(detail).toMatch(/^\/work\/project\/big\.txt\n\nx+\n… \d+ more characters not shown$/u);
  });

  it('refuses the questions a Turn left unanswered, and closes one whose call ended', async () => {
    const { connection, claude, of, replies } = await launched();
    await connection.deliver('Go');
    claude({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } });
    claude({ type: 'control_request', request_id: 'p2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } });
    claude({ type: 'control_request', request_id: 'q1', request: { subtype: 'mcp_message', server_name: 'rac', message: { method: 'tools/call', params: { name: 'ask_user', arguments: { question: 'Sure?' } }, jsonrpc: '2.0', id: 9 } } });
    // a call that ended was answered elsewhere (a replay after a reattach, say): nothing is sent
    claude({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, parent_tool_use_id: null, session_id: session, uuid: 'u1' });
    expect(of('question-closed')).toEqual([{ type: 'question-closed', id: 'p1' }]);
    claude(result({ subtype: 'error_during_execution', is_error: true }));
    expect(of('question-closed').map(event => event.id)).toEqual(['p1', 'p2', 'q1']);
    expect(replies().filter(reply => reply.request_id === 'p2' || reply.request_id === 'q1').map(reply => reply.response)).toEqual([
      { behavior: 'deny', message: 'The Turn ended before the operator answered.' },
      { mcp_response: { jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: 'The operator dismissed the question without answering.' }] } } }
    ]);
    expect(replies().some(reply => reply.request_id === 'p1')).toBe(false);
    expect(of('turn').at(-1)).toEqual({ type: 'turn', turn: { type: 'failed' } });
  });

  it('settles every request still waiting when the channel closes, and times out one never answered', async () => {
    vi.useFakeTimers();
    const first = await launched();
    const switching = first.connection.setModel({ model: 'haiku' });
    vi.advanceTimersByTime(30_000);
    expect(await switching).toBe(false);

    const second = await launched();
    await second.connection.deliver('Go');
    const cancelled = second.connection.cancel();
    const waiting = second.connection.setModel({ model: 'sonnet' });
    const third = await launched();
    const renamed = third.connection.renameConversation('Later');
    second.close();
    third.close();
    expect(await cancelled).toBeUndefined();
    expect(await waiting).toBe(false);
    expect(await renamed).toBe(false);
    expect(second.of('exited')).toHaveLength(1);
  });

  it('reattached, initialises again, and reads its Conversation and history once the replay is in', async () => {
    await sessionFrom('session-interrupt.jsonl');
    const { sent, claude, play, of, connection } = claudeOverChannel({ attached: { dropped: 0, conversation: session } });
    expect(sent[0]).toMatchObject({ request: { subtype: 'initialize' } });
    // the replay comes before the answer to the client's first request
    claude({ ...fixture('turn-steer.jsonl')[0]!, model: 'claude-haiku-5-5' });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(of('conversation')).toEqual([]);
    play(fixture('initialize-again.jsonl'));
    await vi.waitFor(() => expect(of('history')).toHaveLength(1));
    // with no title, the Conversation is named by the first prompt it was sent
    expect(of('conversation')).toEqual([{ type: 'conversation', id: session, name: expect.stringMatching(/^Use the Bash tool to run exactly: touch /u) }]);
    // the Turn in flight stays open in the history
    expect(of('history')[0]!.items.at(-1)).toMatchObject({ kind: 'message', role: 'assistant' });
    expect(of('report')).toEqual([]);
    expect(of('turn')).toEqual([{ type: 'turn', turn: { type: 'started' } }]);
    expect((await connection.models()).map(model => model.id)).toEqual(['default', 'sonnet', 'haiku']);
  });

  it('reattached after lines were lost, takes its state from initialize, and settles a Turn whose start it missed', async () => {
    const idle = claudeOverChannel({ attached: { dropped: 40, conversation: session } });
    expect(await idle.connection.deliver('Go')).toBe('busy');
    idle.play(fixture('initialize-again.jsonl'));
    await vi.waitFor(async () => expect(await idle.connection.deliver('Go')).toBe('started'));

    const working = claudeOverChannel({ attached: { dropped: 40, conversation: session } });
    working.claude(result({ result: 'Done' }));
    expect(working.of('turn')).toEqual([{ type: 'turn', turn: { type: 'settled', message: 'Done' } }]);
    expect(await working.connection.deliver('Go')).toBe('started');
  });

  it('reattached after lines were lost, takes a CLI that does not answer initialize as idle', async () => {
    vi.useFakeTimers();
    const silent = claudeOverChannel({ attached: { dropped: 40, conversation: session } });
    expect(await silent.connection.deliver('Go')).toBe('busy');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await silent.connection.deliver('Go')).toBe('started');
  });

  it('starts a new Conversation with /clear, on the session that follows its reset', async () => {
    await sessionFrom('session-steer-compact.jsonl');
    const { connection, sent, play, of } = await launched();
    await vi.waitFor(() => expect(of('history')).toHaveLength(1));
    const cleared = connection.newConversation();
    expect(sent.at(-1)).toMatchObject({ type: 'user', message: { content: '/clear' } });
    play(sentAs(fixture('clear.jsonl'), { '512b0e65-6c8c-4de8-a29a-8bd2670a9c74': sent.at(-1)!.uuid }));
    expect(await cleared).toBe(true);
    await vi.waitFor(() => expect(of('history')).toHaveLength(2));
    // the session the SessionStart hook and `init` name, not the reset's own id
    expect(of('conversation').at(-1)).toEqual({ type: 'conversation', id: 'e2614e20-a1a6-409c-b55a-f6e8e6d806ff' });
    expect(of('history').at(-1)).toEqual({ type: 'history', items: [] });
    expect(of('turn')).toEqual([]);
  });

  it('does not take a reset another prompt caused as its /clear', async () => {
    const { connection, sent, play } = await launched();
    const cleared = connection.newConversation();
    const records = sentAs(fixture('clear.jsonl'), { '512b0e65-6c8c-4de8-a29a-8bd2670a9c74': 'someone-else' });
    play(records.map(record => record.type === 'result' ? { ...record, uuid: sent.at(-1)!.uuid } : record));
    expect(await cleared).toBe(false);
  });
});
