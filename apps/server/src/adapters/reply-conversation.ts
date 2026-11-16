import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';

export type AuthoredReplyMessage = { id: string; role: 'user' | 'assistant'; text: string };
export type StableJsonlTail = { lines: string[]; generation: string; fileIdentity: string; truncated: boolean };

const maximumMessages = 12;
const maximumContextBytes = 32 * 1_024;
const maximumLatestAssistantLength = 20_000;

// compare one opened-file generation without following a replacement path
function sameGeneration(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

// read one complete bounded jsonl tail from a stable opened inode
export async function readStableJsonlTail(path: string, maximumBytes: number): Promise<StableJsonlTail | undefined> {
  const handle = await open(path, 'r').catch(() => undefined);
  // unreadable transcript paths cannot authorize context
  if (handle === undefined) return undefined;
  try {
    const before = await handle.stat({ bigint: true });
    // reject nonfiles and sizes unsafe to address with node offsets
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    const length = Math.min(Number(before.size), maximumBytes);
    const offset = Number(before.size) - length;
    const bytes = Buffer.allocUnsafe(length);
    let read = 0;
    // fill the exact stable tail rather than accepting a short read
    while (read < length) {
      const result = await handle.read(bytes, read, length - read, offset + read);
      // an unexpected eof means the file changed beneath the handle
      if (result.bytesRead === 0) return undefined;
      read += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    // any append, truncate or metadata replacement invalidates the snapshot
    if (!sameGeneration(before, after) || bytes.at(-1) !== 0x0a) return undefined;
    const truncated = offset > 0;
    let retained = bytes;
    // discard the first partial record of a bounded tail
    if (truncated) {
      const newline = bytes.indexOf(0x0a);
      // one oversized record leaves no complete evidence
      if (newline < 0) return undefined;
      retained = bytes.subarray(newline + 1);
    }
    let text: string;
    // invalid source bytes cannot silently become different authored prose
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(retained); } catch { return undefined; }
    const generation = createHash('sha256').update(JSON.stringify([
      before.dev.toString(), before.ino.toString(), before.size.toString(), before.mtimeNs.toString(), before.ctimeNs.toString()
    ])).digest('base64url');
    // expose inode identity separately so a native reader can classify inert appends
    const fileIdentity = `${before.dev}:${before.ino}`;
    return { lines: text.split('\n').filter(line => line !== ''), generation, fileIdentity, truncated };
  } finally {
    await handle.close();
  }
}

// retain the newest complete authored context within shared count and byte bounds
export function boundedReplyMessages(input: readonly AuthoredReplyMessage[]): AuthoredReplyMessage[] | undefined {
  const seen = new Set<string>();
  const valid: AuthoredReplyMessage[] = [];
  // validate ids and normalize no conversation content
  for (const message of input) {
    // duplicate or malformed records make ordering ambiguous
    if (message.id === '' || seen.has(message.id) || message.text.trim() === '' || /[\u0000]/u.test(message.text)) return undefined;
    seen.add(message.id);
    valid.push(message);
  }
  const latest = valid.at(-1);
  // suggestions require one complete bounded assistant question
  if (latest?.role !== 'assistant' || latest.text.length > maximumLatestAssistantLength) return undefined;
  const retained = valid.slice(-maximumMessages);
  let bytes = retained.reduce((total, message) => total + Buffer.byteLength(message.text, 'utf8'), 0);
  // drop only oldest messages until the shared context bound holds
  while (retained.length > 1 && bytes > maximumContextBytes) {
    const removed = retained.shift()!;
    bytes -= Buffer.byteLength(removed.text, 'utf8');
  }
  // the latest message is never truncated to force it under the bound
  return bytes <= maximumContextBytes ? retained : undefined;
}
