import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedRecord, TokenKey } from './provider-types.js';

const keyPattern = /^([A-Za-z0-9._-]{1,64}):([A-Za-z0-9_-]{43})$/;

// parse one strict aes key declaration
export function parseTokenKey(value: string | undefined): TokenKey {
  const match = value?.match(keyPattern);
  // reject absent or malformed key declarations
  if (match == null) throw new Error('token_key_invalid');
  const bytes = Buffer.from(match[2]!, 'base64url');
  // require exactly one aes-256 key
  if (bytes.length !== 32 || bytes.toString('base64url') !== match[2]) throw new Error('token_key_invalid');
  return { kid: match[1]!, bytes };
}

// bind ciphertext to its record purpose and key identity
function aad(record: string, kid: string): Buffer { return Buffer.from(`rac-google-calendar\0v1\0${record}\0${kid}`, 'utf8'); }

// encrypt one bounded json payload with randomized aes-gcm
export function encryptRecord(value: unknown, key: TokenKey, record = 'auth'): EncryptedRecord {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  // keep private records bounded before encryption
  if (plaintext.length > 1_048_576) throw new Error('encrypted_record_too_large');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  cipher.setAAD(aad(record, key.kid));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { version: 1, kid: key.kid, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

// decrypt only the expected version and record purpose
export function decryptRecord<T>(record: EncryptedRecord, keys: TokenKey[], purpose = 'auth'): { value: T; key: TokenKey } {
  // reject unknown envelope versions and shapes
  if (record?.version !== 1 || typeof record.kid !== 'string' || typeof record.iv !== 'string' || typeof record.tag !== 'string' || typeof record.ciphertext !== 'string') throw new Error('encrypted_record_invalid');
  const key = keys.find(candidate => candidate.kid === record.kid);
  // fail closed when the declared key is unavailable
  if (key === undefined) throw new Error('token_key_unavailable');
  const iv = Buffer.from(record.iv, 'base64url');
  const tag = Buffer.from(record.tag, 'base64url');
  const ciphertext = Buffer.from(record.ciphertext, 'base64url');
  // require canonical bounded gcm fields
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 1_048_576) throw new Error('encrypted_record_invalid');
  const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv);
  decipher.setAAD(aad(purpose, key.kid));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { value: JSON.parse(plaintext.toString('utf8')) as T, key };
}
