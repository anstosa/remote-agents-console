import type { LaunchReport, ProtocolClient, TranscriptItem } from './structured.js';

/**
 * The Pi protocol client (ADR 0017): a thin client over `pi --mode rpc` JSON lines. It speaks
 * only the pinned version and ignores records and fields it does not know.
 */

/** The status key the RAC Pi extension sends its launch report under. */
export const piReportStatusKey = 'rac-launch';

type Record = { [key: string]: unknown };
const isRecord = (value: unknown): value is Record => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('') : '';
// a tool call's one-line target: its first string argument, on one line and bounded
const summary = (args: unknown): string => {
  const first = isRecord(args) ? Object.values(args).find((value): value is string => typeof value === 'string') : undefined;
  const line = (first ?? '').replace(/\s+/gu, ' ').trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};
const parseReport = (statusText: unknown): LaunchReport | undefined => {
  if (typeof statusText !== 'string') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(statusText); } catch { return undefined; }
  if (!isRecord(parsed) || parsed.loaded !== true || typeof parsed.version !== 'string' || !isRecord(parsed.sandbox) || typeof parsed.sandbox.engaged !== 'boolean') return undefined;
  const reason = typeof parsed.sandbox.reason === 'string' ? parsed.sandbox.reason : undefined;
  return { loaded: true, sandbox: { engaged: parsed.sandbox.engaged, ...(reason === undefined ? {} : { reason }) }, version: parsed.version };
};

export const piClient: ProtocolClient = (channel, emit) => {
  const pending = new Map<string, (response: Record) => void>();
  let requests = 0;
  let messages = 0;
  let reported = false;
  // a Turn runs from the first `agent_start` to `agent_settled`: retries and compaction count as working
  let working = false;
  let answer = '';
  let errored = false;
  // a call's summary, read from its arguments at its start (its end carries none)
  const toolSummaries = new Map<string, string>();
  const request = (command: Record): Promise<Record> => new Promise(resolve => {
    const id = `rac-${requests += 1}`;
    pending.set(id, resolve);
    channel.send(JSON.stringify({ ...command, id }));
  });
  const transcript = (item: TranscriptItem) => emit({ type: 'transcript', item });

  channel.onLine(line => {
    let record: unknown;
    try { record = JSON.parse(line); } catch { return; }
    if (!isRecord(record)) return;
    switch (record.type) {
      case 'response': {
        const id = typeof record.id === 'string' ? record.id : undefined;
        const resolve = id === undefined ? undefined : pending.get(id);
        if (resolve !== undefined) { pending.delete(id!); resolve(record); }
        return;
      }
      case 'extension_ui_request': {
        if (reported || record.method !== 'setStatus' || record.statusKey !== piReportStatusKey) return;
        const report = parseReport(record.statusText);
        if (report === undefined) return;
        reported = true;
        emit({ type: 'report', report });
        void request({ type: 'get_state' }).then(response => {
          const id = isRecord(response.data) ? response.data.sessionId : undefined;
          if (typeof id === 'string' && id !== '') emit({ type: 'conversation', id });
        });
        return;
      }
      case 'agent_start':
        if (working) return;
        working = true; answer = ''; errored = false;
        emit({ type: 'turn', turn: { type: 'started' } });
        return;
      case 'message_end': {
        const message = isRecord(record.message) ? record.message : undefined;
        if (message?.role === 'user') transcript({ id: `m${messages += 1}`, kind: 'message', role: 'user', text: text(message.content) });
        if (message?.role !== 'assistant') return;
        errored = message.stopReason === 'error';
        const said = text(message.content);
        const shown = said !== '' ? said : errored && typeof message.errorMessage === 'string' ? `Error: ${message.errorMessage}` : '';
        if (said !== '') answer = said;
        if (shown !== '') transcript({ id: `m${messages += 1}`, kind: 'message', role: 'assistant', text: shown });
        return;
      }
      case 'tool_execution_start':
      case 'tool_execution_end': {
        if (typeof record.toolCallId !== 'string' || typeof record.toolName !== 'string') return;
        const started = record.type === 'tool_execution_start';
        if (started) toolSummaries.set(record.toolCallId, summary(record.args));
        const shown = toolSummaries.get(record.toolCallId) ?? '';
        if (!started) toolSummaries.delete(record.toolCallId);
        transcript({ id: record.toolCallId, kind: 'tool', name: record.toolName, summary: shown, state: started ? 'running' : record.isError === true ? 'failed' : 'done' });
        return;
      }
      case 'agent_settled':
        if (!working) return;
        working = false;
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
      return isRecord(response.data) && response.data.disposition === 'handled' ? 'handled' : 'started';
    },
    close: () => channel.close()
  };
};
