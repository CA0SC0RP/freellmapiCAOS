import { readFileSync } from 'node:fs';
import { createSecureContext, createServer, type Server } from 'node:tls';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedProviderFetch } from '../../lib/pinned-provider-fetch.js';

const certPath = process.env.PINNED_PROVIDER_TEST_CERT;
const keyPath = process.env.PINNED_PROVIDER_TEST_KEY;
const tlsFixtureAvailable = Boolean(certPath && keyPath);

describe.skipIf(!tlsFixtureAvailable)('pinned custom-provider HTTPS/TLS', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
    }));
  });

  async function startTlsServer(): Promise<{ server: Server; port: number; sniNames: string[] }> {
    const sniNames: string[] = [];
    const cert = readFileSync(certPath!, 'utf8');
    const key = readFileSync(keyPath!, 'utf8');
    const context = createSecureContext({ cert, key });
    const server = createServer({
      cert,
      key,
      SNICallback(servername, callback) {
        sniNames.push(servername);
        callback(null, context);
      },
    }, (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ host: request.headers.host, url: request.url }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TLS test server did not bind a TCP port');
    servers.push(server);
    return { server, port: address.port, sniNames };
  }

  it('connects to the pinned IP while sending the original hostname as SNI and validating its certificate', async () => {
    const { port, sniNames } = await startTlsServer();
    const hostname = 'provider.test';
    const response = await pinnedProviderFetch(
      `https://${hostname}:${port}/tls-check`,
      { method: 'GET' },
      ['127.0.0.1'],
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      host: `${hostname}:${port}`,
      url: '/tls-check',
    });
    expect(sniNames).toContain(hostname);
  });

  it('rejects a trusted certificate whose SAN does not match the original hostname', async () => {
    const { port, sniNames } = await startTlsServer();
    const mismatchedHostname = 'wrong-name.provider.test';

    await expect(pinnedProviderFetch(
      `https://${mismatchedHostname}:${port}/hostname-mismatch`,
      { method: 'GET' },
      ['127.0.0.1'],
    )).rejects.toThrow();

    expect(sniNames).toContain(mismatchedHostname);
  });
});
