import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Session } from '../auth/service.js';
import type { CallbackAuthority, GoogleCalendarService, OperationAuthority } from './service.js';
import { GoogleCalendarError } from './provider-types.js';

export type GoogleCalendarRoutes = {
  service: GoogleCalendarService;
  session: (request: FastifyRequest, mutation?: boolean) => Session;
  controlled: (request: FastifyRequest, mutation?: boolean) => Session;
  reservationGeneration: (sessionId: string) => string | undefined;
  renewReservation: (sessionId: string, generation: string) => boolean;
  isSessionValid: (sessionId: string) => boolean;
};

// require one exact shallow json object
function body(request: FastifyRequest, allowed: string[]): Record<string, unknown> {
  const value = request.body;
  // reject arrays, missing objects, and unknown fields
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new GoogleCalendarError('invalid_request', 400);
  return value as Record<string, unknown>;
}

// contain provider failures without reflecting secrets or upstream bodies
function endpoint(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    try { return await handler(request, reply); }
    catch (error) {
      // publish only bounded provider codes
      if (error instanceof GoogleCalendarError) return reply.code(error.statusCode).send({ error: error.code });
      const status = (error as { statusCode?: number }).statusCode;
      // preserve only known authentication boundary statuses
      if (status === 401 || status === 403 || status === 423) return reply.code(status).send({ error: status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'another_client_is_active' });
      return reply.code(503).send({ error: 'google_calendar_unavailable' });
    }
  };
}

// bind one mutation to its signed request session and controller generation
function operationAuthority(request: FastifyRequest, deps: GoogleCalendarRoutes): OperationAuthority {
  const session = deps.controlled(request, true);
  const reservationGeneration = deps.reservationGeneration(session.id);
  // require the exact current controller reservation
  if (reservationGeneration === undefined) throw new GoogleCalendarError('another_client_is_active', 423);
  return {
    sessionId: session.id,
    reservationGeneration,
    reservationGenerationOf: deps.reservationGeneration,
    renewReservation: deps.renewReservation,
    // revalidate the signed request session after every await
    isSessionValid: sessionId => {
      try { return deps.session(request).id === sessionId && deps.isSessionValid(sessionId); }
      catch { return false; }
    }
  };
}

// register the authenticated google calendar settings surface
export async function registerGoogleCalendarRoutes(app: FastifyInstance, deps: GoogleCalendarRoutes): Promise<void> {
  const mutation = { bodyLimit: 16_384, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  app.get('/api/settings/google-calendar', endpoint(async request => { deps.session(request); return deps.service.summary(); }));
  app.post('/api/settings/google-calendar/connect', mutation, endpoint(async request => {
    const authority = operationAuthority(request, deps);
    body(request, []);
    return { url: deps.service.beginConnect(authority.sessionId, authority.reservationGeneration) };
  }));
  app.post('/api/settings/google-calendar/calendars', mutation, endpoint(async request => {
    const authority = operationAuthority(request, deps);
    const input = body(request, ['name']);
    return await deps.service.createCalendar(input.name, authority);
  }));
  app.post('/api/settings/google-calendar/select', mutation, endpoint(async request => {
    const authority = operationAuthority(request, deps);
    const input = body(request, ['calendarId']);
    // require one bounded registry id
    if (typeof input.calendarId !== 'string' || input.calendarId.length < 1 || input.calendarId.length > 1024) throw new GoogleCalendarError('invalid_request', 400);
    return await deps.service.selectCalendar(input.calendarId, authority);
  }));
  app.post('/api/settings/google-calendar/disconnect', mutation, endpoint(async request => { const authority = operationAuthority(request, deps); body(request, []); return await deps.service.disconnect(authority); }));
  app.post('/api/settings/google-calendar/retry', mutation, endpoint(async request => { const authority = operationAuthority(request, deps); body(request, []); return await deps.service.retry(authority); }));
  app.post('/api/settings/google-calendar/title-preview', mutation, endpoint(async request => {
    deps.controlled(request, true);
    const input = body(request, ['template']);
    // require one bounded authored template
    if (typeof input.template !== 'string' || [...input.template].length > 160) throw new GoogleCalendarError('invalid_title_template', 400);
    return { title: deps.service.preview(input.template) };
  }));
  app.get('/api/settings/google-calendar/oauth/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = request.query as Record<string, unknown>;
    const state = typeof query.state === 'string' && query.state.length <= 256 ? query.state : '';
    const code = typeof query.code === 'string' && query.code.length <= 8192 && query.error === undefined ? query.code : '';
    // default every callback authority hook to denial
    let authority: CallbackAuthority = { sessionId: '', reservationGeneration: '', code, state, reservationGenerationOf: () => undefined, renewReservation: () => false, isSessionValid: () => false };
    try {
      const session = deps.session(request);
      const generation = deps.reservationGeneration(session.id) ?? '';
      // revalidate the signed request session and current reservation after every await
      const isSessionValid = (sessionId: string): boolean => {
        try { return deps.session(request).id === sessionId && deps.isSessionValid(sessionId); }
        catch { return false; }
      };
      authority = { sessionId: session.id, reservationGeneration: generation, code, state, reservationGenerationOf: deps.reservationGeneration, renewReservation: deps.renewReservation, isSessionValid };
    } catch {
      // retain denied authority so the one-time state is still consumed
    }
    try { await deps.service.completeConnect(authority); }
    catch {
      // always return to settings without exposing callback material
    }
    return reply.redirect('/#settings');
  });
}
