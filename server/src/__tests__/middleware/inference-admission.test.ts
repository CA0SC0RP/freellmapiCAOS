import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createInferenceAdmission } from '../../middleware/inferenceAdmission.js';

function response() {
  const events = new EventEmitter();
  const headers: Record<string, string> = {};
  const result = Object.assign(events, {
    headers,
    statusCode: 200,
    payload: undefined as unknown,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.payload = payload; return this; },
  });
  return result as unknown as Response & typeof result;
}

const req = {} as Request;

describe('inference admission', () => {
  it('rejects requests over the shared limit with a retry hint', () => {
    const admit = createInferenceAdmission(1);
    const first = response();
    const next = vi.fn() as unknown as NextFunction;
    admit(req, first, next);

    const blocked = response();
    admit(req, blocked, next);
    expect(blocked.statusCode).toBe(503);
    expect(blocked.headers['retry-after']).toBe('1');
    expect(blocked.payload).toMatchObject({
      error: { code: 'inference_concurrency_limit', type: 'server_error' },
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('releases capacity once on finish or disconnect', () => {
    const admit = createInferenceAdmission(1);
    const first = response();
    admit(req, first, vi.fn() as unknown as NextFunction);
    first.emit('finish');
    first.emit('close');

    const next = vi.fn() as unknown as NextFunction;
    const second = response();
    admit(req, second, next);
    expect(next).toHaveBeenCalledOnce();
    second.emit('close');

    const thirdNext = vi.fn() as unknown as NextFunction;
    admit(req, response(), thirdNext);
    expect(thirdNext).toHaveBeenCalledOnce();
  });
});
