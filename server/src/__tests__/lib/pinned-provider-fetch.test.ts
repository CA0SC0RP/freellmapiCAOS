import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createPinnedLookup, pinnedProviderFetch } from '../../lib/pinned-provider-fetch.js';
import { assertProviderUrlAllowed } from '../../lib/url-guard.js';

describe('createPinnedLookup (custom-provider DNS pinning)', () => {
  it('returns only the addresses vetted for the request and never resolves again', () => {
    const lookup = createPinnedLookup('api.example.com', ['93.184.216.34']);
    const callback = vi.fn();
    lookup('api.example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('does not re-resolve when DNS changes from public to metadata after validation', async () => {
    let lookups = 0;
    const resolver = async () => {
      lookups += 1;
      return lookups === 1 ? ['93.184.216.34'] : ['169.254.169.254'];
    };
    const vetted = await assertProviderUrlAllowed('https://api.example.com/v1', { resolve: resolver });
    const lookup = createPinnedLookup('api.example.com', vetted);
    const callback = vi.fn();
    lookup('api.example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    expect(lookups).toBe(1);
  });

  it('connects to the vetted IP while preserving the original Host header', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ host: request.headers.host, url: request.url }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');

    try {
      const response = await pinnedProviderFetch(
        `http://api.example.test:${address.port}/pinned-check`,
        { method: 'GET' },
        ['127.0.0.1'],
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        host: `api.example.test:${address.port}`,
        url: '/pinned-check',
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('supports IPv4 and IPv6 answers while respecting the requested family', () => {
    const lookup = createPinnedLookup('api.example.com', ['93.184.216.34', '2606:4700::1111']);
    const v4 = vi.fn();
    lookup('api.example.com', { family: 4 }, v4);
    expect(v4).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const v6 = vi.fn();
    lookup('api.example.com', { family: 6 }, v6);
    expect(v6).toHaveBeenCalledWith(null, '2606:4700::1111', 6);
  });

  it('rejects unexpected hostnames instead of resolving them', () => {
    const lookup = createPinnedLookup('api.example.com', ['93.184.216.34']);
    const callback = vi.fn();
    lookup('169.254.169.254', {}, callback);
    expect(callback.mock.calls[0][0]).toMatchObject({ code: 'EACCES' });
  });

  it('rejects empty and malformed vetted address sets', () => {
    expect(() => createPinnedLookup('api.example.com', [])).toThrow(/no vetted IP/);
    expect(() => createPinnedLookup('api.example.com', ['not-an-ip'])).toThrow(/invalid IP/);
  });

  it('fails when the requested family has no vetted destination', () => {
    const lookup = createPinnedLookup('api.example.com', ['93.184.216.34']);
    const callback = vi.fn();
    lookup('api.example.com', { family: 6 }, callback);
    expect(callback.mock.calls[0][0]).toMatchObject({ code: 'EAI_ADDRFAMILY' });
  });
});
