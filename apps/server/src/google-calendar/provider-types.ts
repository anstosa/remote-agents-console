import type { GoogleCalendarConfig } from './contracts.js';

export type TokenKey = { kid: string; bytes: Buffer };
export type EncryptedRecord = { version: 1; kid: string; iv: string; tag: string; ciphertext: string };
export type GoogleTokens = { accessToken: string; refreshToken?: string; expiresAt: number };
export type GooglePrincipal = { sub: string; email?: string };
export type GoogleCalendarTarget = { id: string; name: string };
export type GoogleAuthState = {
  version: 1;
  clientId: string;
  principal: GooglePrincipal;
  tokens: GoogleTokens;
  calendars: GoogleCalendarTarget[];
  selectedCalendarId?: string;
  disconnected?: boolean;
};

// share one closed vocabulary between runtime persistence and the type contract
export const calendarActivityStatuses = ['admitted', 'ready', 'delivering', 'delivered', 'suppressed', 'awaiting_evidence', 'authorization_required', 'retry_scheduled', 'dead_letter', 'ownership_conflict', 'deleted_by_user', 'target_missing'] as const;
type ActivityStatus = typeof calendarActivityStatuses[number];

export type CalendarActivity = {
  version: 1;
  id: string;
  agentId: string;
  kind: string;
  submittedAt: string;
  labels: { worktree: string; project?: string; agent: string };
  policy: GoogleCalendarConfig;
  target?: GoogleCalendarTarget;
  principalSub?: string;
  status: ActivityStatus;
  reason?: string;
  sentAt?: string;
  startedAt?: string;
  questionAt?: string;
  finishedAt?: string;
  startAt?: string;
  endAt?: string;
  // distinguish the fixed-duration fallback from measured fifteen-minute work
  estimatedInterval?: true;
  summary?: string;
  eventId?: string;
  marker?: string;
  attempts: number;
  firstAttemptAt?: number;
  nextAttemptAt?: number;
  completedAt?: number;
  lastError?: string;
};

export type ActivityDocument = { version: 1; activities: CalendarActivity[] };

export class GoogleCalendarError extends Error {
  // retain only a bounded public error code
  constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}
