import { describe, it, expect } from 'vitest';
import { readProviderResponseText, readProviderResponseJson, MAX_PROVIDER_RESPONSE_BYTES } from '../../providers/response-body.js';

describe('provider response body size limits', () => {
  it('rejects a response whose Content-Length exceeds the cap', async () => {
    const response = new Response('small', { headers: { 'content-length': String(MAX_PROVIDER_RESPONSE_BYTES + 1) } });
    await expect(readProviderResponseText(response)).rejects.toThrow(/exceeded/);
  });

  it('rejects streamed bytes beyond the cap when Content-Length is absent', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }));
    await expect(readProviderResponseText(response)).rejects.toThrow(/exceeded/);
  });

  it('parses a valid bounded JSON response', async () => {
    const response = new Response(JSON.stringify({ ok: true }));
    await expect(readProviderResponseJson<{ ok: boolean }>(response)).resolves.toEqual({ ok: true });
  });
});


describe('provider streaming frame limits', () => {
  it('defines a bounded frame size for SSE readers', async () => {
    const { MAX_PROVIDER_STREAM_FRAME_BYTES } = await import('../../providers/response-body.js');
    expect(MAX_PROVIDER_STREAM_FRAME_BYTES).toBe(2 * 1024 * 1024);
  });
});
