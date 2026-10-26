import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../src/auth/control.js';

// distinguish reserved ownership from an active connection lease
describe('ControlService', () => {
  // distinguish explicit first admission from passive session restoration
  it('keeps an unowned console inactive when initial admission is disabled', async () => {
    const control = new ControlService();
    expect(control.connect('first')).toBe(false);
    expect(control.ownerSessionId()).toBeUndefined();
    expect(await control.claimInitial('first')).toBe(true);
    expect(control.connect('first')).toBe(true);
    await control.release('first');
    expect(control.connect('second')).toBe(false);
    await control.take('second');
    expect(control.connect('second')).toBe(true);
  });

  // preserve initial admission and deliberate handoffs
  it('keeps one client active and supports explicit takeover', async () => {
    const control = new ControlService();
    expect(await control.claimInitial('first')).toBe(true);
    expect(control.ownerSessionId()).toBe('first');
    expect(control.connect('second')).toBe(false);
    expect(control.active('first')).toBe(true);
    await control.take('second');
    expect(control.ownerSessionId()).toBe('second');
    expect(control.active('first')).toBe(false);
    expect(control.active('second')).toBe(true);
  });

  // block passive acquisition even before an expiry check
  it('requires takeover after inactivity but lets the same owner reconnect', async () => {
    let now = 1_000;
    const control = new ControlService(() => now, 100);
    expect(await control.claimInitial('first')).toBe(true);
    now += 100;
    expect(control.connect('second')).toBe(false);
    expect(control.ownerSessionId()).toBeUndefined();
    expect(control.active('first')).toBe(false);
    expect(control.connect('second')).toBe(false);
    expect(control.connect('first')).toBe(true);
    expect(control.ownerSessionId()).toBe('first');
    expect(control.active('first')).toBe(true);
  });

  // prevent a displaced browser from reclaiming an idle session
  it('retains explicit takeover across later lease expiry', async () => {
    let now = 1_000;
    const control = new ControlService(() => now, 100);
    await control.take('first');
    now += 101;
    await control.take('second');
    expect(control.active('second')).toBe(true);
    expect(control.active('first')).toBe(false);
    now += 101;
    expect(control.ownerSessionId()).toBeUndefined();
    expect(control.connect('first')).toBe(false);
    expect(control.connect('third')).toBe(false);
    expect(control.connect('second')).toBe(true);
  });

  // unauthorized traffic must not keep a lease alive
  it('does not renew the owner lease for another client', async () => {
    let now = 1_000;
    const control = new ControlService(() => now, 100);
    await control.take('first');
    now += 99;
    expect(control.connect('second')).toBe(false);
    expect(control.active('second')).toBe(false);
    now += 1;
    expect(control.ownerSessionId()).toBeUndefined();
    expect(control.active('first')).toBe(false);
  });

  // only an explicit owner logout releases the reservation
  it('releases an expired owner without letting a displaced logout clear ownership', async () => {
    let now = 1_000;
    const control = new ControlService(() => now, 100);
    await control.take('first');
    await control.take('second');
    now += 101;
    await control.release('first');
    expect(control.connect('third')).toBe(false);
    await control.release('second');
    expect(control.connect('third')).toBe(false);
    expect(await control.claimInitial('third')).toBe(true);
  });
});

