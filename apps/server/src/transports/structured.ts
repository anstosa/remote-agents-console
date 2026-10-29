import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { QuestionField } from '../adapters/types.js';
import type { QuestionAnswer, TurnEvent } from './transport.js';

/**
 * The structured Transport (ADR 0015): the protocol-neutral interface a protocol client offers
 * for one running Agent process, and the events it reports. Nothing here is shaped by any one
 * protocol; Pi is the first client behind it.
 */

/** What the console-shipped extension reports once its Agent has started (ADR 0017). */
export type LaunchReport = { loaded: true; sandbox: { engaged: boolean; reason?: string }; version: string };
/**
 * A tool call as the transcript shows it: its verb (`name`) and target (`summary`), its state and
 * duration, and what it gave back: its output, a short `result` line, or an edit's unified `diff` with its file's path.
 * A call another call made (a script's) sits under `parentId`; `kept: false` marks one whose
 * result the Conversation did not keep. A script carries its `source`.
 */
export type TranscriptTool = { id: string; kind: 'tool'; name: string; summary: string; state: 'running' | 'done' | 'failed'; parentId?: string; durationMs?: number; output?: string; result?: string; diff?: { path: string; patch: string }; source?: string; kept?: false };
/**
 * One line of an Agent's transcript, replaced by a later item with the same id: a prompt (a steer
 * when sent mid-Turn, `queued` when it came from the queue), an answer, thinking (`live` while it
 * streams), a notice from the Agent's extension, a tool call, and the end of a Turn with its cost and tool calls.
 */
export type TranscriptItem =
  | { id: string; kind: 'message'; role: 'user' | 'assistant'; text: string; steer?: true; queued?: true }
  | { id: string; kind: 'thinking'; text: string; live?: true }
  | { id: string; kind: 'notice'; text: string; tone: 'info' | 'warning' | 'error' }
  | { id: string; kind: 'settled'; outcome: 'done' | 'cancelled' | 'failed'; cost?: number; toolCalls?: number }
  | TranscriptTool;
/** What an Agent has used of its Conversation: its cost so far and how full its context is. */
export type AgentUsage = { cost: number; contextPercent?: number };
/**
 * A model an Agent can run on: the kind's id for it, its display name and provider, its price per 1M
 * input and output tokens, its context window, and the Efforts it supports.
 */
export type ModelInfo = { id: string; name: string; provider: string; inputPrice?: number; outputPrice?: number; contextWindow?: number; efforts: string[] };
/** A model, by the kind's own id for it, and the Effort to run it at. */
export type ModelSetting = { model: string; effort?: string };
/**
 * A question the Agent asks the operator, open until it is answered or dismissed: its text, one
 * answer field, and when it lapses on its own (epoch ms).
 */
export type StructuredQuestion = { id: string; text: string; field: QuestionField; expiresAt?: number };
/**
 * What a protocol client reports: its launch report, a Turn's steps, its transcript and usage, the current
 * Conversation and model, the steers still pending (the whole list each time), questions opening and
 * closing, text the Agent offers for the operator's draft, and the process exiting.
 */
export type StructuredEvent =
  | { type: 'report'; report: LaunchReport }
  | { type: 'turn'; turn: TurnEvent }
  | { type: 'transcript'; item: TranscriptItem }
  // the Conversation's transcript as loaded from its history, replacing what was shown
  | { type: 'history'; items: TranscriptItem[] }
  // a status line the Agent's extension set, or cleared (no `text`)
  | { type: 'status'; key: string; text?: string }
  | { type: 'usage'; usage: AgentUsage }
  | { type: 'conversation'; id: string; name?: string }
  | { type: 'model'; current: ModelSetting }
  | { type: 'steers'; pending: string[] }
  | { type: 'question'; question: StructuredQuestion }
  | { type: 'question-closed'; id: string }
  | { type: 'draft'; text: string }
  | { type: 'exited' };
/**
 * What became of a delivered prompt: a Turn started, it was handled at once without one, the Agent
 * is `busy` (already working, for now), or it was refused outright.
 */
export type Delivery = 'started' | 'handled' | 'busy' | 'refused';
/**
 * A protocol client's connection to one Agent process; closing it leaves the process running.
 * The Conversation and model operations run between Turns; each answers false when the Agent
 * refused it. A Conversation change reports a `conversation` event, and the model it runs on a
 * `model` event: a switch restores that Conversation's own model, and a new one keeps the current.
 */
