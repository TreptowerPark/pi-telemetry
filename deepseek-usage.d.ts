export type DeepSeekPricingFamily = "flash" | "pro";

export interface DeepSeekTokenRates {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

export interface DeepSeekUsageInput {
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  outputTokens?: number;
}

export interface DeepSeekUsageCost {
  family: DeepSeekPricingFamily;
  peak: boolean;
  rates: DeepSeekTokenRates;
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  cost: number;
  cacheSaved: number;
}

export function getDeepSeekPricingFamily(modelId: string, timestampMs?: number): DeepSeekPricingFamily | undefined;
export function isDeepSeekPeakAt(timestampMs?: number): boolean;
export function calculateDeepSeekUsageCost(
  modelId: string,
  usage: DeepSeekUsageInput,
  timestampMs?: number,
): DeepSeekUsageCost | undefined;
