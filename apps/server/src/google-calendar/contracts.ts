import { z } from 'zod';
import { validateTitleTemplate } from './title.js';

export const googleCalendarStartMoments = ['prompt_submitted', 'prompt_sent', 'work_started'] as const;
export const googleCalendarEndMoments = ['first_question_or_finished', 'work_finished'] as const;

// keep outbound calendar policy independent of remote tool permissions
export const googleCalendarConfigSchema = z.object({
  enabled: z.boolean().default(false),
  titleTemplate: z.string().min(1).max(320).refine(value => validateTitleTemplate(value) === undefined, 'Use 1–160 characters and only {worktree}, {project}, or {agent}.').default('{worktree}'),
  startMoment: z.enum(googleCalendarStartMoments).default('work_started'),
  endMoment: z.enum(googleCalendarEndMoments).default('work_finished')
}).strict();
export type GoogleCalendarConfig = z.output<typeof googleCalendarConfigSchema>;
export const defaultGoogleCalendarConfig: GoogleCalendarConfig = googleCalendarConfigSchema.parse({});
export type CalendarLabels = { worktree: string; project?: string; agent: string };
export type CalendarAdmission = { id: string; agentId: string; kind: string; submittedAt: string; labels: CalendarLabels };
export type CalendarSignal = { id: string; type: 'sent' | 'started' | 'question' | 'finished' | 'invalid'; at?: string; labels?: CalendarLabels; reason?: string };
export type CalendarCaptureSink = { admit: (input: CalendarAdmission) => Promise<boolean>; signal: (input: CalendarSignal) => Promise<void> };
export type CalendarSummary = {
  enabled: boolean;
  available: boolean;
  connected: boolean;
  status: 'disabled' | 'setup_required' | 'connected' | 'ready' | 'degraded';
  accountEmail?: string;
  calendars: { id: string; name: string }[];
  selectedCalendarId?: string;
  setup: { clientId: boolean; clientSecret: boolean; tokenKey: boolean; redirectUri: string };
  counts: { pending: number; delivered: number; failed: number; suppressed: number };
  lastError?: string;
  lastSuccessAt?: string;
};
