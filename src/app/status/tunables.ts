// Timings of the status lines and cards that have no key in config.json yet.
export const STATUS_LOCAL = {
  /** How long a line that fades stays before it starts to. */
  lineMs: 9000,
  /** How long the fade takes. Matches `gm-status-fade` in progress.css. */
  fadeMs: 600,
  /** How long a lost graphics context is given to come back before the card offers "Reload". */
  contextWaitMs: 4000,
  /** How long the waiting screen shows one unchanged stage before it adds "Still working". */
  stillWorkingMs: 12000,
} as const;
