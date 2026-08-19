import type { TokenTotals } from './core.js';

/** USD per million tokens, one row of the published table. */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Published list prices, per million tokens, read from the vendors' own
 * documentation on `asOf`. MUST be refreshed by re-reading those pages —
 * never from memory, and never by interpolating a missing model from a
 * neighbouring one:
 *
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI:    https://developers.openai.com/api/docs/pricing
 *
 * A model missing here yields a null cost, and a day containing any unpriced
 * model surfaces null rather than a partial total. Two strings are left out
 * deliberately even though both occur locally: `codex-auto-review`, which
 * OpenAI does not publish a price for, and `<synthetic>`, which is not a model.
 * Neither absence is an oversight — see `estimateCostUsd`.
 */
export const PRICING = {
  asOf: '2026-08-20',
  models: {
    // ------------------------------------------------------------ Anthropic
    // `cacheWrite` is the 5-minute write rate (1.25x input), which is what
    // Claude Code uses by default; `cacheRead` is 0.1x input. The 1-hour write
    // rate (2x input) is not modelled — the collector cannot tell the two
    // apart, and the 5-minute rate is the one that is actually billed here.
    'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    // Sonnet 5's $2/$10 began as introductory pricing and has since become the
    // standard price; the scheduled rise to $3/$15 will not happen.
    'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },

    // --------------------------------------------------------------- OpenAI
    // OpenAI publishes input, *cached input*, and output — and no separate
    // cache-*write* charge, because writing to cache bills at the ordinary
    // input price. So `cacheWrite` equals `input` on every row below by
    // design; it is not a copy-paste slip, and it is not the Anthropic 1.25x
    // rule with a typo. `cacheRead` is the published cached-input price.
    'gpt-5.6-sol': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
    'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
    'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.2 },
    'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
    // Published but not seen locally; harmless to carry, and saves a refresh
    // the first time somebody in the office runs one.
    'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
    'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
    'gpt-5.3-codex': { input: 3.5, output: 28, cacheRead: 0.35, cacheWrite: 3.5 },
  } as Record<string, ModelRate>,
} as const;

/** A trailing `-YYYYMMDD`, the one variation the lookup will retry without. */
const DATED_SUFFIX = /-\d{8}$/;

/**
 * The exact string first, then one retry with a trailing date stripped.
 *
 * Claude Code reports Haiku as `claude-haiku-4-5-20251001` while every other
 * Claude string arrives bare, so the dated form has to resolve. The retry stops
 * there on purpose: matching by prefix or nearest-neighbour would start
 * *guessing* prices, and a confidently wrong number is worse than no number.
 */
function rateFor(model: string): ModelRate | undefined {
  const exact = PRICING.models[model];
  if (exact) return exact;
  const undated = model.replace(DATED_SUFFIX, '');
  return undated === model ? undefined : PRICING.models[undated];
}

/**
 * Returns `null` — never `0` — when `model` has no entry in `PRICING.models`.
 * The two must stay distinguishable: `null` means "we don't know the price"
 * (the UI says so in as many words), `0` means "this genuinely cost nothing",
 * which is the right answer for a priced model that burned no tokens.
 */
export function estimateCostUsd(model: string, tokens: TokenTotals): number | null {
  const rate = rateFor(model);
  if (!rate) return null;
  return (
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheRead * rate.cacheRead +
      tokens.cacheWrite * rate.cacheWrite) /
    1_000_000
  );
}
