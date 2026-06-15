// AUTH-3: minimal PIN-hygiene policy applied on change-PIN (self) and admin
// reset, on top of the Zod /^\d{6}$/ format check. Rejects reusing the current
// PIN and the most trivially-guessable values (all-same-digit, strict ±1
// sequences). Pure + dependency-free so it is unit-tested without bcrypt.

function isAllSameDigit(pin: string): boolean {
  return /^(\d)\1{5}$/.test(pin);
}

function isConsecutiveSequence(pin: string): boolean {
  const d = pin.split('').map(Number);
  const step = d[1]! - d[0]!;
  if (step !== 1 && step !== -1) return false;
  return d.every((n, i) => i === 0 || n - d[i - 1]! === step);
}

/**
 * Returns a human-readable rejection message, or null if the PIN is acceptable.
 * Pass `oldPin` on the self change-PIN path to forbid a no-op reuse; omit it on
 * the admin-reset path (the admin does not know the current PIN).
 */
export function pinPolicyError(newPin: string, oldPin?: string): string | null {
  if (!/^\d{6}$/.test(newPin)) return 'PIN must be exactly 6 digits';
  if (oldPin !== undefined && newPin === oldPin) {
    return 'New PIN must be different from the current PIN';
  }
  if (isAllSameDigit(newPin) || isConsecutiveSequence(newPin)) {
    return 'PIN is too easy to guess; avoid repeated digits or simple sequences';
  }
  return null;
}
