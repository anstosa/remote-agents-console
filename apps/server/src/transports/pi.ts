import { randomUUID } from 'node:crypto';
import type { QuestionField } from '../adapters/types.js';
import type { LaunchReport, ModelInfo, ModelSetting, ProtocolClient, TranscriptItem, TranscriptTool } from './structured.js';

/**
 * The Pi protocol client (ADR 0017): a thin client over `pi --mode rpc` JSON lines. It speaks
 * only the pinned version and ignores records and fields it does not know.
 */

/** The status key the RAC Pi extension sends its launch report under. */
export const piReportStatusKey = 'rac-launch';
// what a tool call's line reads while its question waits in the Inline-question box
const waitingForAnswer = 'waiting for your answer below';

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
  if (!isObject(parsed) || parsed.loaded !== true || typeof parsed.version !== 'string' || typeof parsed.nonce !== 'string' || !isObject(parsed.sandbox) || typeof parsed.sandbox.engaged !== 'boolean') return undefined;
  const reason = typeof parsed.sandbox.reason === 'string' ? parsed.sandbox.reason : undefined;
  return { loaded: true, sandbox: { engaged: parsed.sandbox.engaged, ...(reason === undefined ? {} : { reason }) }, version: parsed.version, nonce: parsed.nonce };
};
// A dialog's question and the tool call it names. The RAC Pi extension titles its dialogs with
// JSON `{ rac: 'dialog', toolCallId, text }`, since Pi's dialog requests carry no tool call of their
// own; another extension's title is the question itself.
const dialogTitle = (title: unknown): { text: string; toolCallId?: string } => {
  if (typeof title !== 'string') return { text: '' };
  try {
    const parsed: unknown = JSON.parse(title);
    if (isObject(parsed) && parsed.rac === 'dialog' && typeof parsed.text === 'string') return { text: parsed.text, ...(typeof parsed.toolCallId === 'string' ? { toolCallId: parsed.toolCallId } : {}) };
  } catch { /* a plain title */ }
  return { text: title };
};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
// at most this many dialogs stay open (more are dismissed at once) and this many choices show
const maxDialogs = 20;
const maxChoices = 50;
// Pi's dialogs as Inline-question fields: `select` a choice, `confirm` a Yes/No choice, `input` one
// line of text, `editor` several lines with a prefill. A choice shows bounded; its answer is the
// option itself.
const dialogField = (record: Json): QuestionField | undefined => {
  switch (record.method) {
    case 'select': return { kind: 'choice', choices: strings(record.options).slice(0, maxChoices).map(oneLine) };
    case 'confirm': return { kind: 'choice', choices: ['Yes', 'No'] };
    case 'input': return { kind: 'text', multiline: false, ...(typeof record.placeholder === 'string' ? { placeholder: oneLine(record.placeholder) } : {}) };
    case 'editor': return { kind: 'text', multiline: true, ...(typeof record.prefill === 'string' ? { prefill: bounded(record.prefill) } : {}) };
    default: return undefined;
  }
};
type Dialog = { method: 'select' | 'confirm' | 'input' | 'editor'; options: string[]; toolCallId?: string; timer?: NodeJS.Timeout };
const messageCost = (message: Json): number => isObject(message.usage) && isObject(message.usage.cost) && typeof message.usage.cost.total === 'number' ? message.usage.cost.total : 0;

// an assistant message's text, or its error when it failed having said nothing
const answerText = (message: Json): string => {
  const said = text(message.content);
  return said !== '' ? said : message.stopReason === 'error' && typeof message.errorMessage === 'string' ? `Error: ${message.errorMessage}` : '';
};
const outcome = (aborted: boolean, failed: boolean): 'done' | 'cancelled' | 'failed' => aborted ? 'cancelled' : failed ? 'failed' : 'done';
// Pi bounds a tool's output (about 50 KiB); this guards every kept text against a tool or model that does not
const maxText = 64 * 1024;
const bounded = (value: string): string => value.length > maxText ? value.slice(-maxText) : value;

