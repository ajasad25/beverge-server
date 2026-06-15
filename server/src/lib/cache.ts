// Tiny in-process TTL cache with request coalescing.
//
// Two wins for read-heavy dashboard endpoints:
//  1. Repeat loads within the TTL skip the DB entirely (instant).
//  2. Coalescing: N concurrent callers for the same key share ONE in-flight
//     computation instead of each hammering the DB. (e.g. several admins
//     opening the same dashboard at once now cost one aggregation, not N.)
//
// Deliberately process-local and dependency-free — fine for the single API
// instance this system runs (SRS scale: <10 staff). If the API is ever scaled
// horizontally, swap this for Redis behind the same signature.

type Entry<T> = { expiresAt: number; value: Promise<T> };

const store = new Map<string, Entry<unknown>>();

/**
 * Return the cached value for `key`, or compute it with `fn`, cache it for
 * `ttlMs`, and return it. A rejected computation is not cached.
 */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  const value = fn().catch((err) => {
    // Don't let a transient failure stick in the cache.
    if (store.get(key)?.value === value) store.delete(key);
    throw err;
  });
  store.set(key, { expiresAt: now + ttlMs, value });
  return value;
}

/** Drop cache entries whose key starts with `prefix` (e.g. after a mutation). */
export function invalidate(prefix: string): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
