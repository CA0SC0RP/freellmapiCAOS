import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createAdminRateLimiter, createProxyRateLimiter } from '../../middleware/rateLimit.js';

function invoke(limiter: (req: Request, res: Response, next: NextFunction) => void, ip: string) {
  let statusCode = 200;
  let body: unknown;
  const headers = new Map<string, string>();
  const res = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); return this; },
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;
  let nextCalled = false;
  const req = { ip, socket: { remoteAddress: ip }, headers: {} } as unknown as Request;
  limiter(req, res, (() => { nextCalled = true; }) as NextFunction);
  return { statusCode, body, headers, nextCalled };
}

describe('rate limiter memory bounds', () => {
  it.each([
    ['proxy', createProxyRateLimiter],
    ['admin', createAdminRateLimiter],
  ])('%s limiter shares an overflow bucket after the IP table reaches its cap', (_name, createLimiter) => {
    const limiter = createLimiter(1);

    // Fill the bounded per-IP table with distinct, still-active windows.
    for (let i = 0; i < 10_000; i++) {
      expect(invoke(limiter, `198.51.100.${i}`).statusCode).toBe(200);
    }

    // The first additional address enters the shared overflow bucket. A second
    // distinct address must share that same counter and be throttled, proving
    // new addresses cannot each allocate a fresh window or bypass the cap.
    expect(invoke(limiter, '203.0.113.1').statusCode).toBe(200);
    const overflow = invoke(limiter, '203.0.113.2');
    expect(overflow.statusCode).toBe(429);
    expect(overflow.headers.get('retry-after')).toBeTruthy();
    expect(overflow.nextCalled).toBe(false);
  });
});
