// Rate limiting for the /api/ai/* routes (PLAN.md §11.4, "rate limits only").
//
// One small interface covers both limits the routes need: requests per client IP, and detail calls
// per repo digest. It is a fixed-window counter, which maps directly onto Redis `INCR` + `PEXPIRE`,
// so a Redis-backed implementation can replace the in-memory one without touching the handlers.
//
// The in-memory limiter is BEST EFFORT on serverless: each function instance has its own counters,
// instances are created and discarded freely, and the four routes are four separate functions. It
// slows down a single noisy client; it is not a security boundary. A production deployment should
// add a Vercel Firewall rate-limit rule on /api/ai/* and a spend limit on the provider account.

export interface LimitResult {
  allowed: boolean;
  /** Events counted for this key in the current window, including this one. */
  count: number;
  /** How long until the window resets, in ms. Meaningful when `allowed` is false. */
  retryAfterMs: number;
}

export interface Limiter {
  /** Count one event against `key`. Allowed while the count in the current window is ≤ `limit`. */
  hit(key: string, limit: number, windowMs: number, now: number): Promise<LimitResult>;
}

/** Sweep expired windows once the table grows past this many keys. */
const SWEEP_ABOVE = 5000;

export function createMemoryLimiter(): Limiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async hit(key, limit, windowMs, now) {
      if (windows.size > SWEEP_ABOVE) {
        for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
      }
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      return { allowed: w.count <= limit, count: w.count, retryAfterMs: Math.max(0, w.start + windowMs - now) };
    },
  };
}

/**
 * The client address from the standard forwarding headers. On Vercel `x-forwarded-for` is set by
 * the platform and cannot be spoofed by the client; behind any other proxy, trust it only if that
 * proxy overwrites it.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip')?.trim() || 'unknown';
}
