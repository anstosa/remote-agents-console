import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stub of the console's stateless `/mcp`: it offers one read tool, `list_agents`, whose result
 * fills `structuredContent`, and keeps each request's method and `Authorization` header.
 */
export async function stubMcp(): Promise<{ url: string; requests: Array<{ method: string; authorization?: string; name?: string }>; close: () => Promise<void> }> {
  const requests: Array<{ method: string; authorization?: string; name?: string }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { id?: unknown; method?: string; params?: { name?: string } };
      requests.push({ method: message.method ?? '', ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }), ...(message.params?.name === undefined ? {} : { name: message.params.name }) });
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const reply = (result: object) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); };
      if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'remote-agents', version: '1.0.0' } });
      else if (message.method === 'tools/list') reply({ tools: [{ name: 'list_agents', description: 'List current agents.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] });
      else if (message.method === 'tools/call') {
        const envelope = { ok: true, data: [{ id: 'agent-1', attention: 'finished' }] };
        reply({ content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope });
      } else reply({});
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
