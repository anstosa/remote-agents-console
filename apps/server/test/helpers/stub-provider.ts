import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stub OpenAI-compatible provider: every streamed chat completion answers `reply`. `requests`
 * counts the completions asked for.
 */
export async function stubProvider(reply = 'Hello from the stub provider'): Promise<{ baseUrl: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
      requests += 1;
      const chunk = (delta: object, finish: string | null, usage?: object) => `data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: 0, model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(chunk({ role: 'assistant', content: reply }, null));
      response.write(chunk({}, 'stop', { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests: () => requests, close: () => new Promise(resolve => server.close(() => resolve())) };
}

/** A Pi agent directory whose only model is the stub provider's `stub/echo`. */
export const stubModels = (baseUrl: string): string => JSON.stringify({ providers: { stub: { baseUrl, api: 'openai-completions', apiKey: 'stub', models: [{ id: 'echo' }] } } });
