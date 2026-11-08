import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// The browser's half of a pane stream's connection timeline (the `timing` frame). Client
// input: only these keys survive, numbers must be finite and non-negative, and the strings
// are enums, so nothing the browser invents reaches the file verbatim.
const markKeys = ['socket', 'open', 'viewport', 'firstFrame', 'seed', 'parsed', 'cover', 'painted'] as const;
const pageKeys = ['responseEnd', 'domContentLoaded', 'session', 'dashboard'] as const;
const enums = { attempt: ['initial', 'reconnect', 'revisit'], sharedSocket: ['open', 'connecting', 'new'], renderer: ['webgl', 'dom'], browser: ['firefox', 'chrome', 'safari', 'other'] } as const;
export const maxTimingFrameChars = 4_096;

export type ClientTiming = Record<string, unknown>;

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const times = (value: unknown, keys: readonly string[]): Record<string, number> | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter(key => isTime(source[key])).map(key => [key, source[key] as number]));
};

export function parsePaneTiming(frame: Record<string, unknown>): ClientTiming | undefined {
  const marks = times(frame.marks, markKeys);
  if (marks === undefined) return undefined;
  const timing: ClientTiming = { marks };
  for (const [key, allowed] of Object.entries(enums)) if ((allowed as readonly unknown[]).includes(frame[key])) timing[key] = frame[key];
  for (const key of ['sincePageLoad', 'seedBytes']) if (isTime(frame[key])) timing[key] = frame[key];
  if (typeof frame.mobile === 'boolean') timing.mobile = frame.mobile;
  const page = times(frame.page, pageKeys);
  if (page !== undefined) timing.page = page;
  return timing;
}

// Appends one JSON line per record, serialized so a rotation never races an append. Past
// `maxBytes` the file moves to `<file>.1` (replacing the previous one) first. A failed
// write is logged and dropped: timing must never break a pane stream.
export function paneTimingLog(file: string, maxBytes = 5 * 1024 * 1024): (record: unknown) => Promise<void> {
  let queue = Promise.resolve();
  return record => {
    queue = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const size = await stat(file).then(info => info.size, () => 0);
      if (size > maxBytes) await rename(file, `${file}.1`);
      await appendFile(file, `${JSON.stringify(record)}\n`);
    }).catch((error: unknown) => { console.warn(`[pane-timing] could not write ${file}:`, error); });
    return queue;
  };
}
