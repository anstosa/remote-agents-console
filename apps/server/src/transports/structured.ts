import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { TurnEvent } from './transport.js';

/**
 * The structured Transport (ADR 0015): the protocol-neutral interface a protocol client offers
 * for one running Agent process, and the events it reports. Nothing here is shaped by any one
 * protocol; Pi is the first client behind it.
 */

/** What the console-shipped extension reports once its Agent has started (ADR 0017). */
export type LaunchReport = { loaded: true; sandbox: { engaged: boolean; reason?: string }; version: string };
/**
 * One line of an Agent's transcript, replaced by a later item with the same id: a message, or a
 * tool call (nested under `parentId` when another call made it) as it runs and once it ends.
 */
export type TranscriptItem =
  | { id: string; kind: 'message'; role: 'user' | 'assistant'; text: string }
  | { id: string; kind: 'tool'; name: string; summary: string; state: 'running' | 'done' | 'failed'; parentId?: string };
export type StructuredEvent =
  | { type: 'report'; report: LaunchReport }
  | { type: 'turn'; turn: TurnEvent }
  | { type: 'transcript'; item: TranscriptItem }
  | { type: 'conversation'; id: string }
  | { type: 'exited' };
/** What became of a delivered prompt: a Turn started, it was handled at once without one, or it was refused. */
export type Delivery = 'started' | 'handled' | 'refused';
/** One Agent process as its protocol client drives it. */
export interface StructuredSession {
  deliver(prompt: string): Promise<Delivery>;
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
export type ProtocolClient = (channel: LineChannel, emit: (event: StructuredEvent) => void) => StructuredSession;

/**
 * Split a byte stream into lines on LF only, dropping a CR before it. JSON may carry U+2028 and
 * U+2029 unescaped, so a generic line reader that also splits on those would corrupt records.
 */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; rest(): string } {
  let partial = '';
  return {
    push(chunk) {
      partial += chunk;
      let end = partial.indexOf('\n');
      while (end !== -1) {
        onLine(partial.slice(0, end).replace(/\r$/u, ''));
        partial = partial.slice(end + 1);
        end = partial.indexOf('\n');
      }
    },
    rest: () => partial
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

/** The first line a holder sends on every connection, before any of its child's lines. */
export type HolderHello = { holder: 1; pid: number; dropped: number };

/**
 * Connect to a holder's socket, retrying while the holder starts, and read its hello. Every later
 * line is the child's, passed through as the child wrote it.
 */
export async function connectHolder(path: string, { attempts = 100, intervalMs = 100 } = {}): Promise<{ channel: LineChannel; hello: HolderHello } | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const socket = await new Promise<Socket | undefined>(resolve => {
      const candidate = connect(path);
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', () => resolve(undefined));
    });
    if (socket !== undefined) {
      const connected = await holderChannel(socket);
      if (connected !== undefined) return connected;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

// wrap a connected socket, resolving once its hello arrives
function holderChannel(socket: Socket): Promise<{ channel: LineChannel; hello: HolderHello } | undefined> {
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
        if (hello.holder !== 1) { socket.destroy(); return; }
        resolve({ channel, hello });
        return;
      }
      if (lineListeners.length === 0) early.push(line);
      for (const listener of lineListeners) listener(line);
    });
    socket.setEncoding('utf8');
    socket.on('data', chunk => lines.push(chunk as unknown as string));
    socket.on('error', () => {});
    socket.on('close', () => {
      if (hello === undefined) resolve(undefined);
      for (const listener of closeListeners) listener();
    });
  });
}