// Pi's tool names as the transcript's verbs; any other tool keeps its own name
const verbs: Record<string, string> = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Run', grep: 'Search', find: 'Find', ls: 'List', codemode: 'Script', ask_user: 'Ask' };

// a tool call as it starts: its verb and target, and a script's source
function toolCall(id: string, toolName: string, args: unknown, parentId?: string): TranscriptTool {
  const script = toolName === 'codemode';
  // an `ask_user` question shows once, in the Inline-question box, never as the call's target
  return { id, kind: 'tool', name: verbs[toolName] ?? toolName, summary: script ? scriptSummary(0) : toolName === 'ask_user' ? '' : summary(args), state: 'running', ...(parentId === undefined ? {} : { parentId }), ...(script && isObject(args) && typeof args.code === 'string' ? { source: bounded(args.code) } : {}) };
}

// What a finished call gave back: its output (a command's last lines are its result line), plus an
// edit's diff, a read's line count, a search's match count (`path:line:` lines; context lines and
// notices are not matches), or any other call's first line.
function toolResult(toolName: string, args: unknown, result: unknown, failed: boolean): Pick<TranscriptTool, 'output' | 'result' | 'diff'> {
  const output = isObject(result) ? text(result.content) : '';
  const details = isObject(result) && isObject(result.details) ? result.details : undefined;
  const shown = output === '' ? {} : { output: bounded(output) };
  if (toolName === 'bash') return shown;
  if (!failed && toolName === 'edit' && typeof details?.patch === 'string') return { ...shown, diff: { path: isObject(args) && typeof args.path === 'string' ? args.path : '', patch: bounded(details.patch) } };
  if (!failed && toolName === 'read') {
    const truncation = isObject(details?.truncation) ? details.truncation : undefined;
    const lines = typeof truncation?.outputLines === 'number' ? truncation.outputLines : output === '' ? 0 : output.replace(/\n$/u, '').split('\n').length;
    return { ...shown, result: `${count(lines, 'line', 'lines')}${truncation?.truncated === true ? ' (truncated)' : ''}` };
  }
  if (!failed && toolName === 'grep') return { ...shown, result: count(output.split('\n').filter(line => /:\d+: /u.test(line)).length, 'match', 'matches') };
  return output.trim() === '' ? shown : { ...shown, result: oneLine(output.trim().split('\n')[0]!) };
}

// a finished call's state, duration and result
const finished = (toolName: string, args: unknown, result: unknown, failed: boolean, durationMs: unknown): Pick<TranscriptTool, 'state' | 'durationMs' | 'output' | 'result' | 'diff'> =>
  ({ state: failed ? 'failed' : 'done', ...toolResult(toolName, args, result, failed), ...(typeof durationMs === 'number' ? { durationMs: Math.round(durationMs) } : {}) });

/**
 * A Conversation's transcript from its messages (`get_messages`): prompts (a prompt that follows
 * a tool's result was a steer), answers, thinking, tool calls with their results, and the end of
 * each prompt's Turn with its cost. A script's calls keep only their arguments and status, so
 * each shows that its result was not kept. While a Turn is `running`, the last prompt's has no end yet.
 */
