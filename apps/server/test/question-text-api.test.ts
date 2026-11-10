import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { authenticatedHeaders, testAuthService, testHost } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';

// exercise the existing authenticated question boundary with both answer forms
describe('text question API', () => {
  // text answers must never fall through to normal prompt submission
  it('accepts text and numbered answers while rejecting ambiguous bodies and unauthorized requests', async () => {
    const answerQuestion = vi.fn(async () => true);
    const submit = vi.fn(async () => true);
    const app = await buildApp(testConfig(), {
      auth: await testAuthService(),
      prompts: { answerQuestion, submit } as never,
      discovery: {
        // isolate the test from host agent discovery
        worktreesNow: () => [],
        // return an empty dashboard for authentication notifications
        dashboard: async () => ({ generation: 1, places: [], agents: [], projects: [] })
      } as never
    });
    try {
      const url = '/api/agents/agent-1/question';
      const payload = { questionId: 'question-current', text: 'Use a custom approach.' };
      const unauthenticated = await app.inject({ method: 'POST', url, headers: { host: testHost }, payload });
      expect(unauthenticated.statusCode).not.toBe(204);
      expect(answerQuestion).not.toHaveBeenCalled();
      const headers = await authenticatedHeaders(app);
      const missingCsrf = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-csrf-token': '' }, payload });
      expect(missingCsrf.statusCode).toBe(403);
      expect(answerQuestion).not.toHaveBeenCalled();
      const text = await app.inject({ method: 'POST', url, headers, payload });
      expect(text.statusCode).toBe(204);
      expect(answerQuestion).toHaveBeenLastCalledWith('agent-1', payload.questionId, payload.text, { operator: true });
      const choice = await app.inject({ method: 'POST', url, headers, payload: { questionId: payload.questionId, index: 1 } });
      expect(choice.statusCode).toBe(204);
      expect(answerQuestion).toHaveBeenLastCalledWith('agent-1', payload.questionId, 1, { operator: true });
      // the browser is the operator, whose answer alone may grant a tool permission
      // refuse callers that mix text and numeric selection or omit the answer
      for (const body of [{ ...payload, index: 0 }, { questionId: payload.questionId }, { ...payload, text: 7 }, { ...payload, questionId: null }]) {
        const invalid = await app.inject({ method: 'POST', url, headers, payload: body });
        expect(invalid.statusCode).toBe(404);
      }
      expect(answerQuestion).toHaveBeenCalledTimes(2);
      answerQuestion.mockResolvedValueOnce(false);
      const stale = await app.inject({ method: 'POST', url, headers, payload });
      expect(stale.statusCode).toBe(404);
      expect(submit).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
