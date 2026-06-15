import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pinPolicyError } from './pinPolicy';

// ─── strong PINs are accepted ────────────────────────────────────────────
test('a non-trivial 6-digit PIN is accepted', () => {
  assert.equal(pinPolicyError('246803'), null);
  assert.equal(pinPolicyError('907152'), null);
});

// ─── AUTH-3: reuse is rejected ───────────────────────────────────────────
test('changing the PIN to the same value is rejected', () => {
  assert.notEqual(pinPolicyError('246803', '246803'), null);
});

test('a genuinely changed PIN passes the reuse check', () => {
  assert.equal(pinPolicyError('246803', '999111'), null);
});

// ─── AUTH-3: trivially weak PINs are rejected ────────────────────────────
test('all-same-digit PINs are rejected', () => {
  for (const p of ['000000', '111111', '999999']) {
    assert.notEqual(pinPolicyError(p), null, `${p} should be rejected`);
  }
});

test('simple ascending/descending sequences are rejected', () => {
  for (const p of ['123456', '234567', '345678', '654321', '543210']) {
    assert.notEqual(pinPolicyError(p), null, `${p} should be rejected`);
  }
});

// ─── format guard (defense in depth alongside the Zod /^\d{6}$/) ─────────
test('non-6-digit input is rejected', () => {
  assert.notEqual(pinPolicyError('12345'), null);
  assert.notEqual(pinPolicyError('1234567'), null);
  assert.notEqual(pinPolicyError('12a456'), null);
});