export function piHistory(messages: readonly unknown[], { running = false } = {}): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const calls = new Map<string, { toolName: string; args: unknown; index: number }>();
  let open = false;
  let cost = 0;
  let toolCalls = 0;
  let stop: unknown;
  let previous: unknown;
  const id = () => `h${items.length}`;
  const settle = () => {
    if (open) items.push({ id: id(), kind: 'settled', outcome: outcome(stop === 'aborted', stop === 'error'), cost, toolCalls });
    open = false;
    cost = 0;
    toolCalls = 0;
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
      for (const block of blocks) if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') items.push({ id: id(), kind: 'thinking', text: bounded(block.thinking) });
      const shown = answerText(message);
      if (shown !== '') items.push({ id: id(), kind: 'message', role: 'assistant', text: shown });
      for (const block of blocks) {
        if (block.type !== 'toolCall' || typeof block.id !== 'string' || typeof block.name !== 'string') continue;
        calls.set(block.id, { toolName: block.name, args: block.arguments, index: items.length });
        items.push({ ...toolCall(block.id, block.name, block.arguments), state: 'done' });
        toolCalls += 1;
      }
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const call = calls.get(message.toolCallId);
      const item = call === undefined ? undefined : items[call.index];
      if (call === undefined || item?.kind !== 'tool') continue;
      const failed = message.isError === true;
      const nested = isObject(message.nestedCalls) && Array.isArray(message.nestedCalls.calls) ? message.nestedCalls.calls.filter(isObject) : [];
      items[call.index] = { ...item, ...finished(call.toolName, call.args, message, failed, message.durationMs), ...(call.toolName === 'codemode' ? { summary: scriptSummary(nested.length) } : {}) };
      for (const child of nested) {
        if (typeof child.id !== 'string' || typeof child.name !== 'string') continue;
        items.push({ ...toolCall(child.id, child.name, child.arguments, message.toolCallId), state: child.status === 'ok' ? 'done' : 'failed', ...(typeof child.durationMs === 'number' ? { durationMs: Math.round(child.durationMs) } : {}), kept: false });
        toolCalls += 1;
      }
    }
    previous = message.role;
  }
  if (!running) settle();
  return items;
}

/** Pi's thinking levels, which RAC calls Efforts. */
export const piEfforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
// the levels a model supports, decided as Pi's own `getSupportedThinkingLevels` does
const modelEfforts = (model: Json): string[] => {
  if (model.reasoning !== true) return ['off'];
  const map = isObject(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
  return piEfforts.filter(level => map[level] !== null && (level !== 'xhigh' && level !== 'max' || map[level] !== undefined));
};
const modelInfo = (model: unknown): ModelInfo | undefined => {
  if (!isObject(model) || typeof model.provider !== 'string' || typeof model.id !== 'string') return undefined;
  const cost = isObject(model.cost) ? model.cost : {};
  return {
    id: `${model.provider}/${model.id}`, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id, provider: model.provider,
    ...(typeof cost.input === 'number' ? { inputPrice: cost.input } : {}), ...(typeof cost.output === 'number' ? { outputPrice: cost.output } : {}),
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}), efforts: modelEfforts(model)
  };
};
// the model and thinking level a session last changed to, from its entries
const sessionModel = (entries: unknown): ModelSetting | undefined => {
  if (!Array.isArray(entries)) return undefined;
  let setting: ModelSetting | undefined;
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    if (entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') setting = { model: `${entry.provider}/${entry.modelId}`, ...(setting?.effort === undefined ? {} : { effort: setting.effort }) };
    if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string' && setting !== undefined) setting = { ...setting, effort: entry.thinkingLevel };
  }
  return setting;
};
// a session command Pi accepted and no extension cancelled
const accepted = (response: Json): boolean => response.success === true && !(isObject(response.data) && response.data.cancelled === true);

