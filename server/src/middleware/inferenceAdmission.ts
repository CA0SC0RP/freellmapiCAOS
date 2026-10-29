import type { Request, Response, NextFunction } from 'express';

/** Process-local admission gate held through the full response, including SSE. */
export function createInferenceAdmission(maxConcurrent: number) {
  const limit = Number.isSafeInteger(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= 128
    ? maxConcurrent
    : 8;
  let active = 0;

  return function inferenceAdmission(_req: Request, res: Response, next: NextFunction): void {
    if (active >= limit) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({
        error: {
          message: 'Inference capacity is temporarily full; retry shortly.',
          type: 'server_error',
          code: 'inference_concurrency_limit',
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

    res.once('finish', release);
    res.once('close', release);
    try {
      next();
    } catch (err) {
      release();
      next(err);
    }
  };
}
