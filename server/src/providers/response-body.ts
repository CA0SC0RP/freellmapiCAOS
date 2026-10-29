/** Maximum size of a fully buffered upstream provider response body. */
export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Maximum permitted size of one streamed SSE line/frame. */
export const MAX_PROVIDER_STREAM_FRAME_BYTES = 2 * 1024 * 1024;

type StreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
};

type ResponseBodyLike = {
  headers?: { get(name: string): string | null };
  body?: {
    getReader?: () => StreamReader;
    cancel?: () => Promise<void>;
  } | null;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

/** Read a response body while enforcing a hard byte limit independent of Content-Length. */
export async function readProviderResponseText(
  response: Response | ResponseBodyLike,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<string> {
  const res = response as ResponseBodyLike;
  const declaredHeader = res.headers?.get?.('content-length');
  const declared = declaredHeader == null || declaredHeader.trim() === '' ? NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel?.(); } catch { /* already closed */ }
    throw new Error(`Provider response exceeded the ${maxBytes}-byte limit`);
  }

  // Use a stream whenever one is available, regardless of instanceof Response.
  // This also covers cross-realm Responses and Response-like adapters.
  const reader = res.body?.getReader?.();
  if (!reader) {
    // An explicit null body is a valid empty body. For other adapters, a text()
    // or json() method alone cannot enforce a pre-allocation limit: reject it
    // instead of materializing an unbounded body and checking only afterward.
    if ('body' in res && res.body === null) return '';
    if (!('body' in res) && typeof res.text !== 'function' && typeof res.json !== 'function') return '';
    throw new Error('Provider response has no readable stream; refusing an unbounded body read');
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error('Provider response stream returned an invalid chunk');
      }
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new Error(`Provider response exceeded the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Parse bounded JSON from an upstream provider without unbounded json() fallback reads. */
export async function readProviderResponseJson<T = unknown>(
  res: Response | ResponseBodyLike,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<T> {
  return JSON.parse(await readProviderResponseText(res, maxBytes)) as T;
}

/**
 * Reject an oversized transport chunk before decoding it into a potentially
 * much larger JavaScript string. The line buffer is checked after decoding.
 */
export function assertProviderStreamChunkWithinLimit(
  chunk: Uint8Array,
  maxBytes = MAX_PROVIDER_STREAM_FRAME_BYTES,
): void {
  if (chunk.byteLength > maxBytes) {
    throw new Error(`Provider stream chunk exceeded the ${maxBytes}-byte limit`);
  }
}
