import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRevokedRefreshReuse, shouldPruneRefreshToken } from './refreshTokenPolicy';

const NOW = Date.UTC(2026, 5, 12, 12, 0, 0); // fixed instant
const future = new Date(NOW + 86_400_000);
const past = new Date(NOW - 86_400_000);

// ─── AUTH-2: classifying reuse of a REVOKED refresh token ────────────────
test('a revoked token with no replacement (e.g. logged out) is a plain reject', () => {
  assert.equal(classifyRevokedRefreshReuse({ replacedById: null }, null, NOW), 'reject');
});

test('a revoked token whose replacement is still live → grace re-mint (lost response)', () => {
  const action = classifyRevokedRefreshReuse(
    { replacedById: 'repl' },
    { revokedAt: null, expiresAt: future },
    NOW
  );
  assert.equal(action, 'grace');
});

test('a revoked token whose replacement was ALSO rotated → breach (theft signal)', () => {
  const action = classifyRevokedRefreshReuse(
    { replacedById: 'repl' },
    { revokedAt: past, expiresAt: future },
    NOW
  );
  assert.equal(action, 'breach');
});

test('a revoked token whose replacement has expired (not revoked) → reject', () => {
  const action = classifyRevokedRefreshReuse(
    { replacedById: 'repl' },
    { revokedAt: null, expiresAt: past },
    NOW
  );
  assert.equal(action, 'reject');
});

test('a revoked token whose replacement row is missing → reject', () => {
  assert.equal(classifyRevokedRefreshReuse({ replacedById: 'gone' }, null, NOW), 'reject');
});

// ─── AUTH-4: which rows the nightly prune should delete ──────────────────
const GRACE = 7 * 86_400_000;

test('an expired token is prunable', () => {
  assert.equal(shouldPruneRefreshToken({ expiresAt: past, revokedAt: null }, NOW, GRACE), true);
});

test('a live, never-revoked token is kept', () => {
  assert.equal(shouldPruneRefreshToken({ expiresAt: future, revokedAt: null }, NOW, GRACE), false);
});

test('a token revoked within the grace window is kept', () => {
  const revokedAt = new Date(NOW - 3 * 86_400_000); // 3d ago < 7d grace
  assert.equal(shouldPruneRefreshToken({ expiresAt: future, revokedAt }, NOW, GRACE), false);
});

test('a token revoked long ago (past the grace window) is prunable', () => {
  const revokedAt = new Date(NOW - 14 * 86_400_000); // 14d ago > 7d grace
  assert.equal(shouldPruneRefreshToken({ expiresAt: future, revokedAt }, NOW, GRACE), true);
});
