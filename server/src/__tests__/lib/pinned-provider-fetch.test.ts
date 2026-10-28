import { describe, expect, it } from 'vitest';
import { createPinnedLookup } from '../../lib/pinned-provider-fetch.js';

describe('createPinnedLookup (custom-provider DNS pinning)', () => {
  it('returns only the addresses vetted for the request and never resolves again', () => {
    const lookup = createPinnedLookup('api.example.com', ['93.184.216.34']);
    const callback = vi.fn();
    lookup('api.example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
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
