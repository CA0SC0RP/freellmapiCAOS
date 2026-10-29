import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedProviderFetch } from '../../lib/pinned-provider-fetch.js';

async function startServer(bindAddress: string, marker: string): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ marker, host: request.headers.host, path: request.url }));
  });
  server.listen(0, bindAddress);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  return { server, port: address.port };
}

describe('request-scoped DNS pinning isolation', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
      if (!server.listening) return;
      const closed = once(server, 'close');
      server.close();
      await closed;
    }));
  });

  it('keeps concurrent requests to the same hostname pinned to their own vetted address sets', async () => {
    const first = await startServer('127.0.0.1', 'first-address');
    servers.push(first.server);
    const second = await startServer('127.0.0.2', 'second-address');
    servers.push(second.server);

    const hostname = 'same-provider.example.test';
    const [firstResponse, secondResponse] = await Promise.all([
      pinnedProviderFetch(`http://${hostname}:${first.port}/parallel-a`, { method: 'GET' }, ['127.0.0.1']),
      pinnedProviderFetch(`http://${hostname}:${second.port}/parallel-b`, { method: 'GET' }, ['127.0.0.2']),
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toEqual({
      marker: 'first-address',
      host: `${hostname}:${first.port}`,
      path: '/parallel-a',
    });
    await expect(secondResponse.json()).resolves.toEqual({
      marker: 'second-address',
      host: `${hostname}:${second.port}`,
      path: '/parallel-b',
    });
  });
});
