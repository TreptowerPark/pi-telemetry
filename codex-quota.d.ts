export const IDLE_RESET_TOLERANCE_MS: number;

export function normalizeCodexResetAt(
  usedPercent: number | undefined,
  resetsAt: number | undefined,
  durationMinutes: number,
  observedAtMs?: number,
): number | undefined;