export interface StructuredConnection {
  /** Deliver a prompt as a Turn; an Agent already working answers `busy`. */
  deliver(prompt: string): Promise<Delivery>;
  newConversation(): Promise<boolean>;
  /** Switch to a Conversation by the reference its kind's store located. */
  switchConversation(reference: string): Promise<boolean>;
  renameConversation(name: string): Promise<boolean>;
  /** The models the Agent can reach now. */
  models(): Promise<ModelInfo[]>;
  setModel(setting: ModelSetting): Promise<boolean>;
  /** Redirect the working Agent with `prompt` (an idle one starts a Turn with it); false when refused. */
  steer(prompt: string): Promise<boolean>;
  /** Drop the pending steers and abort the Turn; the steers it dropped, or undefined when it could not. */
  cancel(): Promise<string[] | undefined>;
  /** Answer an open question by id, or dismiss it; false when it is no longer open. */
  answer(questionId: string, answer: QuestionAnswer): Promise<boolean>;
  close(): void;
}
/** A line-oriented connection to an Agent process; lines carry no terminator. */
export interface LineChannel {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}
/** A protocol client: it speaks one protocol over a channel and reports what it sees as events. */
export type ProtocolClient = (channel: LineChannel, emit: (event: StructuredEvent) => void) => StructuredConnection;

/**
 * Split a byte stream into lines on LF only, dropping a CR before it. JSON may carry U+2028 and
 * U+2029 unescaped, so a generic line reader that also splits on those would corrupt records.
 */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void } {
  let partial = '';
  return {
    push(chunk) {
      // only the new chunk can hold the next LF, so a long line is scanned once
      let end = chunk.indexOf('\n');
      if (end !== -1) end += partial.length;
      partial += chunk;
      while (end !== -1) {
        onLine(partial.slice(0, end).replace(/\r$/u, ''));
        partial = partial.slice(end + 1);
        end = partial.indexOf('\n');
      }
    }
  };
}

// the holder program beside this module: compiled JavaScript in a build, its TypeScript source
// (which Node runs directly) when the server runs from source
const holderEntry = (): string => {
  const compiled = fileURLToPath(new URL('./holder.js', import.meta.url));
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/u, '.ts');
};
/** The command running `argv` under the holder (ADR 0016), serving its stdio on `socket`. */
export const holderArgv = (socket: string, argv: readonly string[]): string[] => [process.execPath, holderEntry(), socket, '--', ...argv];

/**
 * The holder's answer to a connection, before any of its child's lines: the line it replays from,
 * and how many lines past the client's cursor it no longer had (the protocol client resyncs then).
 */
export type HolderHello = { holder: 1; pid: number; from: number; dropped: number };

/**
 * Connect to a holder's socket, retrying while the holder starts, having read `from` of its
 * child's lines already, and read its hello. Every later line is the child's, as the child wrote it.
 */
export async function connectHolder(path: string, { from = 0, attempts = 100, intervalMs = 100 } = {}): Promise<{ channel: LineChannel; hello: HolderHello } | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const socket = await new Promise<Socket | undefined>(resolve => {
      const candidate = connect(path);
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', () => resolve(undefined));
    });
    if (socket !== undefined) {
      const connected = await holderChannel(socket, from);
      if (connected !== undefined) return connected;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

// wrap a connected socket, resolving once its hello arrives
function holderChannel(socket: Socket, from: number): Promise<{ channel: LineChannel; hello: HolderHello } | undefined> {
  return new Promise(resolve => {
    const lineListeners: Array<(line: string) => void> = [];
    const closeListeners: Array<() => void> = [];
    const early: string[] = [];
    let hello: HolderHello | undefined;
    const channel: LineChannel = {
      send: line => { if (!socket.destroyed) socket.write(`${line}\n`); },
      onLine: listener => { lineListeners.push(listener); for (const line of early.splice(0)) listener(line); },
      onClose: listener => { closeListeners.push(listener); },
      close: () => { socket.end(); }
    };
    const lines = lineSplitter(line => {
      if (hello === undefined) {
        try { hello = JSON.parse(line) as HolderHello; } catch { socket.destroy(); return; }
        if (hello?.holder !== 1) { hello = undefined; socket.destroy(); return; }
        resolve({ channel, hello });
        return;
      }
      if (lineListeners.length === 0) early.push(line);
      for (const listener of lineListeners) listener(line);
    });
    socket.setEncoding('utf8');
    socket.write(`${JSON.stringify({ from })}\n`);
    socket.on('data', chunk => lines.push(chunk as unknown as string));
    socket.on('error', () => {});
    socket.on('close', () => {
      if (hello === undefined) resolve(undefined);
      for (const listener of closeListeners) listener();
    });
  });
}
