import { createHmac, randomBytes } from 'node:crypto';
import { access, open } from 'node:fs/promises';

const processCorrelationSalt = randomBytes(32);

// correlate exact process lifetimes within one server process without exposing host identity fields
export function recoveryProcessKey(kind: string, pid: number, startTime: string): string {
  return createHmac('sha256', processCorrelationSalt).update(`${kind}\0${pid}\0${startTime}`).digest('base64url').slice(0, 22);
}

// read one bounded proc record without trusting the reported file size
export async function readBoundedText(path: string, maxBytes = 64 * 1024): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    // tolerate short reads without exceeding the record budget
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      // stop at the file boundary
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // reject incomplete metadata rather than interpreting a truncated command
    if (offset > maxBytes) throw new Error('proc_record_too_large');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

// never mistake the container's private process namespace for the host
export async function containerized(readText: (path: string, maxBytes: number) => Promise<string> = readBoundedText): Promise<boolean> {
  // prefer explicit runtime markers to cgroup hints
  if ((await Promise.all(['/.dockerenv', '/run/.containerenv'].map(path => access(path).then(() => true, () => false)))).some(Boolean)) return true;
  const cgroup = await readText('/proc/1/cgroup', 64 * 1024).catch(() => '');
  return /(?:docker|containerd|kubepods|libpod)/u.test(cgroup);
}
