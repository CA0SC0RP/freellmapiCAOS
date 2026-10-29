/** Maximum size of a fully buffered upstream provider response body. */
export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Maximum permitted size of one streamed SSE line/frame. */
export const MAX_PROVIDER_STREAM_FRAME_BYTES = 2 * 1024 * 1024;

/** Read a response body while enforcing a hard byte limit independent of Content-Length. */
export async function readProviderResponseText(res: Response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`Provider response exceeded the ${maxBytes}-byte limit`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    // Some existing tests and third-party Response-like adapters expose text()
    // without a Web ReadableStream body. Keep that compatibility, but still
    // check the returned string's encoded byte length.
    if (typeof (res as any).text === 'function') {
      const text = await (res as any).text() as string;
      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        throw new Error(`Provider response exceeded the ${maxBytes}-byte limit`);
      }
      return text;
    }
    return '';
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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

/** Parse bounded JSON from an upstream provider. */
export async function readProviderResponseJson<T = unknown>(res: Response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES): Promise<T> {
  if (!(res instanceof Response) && typeof (res as any).json === 'function') {
    // Compatibility for Response-like test doubles with a json() method but
    // no stream body. Native Fetch Responses use the bounded stream path above.
    const value = await (res as any).json();
    const serialized = JSON.stringify(value);
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > maxBytes) {
      throw new Error(`Provider response exceeded the ${maxBytes}-byte limit`);
    }
    return value as T;
  }
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
