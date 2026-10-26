import { createHash } from 'node:crypto';

// retain the v1 event and ownership protocol across delivery and durable rehydration
export function calendarEventIdentity(calendarId: string, activityId: string): { eventId: string; marker: string } {
  const identity = `${calendarId}\0${activityId}`;
  return {
    eventId: createHash('sha256').update(`rac-calendar-event-v1\0${identity}`).digest('hex').slice(0, 52),
    marker: createHash('sha256').update(`rac-calendar-owner-v1\0${identity}`).digest('base64url')
  };
}