// separate durable ownership from per-process connection leases
describe('persisted control ownership', () => {
  const first = Buffer.alloc(32, 1).toString('base64url');
  const second = Buffer.alloc(32, 2).toString('base64url');
  let directory: string;
  let file: string;

  // isolate every ownership record from the running console
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rac-control-owner-'));
    file = join(directory, 'state', 'control-owner.json');
  });

  // remove only this test's private state
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // reconnect the owner without granting a live lease during server startup
  it('persists first admission and restores ownership without a connection', async () => {
    const control = await ControlService.persisted(file);
    expect(control.connect(first)).toBe(false);
    expect(await control.claimInitial(first)).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, ownerSessionId: first });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    control.connect(first);
    control.active(first);
    await control.take(first);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, ownerSessionId: first });
    const restarted = await ControlService.persisted(file);
    expect(restarted.ownerSessionId()).toBeUndefined();
    expect(restarted.active(first)).toBe(false);
    expect(restarted.connect(second)).toBe(false);
    expect(await restarted.claimInitial(second)).toBe(false);
    expect(restarted.connect(first)).toBe(true);
    expect(restarted.ownerSessionId()).toBe(first);
  });

  // preserve explicit handoffs and logout across process boundaries
  it('keeps displaced clients blocked after takeover and restart', async () => {
    const control = await ControlService.persisted(file);
    await control.take(first);
    await control.take(second);
    const restarted = await ControlService.persisted(file);
    expect(restarted.connect(first)).toBe(false);
    expect(await restarted.claimInitial(first)).toBe(false);
    await restarted.release(first);
    expect((await ControlService.persisted(file)).connect(second)).toBe(true);
    await restarted.release(second);
    const released = await ControlService.persisted(file);
    expect(released.connect(second)).toBe(false);
    expect(await released.claimInitial(first)).toBe(true);
    expect((await ControlService.persisted(file)).connect(first)).toBe(true);
  });

  // prevent overlapping sign-ins or stale logouts from replacing a newer owner
  it('serializes ownership changes in request order', async () => {
    const control = await ControlService.persisted(file);
    expect(await Promise.all([control.claimInitial(first), control.claimInitial(second)])).toEqual([true, false]);
    await Promise.all([control.take(second), control.release(first)]);
    expect(control.connect(first)).toBe(false);
    expect((await ControlService.persisted(file)).connect(second)).toBe(true);
    await Promise.all([control.release(second), control.claimInitial(first)]);
    expect((await ControlService.persisted(file)).connect(first)).toBe(true);
  });

  // keep the last committed owner authoritative when storage is unavailable
  it('does not acknowledge failed takeovers or releases and permits retry', async () => {
    const control = await ControlService.persisted(file);
    await control.take(first);
    const saved = join(directory, 'saved');
    await rename(join(directory, 'state'), saved);
    await writeFile(join(directory, 'state'), 'not a directory');
    await expect(control.take(second)).rejects.toThrow();
    await expect(control.release(first)).rejects.toThrow();
    expect(control.connect(first)).toBe(true);
    expect(control.connect(second)).toBe(false);
    expect((await ControlService.persisted(join(saved, 'control-owner.json'))).connect(first)).toBe(true);
    await rm(join(directory, 'state'));
    await rename(saved, join(directory, 'state'));
    await control.take(second);
    expect((await ControlService.persisted(file)).connect(second)).toBe(true);
    expect(await readdir(join(directory, 'state'))).toEqual(['control-owner.json']);
  });

  // retain ownership and clean temporary records when atomic replacement fails
  it('cleans a failed rename without publishing ownership and permits retry', async () => {
    const control = await ControlService.persisted(file);
    await control.take(first);
    const saved = join(directory, 'saved.json');
    await rename(file, saved);
    await mkdir(file);
    await expect(control.take(second)).rejects.toThrow();
    await expect(control.release(first)).rejects.toThrow();
    expect(control.connect(first)).toBe(true);
    expect(control.connect(second)).toBe(false);
    expect((await ControlService.persisted(saved)).connect(first)).toBe(true);
    expect(await readdir(join(directory, 'state'))).toEqual(['control-owner.json']);
    await rm(file, { recursive: true });
    await rename(saved, file);
    await control.take(second);
    expect((await ControlService.persisted(file)).connect(second)).toBe(true);
  });

  // refuse corrupt state rather than silently freeing a reserved console
  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ version: 2, ownerSessionId: first }),
    JSON.stringify({ version: 1, ownerSessionId: 'invalid' }),
    JSON.stringify({ version: 1, ownerSessionId: 'a'.repeat(43) }),
    JSON.stringify({ version: 1, ownerSessionId: first, expires: 123 }),
    `${' '.repeat(1_025)}${JSON.stringify({ version: 1, ownerSessionId: first })}`
  ])('rejects malformed ownership record %#', async stored => {
    await mkdir(join(directory, 'state'));
    await writeFile(file, stored);
    await expect(ControlService.persisted(file)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(stored);
  });

  // unreadable paths are not equivalent to a missing ownership record
  it('refuses to start with a directory instead of an ownership file', async () => {
    await mkdir(file, { recursive: true });
    await expect(ControlService.persisted(file)).rejects.toThrow();
  });
});
