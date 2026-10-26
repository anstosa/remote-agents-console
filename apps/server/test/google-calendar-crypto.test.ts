import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptRecord, encryptRecord, parseTokenKey } from '../src/google-calendar/crypto.js';

// cover the private token envelope and strict key grammar
describe('Google Calendar encryption', () => {
  // reject noncanonical or non-aes key declarations
  it('parses only a named 32-byte base64url key', () => {
    const encoded = randomBytes(32).toString('base64url');
    expect(parseTokenKey(`active:${encoded}`).bytes).toHaveLength(32);
    expect(() => parseTokenKey(undefined)).toThrow('token_key_invalid');
    expect(() => parseTokenKey(`active:${randomBytes(31).toString('base64url')}`)).toThrow('token_key_invalid');
    expect(() => parseTokenKey(`bad kid:${encoded}`)).toThrow('token_key_invalid');
  });

  // bind randomized ciphertext to key and record purpose
  it('uses randomized aes-gcm with authenticated purpose data', () => {
    const key = parseTokenKey(`k1:${randomBytes(32).toString('base64url')}`);
    const first = encryptRecord({ accessToken: 'secret' }, key);
    const second = encryptRecord({ accessToken: 'secret' }, key);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(decryptRecord<{ accessToken: string }>(first, [key]).value).toEqual({ accessToken: 'secret' });
    expect(() => decryptRecord(first, [key], 'different')).toThrow();
    expect(() => decryptRecord({ ...first, tag: randomBytes(16).toString('base64url') }, [key])).toThrow();
  });
});
