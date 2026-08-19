import type { TokenTotals } from './core.js';

/**
 * Published list prices, per million tokens. MUST be sourced from official
 * documentation — consult the `claude-api` skill when writing or refreshing
 * this table, never memory. A model missing here yields a null cost, which
 * the UI renders as an em dash: an honest gap beats a confident wrong number.
 */
export const PRICING = {
  /** Empty until Task 17 fills it from official documentation. */
  asOf: '',
  models: {} as Record<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number }
  >,
} as const;

/**
 * Returns `null` — never `0` — when `model` has no entry in `PRICING.models`.
 * The two must stay distinguishable: `null` means "we don't know the price"
 * (the UI renders "—"), `0` would mean "this model is free," which is not a
 * claim we can make on an empty table.
 */
export function estimateCostUsd(model: string, tokens: TokenTotals): number | null {
  const rate = PRICING.models[model];
  if (!rate) return null;
  return (
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheRead * rate.cacheRead +
      tokens.cacheWrite * rate.cacheWrite) /
    1_000_000
  );
}