export const piClient: ProtocolClient = (channel, emit, attached) => {
  const pending = new Map<string, (response: Json) => void>();
  // request ids no earlier client used, so a response replayed from before a reattach answers nothing
  const prefix = `rac-${randomUUID().slice(0, 8)}`;
  let requests = 0;
  let sequence = 0;
  let reported = attached !== undefined;
  // a Turn runs from the first `agent_start` to `agent_settled`: retries and compaction count as
  // working. Unknown after a replay that lost lines, until Pi's state or the Turn's end says.
  let working: boolean | undefined = attached !== undefined && attached.dropped > 0 ? undefined : false;
  let prompted = false;
  let answer = '';
  let errored = false;
  let cost = 0;
  let toolCalls = 0;
  let assistantMessages = 0;
  // the calls in flight, as last shown; a script's count of the calls it made
  const tools = new Map<string, { toolName: string; args: unknown; item: TranscriptTool; calls: number }>();
  // the open dialogs, by Pi's request id
  const dialogs = new Map<string, Dialog>();
  const request = (command: Json): Promise<Json> => new Promise(resolve => {
    const id = `${prefix}-${requests += 1}`;
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
  // the Conversation's transcript from its history: on a launch only when it has one, and after
  // a Conversation change always, so a new one starts empty
  const history = (always: boolean) => request({ type: 'get_messages' }).then(response => {
    const messages = isObject(response.data) && Array.isArray(response.data.messages) ? response.data.messages : undefined;
    if (messages !== undefined && (always || messages.length > 0)) emit({ type: 'history', items: piHistory(messages, { running: working === true }) });
  });
  let current: ModelSetting | undefined;
  // report the Conversation and the model Pi is on now
  const refresh = async (): Promise<void> => {
    const state = (await request({ type: 'get_state' })).data;
    if (!isObject(state)) return;
    if (working === undefined) {
      working = state.isStreaming === true || state.isCompacting === true;
      if (working) { prompted = true; emit({ type: 'turn', turn: { type: 'started' } }); }
    }
    if (typeof state.sessionId === 'string' && state.sessionId !== '') emit({ type: 'conversation', id: state.sessionId, ...(typeof state.sessionName === 'string' ? { name: state.sessionName } : {}) });
    const model = modelInfo(state.model);
    if (model === undefined) return;
    current = { model: model.id, ...(typeof state.thinkingLevel === 'string' ? { effort: state.thinkingLevel } : {}) };
    emit({ type: 'model', current });
  };
  // the model switched counts, whatever becomes of the Effort: the next `model` event says which it is on
  const apply = async ({ model, effort }: ModelSetting): Promise<boolean> => {
    const slash = model.indexOf('/');
    if (slash <= 0 || (await request({ type: 'set_model', provider: model.slice(0, slash), modelId: model.slice(slash + 1) })).success !== true) return false;
    if (effort !== undefined) await request({ type: 'set_thinking_level', level: effort });
    return true;
  };

  const closeDialog = (id: string) => {
    const dialog = dialogs.get(id);
    if (dialog === undefined) return;
    clearTimeout(dialog.timer);
    dialogs.delete(id);
    emit({ type: 'question-closed', id });
  };
  const openDialog = (record: Json) => {
    const field = dialogField(record);
    if (typeof record.id !== 'string' || field === undefined) return;
    const id = record.id;
    if (dialogs.size >= maxDialogs) { channel.send(JSON.stringify({ type: 'extension_ui_response', id, cancelled: true })); return; }
    const { text: title, toolCallId } = dialogTitle(record.title);
    const question = bounded(record.method === 'confirm' && typeof record.message === 'string' && record.message !== '' ? `${title}\n\n${record.message}` : title);
    // Pi takes its default answer when a timeout lapses, without saying so; one too long for a
    // timer counts as none
    const timeout = typeof record.timeout === 'number' && record.timeout > 0 && record.timeout <= 2 ** 31 - 1 ? record.timeout : undefined;
    dialogs.set(id, { method: record.method as Dialog['method'], options: record.method === 'select' ? strings(record.options).slice(0, maxChoices) : [], ...(toolCallId === undefined ? {} : { toolCallId }), ...(timeout === undefined ? {} : { timer: setTimeout(() => closeDialog(id), timeout) }) });
    emit({ type: 'question', question: { id, text: question, field, ...(timeout === undefined ? {} : { expiresAt: Date.now() + timeout }) } });
    const tool = toolCallId === undefined ? undefined : tools.get(toolCallId);
    if (tool !== undefined) showTool(toolCallId!, { ...tool.item, summary: waitingForAnswer });
  };

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
        if (record.method === 'set_editor_text' && typeof record.text === 'string') { emit({ type: 'draft', text: record.text }); return; }
        if (record.method === 'select' || record.method === 'confirm' || record.method === 'input' || record.method === 'editor') { openDialog(record); return; }
        if (record.method === 'notify' && typeof record.message === 'string') {
          transcript({ id: next('n'), kind: 'notice', text: bounded(record.message), tone: record.notifyType === 'warning' || record.notifyType === 'error' ? record.notifyType : 'info' });
          return;
        }
        if (record.method !== 'setStatus' || typeof record.statusKey !== 'string') return;
        if (record.statusKey !== piReportStatusKey) {
          emit({ type: 'status', key: record.statusKey, ...(typeof record.statusText === 'string' && record.statusText !== '' ? { text: bounded(record.statusText) } : {}) });
          return;
        }
        {
          // every report goes up: the console keeps only the one bearing its launch's nonce
          const report = parseReport(record.statusText);
          if (report === undefined) return;
          emit({ type: 'report', report });
          if (reported) return;
          reported = true;
        }
        void refresh();
        void history(false);
        usage();
        return;
      case 'queue_update':
        emit({ type: 'steers', pending: strings(record.steering) });
        return;
      case 'agent_start':
        if (working === true) return;
        working = true; prompted = false; answer = ''; errored = false; cost = 0; toolCalls = 0;
        emit({ type: 'turn', turn: { type: 'started' } });
        return;
      case 'message_start':
        if (isObject(record.message) && record.message.role === 'assistant') assistantMessages += 1;
        return;
      case 'message_update': {
        // thinking is live from its start to its end, and shown whole then
        const update = isObject(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
        if (typeof update?.contentIndex !== 'number') return;
        if (update.type === 'thinking_start') transcript({ id: `t${assistantMessages}.${update.contentIndex}`, kind: 'thinking', text: '', live: true });
        if (update.type === 'thinking_end') transcript({ id: `t${assistantMessages}.${update.contentIndex}`, kind: 'thinking', text: typeof update.content === 'string' ? bounded(update.content) : '' });
        return;
      }
      case 'message_end': {
        const message = isObject(record.message) ? record.message : undefined;
        if (message?.role === 'user') {
          // a prompt after the Turn's first arrived as a steer
          transcript({ id: next('m'), kind: 'message', role: 'user', text: text(message.content), ...(working === true && prompted ? { steer: true as const } : {}) });
          prompted = true;
        }
        if (message?.role !== 'assistant') return;
        cost += messageCost(message);
        const blocks = Array.isArray(message.content) ? message.content : [];
        blocks.forEach((block, index) => {
          if (isObject(block) && block.type === 'thinking') transcript({ id: `t${assistantMessages}.${index}`, kind: 'thinking', text: typeof block.thinking === 'string' ? bounded(block.thinking) : '' });
        });
        errored = message.stopReason === 'error';
        const said = text(message.content);
        const shown = answerText(message);
        if (said !== '') answer = said;
        if (shown !== '') transcript({ id: next('m'), kind: 'message', role: 'assistant', text: shown });
        usage();
        return;
      }
      case 'tool_execution_start': {
        if (typeof record.toolCallId !== 'string' || typeof record.toolName !== 'string') return;
        const parentId = typeof record.parentToolCallId === 'string' ? record.parentToolCallId : undefined;
        const item = toolCall(record.toolCallId, record.toolName, record.args, parentId);
        tools.set(record.toolCallId, { toolName: record.toolName, args: record.args, item, calls: 0 });
        toolCalls += 1;
        transcript(item);
        const parent = parentId === undefined ? undefined : tools.get(parentId);
        if (parent?.toolName === 'codemode') showTool(parentId!, { ...parent.item, summary: scriptSummary(parent.calls += 1) });
        return;
      }
      case 'tool_execution_update': {
        const tool = typeof record.toolCallId === 'string' ? tools.get(record.toolCallId) : undefined;
        const output = isObject(record.partialResult) ? text(record.partialResult.content) : '';
        if (tool !== undefined && output !== '' && bounded(output) !== tool.item.output) showTool(record.toolCallId as string, { ...tool.item, output: bounded(output) });
        return;
      }
      case 'tool_execution_end': {
        const tool = typeof record.toolCallId === 'string' ? tools.get(record.toolCallId) : undefined;
        // a dialog the call raised waits no longer (one replayed after it was answered, say)
        for (const [id, dialog] of dialogs) if (dialog.toolCallId === record.toolCallId) closeDialog(id);
        if (tool === undefined) return;
        tools.delete(record.toolCallId as string);
        const failed = record.isError === true;
        const calls = isObject(record.result) && isObject(record.result.details) && Array.isArray(record.result.details.calls) ? record.result.details.calls.length : undefined;
        const { output: _streamed, ...started } = tool.item;
        // a call that waited on the operator shows the answer it got as its result
        transcript({ ...started, ...(started.summary === waitingForAnswer ? { summary: '' } : {}), ...finished(tool.toolName, tool.args, record.result, failed, record.durationMs), ...(calls === undefined ? {} : { summary: scriptSummary(calls) }) });
        return;
      }
      case 'agent_settled':
        if (working === false) return;
        working = false;
        // a settled Turn waits on no dialog; an aborted one's dialogs were dismissed with it
        for (const id of [...dialogs.keys()]) closeDialog(id);
        transcript({ id: next('e'), kind: 'settled', outcome: outcome(record.aborted === true, errored), cost, toolCalls });
        emit({ type: 'turn', turn: record.aborted === true ? { type: 'aborted' } : errored ? { type: 'failed' } : { type: 'settled', message: answer } });
        return;
    }
  });
  channel.onClose(() => {
    for (const resolve of pending.values()) resolve({ success: false });
    pending.clear();
    for (const dialog of dialogs.values()) clearTimeout(dialog.timer);
    dialogs.clear();
    emit({ type: 'exited' });
  });

  // reattached to a process that reported in to an earlier console: read its state afresh
  if (attached !== undefined) {
    void refresh();
    void history(false);
    usage();
  }

  return {
    async deliver(prompt) {
      const response = await request({ type: 'prompt', message: prompt });
      // Pi refuses a prompt while it works, and outright when it has no model or no login
      if (response.success !== true) return typeof response.error === 'string' && response.error.startsWith('Agent is already processing') ? 'busy' : 'refused';
      // a prompt sent without `streamingBehavior` is refused while Pi works, never `queued`
      return isObject(response.data) && response.data.disposition === 'handled' ? 'handled' : 'started';
    },
    async newConversation() {
      const keep = current;
      if (!accepted(await request({ type: 'new_session' }))) return false;
      // a new session starts on the launch's model at no thinking; keep the current ones
      if (keep !== undefined) await apply(keep);
      await refresh();
      void history(true);
      usage();
      return true;
    },
    async switchConversation(reference) {
      if (!accepted(await request({ type: 'switch_session', sessionPath: reference }))) return false;
      // Pi keeps the launch's `--model` across a switch; restore the Conversation's own
      const entries = (await request({ type: 'get_entries' })).data;
      const own = sessionModel(isObject(entries) ? entries.entries : undefined);
      if (own !== undefined) await apply(own);
      await refresh();
      void history(true);
      usage();
      return true;
    },
    async renameConversation(name) {
      if (!accepted(await request({ type: 'set_session_name', name }))) return false;
      await refresh();
      return true;
    },
    async models() {
      const data = (await request({ type: 'get_available_models' })).data;
      return isObject(data) && Array.isArray(data.models) ? data.models.flatMap(model => modelInfo(model) ?? []) : [];
    },
    async setModel(setting) {
      const applied = await apply(setting);
      await refresh();
      return applied;
    },
    async steer(prompt) {
      return (await request({ type: 'prompt', message: prompt, streamingBehavior: 'steer' })).success === true;
    },
    // `clear_queue` first, so `abort` cannot run the steers it holds; the steers come back
    async cancel() {
      const cleared = await request({ type: 'clear_queue' });
      if (cleared.success !== true || (await request({ type: 'abort' })).success !== true) return undefined;
      return strings(isObject(cleared.data) ? cleared.data.steering : undefined);
    },
    async answer(questionId, given) {
      const dialog = dialogs.get(questionId);
      if (dialog === undefined) return false;
      let response: Json;
      if (typeof given === 'object') response = { cancelled: true };
      else if (dialog.method === 'confirm' && (given === 0 || given === 1)) response = { confirmed: given === 0 };
      else if (dialog.method === 'select' && typeof given === 'number' && dialog.options[given] !== undefined) response = { value: dialog.options[given] };
      else if ((dialog.method === 'input' || dialog.method === 'editor') && typeof given === 'string') response = { value: given };
      else return false;
      closeDialog(questionId);
      channel.send(JSON.stringify({ type: 'extension_ui_response', id: questionId, ...response }));
      return true;
    },
    close: () => channel.close()
  };
};
