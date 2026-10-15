import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ResetBoundaryStore } from './reset-boundaries.js';
import { maxStoredAttachmentFootprintBytes, promptAttachmentBytes, promptAttachmentsStorageFootprint, validPrompt, type PromptAttachment } from './validation.js';

// where the queuing Agent ran, so its prompts can still become Notes after it is gone
export type QueuedPromptOrigin = { home: string; placeId?: string };
export type QueuedPrompt = { id: string; text: string; createdAt: string; attachments?: PromptAttachment[]; origin?: QueuedPromptOrigin };
export type QueuedPromptSummary = { id: string; text: string; createdAt: string; attachments?: Array<{ name: string; size: number }> };
type StoredQueues = Record<string, QueuedPrompt[]>;

const maxScopes = 500;
const maxPromptsPerScope = 50;
const maxStoredTextLength = 10_000_000;
const maxStoredAttachmentBytes = 100 * 1024 * 1024;
const validScope = (value: string) => value.length > 0 && value.length <= 4096 && !value.includes('\0');
const validId = (value: string) => /^[A-Za-z0-9_-]{12,64}$/u.test(value);
const validOrigin = (value: unknown): value is QueuedPromptOrigin => {
  if (value === null || typeof value !== 'object') return false;
  const origin = value as { home?: unknown; placeId?: unknown };
  return typeof origin.home === 'string' && validScope(origin.home) && (origin.placeId === undefined || typeof origin.placeId === 'string' && validScope(origin.placeId));
};
const parsePrompt = (value: unknown): QueuedPrompt | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const prompt = value as { id?: unknown; text?: unknown; createdAt?: unknown; attachments?: unknown; origin?: unknown };
  if (typeof prompt.id !== 'string' || !validId(prompt.id) || typeof prompt.text !== 'string' || typeof prompt.createdAt !== 'string' || !Number.isFinite(Date.parse(prompt.createdAt))) return undefined;
  const rawAttachments = prompt.attachments ?? [];
  if (!Array.isArray(rawAttachments)) return undefined;
  const attachments = rawAttachments.filter((attachment): attachment is PromptAttachment => attachment !== null && typeof attachment === 'object' && typeof (attachment as { name?: unknown }).name === 'string' && typeof (attachment as { data?: unknown }).data === 'string');
  if (attachments.length !== rawAttachments.length || !validPrompt(prompt.text, attachments) || prompt.origin !== undefined && !validOrigin(prompt.origin)) return undefined;
  return { id: prompt.id, text: prompt.text, createdAt: prompt.createdAt, ...(attachments.length === 0 ? {} : { attachments }), ...(prompt.origin === undefined ? {} : { origin: { home: prompt.origin.home, ...(prompt.origin.placeId === undefined ? {} : { placeId: prompt.origin.placeId }) } }) };
};
const summarize = (prompt: QueuedPrompt): QueuedPromptSummary => ({ id: prompt.id, text: prompt.text, createdAt: prompt.createdAt, ...(prompt.attachments === undefined ? {} : { attachments: prompt.attachments.map(attachment => ({ name: attachment.name, size: promptAttachmentBytes(attachment)! })) }) });
// sum every durable queue budget across all scopes
const totals = (stored: StoredQueues) => Object.values(stored).flat().reduce((value, prompt) => ({ text: value.text + prompt.text.length, attachments: value.attachments + (prompt.attachments ?? []).reduce((sum, attachment) => sum + (promptAttachmentBytes(attachment) ?? 0), 0), attachmentFootprint: value.attachmentFootprint + promptAttachmentsStorageFootprint(prompt.attachments ?? []) }), { text: 0, attachments: 0, attachmentFootprint: 0 });

export class QueuedPromptService {
  private mutation = Promise.resolve();
  private stored?: StoredQueues;
  readonly resets: ResetBoundaryStore;

  // bind prompt storage, its serialized attachment budget and reset storage
  constructor(private readonly file = process.env.RAC_QUEUED_PROMPTS_FILE ?? '.data/queued-prompts.json', private readonly attachmentFootprintLimit = maxStoredAttachmentFootprintBytes) {
    this.resets = new ResetBoundaryStore(`${file}.resets.json`);
  }

  async list(scope: string): Promise<QueuedPromptSummary[] | undefined> {
    if (!validScope(scope)) return undefined;
    await this.mutation;
    return ((await this.read())[scope] ?? []).map(summarize);
  }

  // validate complete prompt content once before queue persistence
  async enqueue(scope: string, text: string, attachments: PromptAttachment[] = [], origin?: QueuedPromptOrigin): Promise<QueuedPromptSummary | undefined> {
    // prompt validation includes every attachment safeguard
    if (!validScope(scope) || !validPrompt(text, attachments) || origin !== undefined && !validOrigin(origin)) return undefined;
    return await this.mutate(stored => {
      if (stored[scope] === undefined && Object.keys(stored).length >= maxScopes) return undefined;
      const queue = stored[scope] ?? [];
      if (queue.length >= maxPromptsPerScope) return undefined;
      const prompt: QueuedPrompt = { id: randomBytes(18).toString('base64url'), text, createdAt: new Date().toISOString(), ...(attachments.length === 0 ? {} : { attachments }), ...(origin === undefined ? {} : { origin }) };
      queue.push(prompt);
      stored[scope] = queue;
      const size = totals(stored);
      // roll back any aggregate decoded or serialized storage overflow
      if (size.text > maxStoredTextLength || size.attachments > maxStoredAttachmentBytes || size.attachmentFootprint > this.attachmentFootprintLimit) {
        queue.pop();
        if (queue.length === 0) delete stored[scope];
        return undefined;
      }
      return summarize(prompt);
    });
  }

