import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { loadVapidKeys } from '../src/push-vapid.js';

const execute = promisify(execFile);
const fixtureDirectories: string[] = [];

// create one isolated subscription path
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-vapid-'));
  fixtureDirectories.push(directory);
  return { directory, subscriptionFile: join(directory, 'push-subscriptions.json') };
};

// exercise managed VAPID persistence
describe('loadVapidKeys', () => {
  // remove every private test store
  afterEach(async () => {
    // clean each isolated directory
    for (const directory of fixtureDirectories.splice(0)) await rm(directory, { force: true, recursive: true });
  });

  // generate once and reuse the exact secure pair on later starts
  it('generates and persists a stable private key pair with restrictive permissions', async () => {
    const { directory, subscriptionFile } = await fixture();
    const first = await loadVapidKeys(subscriptionFile, {});
    const second = await loadVapidKeys(subscriptionFile, {});
    expect(second).toEqual(first);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/u);
    expect(first.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const file = join(directory, 'push-vapid.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(first);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  // retain migrated credentials regardless of later environment changes
  it('imports a complete legacy pair once and then ignores later legacy values', async () => {
    const { subscriptionFile } = await fixture();
    const imported = webpush.generateVAPIDKeys();
    const replacement = webpush.generateVAPIDKeys();
    expect(await loadVapidKeys(subscriptionFile, imported)).toEqual(imported);
    expect(await loadVapidKeys(subscriptionFile, replacement)).toEqual(imported);
    expect(await loadVapidKeys(subscriptionFile, { publicKey: 'invalid-only' })).toEqual(imported);
  });

  // refuse partial, malformed, or mismatched legacy credentials without creating a store
  it('fails closed for invalid legacy key material', async () => {
    const { directory, subscriptionFile } = await fixture();
    const first = webpush.generateVAPIDKeys();
    const second = webpush.generateVAPIDKeys();
    const cases = [
      { legacy: { publicKey: first.publicKey }, message: 'Legacy VAPID keys must include both public and private keys' },
      { legacy: { privateKey: first.privateKey }, message: 'Legacy VAPID keys must include both public and private keys' },
      { legacy: { publicKey: 'not-base64url', privateKey: first.privateKey }, message: 'Legacy VAPID keys are invalid' },
      { legacy: { publicKey: first.publicKey, privateKey: second.privateKey }, message: 'Legacy VAPID keys are invalid' }
    ];
    // validate each failure against an otherwise absent store
    for (const testCase of cases) {
      await expect(loadVapidKeys(subscriptionFile, testCase.legacy)).rejects.toThrow(testCase.message);
      await expect(readFile(join(directory, 'push-vapid.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  // preserve corrupt state and keep diagnostics free of secrets and paths
  it('does not regenerate or disclose an invalid existing store', async () => {
    const { directory, subscriptionFile } = await fixture();
    const file = join(directory, 'push-vapid.json');
    const privateValue = 'private-corrupt-material';
    const serialized = JSON.stringify({ publicKey: 'corrupt', privateKey: privateValue });
    await writeFile(file, serialized, { mode: 0o644 });
    let message = '';
    try {
      await loadVapidKeys(subscriptionFile, webpush.generateVAPIDKeys());
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('VAPID key store is invalid');
    expect(message).not.toContain(privateValue);
    expect(message).not.toContain(directory);
    expect(await readFile(file, 'utf8')).toBe(serialized);
  });

  // converge concurrent processes on the same no-clobber winner
  it('publishes one key pair across concurrent processes', async () => {
    const { subscriptionFile } = await fixture();
    const moduleUrl = new URL('../src/push-vapid.ts', import.meta.url).href;
    const script = "const {loadVapidKeys}=await import(process.argv[1]);const keys=await loadVapidKeys(process.argv[2],{});process.stdout.write(keys.publicKey)";
    const children = Array.from({ length: 4 }, async () => await execute(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', script, moduleUrl, subscriptionFile
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)) }));
    const results = await Promise.all(children);
    const publicKeys = results.map(result => result.stdout);
    expect(new Set(publicKeys).size).toBe(1);
    expect((await loadVapidKeys(subscriptionFile, {})).publicKey).toBe(publicKeys[0]);
  });

  // repair permissive mode on a valid existing store
  it('restricts permissions on an existing valid store', async () => {
    const { directory, subscriptionFile } = await fixture();
    const file = join(directory, 'push-vapid.json');
    const keys = webpush.generateVAPIDKeys();
    await writeFile(file, JSON.stringify(keys), { mode: 0o600 });
    await chmod(file, 0o644);
    expect(await loadVapidKeys(subscriptionFile, {})).toEqual(keys);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  // fail safely when an existing store is not a readable regular file
  it('does not replace an unreadable store target', async () => {
    const { directory, subscriptionFile } = await fixture();
    const file = join(directory, 'push-vapid.json');
    await mkdir(file);
    await expect(loadVapidKeys(subscriptionFile, {})).rejects.toThrow('VAPID key store is invalid');
    expect((await stat(file)).isDirectory()).toBe(true);
  });

  // reject links and oversized content without reading or replacing their targets
  it('does not follow symbolic links or load oversized stores', async () => {
    const linked = await fixture();
    const privateValue = 'private-linked-material';
    const target = join(linked.directory, 'decoy.json');
    await writeFile(target, privateValue);
    await symlink(target, join(linked.directory, 'push-vapid.json'));
    await expect(loadVapidKeys(linked.subscriptionFile, {})).rejects.toThrow('VAPID key store could not be read');
    expect(await readFile(target, 'utf8')).toBe(privateValue);

    const oversized = await fixture();
    const file = join(oversized.directory, 'push-vapid.json');
    await writeFile(file, 'x'.repeat(4 * 1024 + 1));
    await expect(loadVapidKeys(oversized.subscriptionFile, {})).rejects.toThrow('VAPID key store is invalid');
    expect((await stat(file)).size).toBe(4 * 1024 + 1);
  });

  // inspect a FIFO without blocking startup while waiting for a writer
  it('rejects a FIFO store without waiting', async () => {
    const { directory, subscriptionFile } = await fixture();
    await execute('mkfifo', [join(directory, 'push-vapid.json')]);
    const moduleUrl = new URL('../src/push-vapid.ts', import.meta.url).href;
    const script = "const {loadVapidKeys}=await import(process.argv[1]);try{await loadVapidKeys(process.argv[2],{});process.exitCode=2}catch(error){process.stdout.write(String(error))}";
    const result = await execute(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', script, moduleUrl, subscriptionFile
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 1_000 });
    expect(result.stdout).toBe('Error: VAPID key store is invalid');
  });
});
