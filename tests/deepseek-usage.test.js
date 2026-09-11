import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateDeepSeekUsageCost,
  getDeepSeekPricingFamily,
  isDeepSeekPeakAt,
} from "../deepseek-usage.js";

const beforeProRouting = Date.parse("2026-09-11T12:00:00Z");
const afterProRouting = Date.parse("2026-09-14T04:00:00Z");

test("classifies current and legacy DeepSeek Flash model ids", () => {
  assert.equal(getDeepSeekPricingFamily("deepseek-flash", beforeProRouting), "flash");
  assert.equal(getDeepSeekPricingFamily("deepseek-v4-flash", beforeProRouting), "flash");
  assert.equal(getDeepSeekPricingFamily("deepseek-v4-flash-vision-exp", beforeProRouting), "flash");
});

test("switches the V4 Pro route to Flash pricing at the announced cutover", () => {
  assert.equal(getDeepSeekPricingFamily("deepseek-v4-pro", beforeProRouting), "pro");
  assert.equal(getDeepSeekPricingFamily("deepseek-v4-pro", afterProRouting), "flash");
});

test("detects weekday peak windows in UTC and keeps weekends off-peak", () => {
  assert.equal(isDeepSeekPeakAt(Date.parse("2026-09-14T02:00:00Z")), true);
  assert.equal(isDeepSeekPeakAt(Date.parse("2026-09-14T05:00:00Z")), false);
  assert.equal(isDeepSeekPeakAt(Date.parse("2026-09-14T06:00:00Z")), true);
  assert.equal(isDeepSeekPeakAt(Date.parse("2026-09-14T10:00:00Z")), false);
  assert.equal(isDeepSeekPeakAt(Date.parse("2026-09-13T02:00:00Z")), false);
});

test("calculates V4.1 Flash off-peak cost and cache savings", () => {
  const result = calculateDeepSeekUsageCost(
    "deepseek-flash",
    { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, outputTokens: 1_000_000 },
    Date.parse("2026-09-11T12:00:00Z"),
  );
  assert.ok(result);
  assert.equal(result.peak, false);
  assert.ok(Math.abs(result.cost - 0.753) < 1e-12);
  assert.ok(Math.abs(result.cacheSaved - 0.147) < 1e-12);
});

test("calculates V4.1 Flash peak cost and cache savings", () => {
  const result = calculateDeepSeekUsageCost(
    "deepseek-flash",
    { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, outputTokens: 1_000_000 },
    Date.parse("2026-09-11T02:00:00Z"),
  );
  assert.ok(result);
  assert.equal(result.peak, true);
  assert.ok(Math.abs(result.cost - 1.506) < 1e-12);
  assert.ok(Math.abs(result.cacheSaved - 0.294) < 1e-12);
});

test("uses V4 Pro pricing before its routing cutover", () => {
  const result = calculateDeepSeekUsageCost(
    "deepseek-v4-pro",
    { cacheHitTokens: 1_000_000, cacheMissTokens: 0, outputTokens: 0 },
    Date.parse("2026-09-11T12:00:00Z"),
  );
  assert.ok(result);
  assert.equal(result.family, "pro");
  assert.ok(Math.abs(result.cost - 0.022) < 1e-12);
});
