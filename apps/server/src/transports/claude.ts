import { randomUUID } from 'node:crypto';
import { askUser, askUserReply } from '../adapters/ask-user.js';
import { claudeConversationEffort, claudeConversationName, claudeHookNonce, claudeTranscriptRecords, validClaudeSessionId } from '../adapters/claude-conversations.js';
import type { QuestionField } from '../adapters/types.js';
import { bounded, count, isObject, oneLine, outcome, strings, summary, text, thousands, waitingForAnswer, type Json, type ModelInfo, type ModelSetting, type ProtocolClient, type StructuredQuestion, type TranscriptItem, type TranscriptTool } from './structured.js';

/**
 * The Claude protocol client (ADR 0015): Claude Code driven headless over stream-json lines,
 * `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages
 * --permission-prompts host --permission-prompt-tool stdio` with `--mcp-config` naming the console's SDK MCP server and a
 * SessionStart hook that echoes the launch's nonce. With `--replay-user-messages` the CLI echoes
 * each prompt under the `uuid` it was sent with and reports its `command_lifecycle` (queued,
 * started, completed), which says when a steer is read and which prompt a Turn runs. Prompts are user messages; the CLI answers with the messages of each Turn and a
 * `result` at its end, and asks the console for tool permissions and `ask_user` over control
 * requests. Its Conversation is the session JSONL the TUI writes, which history is read from.
 * Records and fields it does not know are ignored, each kind logged once.
 */

/** Claude's effort levels, which RAC calls Efforts. */
export const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** The SDK MCP server the client serves; a launch names it in `--mcp-config` as `{ type: 'sdk', name }`. */
export const claudeMcpServer = 'rac';
const askUserTool = `mcp__${claudeMcpServer}__${askUser.name}`;
// Claude's tool names as the transcript's verbs; any other tool keeps its own name
const verbs: Record<string, string> = { Bash: 'Run', Grep: 'Search', Glob: 'Find', LS: 'List', MultiEdit: 'Edit', WebFetch: 'Fetch', [askUserTool]: 'Ask' };
const editTools = new Set(['Edit', 'MultiEdit', 'Write']);
const controlTimeoutMs = 30_000;
const compactTimeoutMs = 10 * 60_000;
// how long leftover steers wait, with the CLI quiet and nothing in flight, before they are taken as dropped
const leftoverMs = 60_000;
// at most this many questions stay open (more are refused at once) and this many choices show
const maxQuestions = 20;
const maxChoices = 50;

const ignored = new Set(['stream_event', 'rate_limit_event', 'system/status', 'system/thinking_tokens', 'system/hook_started', 'system/task_started', 'system/task_progress', 'system/task_notification', 'system/permission_denied']);
const logged = new Set<string>();
const unknown = (kind: string): void => {
  if (ignored.has(kind) || logged.has(kind)) return;
  logged.add(kind);
  console.warn(`[claude] ignoring ${kind} lines`);
};

// a local command's output, as `<local-command-stdout>…</local-command-stdout>`
const localOutput = (content: string): { text: string; tone: 'info' | 'warning' } | undefined => {
  const match = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/u.exec(content.trim());
  return match === null ? undefined : { text: match[2]!.trim(), tone: match[1] === 'stderr' ? 'warning' : 'info' };
};
const interruption = (content: unknown): boolean => Array.isArray(content) && content.some(block => isObject(block) && block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('[Request interrupted by user'));
const contextTokens = (usage: unknown): number | undefined => {
  if (!isObject(usage)) return undefined;
  const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens, usage.output_tokens];
  return parts.every(part => typeof part === 'number') ? (parts as number[]).reduce((sum, part) => sum + part, 0) : undefined;
};
// a Turn's own cost, from the usage the CLI counts since its last result
const turnCost = (usage: unknown): number | undefined => {
  if (!isObject(usage)) return undefined;
  const costs = Object.values(usage).flatMap(model => isObject(model) && typeof model.costUSD === 'number' ? [model.costUSD] : []);
  return costs.length === 0 ? undefined : costs.reduce((sum, cost) => sum + cost, 0);
};
// the largest context window among the models in a usage record
const contextWindow = (usage: unknown): number | undefined => {
  if (!isObject(usage)) return undefined;
  const windows = Object.values(usage).flatMap(model => isObject(model) && typeof model.contextWindow === 'number' ? [model.contextWindow] : []);
  return windows.length === 0 ? undefined : Math.max(...windows);
};

