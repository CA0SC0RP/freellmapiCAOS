import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createJsonBodyAdmission } from '../../middleware/boundedJsonParser.js';

function request(contentType = 'application/json'): Request {
  return { headers: { 'content-type': contentType }, body: undefined } as unknown as Request;
}

function response() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    statusCode: 200,
    payload: undefined as unknown,
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.payload = payload; return this; },
  };
  return res as unknown as Response & typeof res;
}

describe('bounded JSON body parser admission', () => {
  it('rejects excess concurrent parses and releases capacity when parsing completes', () => {
    const admit = createJsonBodyAdmission(1);
    let finishFirst!: (err?: unknown) => void;
    const parser: RequestHandler = (_req, _res, next) => { finishFirst = next; };
    const wrapped = admit(parser);
    const next = vi.fn() as unknown as NextFunction;

    wrapped(request(), response(), next);
    const rejected = response();
    wrapped(request(), rejected, next);

    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers['retry-after']).toBe('1');
    expect(rejected.headers.connection).toBe('close');
    expect(rejected.payload).toMatchObject({
      error: { code: 'request_concurrency_limit', type: 'server_error' },
    });

    finishFirst();
    const thirdNext = vi.fn() as unknown as NextFunction;
    let finishThird!: (err?: unknown) => void;
    const third = admit((_req, _res, done) => { finishThird = done; });
    third(request(), response(), thirdNext);
    expect(finishThird).toBeTypeOf('function');
    finishThird();
    expect(thirdNext).toHaveBeenCalledOnce();
  });

  it('shares admission across parser wrappers and releases the slot on parser errors', () => {
    const admit = createJsonBodyAdmission(1);
    let finish!: (err?: unknown) => void;
    const firstParser: RequestHandler = (_req, _res, next) => { finish = next; };
    const secondParser: RequestHandler = (_req, _res, next) => next();
    const first = admit(firstParser);
    const second = admit(secondParser);
    first(request(), response(), vi.fn() as unknown as NextFunction);

    const blocked = response();
    second(request(), blocked, vi.fn() as unknown as NextFunction);
    expect(blocked.statusCode).toBe(503);

    const next = vi.fn() as unknown as NextFunction;
    finish(new Error('invalid JSON'));
    expect(next).toHaveBeenCalledWith(expect.any(Error));

    const nextAfterError = vi.fn() as unknown as NextFunction;
    second(request(), response(), nextAfterError);
    expect(nextAfterError).toHaveBeenCalledOnce();
    expect(nextAfterError).toHaveBeenCalledWith();
  });

  it('does not consume admission capacity for non-JSON content types', () => {
    const admit = createJsonBodyAdmission(1);
    let finish!: (err?: unknown) => void;
    const parser: RequestHandler = (_req, _res, next) => { finish = next; };
    const wrapped = admit(parser);
    wrapped(request('text/plain'), response(), vi.fn() as unknown as NextFunction);

    const jsonNext = vi.fn() as unknown as NextFunction;
    const jsonParser: RequestHandler = (_req, _res, next) => next();
    admit(jsonParser)(request(), response(), jsonNext);
    expect(jsonNext).toHaveBeenCalledOnce();
    finish();
  });
});
