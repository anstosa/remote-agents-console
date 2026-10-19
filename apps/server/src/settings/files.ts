import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { SettingsError } from './contracts.js';

// read one bounded regular file without following its final link
export async function readBounded(path: string, optional = false, privateFile = false, maximum = 1_048_576): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    // refuse devices and excessive documents
    if (!stat.isFile() || stat.size > maximum || privateFile && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new SettingsError('settings_source_unavailable', 503);
    const bytes = await file.readFile();
    // decode only valid bounded utf8
    if (bytes.length > maximum || bytes.includes(0)) throw new SettingsError('settings_source_unavailable', 503);
    const value = bytes.toString('utf8');
    // reject invalid byte sequences
    if (!Buffer.from(value, 'utf8').equals(bytes)) throw new SettingsError('settings_source_unavailable', 503);
    return value;
  } catch (error) {
    // preserve explicitly absent optional sources
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new SettingsError('settings_source_unavailable', 503);
  } finally { await file?.close(); }
}

// publish private metadata durably
export async function writePrivate(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
