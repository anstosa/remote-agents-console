import type { LaunchReport, ProtocolClient, TranscriptItem, TranscriptTool } from './structured.js';

/**
 * The Pi protocol client (ADR 0017): a thin client over `pi --mode rpc` JSON lines. It speaks
 * only the pinned version and ignores records and fields it does not know.
 */

/** The status key the RAC Pi extension sends its launch report under. */
export const piReportStatusKey = 'rac-launch';

type Json = { [key: string]: unknown };
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.flatMap(block => isObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('') : '';
const oneLine = (line: string): string => {
  const flat = line.replace(/\s+/gu, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
};
// a tool call's one-line target: its first string argument
const summary = (args: unknown): string => oneLine((isObject(args) ? Object.values(args).find((value): value is string => typeof value === 'string') : undefined) ?? '');
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const scriptSummary = (calls: number): string => count(calls, 'tool call', 'tool calls');
const parseReport = (statusText: unknown): LaunchReport | undefined => {
  if (typeof statusText !== 'string') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(statusText); } catch { return undefined; }
  if (!isObject(parsed) || parsed.loaded !== true || typeof parsed.version !== 'string' || !isObject(parsed.sandbox) || typeof parsed.sandbox.engaged !== 'boolean') return undefined;
  const reason = typeof parsed.sandbox.reason === 'string' ? parsed.sandbox.reason : undefined;
  return { loaded: true, sandbox: { engaged: parsed.sandbox.engaged, ...(reason === undefined ? {} : { reason }) }, version: parsed.version };
};
const messageCost = (message: Json): number => isObject(message.usage) && isObject(message.usage.cost) && typeof message.usage.cost.total === 'number' ? message.usage.cost.total : 0;

// Pi's tool names as the transcript's verbs; any other tool keeps its own name
const verbs: Record<string, string> = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Run', grep: 'Search', find: 'Find', ls: 'List', codemode: 'Script', ask_user: 'Ask' };
// Pi bounds a tool's output (about 50 KiB); this only guards against a tool that does not
const maxOutput = 64 * 1024;

// a tool call as it starts: its verb and target, and a script's source
function toolCall(id: string, toolName: string, args: unknown, parentId?: string): TranscriptTool {
  const script = toolName === 'codemode';
  return { id, kind: 'tool', name: verbs[toolName] ?? toolName, summary: script ? scriptSummary(0) : summary(args), state: 'running', ...(parentId === undefined ? {} : { parentId }), ...(script && isObject(args) && typeof args.code === 'string' ? { source: args.code } : {}) };
}

// What a finished call gave back: its output (a command's last lines are its result line), plus an
// edit's diff, a read's line count, a search's match count, or any other call's first line.
function toolResult(toolName: string, result: unknown, failed: boolean): Pick<TranscriptTool, 'output' | 'result' | 'diff'> {
  const output = isObject(result) ? text(result.content) : '';
  const details = isObject(result) && isObject(result.details) ? result.details : undefined;
  const shown = output === '' ? {} : { output: output.length > maxOutput ? output.slice(-maxOutput) : output };
  if (toolName === 'bash') return shown;
  if (!failed && toolName === 'edit' && typeof details?.patch === 'string') return { ...shown, diff: details.patch };
  if (!failed && toolName === 'read') {
    const truncation = isObject(details?.truncation) ? details.truncation : undefined;
    const lines = typeof truncation?.outputLines === 'number' ? truncation.outputLines : output.replace(/\n$/u, '').split('\n').length;
    return { ...shown, result: `${count(lines, 'line', 'lines')}${truncation?.truncated === true ? ' (truncated)' : ''}` };
  }
  if (!failed && toolName === 'grep') return { ...shown, result: count(output.startsWith('No matches found') ? 0 : output.split('\n').filter(line => line !== '').length, 'match', 'matches') };
  return output.trim() === '' ? shown : { ...shown, result: oneLine(output.trim().split('\n')[0]!) };
}

/**
 * A Conversation's transcript from its messages (`get_messages`): prompts (a prompt that follows
 * a tool's result was a steer), answers, thinking, tool calls with their results, and the end of
 * each prompt's Turn with its cost. A script's calls keep only their arguments and status, so
 * each shows that its result was not kept.
 */
export function piHistory(messages: readonly unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const calls = new Map<string, { toolName: string; index: number }>();
  let open = false;
  let cost = 0;
  let stop: unknown;
  let previous: unknown;
  const id = () => `h${items.length}`;
  const settle = () => {
    if (open) items.push({ id: id(), kind: 'settled', outcome: stop === 'aborted' ? 'cancelled' : stop === 'error' ? 'failed' : 'done', cost });
    open = false;
    cost = 0;
  };
  for (const message of messages) {
    if (!isObject(message)) continue;
    if (message.role === 'user') {
      const steer = previous === 'toolResult';
      if (!steer) settle();
      open = true;
      items.push({ id: id(), kind: 'message', role: 'user', text: text(message.content), ...(steer ? { steer: true as const } : {}) });
    } else if (message.role === 'assistant') {
      cost += messageCost(message);
      stop = message.stopReason;
      const blocks = Array.isArray(message.content) ? message.content.filter(isObject) : [];
      for (const block of blocks) if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') items.push({ id: id(), kind: 'thinking', text: block.thinking });
      const said = text(blocks);
      const shown = said !== '' ? said : stop === 'error' && typeof message.errorMessage === 'string' ? `Error: ${message.errorMessage}` : '';
      if (shown !== '') items.push({ id: id(), kind: 'message', role: 'assistant', text: shown });
      for (const block of blocks) {
        if (block.type !== 'toolCall' || typeof block.id !== 'string' || typeof block.name !== 'string') continue;
        calls.set(block.id, { toolName: block.name, index: items.length });
        items.push({ ...toolCall(block.id, block.name, block.arguments), state: 'done' });
      }
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const call = calls.get(message.toolCallId);
      const item = call === undefined ? undefined : items[call.index];
      if (call === undefined || item?.kind !== 'tool') continue;
      const failed = message.isError === true;
      const nested = isObject(message.nestedCalls) && Array.isArray(message.nestedCalls.calls) ? message.nestedCalls.calls.filter(isObject) : [];
      items[call.index] = { ...item, state: failed ? 'failed' : 'done', ...toolResult(call.toolName, message, failed), ...(typeof message.durationMs === 'number' ? { durationMs: message.durationMs } : {}), ...(call.toolName === 'codemode' ? { summary: scriptSummary(nested.length) } : {}) };
      for (const child of nested) {
        if (typeof child.id !== 'string' || typeof child.name !== 'string') continue;
        items.push({ ...toolCall(child.id, child.name, child.arguments, message.toolCallId), state: child.status === 'ok' ? 'done' : 'failed', ...(typeof child.durationMs === 'number' ? { durationMs: Math.round(child.durationMs) } : {}), kept: false });
      }
    }
    previous = message.role;
  }
  settle();
  return items;
}

export const piClient: ProtocolClient = (channel, emit) => {
  const pending = new Map<string, (response: Json) => void>();
  let requests = 0;
  let sequence = 0;
  let reported = false;
  // a Turn runs from the first `agent_start` to `agent_settled`: retries and compaction count as working
  let working = false;
  let prompted = false;
  let answer = '';
  let errored = false;
  let cost = 0;
  let assistantMessages = 0;
  // the calls in flight, as last shown; a script's count of the calls it made
  const tools = new Map<string, { toolName: string; item: TranscriptTool; calls: number }>();
  const request = (command: Json): Promise<Json> => new Promise(resolve => {
    const id = `rac-${requests += 1}`;
    pending.set(id, resolve);
    channel.send(JSON.stringify({ ...command, id }));
  });
  const transcript = (item: TranscriptItem) => emit({ type: 'transcript', item });
  const next = (prefix: string) => `${prefix}${sequence += 1}`;
  const showTool = (id: string, item: TranscriptTool) => {
    const tool = tools.get(id);
    if (tool !== undefined) tool.item = item;
    transcript(item);
  };
  const usage = () => void request({ type: 'get_session_stats' }).then(response => {
    const data = isObject(response.data) ? response.data : undefined;
    if (typeof data?.cost !== 'number') return;
    const percent = isObject(data.contextUsage) && typeof data.contextUsage.percent === 'number' ? data.contextUsage.percent : undefined;
    emit({ type: 'usage', usage: { cost: data.cost, ...(percent === undefined ? {} : { contextPercent: percent }) } });
  });

  channel.onLine(line => {
    let record: unknown;
    try { record = JSON.parse(line); } catch { return; }
    if (!isObject(record)) return;
    switch (record.type) {
      case 'response': {
        const id = typeof record.id === 'string' ? record.id : undefined;
        const resolve = id === undefined ? undefined : pending.get(id);
        if (resolve !== undefined) { pending.delete(id!); resolve(record); }
        return;
      }
      case 'extension_ui_request':
        if (record.method === 'notify' && typeof record.message === 'string') {
          transcript({ id: next('n'), kind: 'notice', text: record.message, tone: record.notifyType === 'warning' || record.notifyType === 'error' ? record.notifyType : 'info' });
          return;
        }
        if (record.method !== 'setStatus' || typeof record.statusKey !== 'string') return;
        if (record.statusKey !== piReportStatusKey) {
          emit({ type: 'status', key: record.statusKey, ...(typeof record.statusText === 'string' && record.statusText !== '' ? { text: record.statusText } : {}) });
          return;
        }
        if (reported) return;
        {
          const report = parseReport(record.statusText);
          if (report === undefined) return;
          reported = true;
          emit({ type: 'report', report });
        }
        void request({ type: 'get_state' }).then(response => {
          const id = isObject(response.data) ? response.data.sessionId : undefined;
          if (typeof id === 'string' && id !== '') emit({ type: 'conversation', id });
        });
        void request({ type: 'get_messages' }).then(response => {
          const messages = isObject(response.data) && Array.isArray(response.data.messages) ? response.data.messages : undefined;
          if (messages !== undefined && messages.length > 0) emit({ type: 'history', items: piHistory(messages) });
        });
        usage();
        return;
      case 'agent_start':
        if (working) return;
        working = true; prompted = false; answer = ''; errored = false; cost = 0;
        emit({ type: 'turn', turn: { type: 'started' } });
        return;
      case 'message_start':
        if (isObject(record.message) && record.message.role === 'assistant') assistantMessages += 1;
        return;
      case 'message_update': {
        // only that thinking is under way: its text arrives whole with the message
        const update = isObject(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
        if (update?.type === 'thinking_start' && typeof update.contentIndex === 'number') transcript({ id: `t${assistantMessages}.${update.contentIndex}`, kind: 'thinking', text: '', live: true });
        return;
      }
      case 'message_end': {
        const message = isObject(record.message) ? record.message : undefined;
        if (message?.role === 'user') {
          // a prompt after the Turn's first arrived as a steer
          transcript({ id: next('m'), kind: 'message', role: 'user', text: text(message.content), ...(working && prompted ? { steer: true as const } : {}) });
          prompted = true;
        }
        if (message?.role !== 'assistant') return;
        cost += messageCost(message);
        const blocks = Array.isArray(message.content) ? message.content : [];
        blocks.forEach((block, index) => {
          if (isObject(block) && block.type === 'thinking') transcript({ id: `t${assistantMessages}.${index}`, kind: 'thinking', text: typeof block.thinking === 'string' ? block.thinking : '' });
        });
        errored = message.stopReason === 'error';
        const said = text(message.content);
        const shown = said !== '' ? said : errored && typeof message.errorMessage === 'string' ? `Error: ${message.errorMessage}` : '';
        if (said !== '') answer = said;
        if (shown !== '') transcript({ id: next('m'), kind: 'message', role: 'assistant', text: shown });
        usage();
        return;
      }
      case 'tool_execution_start': {
        if (typeof record.toolCallId !== 'string' || typeof record.toolName !== 'string') return;
        const parentId = typeof record.parentToolCallId === 'string' ? record.parentToolCallId : undefined;
        const item = toolCall(record.toolCallId, record.toolName, record.args, parentId);
        tools.set(record.toolCallId, { toolName: record.toolName, item, calls: 0 });
        transcript(item);
        const parent = parentId === undefined ? undefined : tools.get(parentId);
        if (parent?.toolName === 'codemode') showTool(parentId!, { ...parent.item, summary: scriptSummary(parent.calls += 1) });
        return;
      }
      case 'tool_execution_update': {
        const tool = typeof record.toolCallId === 'string' ? tools.get(record.toolCallId) : undefined;
        const output = isObject(record.partialResult) ? text(record.partialResult.content) : '';
        if (tool !== undefined && output !== '' && output !== tool.item.output) showTool(record.toolCallId as string, { ...tool.item, output: output.length > maxOutput ? output.slice(-maxOutput) : output });
        return;
      }
      case 'tool_execution_end': {
        const tool = typeof record.toolCallId === 'string' ? tools.get(record.toolCallId) : undefined;
        if (tool === undefined) return;
        tools.delete(record.toolCallId as string);
        const failed = record.isError === true;
        const calls = isObject(record.result) && isObject(record.result.details) && Array.isArray(record.result.details.calls) ? record.result.details.calls.length : undefined;
        const { output: _streamed, ...started } = tool.item;
        transcript({ ...started, state: failed ? 'failed' : 'done', ...toolResult(tool.toolName, record.result, failed), ...(typeof record.durationMs === 'number' ? { durationMs: Math.round(record.durationMs) } : {}), ...(calls === undefined ? {} : { summary: scriptSummary(calls) }) });
        return;
      }
      case 'agent_settled':
        if (!working) return;
        working = false;
        transcript({ id: next('e'), kind: 'settled', outcome: record.aborted === true ? 'cancelled' : errored ? 'failed' : 'done', cost });
        emit({ type: 'turn', turn: record.aborted === true ? { type: 'aborted' } : errored ? { type: 'failed' } : { type: 'settled', message: answer } });
        return;
    }
  });
  channel.onClose(() => {
    for (const resolve of pending.values()) resolve({ success: false });
    pending.clear();
    emit({ type: 'exited' });
  });

  return {
    async deliver(prompt) {
      const response = await request({ type: 'prompt', message: prompt });
      if (response.success !== true) return 'refused';
      // a prompt sent without `streamingBehavior` is refused while Pi works, never `queued`
      return isObject(response.data) && response.data.disposition === 'handled' ? 'handled' : 'started';
    },
    close: () => channel.close()
  };
};
