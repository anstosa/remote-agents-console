import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { FileChangeCache } from './file-change-cache.js';
import type { ConversationSummary } from './types.js';

/**
 * Pi's Conversation store for the Pi Adapter: the session files Pi keeps per working directory
 * under its agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`), as
 * `sessions/--<cwd with separators as dashes>--/<timestamp>_<session id>.jsonl`. A session's name
 * is its latest `session_info` entry, whoever set it: the console, or a Pi TUI started by hand;
 * it was last active at its latest entry.
 */

// Pi's own session id rule (`assertValidSessionId`), bounded; never shell-active nor flag-like
const sessionId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const sessionFile = /^[^_]+_(.+)\.jsonl$/u;
const maxListedSessions = 200;
const maxNameLength = 120;

export const validPiSessionId = (id: string): boolean => sessionId.test(id);

function piAgentDir(env: NodeJS.ProcessEnv): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured === undefined || configured === '') return join(homedir(), '.pi', 'agent');
  return configured === '~' ? homedir() : configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
}
// the directory Pi keeps a working directory's sessions in, encoded as Pi encodes it
const sessionDirectory = (cwd: string, env: NodeJS.ProcessEnv): string =>
  join(piAgentDir(env), 'sessions', `--${resolve(cwd).replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`);

// an entry's own timestamp, which Pi writes near the start of its line
const entryTimestamp = /^.{0,400}?"timestamp":"([^"]+)"/u;

// a session file's id (from its header), latest name and latest entry time; undefined when it is
// not a session
const sessionScan = new FileChangeCache(async (path: string): Promise<{ id: string; name?: string; lastActiveAt: number } | undefined> => {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let id: string | undefined;
  let name: string | undefined;
  let lastActiveAt = 0;
  for await (const line of lines) {
    const at = Date.parse(entryTimestamp.exec(line)?.[1] ?? '');
    if (at > lastActiveAt) lastActiveAt = at;
    if (id === undefined) {
      const header = parse(line) as { type?: unknown; id?: unknown } | undefined;
      if (header?.type !== 'session' || typeof header.id !== 'string') break;
      id = header.id;
      continue;
    }
    // only the rare `session_info` line is worth parsing
    if (!line.includes('"session_info"')) continue;
    const entry = parse(line) as { type?: unknown; name?: unknown } | undefined;
    if (entry?.type === 'session_info') name = typeof entry.name === 'string' ? compactName(entry.name) : undefined;
  }
  lines.close();
  return id === undefined ? undefined : { id, ...(name === undefined ? {} : { name }), lastActiveAt };
}, { maxEntries: 512 });

function parse(line: string): unknown {
  try { return JSON.parse(line); } catch { return undefined; }
}
function compactName(text: string): string | undefined {
  const name = text.replace(/\s+/gu, ' ').trim();
  return name === '' ? undefined : name.length > maxNameLength ? `${name.slice(0, maxNameLength - 1)}…` : name;
}

// the session files of one working directory, newest first
async function sessionFiles(cwd: string, env: NodeJS.ProcessEnv): Promise<Array<{ id: string; path: string; mtimeMs: number }>> {
  // Pi names the directory after its physical working directory
  const directory = sessionDirectory(await realpath(cwd).catch(() => cwd), env);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: Array<{ id: string; path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const id = entry.isFile() ? sessionFile.exec(entry.name)?.[1] : undefined;
    if (id === undefined || !validPiSessionId(id)) continue;
    const path = join(directory, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && info.size > 0) files.push({ id, path, mtimeMs: info.mtimeMs });
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/** The Named Pi Conversations started in each directory, newest first across all of them. */
export async function piConversationSummaries(directories: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<ConversationSummary[]> {
  const summaries: ConversationSummary[] = [];
  for (const directory of directories) {
    for (const file of (await sessionFiles(directory, env)).slice(0, maxListedSessions)) {
      const scanned = await sessionScan.get(file.path).catch(() => undefined);
      if (scanned?.id === file.id && scanned.name !== undefined) summaries.push({ id: file.id, name: scanned.name, lastActiveAt: scanned.lastActiveAt || file.mtimeMs, directory });
    }
  }
  return summaries.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

/** The session file of a Conversation started in `cwd`: what Pi resumes and switches to. */
export async function locatePiSession(id: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!validPiSessionId(id)) return undefined;
  return (await sessionFiles(cwd, env)).find(file => file.id === id)?.path;
}

/** A Conversation's current name, read from its session file; undefined without a `cwd`. */
export async function piConversationName(id: string, cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const path = cwd === undefined ? undefined : await locatePiSession(id, cwd, env);
  return path === undefined ? undefined : (await sessionScan.get(path).catch(() => undefined))?.name;
}