const compaction = (record: Json): { before?: number; after?: number; auto: boolean } => {
  const meta = isObject(record.compact_metadata) ? record.compact_metadata : isObject(record.compactMetadata) ? record.compactMetadata : {};
  const before = meta.pre_tokens ?? meta.preTokens;
  const after = meta.post_tokens ?? meta.postTokens;
  return { ...(typeof before === 'number' ? { before } : {}), ...(typeof after === 'number' ? { after } : {}), auto: meta.trigger === 'auto' };
};
// a local command's output (`/rename`) or an API error, which the CLI sends as an answer
const synthetic = (message: Json): boolean => message.model === '<synthetic>';
const head = (value: string, max: number): string => value.length > max ? `${value.slice(0, max)}\n… ${value.length - max} more characters not shown` : value;
// how much of what a tool permission grants is shown; one that does not fit can only be denied
const maxPermissionDetail = 16 * 1024;
// Bidirectional and zero-width code points would let shown text differ from what runs, so each
// shows as its code point
const hidden = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu;
const visible = (value: string): string => value.replace(hidden, point => `<U+${point.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
// What a tool permission grants, in full: a command as it will run, the content a Write puts in
// its file, the change an Edit makes, then every other input key it grants with them (a timeout,
// `replace_all`, `dangerouslyDisableSandbox`); or else the tool's whole input.
const permissionDetail = (tool: string, input: unknown): string => {
  if (!isObject(input)) return '';
  const rest = (shown: string, keys: string[]) => {
    const others = Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)));
    return visible(Object.keys(others).length === 0 ? shown : `${shown}\n\n${JSON.stringify(others, null, 2)}`);
  };
  if (tool === 'Bash' && typeof input.command === 'string') return rest(input.command, ['command']);
  if (tool === 'Write' && typeof input.file_path === 'string' && typeof input.content === 'string') return rest(`${input.file_path}\n\n${input.content}`, ['file_path', 'content']);
  if (tool === 'Edit' && typeof input.file_path === 'string' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return rest(`${input.file_path}\n\n${[...input.old_string.split('\n').map(line => `-${line}`), ...input.new_string.split('\n').map(line => `+${line}`)].join('\n')}`, ['file_path', 'old_string', 'new_string']);
  }
  return visible(JSON.stringify(input, null, 2));
};

// an edit's unified diff, from the hunks the CLI keeps of it (`structuredPatch`); a file Write
// created has none, so all of it is new
function editDiff(file: string | undefined, result: unknown): TranscriptTool['diff'] {
  if (!isObject(result)) return undefined;
  const path = typeof result.filePath === 'string' ? result.filePath : file;
  const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch.filter(isObject) : [];
  let body = hunks.flatMap(hunk => typeof hunk.oldStart === 'number' && typeof hunk.oldLines === 'number' && typeof hunk.newStart === 'number' && typeof hunk.newLines === 'number'
    ? [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${strings(hunk.lines).join('\n')}\n`] : []).join('');
  if (body === '' && result.type === 'create' && typeof result.content === 'string') {
    const lines = result.content.replace(/\n$/u, '').split('\n');
    body = `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`;
  }
  return path === undefined || body === '' ? undefined : { path, patch: bounded(`--- ${path}\n+++ ${path}\n${body}`) };
}

// What a finished call gave back: its output (a command's last lines are its result line), plus an
// edit's diff, a read's line count, or any other call's first line.
function toolResult(name: string, file: string | undefined, output: string, result: unknown, failed: boolean): Pick<TranscriptTool, 'output' | 'result' | 'diff'> {
  const shown = output === '' ? {} : { output: bounded(output) };
  if (name === 'Bash') return shown;
  const diff = failed || !editTools.has(name) ? undefined : editDiff(file, result);
  if (diff !== undefined) return { ...shown, diff };
  if (!failed && name === 'Read') {
    const file = isObject(result) && isObject(result.file) ? result.file : undefined;
    return { ...shown, result: count(typeof file?.numLines === 'number' ? file.numLines : output === '' ? 0 : output.replace(/\n$/u, '').split('\n').length, 'line', 'lines') };
  }
  return output.trim() === '' ? shown : { ...shown, result: oneLine(output.trim().split('\n')[0]!) };
}

/**
 * Reads Claude's message records into transcript items, the same for the live stream and the
 * session JSONL: the two share message shapes and record ids (`uuid`), so a history reloaded
 * later replaces what the stream showed item for item. A tool call's result replaces its call,
 * and a compaction's summary fills in its notice. Each record gives the items it adds or replaces.
 */
