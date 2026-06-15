// Pure decision logic for refresh-token rotation hygiene. Kept dependency-free
// so the branching is unit-tested without a DB.

export type RefreshReuseAction =
  | 'grace' //  re-mint the live replacement (a dropped rotation response on a flaky link)
  | 'breach' // an already-superseded token is being replayed → treat as theft
  | 'reject'; //  nothing safe to do → fail the refresh

/**
 * AUTH-2: classify presentation of an already-REVOKED refresh token.
 *
 * - replacement still live (not revoked, not expired) → `grace`: the legitimate
 *   client never received the rotated response; re-mint instead of locking out.
 * - replacement itself already revoked → `breach`: the chain has moved on, so an
 *   old token is being replayed — a theft signal that should revoke the chain.
 * - otherwise (no chain pointer, missing replacement, expired replacement) →
 *   `reject`.
 */
export function classifyRevokedRefreshReuse(
  stored: { replacedById: string | null },
  replacement: { revokedAt: Date | null; expiresAt: Date } | null,
  now: number
): RefreshReuseAction {
  if (!stored.replacedById || !replacement) return 'reject';
  if (replacement.revokedAt) return 'breach';
  if (replacement.expiresAt.getTime() < now) return 'reject';
  return 'grace';
}

/**
 * AUTH-4: a refresh-token row is prunable when it is expired, or it has been
 * revoked for longer than the grace window (kept briefly so the grace-re-mint
 * path above can still resolve a dropped rotation).
 */
export function shouldPruneRefreshToken(
  row: { expiresAt: Date; revokedAt: Date | null },
  now: number,
  graceMs: number
): boolean {
  if (row.expiresAt.getTime() < now) return true;
  if (row.revokedAt && row.revokedAt.getTime() < now - graceMs) return true;
  return false;
}
