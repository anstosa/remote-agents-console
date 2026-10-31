import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { sourceSchema } from '../src/config/schema.js';
import { applicationSettingsSchema } from '../src/settings/schema.js';
import { environmentDescription, protectedEnvironment } from '../src/settings/catalog.js';
import argon2 from 'argon2';
import { validateEnvironment } from '../src/settings/validation.js';

const base = { publicOrigin: 'http://127.0.0.1:8787' };

// keep optional calendar policy portable and independent of inbound tools
describe('Google Calendar configuration', () => {
  // share runtime key grammar for active and rotating environment credentials
  it('accepts dotted maximum-length key ids and rejects noncanonical key material', async () => {
    const auth = `RAC_PASSWORD_HASH='${await argon2.hash('synthetic-settings-password')}'\nRAC_SESSION_SECRET=${Buffer.alloc(32, 1).toString('base64url')}`;
    const key = `${'rotation.'.padEnd(64, 'a')}:${Buffer.alloc(32, 2).toString('base64url')}`;
    // apply the same strict contract to each key slot
    for (const name of ['RAC_GOOGLE_CALENDAR_TOKEN_KEY', 'RAC_GOOGLE_CALENDAR_PREVIOUS_TOKEN_KEY']) {
      await expect(validateEnvironment(`${auth}\n${name}=${key}`)).resolves.toBeUndefined();
      await expect(validateEnvironment(`${auth}\n${name}=${key.slice(0, -1)}B`)).rejects.toMatchObject({ code: 'invalid_google_calendar_token_key' });
    }
  });
  // keep package defaults consistent without tying lifecycle support to one release
  it('aligns portable codex defaults independently of lifecycle compatibility', async () => {
    const root = new URL('../../../', import.meta.url);
    const dockerfile = await readFile(new URL('Dockerfile', root), 'utf8');
    const compose = await readFile(new URL('compose.yaml', root), 'utf8');
    const catalog = await readFile(new URL('apps/server/src/settings/catalog.ts', root), 'utf8');
    const defaultVersion = /ARG CODEX_VERSION=(\S+)/u.exec(dockerfile)?.[1];
    expect(defaultVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(compose.match(/CODEX_VERSION:-([^}]+)/g)).toEqual(Array(2).fill(`CODEX_VERSION:-${defaultVersion}`));
    expect(catalog).toContain(`CODEX_VERSION: { value: '${defaultVersion}'`);
  });
  // preserve an inert installation and the agreed interval defaults
  it('defaults to disabled capture with worktree and actual-work timing', () => {
    expect(sourceSchema.parse(base).googleCalendar).toEqual({ enabled: false, titleTemplate: '{worktree}', startMoment: 'work_started', endMoment: 'work_finished' });
  });
  // retain every meaningful lifecycle pairing without adding offsets
  it('accepts lifecycle choices but rejects unknown fields and unsafe titles', () => {
    // validate all declared lifecycle pairs
    for (const startMoment of ['prompt_submitted', 'prompt_sent', 'work_started']) {
      for (const endMoment of ['first_question_or_finished', 'work_finished']) {
        expect(sourceSchema.safeParse({ ...base, googleCalendar: { enabled: true, startMoment, endMoment } }).success).toBe(true);
      }
    }
    expect(sourceSchema.safeParse({ ...base, googleCalendar: { startOffset: 5 } }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...base, googleCalendar: { titleTemplate: '{prompt}' } }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...base, googleCalendar: { startMoment: 'guessed' } }).success).toBe(false);
  });
  // preserve the existing settings transaction rather than live-autosaving policy
  it('publishes labeled restart-required fields and protects encryption secrets', () => {
    const schema = applicationSettingsSchema().properties!.googleCalendar!;
    expect(schema.label).toBe('Google Calendar');
    expect(schema.properties!.startMoment!.options).toEqual(['prompt_submitted', 'prompt_sent', 'work_started']);
    expect(schema.properties!.endMoment!.options).toEqual(['first_question_or_finished', 'work_finished']);
    expect(schema.properties!.titleTemplate!.apply).toBe('rac-restart');
    expect(protectedEnvironment('RAC_GOOGLE_CALENDAR_CLIENT_SECRET')).toBe(true);
    expect(protectedEnvironment('RAC_GOOGLE_CALENDAR_TOKEN_KEY')).toBe(true);
    expect(protectedEnvironment('RAC_GOOGLE_CALENDAR_PREVIOUS_TOKEN_KEY')).toBe(true);
    expect(environmentDescription('RAC_GOOGLE_CALENDAR_CLIENT_ID')).toContain('Google OAuth');
  });
});
