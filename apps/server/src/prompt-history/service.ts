import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type PromptHistoryEntry = { id: string; text: string; createdAt: string; answer?: string; answeredAt?: string };
type StoredHistory = Record<string, PromptHistoryEntry[]>;

const maxScopes = 500;
const maxEntriesPerScope = 2_000;
const listedEntriesPerScope = 50;
const maxTotalTextLength = 10_000_000;
const validScope = (value: string) => value.length > 0 && value.length <= 4096 && !value.includes("\0");
const validText = (value: string) => value.trim().length > 0 && value.length <= 64_000 && !value.includes('\0');
// validate persisted history entries
const validEntry = (value: unknown): value is PromptHistoryEntry => {
  // require the base prompt fields
  if (value === null || typeof value !== 'object') return false;
  const entry = value as { id?: unknown; text?: unknown; createdAt?: unknown; answer?: unknown; answeredAt?: unknown };
  const validAnswer = entry.answer === undefined && entry.answeredAt === undefined
    || typeof entry.answer === 'string'
      && validText(entry.answer)
      && typeof entry.answeredAt === 'string'
      && Number.isFinite(Date.parse(entry.answeredAt));
  return typeof entry.id === 'string'
    && /^[A-Za-z0-9_-]{12,64}$/u.test(entry.id)
    && typeof entry.text === 'string'
    && validText(entry.text)
    && typeof entry.createdAt === 'string'
    && Number.isFinite(Date.parse(entry.createdAt))
    && validAnswer;
};
// count all persisted history text
const totalTextLength = (stored: StoredHistory) => Object.values(stored).flat().reduce((total, entry) => total + entry.text.length + (entry.answer?.length ?? 0), 0);

export class PromptHistoryService {
  private mutation = Promise.resolve();

  constructor(private readonly file = process.env.RAC_PROMPT_HISTORY_FILE ?? '.data/prompt-history.json') {}

  async list(scope: string): Promise<PromptHistoryEntry[] | undefined> {
    if (!validScope(scope)) return undefined;
    await this.mutation;
    return ((await this.read())[scope] ?? []).slice(0, listedEntriesPerScope);
  }

  async record(scope: string, text: string): Promise<PromptHistoryEntry | undefined> {
    if (!validScope(scope) || !validText(text)) return undefined;
    return await this.mutate(stored => {
      if (stored[scope] === undefined && Object.keys(stored).length >= maxScopes) {
        const oldestScope = Object.entries(stored).sort(([, left], [, right]) => Date.parse(left.at(-1)?.createdAt ?? '') - Date.parse(right.at(-1)?.createdAt ?? ''))[0]?.[0];
        if (oldestScope !== undefined) delete stored[oldestScope];
      }
      const entry = { id: randomBytes(18).toString('base64url'), text, createdAt: new Date().toISOString() };
      stored[scope] = [entry, ...(stored[scope] ?? [])].slice(0, maxEntriesPerScope);
      while (totalTextLength(stored) > maxTotalTextLength) {
        const oldest = Object.entries(stored).sort(([, left], [, right]) => Date.parse(left.at(-1)?.createdAt ?? '') - Date.parse(right.at(-1)?.createdAt ?? ''))[0];
        if (oldest === undefined) break;
        oldest[1].pop();
        if (oldest[1].length === 0) delete stored[oldest[0]];
      }
      return entry;
    });
  }

  // attach the completed assistant answer
  async recordAnswer(scope: string, entryId: string, answer: string): Promise<PromptHistoryEntry | undefined> {
    // reject invalid updates
    if (!validScope(scope) || !/^[A-Za-z0-9_-]{12,64}$/u.test(entryId) || !validText(answer)) return undefined;
    return await this.mutate(stored => {
      const entries = stored[scope];
      const index = entries?.findIndex(entry => entry.id === entryId) ?? -1;
      // require the original prompt
      if (entries === undefined || index < 0) return undefined;
      const completed = { ...entries[index]!, answer, answeredAt: new Date().toISOString() };
      entries[index] = completed;
      // enforce the shared storage budget
      while (totalTextLength(stored) > maxTotalTextLength) {
        const oldest = Object.entries(stored).sort(([, left], [, right]) => Date.parse(left.at(-1)?.createdAt ?? '') - Date.parse(right.at(-1)?.createdAt ?? ''))[0];
        // stop after exhausting history
        if (oldest === undefined) break;
        oldest[1].pop();
        // remove empty scopes
        if (oldest[1].length === 0) delete stored[oldest[0]];
      }
      return completed;
    });
  }

  // hand one scope's history to another, behind its newer entries
  async moveScope(from: string, to: string): Promise<void> {
    if (!validScope(from) || !validScope(to) || from === to) return;
    await this.mutate(stored => {
      const moving = stored[from];
      if (moving === undefined) return;
      stored[to] = [...stored[to] ?? [], ...moving].slice(0, maxEntriesPerScope);
      delete stored[from];
    });
  }

  async scopes(): Promise<string[]> {
    await this.mutation;
    return Object.keys(await this.read());
  }

  // drop every recorded prompt for one scope — a departed Agent's history goes with it
  async clearScope(scope: string): Promise<void> {
    if (!validScope(scope)) return;
    await this.mutate(stored => { delete stored[scope]; });
  }

  private async mutate<T>(change: (stored: StoredHistory) => T | Promise<T>): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      const result = await change(stored);
      await this.write(stored);
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private async read(): Promise<StoredHistory> {
    let serialized: string;
    try { serialized = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const raw = JSON.parse(serialized) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid prompt history file');
    const stored: StoredHistory = {};
    for (const [scope, entries] of Object.entries(raw)) {
      if (!validScope(scope) || !Array.isArray(entries) || entries.length > maxEntriesPerScope || entries.some(entry => !validEntry(entry))) throw new Error('invalid prompt history file');
      stored[scope] = entries;
    }
    if (Object.keys(stored).length > maxScopes || totalTextLength(stored) > maxTotalTextLength) throw new Error('prompt history file exceeds storage limits');
    return stored;
  }

  private async write(value: StoredHistory): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
