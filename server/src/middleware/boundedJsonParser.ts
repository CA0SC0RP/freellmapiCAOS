import type { RequestHandler } from 'express';

/**
 * Creates parser wrappers that share one process-local admission counter.
 * The slot covers only body reading/parsing, never downstream inference.
 */
export function createJsonBodyAdmission(maxConcurrent: number) {
  const limit = Number.isSafeInteger(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= 128
    ? maxConcurrent
    : 2;
  let active = 0;

  return (parser: RequestHandler): RequestHandler => (req, res, next) => {
    const contentType = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase();
    const isJson = contentType === 'application/json' ||
      (contentType.startsWith('application/') && contentType.endsWith('+json'));

    // Non-JSON requests and requests already parsed by the earlier tier do not
    // consume another slot. The parser still owns its normal type/size checks.
    if (!isJson || req.body !== undefined) {
      parser(req, res, next);
      return;
    }

    if (active >= limit) {
      res.setHeader('Retry-After', '1');
      // The body has not been consumed. Closing this connection avoids leaving
      // an oversized rejected upload occupying a keep-alive socket.
      res.setHeader('Connection', 'close');
      res.status(503).json({
        error: {
          message: 'JSON body capacity is temporarily full; retry shortly.',
          type: 'server_error',
          code: 'request_concurrency_limit',
        },
      });
      return;
    }

    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };

    try {
      parser(req, res, (err?: unknown) => {
        release();
        next(err);
      });
    } catch (err) {
      release();
      next(err);
    }
  };
}
