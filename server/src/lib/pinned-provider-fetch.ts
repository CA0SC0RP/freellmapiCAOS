import net from 'node:net';

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * A request-scoped lookup implementation backed only by addresses already
 * assessed by url-guard. It deliberately never calls system DNS.
 */
export function createPinnedLookup(
  expectedHostname: string,
  vettedAddresses: string[],
): (hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback) => void {
  const expected = expectedHostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const records = [...new Set(vettedAddresses)].map((address) => {
    const family = net.isIP(address);
    if (!family) throw new Error('Pinned provider destination contains an invalid IP address');
    return { address, family };
  });
  if (records.length === 0) throw new Error('Pinned provider destination has no vetted IP addresses');

  let cursor = 0;
  return (hostname, options, callback) => {
    const requested = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (requested !== expected) {
      const error = Object.assign(new Error('Pinned provider lookup received an unexpected hostname'), { code: 'EACCES' });
      callback(error, '', 0);
      return;
    }
    const candidates = records.filter((record) => !options.family || options.family === record.family);
    if (candidates.length === 0) {
      const error = Object.assign(new Error('No vetted address matches the requested address family'), { code: 'EAI_ADDRFAMILY' });
      callback(error, '', 0);
      return;
    }
    if (options.all) {
      callback(null, candidates);
      return;
    }
    const record = candidates[cursor++ % candidates.length];
    callback(null, record.address, record.family);
  };
}

/**
 * Send one custom-provider request using a fresh Undici Agent pinned to the
 * DNS answer set returned by assertProviderUrlAllowed. The URL hostname stays
 * unchanged so Host, TLS SNI and certificate verification remain hostname-based.
 */
export async function pinnedProviderFetch(
  url: string,
  init: RequestInit | undefined,
  vettedAddresses: string[],
): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Custom provider URL blocked: unsupported transport protocol');
  }
  const { Agent } = await import('undici');
  const lookup = createPinnedLookup(target.hostname, vettedAddresses);
  const dispatcher = new Agent({
    connect: {
      lookup: lookup as never,
    },
  });

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'manual',
      dispatcher,
    } as RequestInit & { dispatcher: unknown });
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }

  if (!response.body) {
    await dispatcher.close().catch(() => undefined);
    return response;
  }

  // Keep the Agent alive while the caller consumes a streaming body; close it
  // on EOF, read error, or cancellation. This avoids truncating valid streams
  // while ensuring request-scoped pools do not accumulate.
  const reader = response.body.getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await dispatcher.close().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await close();
      }
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
