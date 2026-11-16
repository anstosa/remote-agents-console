import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { ControlService } from '../src/auth/control.js';
import { ReplySuggestionService } from '../src/reply-suggestions/service.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

const opened: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const directories: string[] = [];

// keep test queues and application shutdown independent of operator state
afterEach(async () => {
  // shut down services before removing their temporary storage
  for (const app of opened.splice(0)) await app.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // remove only directories created by this fixture
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// provide a current own-login source without calling a real provider
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rac-reply-api-'));
  directories.push(directory);
  vi.stubEnv('RAC_QUEUED_PROMPTS_FILE', join(directory, 'queue.json'));
  const auth = await testAuthService();
  const control = new ControlService();
  const source = {
    kind: 'pi' as const, transport: 'structured' as const, runtimeGeneration: 'fixture-runtime', agentId: 'pi-1', identity: 'source-1', sourceGeneration: 1, processGeneration: 1, conversationId: 'conversation-1',
    model: { model: 'openai/test-model', effort: 'high' },
    nativeModel: { provider: 'openai', id: 'test-model', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
    messages: [{ id: 'assistant-1', role: 'assistant' as const, text: 'Should I run the local test?' }]
  };
  const suggestions = [{ label: 'Run local test', text: 'Run the local test without publishing.' }];
  let generate = async () => suggestions;
  const generated = vi.fn(async () => await generate());
  const service = new ReplySuggestionService({ source: async () => source, routeFingerprint: async () => 'active-login', generate: generated });
  const discovery = {
    projectsNow: () => [], worktreesNow: () => [],
    dashboard: async () => ({ agents: [{ id: 'pi-1', kind: 'pi', transport: 'structured', attention: 'finished' }], projects: [], places: [] })
  };
  const app = await buildApp(testConfig({ replySuggestions: true }), { auth, control, discovery: discovery as never, replySuggestions: service });
  opened.push(app);
  const headers = await authenticatedHeaders(app);
  const sourceKey = (await service.observe('pi-1'))!;
  return { app, auth, control, service, headers, sourceKey, generated, suggestions, setGenerate: (next: typeof generate) => { generate = next; } };
}

describe('reply suggestion protected demand API', () => {
  // disabled mode cannot observe sources or spend through an injected service
  it('hides the endpoint without source, route, validation or generation work when disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-reply-api-disabled-'));
    directories.push(directory);
    vi.stubEnv('RAC_QUEUED_PROMPTS_FILE', join(directory, 'queue.json'));
    const auth = await testAuthService();
    const control = new ControlService();
    const source = vi.fn(async () => undefined);
    const routeFingerprint = vi.fn(async () => undefined);
    const validate = vi.fn(async () => false);
    const generate = vi.fn(async () => []);
    const service = new ReplySuggestionService({ source, routeFingerprint, validate, generate });
    const observe = vi.spyOn(service, 'observe');
    const request = vi.spyOn(service, 'request');
    const stop = vi.spyOn(service, 'stop');
    const useReplySuggestions = vi.fn();
    const dashboard = vi.fn(async () => ({ agents: [{ id: 'pi-1', kind: 'pi', transport: 'structured', attention: 'finished' }], projects: [], places: [] }));
    const discovery = { projectsNow: () => [], worktreesNow: () => [], dashboard, useReplySuggestions };
    const app = await buildApp(testConfig({ replySuggestions: false }), { auth, control, discovery: discovery as never, replySuggestions: service });
    opened.push(app);
    const headers = await authenticatedHeaders(app);

    const response = await app.inject({ method: 'POST', url: '/api/agents/pi-1/reply-suggestions', headers, payload: { sourceKey: 'disabled-source' } });

    expect(response.statusCode).toBe(404);
    expect(useReplySuggestions).not.toHaveBeenCalled();
    expect(dashboard).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(routeFingerprint).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
    await app.close();
    opened.splice(opened.indexOf(app), 1);
    expect(stop).not.toHaveBeenCalled();
  });

  // auth errors must happen before any provider request
  it('enforces host origin csrf session and existing controller boundaries', async () => {
    const { app, headers, sourceKey, generated } = await fixture();
    // omitted headers remain absent instead of becoming invalid fixture values
    const post = (overrides: Record<string, string | undefined>) => app.inject({ method: 'POST', url: '/api/agents/pi-1/reply-suggestions', headers: Object.fromEntries(Object.entries({ ...headers, ...overrides }).filter(([, value]) => value !== undefined)), payload: { sourceKey } });
    expect((await post({ cookie: undefined })).statusCode).toBe(401);
    expect((await post({ host: 'attacker.example' })).statusCode).toBe(403);
    expect((await post({ origin: 'https://attacker.example' })).statusCode).toBe(403);
    expect((await post({ 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    const other = await authenticatedHeaders(app);
    expect((await app.inject({ method: 'POST', url: '/api/agents/pi-1/reply-suggestions', headers: other, payload: { sourceKey } })).statusCode).toBe(423);
    expect(generated).not.toHaveBeenCalled();
  });

  // only server-resolved source locators may start inference
  it('validates payload and target then returns a key-fenced result without sending a prompt', async () => {
    const { app, headers, sourceKey, generated, suggestions } = await fixture();
    const post = (payload: unknown, id = 'pi-1') => app.inject({ method: 'POST', url: `/api/agents/${id}/reply-suggestions`, headers, payload });
    expect((await post({ sourceKey, model: 'other-model' })).statusCode).toBe(400);
    expect((await post({ sourceKey, prompt: 'run tools' })).statusCode).toBe(400);
    expect((await post({ sourceKey: 4 })).statusCode).toBe(400);
    expect((await post({ sourceKey: '' })).statusCode).toBe(400);
    expect((await post({ sourceKey }, 'missing')).statusCode).toBe(404);
    expect((await post({ sourceKey: 'stale-source' })).statusCode).toBe(409);
    expect(generated).not.toHaveBeenCalled();
    const response = await post({ sourceKey });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sourceKey, suggestions });
    expect((await post({ sourceKey })).json()).toEqual({ sourceKey, suggestions });
    expect(generated).toHaveBeenCalledTimes(1);
  });

  // displaced reservations cannot publish or regain control after a slow provider
  it('discards output after takeover without renewing the old controller', async () => {
    const { app, headers, sourceKey, control, setGenerate } = await fixture();
    let finish!: (value: Array<{ label: string; text: string }>) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    setGenerate(async () => { began(); return await new Promise(resolve => { finish = resolve; }); });
    const response = app.inject({ method: 'POST', url: '/api/agents/pi-1/reply-suggestions', headers, payload: { sourceKey } });
    void response.then(() => undefined);
    await started;
    const displaced = control.ownerSessionId()!;
    await control.take('00000000-0000-4000-8000-000000000000');
    const connect = vi.spyOn(control, 'connect');
    finish([{ label: 'Run tests', text: 'Run the tests.' }]);
    expect((await response).statusCode).toBe(403);
    expect(connect).not.toHaveBeenCalledWith(displaced);
    expect(control.ownerSessionId()).toBe('00000000-0000-4000-8000-000000000000');
  });

  // the signed session check is independent of reservation continuity
  it('discards output when the session becomes invalid during generation', async () => {
    const { app, auth, headers, sourceKey, setGenerate } = await fixture();
    let finish!: (value: Array<{ label: string; text: string }>) => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    setGenerate(async () => { began(); return await new Promise(resolve => { finish = resolve; }); });
    const response = app.inject({ method: 'POST', url: '/api/agents/pi-1/reply-suggestions', headers, payload: { sourceKey } });
    void response.then(() => undefined);
    await started;
    vi.spyOn(auth, 'get').mockReturnValue(undefined);
    finish([{ label: 'Run tests', text: 'Run the tests.' }]);
    expect((await response).statusCode).toBe(403);
  });

  // repeated demand is bounded per authenticated session even for cached replies
  it('rate limits the generation endpoint without repeating provider work', async () => {
    const { app, headers, sourceKey, generated } = await fixture();
    // each cached request still consumes one endpoint admission
    for (let index = 0; index < 30; index += 1) {
      expect((await app.inject({ method: 'POST', url: '/api/agents/pi-1/reply-suggestions', headers, payload: { sourceKey } })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'POST', url: '/api/agents/pi-1/reply-suggestions', headers, payload: { sourceKey } })).statusCode).toBe(429);
    expect(generated).toHaveBeenCalledTimes(1);
  });
});
