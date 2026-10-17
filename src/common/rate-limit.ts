import type { RequestHandler } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

export function createRateLimit(options: { windowMs: number; limit: number }): RequestHandler {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep >= options.windowMs) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      lastSweep = now;
    }

    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const previous = buckets.get(key);
    const bucket = !previous || previous.resetAt <= now
      ? { count: 1, resetAt: now + options.windowMs }
      : { count: previous.count + 1, resetAt: previous.resetAt };
    buckets.set(key, bucket);

    const remaining = Math.max(0, options.limit - bucket.count);
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('RateLimit-Policy', `"${options.limit}-in-${Math.ceil(options.windowMs / 1000)}sec"; q=${options.limit}; w=${Math.ceil(options.windowMs / 1000)}`);
    res.setHeader('RateLimit', `limit=${options.limit}, remaining=${remaining}, reset=${resetSeconds}`);

    if (bucket.count > options.limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests; try again later' } });
      return;
    }
    next();
  };
}
