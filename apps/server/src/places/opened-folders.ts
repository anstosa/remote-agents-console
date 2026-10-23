import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { gitCommonDir } from '../git/worktrees.js';
import { serverCheckout } from '../workspaces/server-checkout.js';

type OpenedFolder = { path: string; openedAt: number };
// a listed folder, `git` when it lies in a git checkout (an implicit Project, unless configured)
export type RecentFolder = OpenedFolder & { kind: 'git' | 'folder' };

const maxFolders = 50;
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !value.includes('\0');
const isEntry = (value: unknown): value is OpenedFolder => value !== null && typeof value === 'object' && validPath((value as OpenedFolder).path) && Number.isFinite((value as OpenedFolder).openedAt);

/**
 * A folder path from the browser, as the folder it names: a string of at most 4096 characters
 * with no NUL, a leading `~` expanded against the account home, absolute, realpath'd, and a
 * directory. Otherwise the reason it is refused.
 */
export async function resolveFolderPath(input: unknown): Promise<{ path: string } | { error: string }> {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096 || input.includes('\0')) return { error: 'That is not a valid path.' };
  const expanded = input === '~' || input.startsWith('~/') ? join(homedir(), input.slice(1)) : input;
  if (!isAbsolute(expanded)) return { error: 'The path must be absolute.' };
  const path = await realpath(expanded).catch(() => undefined);
  if (path === undefined) return { error: 'That folder does not exist.' };
  return (await stat(path).catch(() => undefined))?.isDirectory() === true ? { path } : { error: 'That is not a folder.' };
}

/**
 * The folders opened through Open folder, newest first, one entry per realpath and at most 50,
 * persisted in `.data`. Callers record a folder only once it has opened.
 */
export class OpenedFolderStore {
  private mutation = Promise.resolve();

  constructor(private readonly file = process.env.RAC_OPENED_FOLDERS_FILE ?? join(serverCheckout(), '.data/opened-folders.json')) {}

  // the folders that still exist, newest first; one since removed is left out but kept, so it
  // returns if its folder does
  async list(): Promise<RecentFolder[]> {
    await this.mutation;
    const listed = await Promise.all((await this.read()).map(async entry => {
      if (!(await stat(entry.path).catch(() => undefined))?.isDirectory()) return undefined;
      return { ...entry, kind: await gitCommonDir(entry.path) === undefined ? 'folder' as const : 'git' as const };
    }));
    return listed.filter(entry => entry !== undefined);
  }

  // move a realpath'd folder to the front
  async record(path: string, openedAt = Date.now()): Promise<void> {
    if (!validPath(path)) return;
    await this.mutate(stored => [{ path, openedAt }, ...stored.filter(entry => entry.path !== path)].slice(0, maxFolders));
  }

  async forget(path: string): Promise<void> {
    await this.mutate(stored => stored.filter(entry => entry.path !== path));
  }

  private async mutate(change: (stored: OpenedFolder[]) => OpenedFolder[]): Promise<void> {
    const operation = this.mutation.then(async () => await this.write(change(await this.read())));
    this.mutation = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private async read(): Promise<OpenedFolder[]> {
    let serialized: string;
    try {
      serialized = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const raw = JSON.parse(serialized) as unknown;
    if (!Array.isArray(raw) || raw.length > maxFolders || !raw.every(isEntry)) throw new Error('invalid opened folders file');
    return raw;
  }

  private async write(value: OpenedFolder[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
