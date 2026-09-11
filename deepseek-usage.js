const ONE_MILLION = 1_000_000;

const FLASH_RATES = {
  offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
  peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
};

const PRO_RATES = {
  offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
};

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function getDeepSeekPricingFamily(modelId) {
  if (typeof modelId !== "string") return undefined;
  const id = modelId.toLowerCase();
  if (id.includes("v4-pro")) return "pro";
  if (id.includes("v4-flash") || id === "deepseek-chat" || id === "deepseek-reasoner") return "flash";
  return undefined;
}

export function isDeepSeekPeakAt(timestampMs = Date.now()) {
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return false;

  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;

  const utcHour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  return (utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10);
}

export function calculateDeepSeekUsageCost(modelId, usage, timestampMs = Date.now()) {
  const family = getDeepSeekPricingFamily(modelId);
  if (!family) return undefined;

  const peak = isDeepSeekPeakAt(timestampMs);
  const rates = (family === "pro" ? PRO_RATES : FLASH_RATES)[peak ? "peak" : "offPeak"];
  const cacheHitTokens = finiteNonNegative(usage?.cacheHitTokens);
  const cacheMissTokens = finiteNonNegative(usage?.cacheMissTokens);
  const outputTokens = finiteNonNegative(usage?.outputTokens);

  const cost =
    (cacheHitTokens * rates.cacheHit + cacheMissTokens * rates.cacheMiss + outputTokens * rates.output) / ONE_MILLION;
  const cacheSaved = (cacheHitTokens * Math.max(0, rates.cacheMiss - rates.cacheHit)) / ONE_MILLION;

  return {
    family,
    peak,
    rates,
    cacheHitTokens,
    cacheMissTokens,
    outputTokens,
    cost,
    cacheSaved,
  };
}
