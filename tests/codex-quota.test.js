import assert from "node:assert/strict";
import test from "node:test";

import { IDLE_RESET_TOLERANCE_MS, normalizeCodexResetAt } from "../codex-quota.js";

const observedAtMs = 1_800_000_000_000;

function resetAt(durationMinutes, offsetMs = 0) {
  return (observedAtMs + durationMinutes * 60_000 + offsetMs) / 1000;
}

test("suppresses an unused five-hour sliding reset", () => {
  assert.equal(normalizeCodexResetAt(0, resetAt(300), 300, observedAtMs), undefined);
});

test("suppresses an unused weekly sliding reset within clock skew tolerance", () => {
  const offsetMs = IDLE_RESET_TOLERANCE_MS - 1;
  assert.equal(normalizeCodexResetAt(0, resetAt(10_080, offsetMs), 10_080, observedAtMs), undefined);
});

test("preserves an anchored zero-percent reset once it is no longer tracking now", () => {
  const offsetMs = -(IDLE_RESET_TOLERANCE_MS + 1);
  const value = resetAt(300, offsetMs);
  assert.equal(normalizeCodexResetAt(0, value, 300, observedAtMs), value);
});

test("preserves reset timestamps whenever usage is non-zero", () => {
  const value = resetAt(300);
  assert.equal(normalizeCodexResetAt(0.1, value, 300, observedAtMs), value);
});
