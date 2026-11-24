import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export type AgentUpdateDirectoryOptions = {
  jobs?: boolean;
  create?: boolean;
};

export class InvalidAgentUpdateArtifact extends Error {}

// validate one serialized device and inode identity without numeric rounding
export function validInstallerLockIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{1,20}:[0-9]{1,20}$/u.test(value);
}

// classify only one absent path as unavailable storage
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// create one component without following an existing entry
async function createDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => {
    // validate an existing entry through lstat below
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
}

// require one account-owned directory with the requested privacy
async function requireDirectory(path: string, ownerOnly: boolean, create: boolean): Promise<boolean> {
  // create only after the caller has validated the parent
  if (create) await createDirectory(path);
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    // preserve optional lookup semantics for an absent component
    if (!create && isMissing(error)) return false;
    throw error;
  }
  const owner = process.getuid?.();
  const exposed = ownerOnly ? (details.mode & 0o077) !== 0 : (details.mode & 0o022) !== 0;
  // reject links, foreign owners and unsafe permissions
  if (!details.isDirectory() || details.isSymbolicLink() || exposed || owner !== undefined && details.uid !== owner) {
    throw new Error('invalid private agent update directory');
  }
  return true;
}

// resolve the shared private update directory without recursive creation
export async function agentUpdateDirectory(checkout: string, options: AgentUpdateDirectoryOptions = {}): Promise<string | undefined> {
  const create = options.create ?? true;
  const data = join(checkout, '.data');
  // stop before creating descendants when the state root is absent or unsafe
  if (!await requireDirectory(data, false, create)) return undefined;
  const updates = join(data, 'agent-updates');
  // require owner-only shared update state
  if (!await requireDirectory(updates, true, create)) return undefined;
  // return the common update directory unless job state was requested
  if (options.jobs !== true) return updates;
  const jobs = join(updates, 'jobs');
  // require the same owner-only boundary for durable jobs
  if (!await requireDirectory(jobs, true, create)) return undefined;
  return jobs;
}

// reject one malformed or exposed final artifact
function requirePrivateArtifact(details: Stats, maximum: number, tail: boolean): void {
  const owner = process.getuid?.();
  const oversized = !tail && details.size > maximum;
  // require a bounded account-owned regular file
  if (!details.isFile() || details.isSymbolicLink() || oversized || (details.mode & 0o077) !== 0 || owner !== undefined && details.uid !== owner) {
    throw new InvalidAgentUpdateArtifact('invalid private agent update artifact');
  }
}

// read exactly one bounded regular-file range
async function readRange(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let read = 0;
  // tolerate short regular-file reads without widening the requested range
  while (read < length) {
    const result = await file.read(bytes, read, length - read, offset + read);
    // stop when a concurrently shortened file reaches eof
    if (result.bytesRead === 0) break;
    read += result.bytesRead;
  }
  return bytes.subarray(0, read);
}

// read one no-follow owner-private artifact without blocking on special files
export async function readPrivateAgentArtifact(path: string, maximum: number, tail = false): Promise<Buffer | undefined> {
  // reject invalid allocation bounds before inspecting shared state
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new RangeError('invalid private agent update artifact limit');
  let initial;
  try {
    initial = await lstat(path);
  } catch (error) {
    // an absent final artifact represents unfinished work
    if (isMissing(error)) return undefined;
    throw error;
  }
  requirePrivateArtifact(initial, maximum, tail);
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const details = await file.stat();
    requirePrivateArtifact(details, maximum, tail);
    // reject replacement between lstat and the no-follow open
    if (details.dev !== initial.dev || details.ino !== initial.ino) throw new InvalidAgentUpdateArtifact('replaced private agent update artifact');
    const length = Math.min(details.size, maximum);
    const offset = tail ? Math.max(0, details.size - length) : 0;
    return await readRange(file, offset, length);
  } catch (error) {
    // preserve optional lookup when the file disappears during inspection
    if (isMissing(error)) return undefined;
    // classify a final symlink as malformed shared state
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new InvalidAgentUpdateArtifact('invalid private agent update artifact');
    throw error;
  } finally {
    await file?.close();
  }
}
