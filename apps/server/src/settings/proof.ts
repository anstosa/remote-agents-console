import { createHash } from 'node:crypto';
import { appApply, envApply } from './catalog.js';
import { environment } from './env.js';

// retain private exact-byte proofs only
export function contentHash(content: string | undefined): string { return createHash('sha256').update(content ?? '').digest('hex'); }
// remove fields already live or without a runtime consumer
export function restartProjection(value: unknown, path: string[] = []): unknown {
  // drop known non-restart leaves
  if (path.length > 0 && appApply(path) !== 'rac-restart') return undefined;
  // project original collection identities and ordering
  if (Array.isArray(value)) return value.map((child, index) => restartProjection(child, [...path, String(index)]));
  // preserve all other nested configuration
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restartProjection(child, [...path, key])]).filter(([, child]) => child !== undefined));
  return value;
}
// ignore dotenv comments and dormant entries in effective comparisons
export function environmentProjection(content: string): string { return JSON.stringify(Object.fromEntries(Object.entries(environment(content)).filter(([key]) => envApply(key) !== 'saved-only').sort(([left], [right]) => left.localeCompare(right)))); }
// derive restart-relevant application evidence
export function applicationHash(value: unknown): string { return contentHash(JSON.stringify(restartProjection(value))); }