function transcriptReader() {
  // the calls in flight, with the file an edit names
  const calls = new Map<string, { name: string; file?: string; at: number; item: TranscriptTool }>();
  // the latest compaction's notice, until its summary (and the command's own output) has passed
  let compacted: Extract<TranscriptItem, { kind: 'notice' }> | undefined;
  const notice = (id: string, said: string, tone: 'info' | 'warning' | 'error' = 'info'): TranscriptItem => ({ id, kind: 'notice', text: bounded(said), tone });

  // a user message's text: a prompt, or what a local command or a compaction left
  const userText = (record: Json, id: string, content: string): TranscriptItem[] => {
    if (record.isCompactSummary === true || record.isSynthetic === true) {
      if (compacted === undefined) return [];
      compacted = { ...compacted, detail: bounded(content) };
      return [compacted];
    }
    const local = localOutput(content);
    if (local !== undefined) {
      // a compaction's own "Compacted" line repeats its notice
      if (compacted !== undefined) { compacted = undefined; return []; }
      return local.text === '' ? [] : [notice(id, local.text, local.tone)];
    }
    // a slash command's echo, which its output follows
    if (content.trimStart().startsWith('<command-name>')) return [];
    compacted = undefined;
    return [{ id, kind: 'message', role: 'user', text: bounded(content) }];
  };

  return {
    items(record: Json): TranscriptItem[] {
      const id = typeof record.uuid === 'string' ? record.uuid : undefined;
      const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
      // a subagent's messages are its own transcript's
      if (id === undefined || record.isSidechain === true || (record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null)) return [];
      const message = isObject(record.message) ? record.message : {};
      switch (record.type) {
        case 'assistant': {
          const blocks = Array.isArray(message.content) ? message.content : [];
          compacted = undefined;
          if (synthetic(message)) {
            const said = text(blocks).trim();
            return said === '' ? [] : [notice(id, said, record.isApiErrorMessage === true || said.startsWith('API Error') ? 'error' : 'info')];
          }
          return blocks.flatMap((block, index): TranscriptItem[] => {
            if (!isObject(block)) return [];
            if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return [{ id: `${id}:${index}`, kind: 'message', role: 'assistant', text: bounded(block.text) }];
            // Claude keeps its thinking to itself unless the operator's settings show it
            if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') return [{ id: `${id}:${index}`, kind: 'thinking', text: bounded(block.thinking) }];
            if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') return [];
            // an `ask_user` question shows once, in the Inline-question box, never as the call's target
            const item: TranscriptTool = { id: block.id, kind: 'tool', name: verbs[block.name] ?? block.name, summary: block.name === askUserTool ? '' : summary(block.input), state: 'running' };
            calls.set(block.id, { name: block.name, ...(isObject(block.input) && typeof block.input.file_path === 'string' ? { file: block.input.file_path } : {}), at, item });
            return [item];
          });
        }
        case 'user': {
          if (record.isMeta === true) return [];
          const content = message.content;
          if (typeof content === 'string') return userText(record, id, content);
          if (!Array.isArray(content) || interruption(content)) return [];
          const results = content.filter(block => isObject(block) && block.type === 'tool_result') as Json[];
          if (results.length === 0) { const said = text(content); return said === '' ? [] : userText(record, id, said); }
          // the stream's `tool_use_result` is the JSONL's `toolUseResult`
          const kept = record.tool_use_result ?? record.toolUseResult;
          return results.flatMap(block => {
            const call = typeof block.tool_use_id === 'string' ? calls.get(block.tool_use_id) : undefined;
            if (call === undefined) return [];
            calls.delete(block.tool_use_id as string);
            const failed = block.is_error === true;
            const durationMs = Math.round(at - call.at);
            return [{ ...call.item, state: failed ? 'failed' as const : 'done' as const, ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}), ...toolResult(call.name, call.file, text(block.content), kept, failed) }];
          });
        }
        // a prompt sent mid-Turn, as the JSONL keeps it: by the id it was sent under
        case 'attachment': {
          const attachment = isObject(record.attachment) ? record.attachment : {};
          if (attachment.type !== 'queued_command' || attachment.commandMode !== 'prompt' || typeof attachment.prompt !== 'string') return [];
          return [{ id: typeof attachment.source_uuid === 'string' ? attachment.source_uuid : id, kind: 'message', role: 'user', text: bounded(attachment.prompt), steer: true }];
        }
        case 'system':
          if (record.subtype === 'compact_boundary') {
            const { before, after, auto } = compaction(record);
            const freed = before === undefined ? '' : after !== undefined ? `: ${thousands(before)} → ${thousands(after)} tokens of context` : `: ${thousands(before)} tokens of context before`;
            compacted = notice(id, `${auto ? 'Claude compacted the conversation as its context neared the model\'s limit' : 'Compacted the conversation'}${freed}`) as Extract<TranscriptItem, { kind: 'notice' }>;
            return [compacted];
          }
          // the JSONL's record of a local command's output, which the stream sends as a synthetic answer
          if (record.subtype === 'local_command' && typeof record.content === 'string') return userText(record, id, record.content);
          return [];
        default:
          return [];
      }
    },
    /** The call `toolUseId` while it waits on the operator, if it is still running. */
    waiting(toolUseId: string): TranscriptTool | undefined {
      const call = calls.get(toolUseId);
      return call === undefined ? undefined : { ...call.item, summary: waitingForAnswer };
    }
  };
}

/**
 * A Conversation's transcript from its session JSONL records: prompts (with the steers it folded
 * in), answers, thinking, tool calls with their results, notices, and the end of each prompt's
 * Turn with its tool calls, cancelled when it was interrupted and failed on an API error. The JSONL
 * keeps no cost per Turn. While a Turn is `running`, the last prompt's has no end yet.
 */
export function claudeHistory(lines: Iterable<string>, { running = false } = {}): TranscriptItem[] {
  const reader = transcriptReader();
  const items: TranscriptItem[] = [];
  const index = new Map<string, number>();
  let prompt: string | undefined;
  let toolCalls = 0;
  let interrupted = false;
  let failed = false;
  const settle = () => {
    if (prompt !== undefined) items.push({ id: `${prompt}:end`, kind: 'settled', outcome: outcome(interrupted, failed), toolCalls });
    prompt = undefined;
    toolCalls = 0;
    interrupted = false;
    failed = false;
  };
  for (const line of lines) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!isObject(record)) continue;
    if (record.type === 'user' && isObject(record.message) && interruption(record.message.content)) interrupted = true;
    if (record.type === 'assistant' && record.isApiErrorMessage === true) failed = true;
    for (const item of reader.items(record)) {
      if (item.kind === 'message' && item.role === 'user' && item.steer !== true) { settle(); prompt = item.id; }
      const at = index.get(item.id);
      if (at !== undefined) { items[at] = item; continue; }
      if (item.kind === 'tool') toolCalls += 1;
      index.set(item.id, items.length);
      items.push(item);
    }
  }
  if (!running) settle();
  return items;
}


