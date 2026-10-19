const DEFAULT_WINDOW = 200_000
const BIG_WINDOW = 1_000_000

/** ASSUMED from the model id: `[1m]` or `-1m` means 1M, anything else 200K. The transcript does not carry the real limit. */
export const contextWindowFor = (model?: string): number => (model !== undefined && /\[1m\]|-1m(?![a-z0-9])/i.test(model) ? BIG_WINDOW : DEFAULT_WINDOW)

/** 0..1; bad input counts as 0. */
export const contextShare = (tokens: number, window: number): number =>
  Number.isFinite(tokens) && Number.isFinite(window) && window > 0 ? Math.min(1, Math.max(0, tokens / window)) : 0

const size = (w: number): string => (w >= 1_000_000 ? `${w / 1_000_000}M` : `${Math.round(w / 1000)}K`)

/** Whole percent of the assumed window, or undefined when the token count is missing, negative or not finite. */
export const contextPercent = (tokens: number | undefined, model?: string): number | undefined =>
  tokens === undefined || !Number.isFinite(tokens) || tokens < 0 ? undefined : Math.round(contextShare(tokens, contextWindowFor(model)) * 100)

export function contextLabel(tokens: number | undefined, model?: string): string {
  const pct = contextPercent(tokens, model)
  if (pct === undefined) return 'unknown'
  const w = contextWindowFor(model)
  return `${pct}% of ${size(w)} (assumed window)`
}
