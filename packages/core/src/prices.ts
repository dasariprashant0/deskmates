export type PriceTable = Record<string, { inputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number; outputPerMTok: number }>

// EXAMPLE VALUES, verify against current pricing before relying on cost.
// These are fake round numbers, not real model prices.
export const EXAMPLE_PRICES: PriceTable = {
  'example-model': { inputPerMTok: 1, cacheWritePerMTok: 2, cacheReadPerMTok: 0.1, outputPerMTok: 5 },
  'example-model-small': { inputPerMTok: 0.5, cacheWritePerMTok: 1, cacheReadPerMTok: 0.05, outputPerMTok: 2 },
}
