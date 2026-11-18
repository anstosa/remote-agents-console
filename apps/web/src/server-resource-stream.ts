import { isResourceSnapshot, type ResourceSnapshot } from '../../server/src/server-admin/resource-contracts.js';

export type ResourceRequest = (url: string, init?: RequestInit) => Promise<Response>;
const maxRecordLength = 512_000;

// consume framed samples without starting a new host collector each second
export async function readResourceStream(request: ResourceRequest, signal: AbortSignal, onSample: (snapshot: ResourceSnapshot) => void): Promise<void> {
  const connection = new AbortController();
  const decoder = new TextDecoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pending = '';
  let deadline = window.setTimeout(() => connection.abort(), 10_000);

  // release the network request as soon as the owning flyout closes
  const abort = () => connection.abort();
  // cancel pending reads even when the transport does not reject on abort
  const cancel = () => { void reader?.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    // honor cancellation that preceded listener registration
    if (signal.aborted) return;
    const response = await request('/api/server/resources/live', { cache: 'no-store', headers: { accept: 'application/x-ndjson' }, signal: connection.signal });
    // treat unavailable responses as local refresh failures
    if (!response.ok || response.body === null || connection.signal.aborted) throw new Error('Resource stream unavailable');
    reader = response.body.getReader();
    connection.signal.addEventListener('abort', cancel, { once: true });
    // close a reader acquired during a cancellation race
    if (connection.signal.aborted) cancel();
    // read only for this visible flyout's lifetime
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      // ignore replies from a closed flyout
      if (signal.aborted) return;
      // reconnect rather than showing stale data as current
      if (done || connection.signal.aborted) throw new Error('Resource stream ended');
      pending += decoder.decode(value, { stream: true });
      let boundary = pending.indexOf('\n');
      // handle split and batched records independently of network chunks
      while (boundary !== -1) {
        // reject oversized records before parsing
        if (boundary > maxRecordLength) throw new Error('Resource sample too large');
        const line = pending.slice(0, boundary).trim();
        pending = pending.slice(boundary + 1);
        // ignore empty framing lines
        if (line !== '') {
          const snapshot: unknown = JSON.parse(line);
          // reject malformed optional data before publishing it
          if (!isResourceSnapshot(snapshot)) throw new Error('Invalid resource sample');
          window.clearTimeout(deadline);
          deadline = window.setTimeout(() => connection.abort(), 5_000);
          onSample(snapshot);
        }
        boundary = pending.indexOf('\n');
      }
      // bound unfinished records as well as complete ones
      if (pending.length > maxRecordLength) throw new Error('Resource sample too large');
    }
  } finally {
    window.clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    connection.signal.removeEventListener('abort', cancel);
    connection.abort();
    // startup failures have no reader to release
    if (reader !== undefined) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
