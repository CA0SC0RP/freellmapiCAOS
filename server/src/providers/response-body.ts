/** Maximum size of a fully buffered upstream provider response body. */
export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Read a response body while enforcing a hard byte limit independent of Content-Length. */
export async function readProviderResponseText(res: Response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`Provider response exceeded the ${maxBytes}-byte limit`);
  }

  const reader = res.body?.getReader();
  if (!reader) return '';
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
  return JSON.parse(await readProviderResponseText(res, maxBytes)) as T;
}
