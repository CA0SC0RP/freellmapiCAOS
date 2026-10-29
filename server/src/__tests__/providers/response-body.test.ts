import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import { readProviderResponseText, readProviderResponseJson, readProviderResponseBytes, MAX_PROVIDER_RESPONSE_BYTES, MAX_PROVIDER_STREAM_FRAME_BYTES, assertProviderStreamChunkWithinLimit } from '../../providers/response-body.js';

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

  it('enforces the cap on a Response-like object with a readable stream', async () => {
    const bytes = new Uint8Array(MAX_PROVIDER_RESPONSE_BYTES + 1);
    const responseLike = {
      headers: { get: () => null },
      body: { getReader: () => new Response(bytes).body!.getReader() },
      text: async () => { throw new Error('text fallback must not be used'); },
    };
    await expect(readProviderResponseText(responseLike)).rejects.toThrow(/exceeded/);
  });

  it('cancels the reader when a stream yields an invalid chunk', async () => {
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const responseLike = {
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: { not: 'a byte array' } as unknown as Uint8Array }),
          cancel,
          releaseLock,
        }),
      },
    };
    await expect(readProviderResponseText(responseLike)).rejects.toThrow(/invalid chunk/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('accepts Uint8Array chunks created in another JavaScript realm', async () => {
    const crossRealmBytes = runInNewContext('new Uint8Array([111, 107])') as Uint8Array;
    expect(crossRealmBytes).not.toBeInstanceOf(Uint8Array);
    const responseLike = {
      body: {
        getReader: () => {
          let read = false;
          return {
            read: async () => read
              ? { done: true }
              : (read = true, { done: false, value: crossRealmBytes }),
            cancel: async () => {},
            releaseLock: () => {},
          };
        },
      },
    };
    await expect(readProviderResponseText(responseLike)).resolves.toBe('ok');
    expect(() => assertProviderStreamChunkWithinLimit(crossRealmBytes)).not.toThrow();
  });

  it('rejects adapters without a readable stream before calling unbounded text/json methods', async () => {
    const text = vi.fn(async () => 'x'.repeat(MAX_PROVIDER_RESPONSE_BYTES + 1));
    const json = vi.fn(async () => ({ payload: 'x'.repeat(MAX_PROVIDER_RESPONSE_BYTES + 1) }));
    const responseLike = { text, json };
    await expect(readProviderResponseText(responseLike)).rejects.toThrow(/no readable stream/);
    await expect(readProviderResponseJson(responseLike)).rejects.toThrow(/no readable stream/);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('parses a valid bounded JSON response', async () => {
    const response = new Response(JSON.stringify({ ok: true }));
    await expect(readProviderResponseJson<{ ok: boolean }>(response)).resolves.toEqual({ ok: true });
  });
});


describe('provider streaming frame limits', () => {
  it('rejects a transport chunk larger than the frame cap before decoding', () => {
    expect(() => assertProviderStreamChunkWithinLimit(new Uint8Array(MAX_PROVIDER_STREAM_FRAME_BYTES + 1)))
      .toThrow(/stream chunk exceeded/);
  });

  it('accepts a transport chunk within the frame cap', () => {
    expect(() => assertProviderStreamChunkWithinLimit(new Uint8Array(MAX_PROVIDER_STREAM_FRAME_BYTES)))
      .not.toThrow();
  });

  it('enforces binary response limits before allocating the full body', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    }));
    await expect(readProviderResponseBytes(response, 8)).rejects.toThrow(/exceeded.*byte limit/);
  });

  it('preserves binary bytes across multiple chunks while buffering incrementally', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.enqueue(new Uint8Array([6, 7, 8, 9]));
        controller.close();
      },
    }));
    await expect(readProviderResponseBytes(response, 16)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
  });

  it('cancels and releases a binary stream when the byte limit is exceeded', async () => {
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    let readCount = 0;
    const responseLike = {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => readCount++ === 0
            ? { done: false, value: new Uint8Array([1, 2, 3, 4, 5]) }
            : { done: true },
          cancel,
          releaseLock,
        }),
      },
    };
    await expect(readProviderResponseBytes(responseLike, 4)).rejects.toThrow(/exceeded/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});


describe('provider response byte limit configuration', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid response byte limit %s',
    async (limit) => {
      const response = new Response('small');
      await expect(readProviderResponseText(response, limit)).rejects.toThrow(/non-negative safe integer/);
      await expect(readProviderResponseBytes(response, limit)).rejects.toThrow(/non-negative safe integer/);
      expect(() => assertProviderStreamChunkWithinLimit(new Uint8Array(0), limit))
        .toThrow(/non-negative safe integer/);
    },
  );

  it('accepts a zero-byte limit only for an empty response', async () => {
    await expect(readProviderResponseBytes(new Response(null), 0)).resolves.toEqual(new Uint8Array(0));
    await expect(readProviderResponseText(new Response('x'), 0)).rejects.toThrow(/exceeded/);
  });
});
