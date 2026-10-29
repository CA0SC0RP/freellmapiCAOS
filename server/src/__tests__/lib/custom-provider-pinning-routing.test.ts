import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProxyBypass,
  applyProxyEnabled,
  applyProxyMode,
  applyProxyUrl,
  proxyFetch,
  withKeyProxy,
} from '../../lib/proxy.js';

const publicIpUrl = 'https://93.184.216.34/v1';

beforeEach(() => {
  for (const name of [
    'PROXY_URL',
    'PROXY_MODE',
    'ALL_PROXY',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'PROXY_REQUIRED_PLATFORMS',
    'FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS',
  ]) {
    delete process.env[name];
    delete process.env[name.toLowerCase()];
  }
  applyProxyEnabled(true);
  applyProxyBypass('');
  applyProxyUrl('');
  applyProxyMode('forward');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('custom-provider pinned transport routing', () => {
  it('uses the direct pinned dispatcher when no proxy is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const response = await proxyFetch(publicIpUrl, { method: 'POST', body: '{}' }, 'custom');

    expect(response.status).toBe(200);
    expect((fetchSpy.mock.calls[0]?.[1] as { dispatcher?: unknown })?.dispatcher).toBeDefined();
    await expect(response.text()).resolves.toBe('ok');
  });

  it.each([
    ['HTTP forward proxy', 'http://127.0.0.1:8080', 'forward'],
    ['SOCKS proxy', 'socks5h://127.0.0.1:1080', 'forward'],
    ['Fetch Relay', 'https://relay.example.test', 'fetch-relay'],
  ] as const)('fails closed before dispatching through %s', async (_label, proxyUrl, mode) => {
    applyProxyUrl(proxyUrl);
    applyProxyMode(mode);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(proxyFetch(publicIpUrl, { method: 'POST', body: '{"secret":"payload"}' }, 'custom'))
      .rejects.toThrow(/cannot guarantee DNS-pinned upstream connections/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cancels redirect bodies so the request-scoped transport can close', async () => {
    let cancelled = false;
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('redirect body'));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(upstreamBody, {
      status: 302,
      headers: { location: 'http://127.0.0.1:8080/private' },
    }));

    await expect(proxyFetch(publicIpUrl, { method: 'GET' }, 'custom'))
      .rejects.toThrow(/redirected \(302\)/);
    expect(cancelled).toBe(true);
  });

  it('blocks a per-key proxy before credentials or payload can be sent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(withKeyProxy('socks5://127.0.0.1:1081', () =>
      proxyFetch(publicIpUrl, {
        method: 'POST',
        headers: { authorization: 'Bearer test-secret' },
        body: '{"secret":"payload"}',
      }, 'custom')))
      .rejects.toThrow(/cannot guarantee DNS-pinned upstream connections/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not silently bypass a mandatory-proxy policy for custom providers', async () => {
    process.env.PROXY_REQUIRED_PLATFORMS = 'custom';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(proxyFetch(publicIpUrl, { method: 'POST', body: '{}' }, 'custom'))
      .rejects.toMatchObject({ code: 'PROXY_REQUIRED_UNAVAILABLE' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
