export const IDLE_RESET_TOLERANCE_MS = 15_000;

/**
 * OpenAI can expose an unused rolling quota window with usedPercent=0 and a
 * placeholder reset time that tracks roughly "now + window duration". That
 * timestamp is not an anchored reset deadline, so suppress it until the
 * provider reports evidence of an active window.
 */
export function normalizeCodexResetAt(usedPercent, resetsAt, durationMinutes, observedAtMs = Date.now()) {
  if (usedPercent !== 0 || resetsAt === undefined) return resetsAt;
  if (!Number.isFinite(resetsAt) || !Number.isFinite(durationMinutes) || !Number.isFinite(observedAtMs)) {
    return resetsAt;
  }
  if (durationMinutes <= 0) return resetsAt;

  const expectedIdleResetMs = observedAtMs + durationMinutes * 60_000;
  const actualResetMs = resetsAt * 1000;
  return Math.abs(actualResetMs - expectedIdleResetMs) <= IDLE_RESET_TOLERANCE_MS ? undefined : resetsAt;
}
