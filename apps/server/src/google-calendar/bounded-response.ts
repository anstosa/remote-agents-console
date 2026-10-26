import { GoogleCalendarError } from './provider-types.js';

// parse one bounded provider object without reflecting its body
export async function readGoogleObject(response: Response, maximum: number): Promise<Record<string, any>> {
  const text = await boundedText(response, maximum);
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  } catch { return {}; }
}

// stream one response only through the caller's byte limit
async function boundedText(response: Response, maximum: number): Promise<string> {
  // preserve an absent response body as an empty document
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    // consume only bounded chunks
    while (true) {
      const part = await reader.read();
      // stop at the exact end of the stream
      if (part.done) break;
      bytes += part.value.byteLength;
      // cancel before retaining an oversized provider body
      if (bytes > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new GoogleCalendarError('google_unavailable', 503);
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}
