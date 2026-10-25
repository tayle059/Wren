// Simple in-memory sliding-window limits, keyed by things like IP address.
// Account lockout (per email) lives in the database; this guards everything else.
import { now } from '../util/time.ts';

const buckets = new Map<string, number[]>();

/** Records an attempt and returns true if it's still within the limit. */
export function allow(key: string, max: number, windowMs: number): boolean {
  const t = now().getTime();
  const recent = (buckets.get(key) ?? []).filter((x) => t - x < windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(t);
  buckets.set(key, recent);
  return true;
}

export function resetLimits() {
  buckets.clear();
}

// Keep memory bounded on long-running servers.
setInterval(() => {
  const t = now().getTime();
  for (const [k, v] of buckets) if (!v.some((x) => t - x < 3600_000)) buckets.delete(k);
}, 600_000).unref();
