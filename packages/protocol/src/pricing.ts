import { processedTokens, type TokenTotals } from './core.js';

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
 *
 * Re-read 2026-09-04. Since the 2026-08-20 pass OpenAI has cut `gpt-5.6-sol`
 * (5/30 → 4/20, and it is 47.9% of the office's Codex tokens) and `gpt-5.3-codex`
 * (3.5/28 → 1.75/14), and published `gpt-5.5` and `gpt-6-astra`. Anthropic has
 * added Fable 5.1, Mythos 5/5.1, Opus 4.5 and Sonnet 4.5; every rate already
 * listed was unchanged.
 */
export const PRICING = {
  asOf: '2026-09-04',
  models: {
    // ------------------------------------------------------------ Anthropic
    // `cacheWrite` is the 5-minute write rate (1.25x input), which is what
    // Claude Code uses by default; `cacheRead` is 0.1x input. The 1-hour write
    // rate (2x input) is not modelled — the collector cannot tell the two
    // apart, and the 5-minute rate is the one that is actually billed here.
    //
    // Fable 5.1 is the one row where the read multiplier is not 0.1: Anthropic
    // prices cache hits on it at 0.025x base input. Transcribed from the table
    // rather than derived from the neighbouring Fable 5 row, which would have
    // been wrong by 4x on the field that dominates every Claude Code day.
    'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    // Sonnet 5's $2/$10 began as introductory pricing and has since become the
    // standard price; the scheduled rise to $3/$15 will not happen.
    'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    // Claude Mythos 5 and 5.1 are on the page and are deliberately absent.
    // They are limited-availability models nobody in the office has run, so
    // their API id strings have never been observed — and inventing the string
    // `claude-mythos-5-1` to hang a price on is the same class of guess as
    // inventing the price. An unpriced day says so; a wrong key says nothing.

    // --------------------------------------------------------------- OpenAI
    // OpenAI publishes input, *cached input*, and output — and no separate
    // cache-*write* charge, because writing to cache bills at the ordinary
    // input price. So `cacheWrite` equals `input` on every row below by
    // design; it is not a copy-paste slip, and it is not the Anthropic 1.25x
    // rule with a typo. `cacheRead` is the published cached-input price.
    // Sol's 4/20 is promotional — the page holds it "at least through
    // November 21, 2026". If a day suddenly looks pricier after that, re-read
    // the page before assuming a bug.
    'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 4 },
    'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 10 },
    'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
    'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.2 },
    'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
    'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
    // Published but not seen locally; harmless to carry, and saves a refresh
    // the first time somebody in the office runs one.
    'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
    'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
    'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
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

/** A day priced as far as it can be priced. See `estimateCostFloorUsd`. */
export interface CostFloor {
  /**
   * The priced models' sum. A *lower bound* on the day when `exact` is false,
   * and the day's whole cost when it is true. Never null: a day where nothing
   * could be priced floors at 0, and 0 is not a claim about the total — it is
   * the claim that we can vouch for nothing, which callers must not print as
   * a dollar figure.
   */
  usd: number;
  /** True when every model here had a price, and `usd` is therefore the total. */
  exact: boolean;
  /** The models with no published price, heaviest first. Empty when `exact`. */
  unpriced: string[];
}

/**
 * The same day as a floor, for when `estimateCostUsd`'s null is unusable.
 *
 * The null contract above is right and stays: a day containing one unpriced
 * model has no knowable total, and a partial sum printed as "est. $12.40"
 * would be a smaller number wearing a complete number's clothes. But on real
 * data the null swallows almost everything — `codex-auto-review` (26.7% of the
 * office's Codex tokens, deliberately unpriced) alone blanks 41 of 41 Codex
 * days, while 0 of 44 Claude Code days blank. The cost column dies exactly
 * where it is most worth having.
 *
 * A floor is the third answer. "At least $12.40" is not a partial total
 * pretending to be whole — it makes the partiality the point, and it is the
 * strongest honest statement available: the priced share is money that was
 * definitely spent, and the unpriced share can only add. Callers get `exact`
 * so a floor can be *rendered* as a floor; a floor rendered as an estimate
 * would be the undercount this whole contract exists to prevent.
 *
 * Every entry given is counted, zero-token rows included, so `exact` is false
 * on exactly the days `estimateCostUsd` would null — one rule, two functions,
 * no daylight between them.
 */
export function estimateCostFloorUsd(byModel: Record<string, TokenTotals>): CostFloor {
  let usd = 0;
  // Heaviest first, so a caller naming one or two of these in a tooltip names
  // the ones that account for most of the missing money.
  const unpriced: { model: string; weight: number }[] = [];
  for (const [model, tokens] of Object.entries(byModel)) {
    const cost = estimateCostUsd(model, tokens);
    if (cost === null) unpriced.push({ model, weight: processedTokens(tokens) });
    else usd += cost;
  }
  unpriced.sort((a, b) => b.weight - a.weight);
  return { usd, exact: unpriced.length === 0, unpriced: unpriced.map((u) => u.model) };
}
