import { randomBytes } from 'node:crypto';

const sessionIdBytes = 32;
// derive the unpadded base64url width from the generated entropy
const sessionIdPattern = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil(sessionIdBytes * 8 / 6)}}$`, 'u');

// issue one opaque browser identity
export const createSessionId = (): string => randomBytes(sessionIdBytes).toString('base64url');

// recognize identities issued by the browser authentication service
export const isSessionId = (value: unknown): value is string => typeof value === 'string' && sessionIdPattern.test(value);
