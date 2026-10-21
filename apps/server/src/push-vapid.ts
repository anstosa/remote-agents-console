import { createECDH, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import webpush from 'web-push';

export type VapidKeys = { publicKey: string; privateKey: string };

const storeName = 'push-vapid.json';
const maximumStoreBytes = 4 * 1024;
const publicKeyPattern = /^[A-Za-z0-9_-]{87}$/u;
const privateKeyPattern = /^[A-Za-z0-9_-]{43}$/u;

// construct a bounded diagnostic without retaining the filesystem cause
const failure = (message: string): Error => new Error(message);

// identify values supplied by the former environment configuration
const nonblank = (value: string | undefined): value is string => typeof value === 'string' && value.trim().length > 0;

// validate canonical P-256 key material and prove that the pair matches
const validKeys = (value: unknown): value is VapidKeys => {
  // require the managed pair shape
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VapidKeys>;
  // reject non-canonical base64url lengths and alphabets
  if (typeof candidate.publicKey !== 'string' || !publicKeyPattern.test(candidate.publicKey)) return false;
  if (typeof candidate.privateKey !== 'string' || !privateKeyPattern.test(candidate.privateKey)) return false;
  const publicKey = Buffer.from(candidate.publicKey, 'base64url');
  const privateKey = Buffer.from(candidate.privateKey, 'base64url');
  // reject alternate encodings and unexpected decoded lengths
  if (publicKey.length !== 65 || privateKey.length !== 32) return false;
  if (publicKey.toString('base64url') !== candidate.publicKey || privateKey.toString('base64url') !== candidate.privateKey) return false;
  try {
    const curve = createECDH('prime256v1');
    curve.setPrivateKey(privateKey);
    const derived = curve.getPublicKey(undefined, 'uncompressed');
    return derived.length === publicKey.length && timingSafeEqual(derived, publicKey);
  } catch {
    return false;
  }
};

// load and secure an existing managed store without following symbolic links
const readStore = async (file: string): Promise<VapidKeys | undefined> => {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    // distinguish only absence because every other failure must block rotation
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw failure('VAPID key store could not be read');
  }
  try {
    const metadata = await handle.stat();
    // accept only one regular managed file
    if (!metadata.isFile() || metadata.size > maximumStoreBytes) throw failure('VAPID key store is invalid');
    const serialized = await handle.readFile('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw failure('VAPID key store is invalid');
    }
    // never replace malformed or mismatched persisted credentials
    if (!validKeys(parsed)) throw failure('VAPID key store is invalid');
    await handle.chmod(0o600);
    return parsed;
  } catch (error) {
    // preserve intentional validation diagnostics without exposing I/O details
    if (error instanceof Error && error.message === 'VAPID key store is invalid') throw error;
    throw failure('VAPID key store could not be read');
  } finally {
    await handle.close().catch(() => undefined);
  }
};

// synchronize a directory entry when the host filesystem supports it
const syncDirectory = async (directory: string): Promise<void> => {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // tolerate filesystems that cannot synchronize directory handles
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw failure('VAPID key store could not be created');
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

// select a one-time migration pair or generate a fresh managed pair
const initialKeys = (legacy: { publicKey?: string; privateKey?: string }): VapidKeys => {
  const hasPublic = nonblank(legacy.publicKey);
  const hasPrivate = nonblank(legacy.privateKey);
  // reject a partial legacy configuration instead of rotating subscriptions
  if (hasPublic !== hasPrivate) throw failure('Legacy VAPID keys must include both public and private keys');
  if (hasPublic && hasPrivate) {
    const imported = { publicKey: legacy.publicKey, privateKey: legacy.privateKey };
    // reject malformed or mismatched legacy credentials
    if (!validKeys(imported)) throw failure('Legacy VAPID keys are invalid');
    return imported;
  }
  try {
    const generated = webpush.generateVAPIDKeys();
    // fail closed if the provider returns unexpected material
    if (!validKeys(generated)) throw failure('VAPID keys could not be generated');
    return generated;
  } catch {
    throw failure('VAPID keys could not be generated');
  }
};

// publish one durable candidate without replacing a concurrent winner
const publish = async (directory: string, file: string, keys: VapidKeys): Promise<void> => {
  const temporary = join(directory, `.${storeName}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(keys)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, file);
      await syncDirectory(directory);
    } catch (error) {
      // a concurrent publisher owns the immutable winner
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } catch {
    throw failure('VAPID key store could not be created');
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
};

// load stable managed credentials, migrating or generating only when absent
export const loadVapidKeys = async (
  subscriptionFile: string,
  legacy: { publicKey?: string; privateKey?: string }
): Promise<VapidKeys> => {
  const directory = dirname(subscriptionFile);
  const file = join(directory, storeName);
  const stored = await readStore(file);
  // make persisted state authoritative after the first successful boot
  if (stored !== undefined) return stored;
  let keys: VapidKeys;
  try {
    keys = initialKeys(legacy);
    await mkdir(directory, { mode: 0o700, recursive: true });
  } catch (error) {
    // preserve credential diagnostics while sanitizing storage failures
    if (error instanceof Error && error.message.startsWith('Legacy VAPID keys')) throw error;
    if (error instanceof Error && error.message === 'VAPID keys could not be generated') throw error;
    throw failure('VAPID key store could not be created');
  }
  await publish(directory, file, keys);
  const winner = await readStore(file);
  // require publication to leave one readable durable winner
  if (winner === undefined) throw failure('VAPID key store could not be created');
  return winner;
};
