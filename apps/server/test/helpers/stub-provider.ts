import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type ChatMessage = { role: string; content?: unknown };
const said = (message: ChatMessage | undefined): string => typeof message?.content === 'string' ? message.content
  : Array.isArray(message?.content) ? message.content.map(part => typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '').join('') : '';

/**
 * A stub OpenAI-compatible provider: every streamed chat completion answers `reply`, with these
 * scripted exceptions read from the conversation so far. The first completion calls `toolCall` when
 * one is given. A user message containing `slowly` is answered after `slowMs` (so a Turn can be
 * steered or cancelled while it runs); one containing `ask me` is answered with an `ask_user` call
 * offering `red` and `blue`; and a tool result is answered `You answered: <result>`. `requests`
 * counts the completions asked for and `prompts` lists the last user message of each.
 */
export async function stubProvider(reply = 'Hello from the stub provider', { slowMs = 3_000, toolCall }: { slowMs?: number; toolCall?: { name: string; arguments: object } } = {}): Promise<{ baseUrl: string; requests: () => number; prompts: () => string[]; close: () => Promise<void> }> {
  let requests = 0;
  const prompts: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
      requests += 1;
      let messages: ChatMessage[] = [];
      try { messages = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: ChatMessage[] }).messages ?? []; } catch { /* answer the default */ }
      const last = messages.at(-1);
      const lastUser = said(messages.filter(message => message.role === 'user').at(-1));
      prompts.push(lastUser);
      const chunk = (delta: object, finish: string | null, usage?: object) => `data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', created: 0, model: 'stub', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
      const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
      const answer = () => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (toolCall !== undefined && requests === 1) {
          response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_stub', type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) } }] }, null));
          response.write(chunk({}, 'tool_calls', usage));
        } else if (last?.role === 'tool') {
          response.write(chunk({ role: 'assistant', content: `You answered: ${said(last)}` }, null));
          response.write(chunk({}, 'stop', usage));
        } else if (last?.role === 'user' && lastUser.includes('ask me')) {
          const call = { index: 0, id: `call_${requests}`, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which colour?', choices: ['red', 'blue'] }) } };
          response.write(chunk({ role: 'assistant', tool_calls: [call] }, null));
          response.write(chunk({}, 'tool_calls', usage));
        } else {
          response.write(chunk({ role: 'assistant', content: reply }, null));
          response.write(chunk({}, 'stop', usage));
        }
        response.end('data: [DONE]\n\n');
      };
      if (lastUser.includes('slowly') && last?.role === 'user') {
        const timer = setTimeout(answer, slowMs);
        response.on('close', () => clearTimeout(timer));
      } else answer();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests: () => requests, prompts: () => prompts, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** A Pi agent directory whose models are the stub provider's `stub/echo`, priced so a Turn has a cost, and the reasoning `stub/think`. */
export const stubModels = (baseUrl: string): string => JSON.stringify({ providers: { stub: { baseUrl, api: 'openai-completions', apiKey: 'stub', models: [{ id: 'echo', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, { id: 'think', name: 'Thinker', reasoning: true }] } } });
