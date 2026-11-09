import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// Appends one JSON line per record, serialized so a rotation never races an append. Past
// `maxBytes` the file moves to `<file>.1` (replacing the previous one) first. A failed
// write is logged and dropped: a diagnostic log must never break what it records.
export function jsonlLog(file: string, maxBytes = 5 * 1024 * 1024): (record: unknown) => Promise<void> {
  let queue = Promise.resolve();
  return record => {
    queue = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const size = await stat(file).then(info => info.size, () => 0);
      if (size > maxBytes) await rename(file, `${file}.1`);
      await appendFile(file, `${JSON.stringify(record)}\n`);
    }).catch((error: unknown) => { console.warn(`[jsonl-log] could not write ${file}:`, error); });
    return queue;
  };
}
