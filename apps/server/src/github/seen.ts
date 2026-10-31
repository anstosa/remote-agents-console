import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// the oldest keys go beyond this, so a record that cannot be pruned still takes new ones
const maxKeys = 5_000;
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0-\x1f]/u.test(value);

/**
 * The seen record: the (Pull request, reason instance) pairs the operator has been shown, as
 * `owner/name#number:instance` keys. With a file it survives restarts; it is the only GitHub state
 * the console keeps on disk.
 */
export class SeenRecord {
  private readonly keys = new Set<string>();
  private loading?: Promise<void>;
  private writing = Promise.resolve();

  constructor(private readonly file?: string) {}

  /** Reads the file once; a missing or unreadable one starts the record empty. */
  async load(): Promise<void> {
    this.loading ??= this.read();
    await this.loading;
  }

  has(key: string): boolean { return this.keys.has(key); }

  /** Records `keys` as seen and saves them; false when all were seen already. */
  async add(keys: Iterable<string>): Promise<boolean> {
    const added = [...keys].filter(key => validKey(key) && !this.keys.has(key));
    if (added.length === 0) return false;
    for (const key of added) this.keys.add(key);
    for (const key of this.keys) if (this.keys.size > maxKeys) this.keys.delete(key); else break;
    await this.save();
    return true;
  }

  /** Forgets every key `keep` refuses, so a reason that stops holding is new when it returns. */
  async retain(keep: (key: string) => boolean): Promise<void> {
    const before = this.keys.size;
    for (const key of this.keys) if (!keep(key)) this.keys.delete(key);
    if (this.keys.size !== before) await this.save();
  }

  private async read(): Promise<void> {
    if (this.file === undefined) return;
    const stored = await readFile(this.file, 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined);
    if (Array.isArray(stored)) for (const key of stored.slice(-maxKeys)) if (validKey(key)) this.keys.add(key);
  }

  // writes are queued, each the whole record as it is then, through a rename so a crash never
  // leaves half a file
  private async save(): Promise<void> {
    const file = this.file;
    if (file === undefined) return;
    const write = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.next`, JSON.stringify([...this.keys]), { mode: 0o600 });
      await rename(`${file}.next`, file);
    });
    this.writing = write.catch(() => undefined);
    await write;
  }
}
