export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse an ISO timestamp to epoch milliseconds, or null when unusable. */
export function parseEpochMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Age in seconds of an ISO timestamp relative to `nowMs`. */
export function ageSeconds(value: unknown, nowMs: number): number | null {
  const epoch = parseEpochMs(value);
  if (epoch === null) return null;
  return (nowMs - epoch) / 1000;
}