  async update(scope: string, id: string, text: string): Promise<QueuedPromptSummary | undefined> {
    if (!validScope(scope) || !validId(id) || typeof text !== 'string') return undefined;
    return await this.mutate(stored => {
      const prompt = stored[scope]?.find(candidate => candidate.id === id);
      if (prompt === undefined || !validPrompt(text, prompt.attachments ?? [])) return undefined;
      const previous = prompt.text;
      prompt.text = text;
      if (totals(stored).text > maxStoredTextLength) {
        prompt.text = previous;
        return undefined;
      }
      return summarize(prompt);
    });
  }

  async move(scope: string, id: string, direction: 'earlier' | 'later'): Promise<QueuedPromptSummary[] | undefined> {
    if (!validScope(scope) || !validId(id)) return undefined;
    return await this.mutate(stored => {
      const queue = stored[scope];
      if (queue === undefined) return undefined;
      const index = queue.findIndex(prompt => prompt.id === id);
      if (index < 0) return undefined;
      const next = direction === 'earlier' ? index - 1 : index + 1;
      if (next < 0 || next >= queue.length) return queue.map(summarize);
      [queue[index], queue[next]] = [queue[next]!, queue[index]!];
      return queue.map(summarize);
    });
  }

  async remove(scope: string, id: string): Promise<QueuedPrompt | undefined> {
    if (!validScope(scope) || !validId(id)) return undefined;
    return await this.mutate(stored => {
      const queue = stored[scope];
      if (queue === undefined) return undefined;
      const index = queue.findIndex(prompt => prompt.id === id);
      if (index < 0) return undefined;
      const [prompt] = queue.splice(index, 1);
      if (queue.length === 0) delete stored[scope];
      return prompt;
    });
  }

  async consumeOnSuccess(scope: string, id: string, use: (prompt: QueuedPrompt) => Promise<boolean>): Promise<'missing' | 'failed' | 'consumed'> {
    if (!validScope(scope) || !validId(id)) return 'missing';
    return await this.mutate(async stored => {
      const queue = stored[scope];
      const index = queue?.findIndex(prompt => prompt.id === id) ?? -1;
      if (queue === undefined || index < 0) return 'missing';
      if (!await use(queue[index]!)) return 'failed';
      queue.splice(index, 1);
      if (queue.length === 0) delete stored[scope];
      return 'consumed';
    }, result => result === 'consumed');
  }

  // hand one scope's prompts to another, ahead of any already waiting there; refuses rather
  // than drop prompts past the per-scope cap
  async moveScope(from: string, to: string): Promise<boolean> {
    if (!validScope(from) || !validScope(to) || from === to) return false;
    return await this.mutate(stored => {
      const moving = stored[from];
      if (moving === undefined) return true;
      const merged = [...moving, ...stored[to] ?? []];
      if (merged.length > maxPromptsPerScope) return false;
      stored[to] = merged;
      delete stored[from];
      return true;
    });
  }

  async scopes(): Promise<string[]> {
    await this.mutation;
    return Object.keys(await this.read());
  }

  async next(scope: string): Promise<QueuedPrompt | undefined> {
    if (!validScope(scope)) return undefined;
    await this.mutation;
    return (await this.read())[scope]?.[0];
  }

  // drop every queued prompt for one scope — Remove deletes the Worktree's queue outright
  async clearScope(scope: string): Promise<void> {
    if (!validScope(scope)) return;
    await this.mutate(stored => { delete stored[scope]; });
    await this.resets.clear(scope);
  }

  private async mutate<T>(change: (stored: StoredQueues) => T | Promise<T>, shouldWrite: (result: T) => boolean = () => true): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = structuredClone(await this.read());
      const result = await change(stored);
      // publish only durable mutations
      if (shouldWrite(result)) {
        await this.write(stored);
        this.stored = stored;
      }
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private async read(): Promise<StoredQueues> {
    // reuse the process-owned durable snapshot
    if (this.stored !== undefined) return this.stored;
    const raw = await readFile(this.file, 'utf8').then(value => JSON.parse(value) as unknown).catch(error => {
      // treat missing storage as an empty queue
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    });
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid queued prompts file');
    const stored: StoredQueues = {};
    for (const [scope, prompts] of Object.entries(raw)) {
      if (!validScope(scope) || !Array.isArray(prompts) || prompts.length > maxPromptsPerScope) throw new Error('invalid queued prompts file');
      const parsed = prompts.map(parsePrompt);
      if (parsed.some(prompt => prompt === undefined)) throw new Error('invalid queued prompts file');
      stored[scope] = parsed as QueuedPrompt[];
    }
    const size = totals(stored);
    // reject persisted data outside any aggregate storage budget
    if (Object.keys(stored).length > maxScopes || size.text > maxStoredTextLength || size.attachments > maxStoredAttachmentBytes || size.attachmentFootprint > this.attachmentFootprintLimit) throw new Error('queued prompts file exceeds storage limits');
    this.stored = stored;
    return stored;
  }

  private async write(value: StoredQueues): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
