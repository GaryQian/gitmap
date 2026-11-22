// Values of the client orchestration that have no config.json entry yet. They sit here, in one
// place, until the lead adds them to the `ai` block.
export const CLIENT_LOCAL = {
  /** City summaries requested at the same time (the map step). */
  summaryConcurrency: 4,
  /**
   * How long the points-of-interest request runs alone before the tour request is sent. The two
   * share a cached prompt prefix, and the provider can only serve the second from the cache once
   * the first has begun responding; sent at the same instant, both pay for the whole digest.
   */
  reduceHeadStartMs: 3000,
  /** A rate-limited request is retried once when the server asks for no more than this wait. */
  maxRetryAfterSeconds: 5,
} as const;
