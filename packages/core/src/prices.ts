export type PriceTable = Record<string, { inputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number; outputPerMTok: number }>

// EXAMPLE VALUES, verify against current pricing before relying on cost.
// These are fake round numbers, not real model prices.
export const EXAMPLE_PRICES: PriceTable = {
  'example-model': { inputPerMTok: 1, cacheWritePerMTok: 2, cacheReadPerMTok: 0.1, outputPerMTok: 5 },
  'example-model-small': { inputPerMTok: 0.5, cacheWritePerMTok: 1, cacheReadPerMTok: 0.05, outputPerMTok: 2 },
}

export type PricesSource = 'default' | 'user' | 'example'

export const PRICES_AS_OF = '2026-10-18'

const p = (inputPerMTok: number, cacheWritePerMTok: number, cacheReadPerMTok: number, outputPerMTok: number) => ({ inputPerMTok, cacheWritePerMTok, cacheReadPerMTok, outputPerMTok })
const FABLE_5_1 = p(10, 12.5, 0.25, 50)
const FABLE_5 = p(10, 12.5, 1, 50)
const OPUS_5 = p(5, 6.25, 0.5, 25)
const OPUS_4_1 = p(15, 18.75, 1.5, 75)
const SONNET_4 = p(3, 3.75, 0.3, 15)

/**
 * Built-in USD per million tokens (5-minute cache write = 1.25 x input), as of PRICES_AS_OF.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * To refresh: re-read that page, update the rows and PRICES_AS_OF, and the docs date. Keys are normalized ids (see normalizeModelId).
 * claude-haiku-5-5 is the 100K-prompt tier only; the higher long-prompt tier is not modeled.
 */
export const DEFAULT_PRICES: PriceTable = {
  'claude-fable-5-1': FABLE_5_1,
  'claude-mythos-5-1': FABLE_5_1,
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,
  'claude-opus-5-5': p(4, 5, 0.2, 20),
  'claude-opus-5': OPUS_5,
  'claude-opus-4-8': OPUS_5,
  'claude-opus-4-7': OPUS_5,
  'claude-opus-4-6': OPUS_5,
  'claude-opus-4-5': OPUS_5,
  'claude-opus-4-1': OPUS_4_1,
  'claude-opus-4': OPUS_4_1,
  'claude-sonnet-5-5': p(2, 2.5, 0.1, 10),
  'claude-sonnet-5': p(2, 2.5, 0.2, 10),
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-sonnet-4': SONNET_4,
  'claude-haiku-5-5': p(0.1, 0.125, 0.005, 0.5),
  'claude-haiku-4-5': p(1, 1.25, 0.1, 5),
  'claude-haiku-3-5': p(0.8, 1, 0.08, 4),
}

/** Lowercase, drop a trailing `[...]` (e.g. `[1m]`) and a trailing `-YYYYMMDD`. Never throws; '' for non-strings. */
export function normalizeModelId(id: string): string {
  if (typeof id !== 'string') return ''
  return id.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').trim().replace(/-\d{8}$/, '')
}