// a model as `initialize` lists it, with the Efforts it supports; an Effort is a launch argument
// (`--effort`) this client cannot change live (unverified: whether `/effort` works between Turns
// in `-p` mode), so the console starts the process again for one
const modelInfo = (model: Json): ModelInfo[] => typeof model.value !== 'string' ? [] : [{
  id: model.value, name: typeof model.displayName === 'string' && model.displayName !== '' ? model.displayName : model.value, provider: 'anthropic',
  efforts: model.supportsEffort === true ? strings(model.supportedEffortLevels) : []
}];

// an open question: a tool permission (`can_use_tool`), or an `ask_user` call, answered by `respond`;
// either names the tool call it holds up, when the CLI says
// a permission too long to show in full (`deniable`) offers only Deny
type Question = ({ kind: 'permission'; input: unknown; deniable?: true } | { kind: 'ask'; choices: string[]; respond: (body: Json) => void }) & { toolUseId?: string };
// a slash command the console sent as a prompt (under `id`), or a model switch, which ends no Turn; `seen` once it did what it was for
type Operation = { kind: 'rename' | 'compact' | 'clear' | 'model'; id?: string; seen: boolean; finish: (result?: Json) => void };

export const claudeClient: ProtocolClient = (channel, emit, { cwd, model: launched, attached }) => {
  // request ids no earlier client used, so a response replayed from before a reattach answers nothing
  const prefix = `rac-${randomUUID().slice(0, 8)}`;
  let requests = 0;
  const pending = new Map<string, (response: Json | undefined) => void>();
  const reader = transcriptReader();
  const transcript = (item: TranscriptItem) => emit({ type: 'transcript', item });
  let sessionId = attached?.conversation;
  let version: string | undefined;
  // every nonce a SessionStart hook printed, and those reported
  const nonces = new Set<string>();
  const told = new Set<string>();
  let reported = attached !== undefined;
  let models: Json[] | undefined;
  // the model by the kind's id for it (the launch's, until the CLI says), and the full id the CLI reports it by
  let current: ModelSetting | undefined = launched;
  let resolved: string | undefined;
  // a Turn runs from our prompt, or one the CLI starts itself, to its `result`. Unknown after a
  // replay that lost lines, until the CLI's state (`initialize`) or a Turn's start or end says.
  let working: boolean | undefined = attached !== undefined && attached.dropped > 0 ? undefined : false;
  let cancelling = false;
  // what this process has spent (the CLI's `total_cost_usd`), so a restarted Agent counts afresh
  let total: number | undefined;
  let tokens: number | undefined;
  let window: number | undefined;
  let toolCalls = 0;
  let answer = '';
  // the prompt the Turn in flight started with
  let turnPrompt: string | undefined;
  // the steers sent and not yet read: the CLI folds each into the Turn at its next tool boundary,
  // or runs it as a Turn of its own once the Turn ends
  const steers: Array<{ id: string; text: string }> = [];
  // A steer left over when its Turn ends stays pending until the CLI starts it, completes it or
  // gives it back: it may run several leftovers as Turns one after another, so a Turn's end says
  // nothing about the next one's. Only a CLI quiet for `leftoverMs` with nothing in flight has
  // dropped them, which keeps a lost lifecycle line from holding the Agent busy for good.
  let leftover: NodeJS.Timeout | undefined;
  const awaitLeftovers = () => {
    clearTimeout(leftover);
    if (steers.length === 0 || working === true) return;
    leftover = setTimeout(() => { if (working !== true && steers.length > 0) unread(steers.splice(0)); }, leftoverMs);
    leftover.unref?.();
  };
  const questions = new Map<string, Question>();
  let operation: Operation | undefined;
  const waiters: Array<(idle: boolean) => void> = [];

  // idle, and with no steer left for the CLI to run
  const idle = () => working === false && operation === undefined && steers.length === 0;
  const wake = () => { if (idle()) for (const waiter of waiters.splice(0)) waiter(true); };
  const nextIdle = () => new Promise<boolean>(resolve => waiters.push(resolve));
  const write = (record: Json) => channel.send(JSON.stringify(record));
  // the CLI keeps `id` as the message's `uuid`, in its echo, its lifecycle and the session JSONL
  const userMessage = (content: string, id: string = randomUUID()) => write({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', uuid: id });
  // a control request's response, or undefined when it failed, timed out or the channel closed
  const control = (request: Json, timeoutMs = controlTimeoutMs): Promise<Json | undefined> => new Promise(resolve => {
    const id = `${prefix}-${requests += 1}`;
    const timer = setTimeout(() => { pending.delete(id); resolve(undefined); }, timeoutMs);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    write({ type: 'control_request', request_id: id, request });
  });
  const reply = (requestId: string, response: Json) => write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  const refuse = (requestId: string, error: string) => write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
  const showSteers = () => emit({ type: 'steers', pending: steers.map(steer => steer.text) });
  const usage = () => emit({ type: 'usage', usage: { cost: total ?? 0, ...(tokens === undefined ? {} : { contextTokens: tokens, ...(window === undefined ? {} : { contextPercent: tokens / window * 100 }) }) } });

  // the Conversation and its history, read from its session JSONL: on a launch only when it has
  // one, and after a Conversation change always, so a new one starts empty
  const resync = async (always: boolean): Promise<void> => {
    const id = sessionId;
    if (id === undefined) return;
    const [name, lines] = await Promise.all([claudeConversationName(id, cwd), claudeTranscriptRecords(id, cwd)]);
    if (id !== sessionId) return;
    emit({ type: 'conversation', id, ...(name === undefined ? {} : { name }) });
    const items = lines === undefined ? [] : claudeHistory(lines, { running: working === true });
    if (always || items.length > 0) emit({ type: 'history', items });
  };
  const session = (id: unknown) => {
    if (typeof id !== 'string' || !validClaudeSessionId(id) || id === sessionId) return;
    sessionId = id;
    if (reported) void resync(true);
  };
  // the launch report, once the CLI has said its version: one for each nonce a SessionStart hook
  // printed, of which the console keeps the one its launch minted
  const reportIn = () => {
    if (version === undefined) return;
    for (const nonce of nonces) {
      if (told.has(nonce)) continue;
      told.add(nonce);
      emit({ type: 'report', report: { loaded: true, sandbox: { engaged: false, reason: 'the console does not sandbox Claude; its own sandbox follows the operator\'s settings' }, version, nonce } });
    }
    if (reported || told.size === 0) return;
    reported = true;
    if (current !== undefined) emit({ type: 'model', current });
    void resync(false);
  };
  // the kind's id for a model the CLI names by its full id: itself when listed so, else the one
  // alias listed under it (`default` when it is the only one), else the full id
  const alias = (id: string): string => {
    const listed = models?.filter(entry => entry.value === id || entry.resolvedModel === id) ?? [];
    if (listed.length === 0 || listed.some(entry => entry.value === id)) return id;
    const named = listed.filter(entry => entry.value !== 'default');
    return named.length === 1 ? named[0]!.value as string : named.length === 0 ? 'default' : id;
  };
  const observeModel = (model: unknown) => {
    if (typeof model !== 'string' || model === '' || model === resolved) return;
    resolved = model;
    // the model it was on already, by its alias
    if (current !== undefined && (current.model === model || models?.some(entry => entry.value === current!.model && entry.resolvedModel === model) === true)) return;
    current = { model: alias(model), ...(current?.effort === undefined ? {} : { effort: current.effort }) };
    emit({ type: 'model', current });
  };
  // the Effort a Turn ran at, which only the session JSONL names: with no `--effort`, Claude's default
  const observeEffort = async () => {
    const id = sessionId;
    if (id === undefined) return;
    const effort = await claudeConversationEffort(id, cwd);
    if (id !== sessionId || current === undefined || effort === undefined || effort === current.effort || !(claudeEfforts as readonly string[]).includes(effort)) return;
    current = { ...current, effort };
    emit({ type: 'model', current });
  };
  const turnStarted = () => {
    working = true;
    toolCalls = 0;
    answer = '';
    turnPrompt = undefined;
    emit({ type: 'turn', turn: { type: 'started' } });
  };
  // a steer the CLI took up: folded into the Turn in flight, or, once that has ended, the prompt of
  // a Turn of its own (as after an interrupt)
  const steerTaken = (id: unknown) => {
    const at = steers.findIndex(steer => steer.id === id);
    if (at === -1) return;
    const [steer] = steers.splice(at, 1);
    if (working !== true) {
      turnStarted();
      turnPrompt = steer!.id;
      transcript({ id: steer!.id, kind: 'message', role: 'user', text: steer!.text });
    }
    showSteers();
  };
  // steers the CLI will not run: it completed them unread, or a Turn after theirs ended without them
  const unread = (dropped: Array<{ id: string; text: string }>) => {
    if (dropped.length === 0) return;
    for (const steer of dropped) transcript({ id: `${steer.id}:unread`, kind: 'notice', text: `The agent did not read this steer: ${oneLine(steer.text)}`, tone: 'warning' });
    showSteers();
    wake();
  };
  const closeQuestion = (id: string) => {
    if (!questions.delete(id)) return;
    emit({ type: 'question-closed', id });
  };
  // a question nobody answered: the CLI is told no, so no call waits on it
  const dismiss = (id: string, question: Question, why: string) => {
    if (question.kind === 'ask') question.respond({ result: { content: [{ type: 'text', text: askUserReply(question.choices, undefined) }] } });
    else reply(id, { behavior: 'deny', message: why });
    closeQuestion(id);
  };
  const openQuestion = (id: string, question: Question, shown: Omit<StructuredQuestion, 'id'>) => {
    if (questions.size >= maxQuestions) { dismiss(id, question, 'The operator has too many questions open.'); return; }
    questions.set(id, question);
    emit({ type: 'question', question: { id, ...shown } });
    const waiting = question.kind === 'ask' && question.toolUseId !== undefined ? reader.waiting(question.toolUseId) : undefined;
    if (waiting !== undefined) transcript(waiting);
  };

  // the console's SDK MCP server: `ask_user`, and nothing else
  const mcp = (requestId: string, request: Json) => {
    const message = isObject(request.message) ? request.message : {};
    const params = isObject(message.params) ? message.params : {};
    const respond = (body: Json) => reply(requestId, { mcp_response: { jsonrpc: '2.0', ...(message.id === undefined ? {} : { id: message.id }), ...body } });
    if (request.server_name !== claudeMcpServer) { refuse(requestId, `No MCP server ${String(request.server_name)} is served here.`); return; }
    switch (message.method) {
      case 'initialize':
        respond({ result: { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: claudeMcpServer, version: '1' } } });
        return;
      case 'ping':
        respond({ result: {} });
        return;
      case 'tools/list':
        respond({ result: { tools: [{ name: askUser.name, description: askUser.description, inputSchema: askUser.parameters }] } });
        return;
      case 'tools/call': {
        if (params.name !== askUser.name) { respond({ error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } }); return; }
        const args = isObject(params.arguments) ? params.arguments : {};
        if (typeof args.question !== 'string' || args.question.trim() === '') { respond({ result: { content: [{ type: 'text', text: 'ask_user needs a question.' }], isError: true } }); return; }
        const choices = strings(args.choices).slice(0, maxChoices);
        const meta = isObject(params._meta) ? params._meta : {};
        const toolUseId = typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : undefined;
        openQuestion(requestId, { kind: 'ask', choices, respond, ...(toolUseId === undefined ? {} : { toolUseId }) }, { text: bounded(args.question), field: choices.length > 0 ? { kind: 'choice', choices: choices.map(oneLine) } : { kind: 'text', multiline: false } });
        return;
      }
      default:
        // a notification (`notifications/initialized`) needs no answer but the request's own
        respond(message.id === undefined ? { result: {} } : { error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
    }
  };
  // `can_use_tool`, sent only with `--permission-prompt-tool stdio` (without it the CLI denies what
  // would prompt); its `permission_suggestions` (rules to save) are not offered
  const permission = (requestId: string, request: Json) => {
    const tool = visible(typeof request.tool_name === 'string' ? request.tool_name : 'a tool');
    const target = visible(summary(request.input));
    const reason = typeof request.decision_reason === 'string' && request.decision_reason !== '' ? ` ${visible(head(oneLine(request.decision_reason), 500))}` : '';
    // said first, since Allow would let the command reach what the sandbox keeps from it
    const unsandboxed = isObject(request.input) && request.input.dangerouslyDisableSandbox === true ? 'Runs OUTSIDE Claude\'s sandbox. ' : '';
    const toolUseId = typeof request.tool_use_id === 'string' ? { toolUseId: request.tool_use_id } : {};
    const detail = permissionDetail(tool, request.input);
    // what is granted must be what is shown, so a cut one can only be denied (and grants nothing)
    if (detail.length > maxPermissionDetail) {
      openQuestion(requestId, { kind: 'permission', input: request.input, deniable: true, ...toolUseId }, { text: `${unsandboxed}${tool}${target === '' ? '' : ` ${target}`} asks for permission, but what it would run is too long to show here in full, so it can only be denied.${reason}`, detail: head(detail, maxPermissionDetail), field: { kind: 'choice', choices: ['Deny'] } });
      return;
    }
    const field: QuestionField = { kind: 'choice', choices: ['Allow', 'Deny'] };
    openQuestion(requestId, { kind: 'permission', input: request.input, ...toolUseId }, { text: `${unsandboxed}Allow ${tool}${target === '' ? '' : ` ${target}`}?${reason}`, detail, permission: true, field });
  };

  const finishTurn = (record: Json, cost: number | undefined) => {
    working = false;
    for (const [id, question] of [...questions]) dismiss(id, question, 'The Turn ended before the operator answered.');
    const aborted = cancelling && record.subtype === 'error_during_execution';
    const failed = record.is_error === true && !aborted;
    cancelling = false;
    // under the id its history gives it, when the Turn's prompt is known
    transcript({ id: turnPrompt !== undefined ? `${turnPrompt}:end` : typeof record.uuid === 'string' ? record.uuid : randomUUID(), kind: 'settled', outcome: outcome(aborted, failed), ...(cost === undefined ? {} : { cost }), toolCalls });
    usage();
    emit({ type: 'turn', turn: aborted ? { type: 'aborted' } : failed ? { type: 'failed' } : { type: 'settled', message: typeof record.result === 'string' ? record.result : answer } });
    void observeEffort();
    wake();
  };

  const handle = (line: string) => {
    let record: unknown;
    try { record = JSON.parse(line); } catch { return; }
    if (!isObject(record)) return;
    const main = record.parent_tool_use_id === null || record.parent_tool_use_id === undefined;
    switch (record.type) {
      case 'control_response': {
        const response = isObject(record.response) ? record.response : {};
        const resolve = typeof response.request_id === 'string' ? pending.get(response.request_id) : undefined;
        if (resolve === undefined) return;
        pending.delete(response.request_id as string);
        resolve(response.subtype === 'success' ? (isObject(response.response) ? response.response : {}) : undefined);
        return;
      }
      case 'control_request': {
        const request = isObject(record.request) ? record.request : undefined;
        if (typeof record.request_id !== 'string' || request === undefined) return;
        if (request.subtype === 'mcp_message') mcp(record.request_id, request);
        else if (request.subtype === 'can_use_tool') permission(record.request_id, request);
        else { unknown(`control_request/${String(request.subtype)}`); refuse(record.request_id, `The console does not handle ${String(request.subtype)} requests.`); }
        return;
      }
      // the CLI no longer waits on a request it asked (an interrupt withdraws a waiting permission)
      case 'control_cancel_request':
        if (typeof record.request_id === 'string') closeQuestion(record.request_id);
        return;
      case 'system':
        switch (record.subtype) {
          // the start of every Turn, the CLI's own included, and of a console command
          case 'init':
            if (typeof record.claude_code_version === 'string') version ??= record.claude_code_version;
            session(record.session_id);
            observeModel(record.model);
            if ((operation !== undefined && operation.kind !== 'model') || working === true) return;
            // a Turn the CLI started with no lifecycle line before it: with a steer, if one waits
            if (steers.length > 0) steerTaken(steers[0]!.id); else turnStarted();
            return;
          case 'hook_started':
            if (record.hook_event === 'SessionStart') session(record.session_id);
            return;
          case 'hook_response': {
            if (record.hook_event !== 'SessionStart') return;
            session(record.session_id);
            const nonce = claudeHookNonce(record.stdout);
            if (nonce !== undefined) { nonces.add(nonce); reportIn(); }
            return;
          }
          case 'session_title_changed':
            if (typeof record.title !== 'string' || sessionId === undefined) return;
            if (operation?.kind === 'rename') operation.seen = true;
            emit({ type: 'conversation', id: sessionId, name: record.title });
            return;
          case 'compact_boundary':
            if (operation?.kind === 'compact') operation.seen = true;
            for (const item of reader.items(record)) transcript(item);
            tokens = compaction(record).after;
            usage();
            return;
          default:
            unknown(`system/${String(record.subtype)}`);
            return;
        }
      case 'assistant': {
        const message = isObject(record.message) ? record.message : {};
        if (main) {
          if (!synthetic(message)) {
            tokens = contextTokens(message.usage) ?? tokens;
            const said = text(message.content);
            if (said !== '') answer = said;
          }
        }
        for (const item of reader.items(record)) {
          if (item.kind === 'tool' && item.state === 'running') toolCalls += 1;
          transcript(item);
        }
        return;
      }
      case 'user': {
        const message = isObject(record.message) ? record.message : {};
        // A prompt this client sent, echoed: shown when it was sent. A steer's echo comes when the
        // CLI folds it in. A local command's output is echoed too, and shown.
        if (record.isReplay === true && typeof message.content === 'string' && localOutput(message.content) === undefined) {
          if (working === true) steerTaken(record.uuid);
          return;
        }
        const results = main && Array.isArray(message.content) ? message.content.filter(block => isObject(block) && block.type === 'tool_result') as Json[] : [];
        // a call that ended waits on no question (one replayed after a reattach, say)
        for (const block of results) for (const [id, question] of [...questions]) if (question.toolUseId === block.tool_use_id) closeQuestion(id);
        // a model switch's own "Set model to" line repeats the console's notice
        for (const item of reader.items(record)) if (operation?.kind !== 'model' || item.kind !== 'notice') transcript(item);
        return;
      }
      // our prompts' lifecycle: a steer started was read (or starts a Turn of its own), and one
      // completed without starting was dropped
      case 'command_lifecycle': {
        if (record.state === 'started') {
          if (steers.some(steer => steer.id === record.command_uuid)) steerTaken(record.command_uuid);
          // a prompt this client did not send (an earlier console's, before a reattach) starting
          // a Turn: its id is the one the Turn's history goes under
          else if (working !== true && operation === undefined && typeof record.command_uuid === 'string') { turnStarted(); turnPrompt = record.command_uuid; }
        }
        // a steer the CLI ended without starting it was not read
        if (record.state === 'completed' || record.state === 'cancelled') {
          const at = steers.findIndex(steer => steer.id === record.command_uuid);
          if (at !== -1) unread(steers.splice(at, 1));
        }
        return;
      }
      // the new session `/clear` started (the id it gives is not the session's: that comes with
      // the SessionStart hook and the next `init`)
      case 'conversation_reset':
        if (operation?.kind === 'clear' && record.user_message_uuid === operation.id) operation.seen = true;
        return;
      case 'result': {
        // the Turn's own cost, else what the process's total grew by
        const before = total;
        if (typeof record.total_cost_usd === 'number') total = record.total_cost_usd;
        const cost = turnCost(record.model_usage_since_last_result) ?? (before === undefined || total === undefined ? undefined : total - before);
        // the window of the models this Turn used, else the session's
        window = contextWindow(record.model_usage_since_last_result) ?? window ?? contextWindow(record.modelUsage);
        // a console command ends no Turn
        if (operation !== undefined && operation.kind !== 'model') { operation.finish(record); usage(); return; }
        if (working === false) { usage(); return; }
        finishTurn(record, cost);
        return;
      }
      default:
        unknown(String(record.type));
    }
  };
  // after `handle` exists: `onLine` replays the lines that arrived before it, synchronously
  channel.onLine(line => {
    handle(line);
    // any line from the CLI is activity: the wait for leftover steers starts again from it
    awaitLeftovers();
  });
  channel.onClose(() => {
    clearTimeout(leftover);
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
    operation?.finish();
    for (const waiter of waiters.splice(0)) waiter(false);
    questions.clear();
    emit({ type: 'exited' });
  });

  // a slash command sent as a prompt between Turns; resolves once its `result` ends it
  const command = (kind: Operation['kind'], line: string, timeoutMs = controlTimeoutMs): Promise<{ result?: Json; seen: boolean }> => new Promise(resolve => {
    if (!idle()) { resolve({ seen: false }); return; }
    const timer = setTimeout(() => op.finish(), timeoutMs);
    const op: Operation = {
      kind, id: randomUUID(), seen: false,
      finish: result => { if (operation !== op) return; clearTimeout(timer); operation = undefined; resolve({ ...(result === undefined ? {} : { result }), seen: op.seen }); wake(); }
    };
    operation = op;
    userMessage(line, op.id);
  });
  // Reattached, the CLI answers a second `initialize` in full, its `session_state` included, and
  // after the holder's replay, so the Conversation is read then. A CLI that does not answer is taken as idle.
  const initialize = async () => {
    const response = await control({ subtype: 'initialize', sdkMcpServers: [claudeMcpServer] });
    if (response !== undefined) {
      if (typeof response.claude_code_version === 'string') version = response.claude_code_version;
      if (Array.isArray(response.models)) models = response.models.filter(isObject);
      reportIn();
    }
    if (working === undefined) {
      if (response === undefined || response.session_state === 'idle') { working = false; wake(); } else turnStarted();
    }
    if (attached !== undefined) void resync(false);
  };
  void initialize();

  const deliver = async (prompt: string) => {
    if (!idle()) return 'busy' as const;
    turnStarted();
    const id = randomUUID();
    turnPrompt = id;
    transcript({ id, kind: 'message', role: 'user', text: prompt });
    userMessage(prompt, id);
    return 'started' as const;
  };
  return {
    deliver,
    // `/clear` starts a new session in the same process: a `conversation_reset` for its prompt
    async newConversation() {
      return (await command('clear', '/clear')).seen;
    },
    async renameConversation(name) {
      return (await command('rename', `/rename ${name.replace(/\s+/gu, ' ').trim()}`)).seen;
    },
    // Claude never hosts the Conductor, so a compaction carries no console state
    async compact({ instructions }) {
      const { result, seen } = await command('compact', instructions === undefined || instructions.trim() === '' ? '/compact' : `/compact ${instructions.trim()}`, compactTimeoutMs);
      if (seen) return undefined;
      return typeof result?.result === 'string' && result.result !== '' ? result.result : 'The agent did not compact.';
    },
    async models() {
      return models?.flatMap(modelInfo) ?? (current === undefined ? [] : [{ id: current.model, name: current.model, provider: 'anthropic', efforts: [] }]);
    },
    // Only the model changes: the Effort stays the launch's, so a change of it alone is refused.
    // One asked for mid-Turn (the console holding a restored model to the Allowed ones) waits for its end.
    async setModel({ model, effort }) {
      if (model === current?.model && effort !== undefined && effort !== current.effort) return false;
      while (!idle()) if (!await nextIdle()) return false;
      const op: Operation = { kind: 'model', seen: false, finish: () => { if (operation !== op) return; operation = undefined; wake(); } };
      operation = op;
      const response = await control({ subtype: 'set_model', model });
      op.finish();
      if (response === undefined) return false;
      if (typeof response.model === 'string') resolved = response.model;
      current = { model, ...(current?.effort === undefined ? {} : { effort: current.effort }) };
      emit({ type: 'model', current });
      return true;
    },
    async steer(prompt) {
      if (working !== true) return await deliver(prompt) === 'started';
      const id = randomUUID();
      transcript({ id, kind: 'message', role: 'user', text: prompt, steer: true });
      steers.push({ id, text: prompt });
      showSteers();
      userMessage(prompt, id);
      return true;
    },
    // Nothing comes back: what the interrupt says it still had queued (`still_queued`, by uuid)
    // the CLI runs as a Turn of its own after it, so every steer stays pending until started.
    async cancel() {
      cancelling = true;
      const response = await control({ subtype: 'interrupt' });
      if (response === undefined || working === false) cancelling = false;
      return response === undefined ? undefined : [];
    },
    async answer(questionId, given, operator = false) {
      const question = questions.get(questionId);
      if (question === undefined) return false;
      if (question.kind === 'permission') {
        // text on the choice is a refusal in the answerer's own words; only the operator's is said to be theirs
        if (given === 0 && question.deniable !== true) reply(questionId, { behavior: 'allow', updatedInput: question.input });
        else if (given === (question.deniable === true ? 0 : 1)) reply(questionId, { behavior: 'deny', message: operator ? 'The operator denied this.' : 'This was denied.' });
        else if (typeof given === 'string') reply(questionId, { behavior: 'deny', message: `${operator ? 'The operator denied this and said' : 'This was denied, with the reply'}:\n\n${given}` });
        else if (typeof given === 'object') reply(questionId, { behavior: 'deny', message: operator ? 'The operator dismissed the permission request.' : 'The permission request was dismissed.' });
        else return false;
      } else {
        const chosen = typeof given === 'number' ? question.choices[given] : typeof given === 'string' ? given : undefined;
        if (typeof given === 'number' && chosen === undefined) return false;
        question.respond({ result: { content: [{ type: 'text', text: askUserReply(question.choices, chosen) }] } });
      }
      closeQuestion(questionId);
      return true;
    },
    close: () => channel.close()
  };
};
