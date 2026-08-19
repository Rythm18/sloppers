import { describe, expect, it } from 'vitest';
import type { TokenTotals } from './core.js';
import { estimateCostUsd, PRICING } from './index.js';

const M = 1_000_000;

/** One field moves, the rest stay zero, so a rate can never hide behind another. */
function only(field: keyof TokenTotals, n: number): TokenTotals {
  const t: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  t[field] = n;
  return t;
}

/**
 * Cache rates as multiples of the input rate, rounded past float noise
 * (0.3 / 3 is 0.09999999999999999, not 0.1).
 */
function ratioTable(
  pick: (model: string) => boolean,
): Record<string, { write: number; read: number }> {
  const out: Record<string, { write: number; read: number }> = {};
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  for (const [model, rate] of Object.entries(PRICING.models)) {
    if (!pick(model)) continue;
    out[model] = {
      write: round(rate.cacheWrite / rate.input),
      read: round(rate.cacheRead / rate.input),
    };
  }
  return out;
}

/**
 * The ledger's fold, mirrored: a day is priced by summing its (model, totals)
 * buckets, and one unpriced model makes the whole day unknown. Tested here as
 * well as in the server so the rule is pinned against the *real* model strings
 * the corpus contains, not a stand-in.
 */
function dayCost(buckets: [string, TokenTotals][]): number | null {
  let total: number | null = 0;
  for (const [model, tokens] of buckets) {
    const cost = estimateCostUsd(model, tokens);
    total = cost === null || total === null ? null : total + cost;
  }
  return total;
}

describe('pricing', () => {
  it('is stamped with the date it was sourced', () => {
    expect(PRICING.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICING.asOf).toBe('2026-08-20');
  });

  it('prices a known model and refuses to guess an unknown one', () => {
    const known = Object.keys(PRICING.models)[0];
    if (!known) throw new Error('pricing table is empty');
    expect(estimateCostUsd(known, only('input', M))).toBeGreaterThan(0);
    expect(estimateCostUsd('not-a-model', only('input', M))).toBeNull();
  });

  it('bills each token class at its own published rate', () => {
    // claude-opus-5: 5 in / 25 out / 0.50 cache read / 6.25 cache write.
    expect(estimateCostUsd('claude-opus-5', only('input', M))).toBe(5);
    expect(estimateCostUsd('claude-opus-5', only('output', M))).toBe(25);
    expect(estimateCostUsd('claude-opus-5', only('cacheRead', M))).toBe(0.5);
    expect(estimateCostUsd('claude-opus-5', only('cacheWrite', M))).toBe(6.25);
  });

  it('adds the four classes together', () => {
    // gpt-5.6-luna: 0.20 in / 1.20 out / 0.02 read / 0.20 write.
    const cost = estimateCostUsd('gpt-5.6-luna', {
      input: M,
      output: M,
      cacheRead: M,
      cacheWrite: M,
    });
    expect(cost).toBeCloseTo(0.2 + 1.2 + 0.02 + 0.2, 10);
  });

  it('scales linearly below a million tokens', () => {
    expect(estimateCostUsd('claude-opus-5', only('input', 200_000))).toBe(1);
    expect(estimateCostUsd('claude-opus-5', only('input', 1))).toBeCloseTo(5e-6, 12);
  });

  it('charges a priced model nothing for zero tokens — free is not unknown', () => {
    expect(estimateCostUsd('claude-opus-5', only('input', 0))).toBe(0);
  });

  it('quotes every Claude model at Anthropic 5-minute cache rates', () => {
    // 1.25x input to write, 0.1x to read. Pinning the ratios catches a
    // transcription slip in any row without restating all eight tables, and
    // comparing whole objects names the offending model on failure.
    const ratios = ratioTable((m) => m.startsWith('claude-'));
    expect(Object.keys(ratios).length).toBeGreaterThan(0);
    for (const [model, ratio] of Object.entries(ratios)) {
      expect({ model, ...ratio }).toEqual({ model, write: 1.25, read: 0.1 });
    }
  });

  it('quotes every OpenAI model with cache writes at the plain input rate', () => {
    // OpenAI publishes no separate cache-write charge: writes bill as ordinary
    // input. Equal input/cacheWrite numbers are the contract, not a copy-paste
    // slip — this test is what says so.
    const ratios = ratioTable((m) => m.startsWith('gpt-'));
    expect(Object.keys(ratios).length).toBeGreaterThan(0);
    for (const [model, ratio] of Object.entries(ratios)) {
      expect({ model, ...ratio }).toEqual({ model, write: 1, read: 0.1 });
    }
  });

  it('quotes a positive, finite rate for every class of every priced model', () => {
    const bad: string[] = [];
    for (const [model, rate] of Object.entries(PRICING.models)) {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        if (!(Number.isFinite(rate[field]) && rate[field] > 0)) {
          bad.push(`${model}.${field}=${rate[field]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // ------------------------------------------------------- the dated suffix

  it('prices claude-haiku-4-5 under both the bare and the dated string', () => {
    // Claude Code reports Haiku as `claude-haiku-4-5-20251001` while every
    // other Claude string arrives bare. Both must reach the same rate.
    const bare = estimateCostUsd('claude-haiku-4-5', only('input', M));
    const dated = estimateCostUsd('claude-haiku-4-5-20251001', only('input', M));
    expect(bare).toBe(1);
    expect(dated).toBe(bare);
  });

  it('retries only the dated suffix, and only once', () => {
    // Stripping -YYYYMMDD is the whole allowance. Anything looser starts
    // guessing prices, which is worse than showing none.
    expect(estimateCostUsd('claude-haiku-9-9-20251001', only('input', M))).toBeNull();
    expect(estimateCostUsd('claude-haiku-4-5-2025100', only('input', M))).toBeNull();
    expect(estimateCostUsd('claude-haiku-4-5-20251001-preview', only('input', M))).toBeNull();
    expect(estimateCostUsd('claude-opus', only('input', M))).toBeNull();
    expect(estimateCostUsd('claude-opus-5-turbo', only('input', M))).toBeNull();
  });

  // --------------------------------------------- deliberately unpriced rows

  it('leaves codex-auto-review and <synthetic> unpriced on purpose', () => {
    // High-volume locally, but OpenAI publishes no price for codex-auto-review
    // and `<synthetic>` is not a model. Inventing a number for either would
    // make a wrong total look authoritative.
    expect(estimateCostUsd('codex-auto-review', only('input', M))).toBeNull();
    expect(estimateCostUsd('<synthetic>', only('input', M))).toBeNull();
    expect(PRICING.models['codex-auto-review']).toBeUndefined();
    expect(PRICING.models['<synthetic>']).toBeUndefined();
  });

  it('leaves the collector unattributed bucket unpriced', () => {
    // `unknown` is what the collector files spend under when a harness reports
    // tokens before naming a model. Tokens nobody can attribute cannot be
    // priced either.
    expect(estimateCostUsd('unknown', only('input', M))).toBeNull();
  });

  it('covers every priced model string the local corpus actually contains', () => {
    // Measured across 608 Claude transcripts and 528 Codex rollouts. Listing
    // the unpriced ones would be listing the two exceptions above.
    const measured = [
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-5.4',
      'claude-opus-4-8',
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ];
    const unpriced = measured.filter((m) => estimateCostUsd(m, only('input', M)) === null);
    expect(unpriced).toEqual([]);
  });

  // ----------------------------------------------- the shapes a day arrives in

  it('prices a day of one model', () => {
    expect(dayCost([['claude-opus-5', only('input', M)]])).toBe(5);
  });

  it('prices a day of several models as their sum', () => {
    expect(
      dayCost([
        ['claude-opus-5', only('input', M)],
        ['claude-sonnet-5', only('input', M)],
        ['gpt-5.6-sol', only('input', M)],
      ]),
    ).toBe(5 + 2 + 5);
  });

  it('surfaces null rather than a partial total when one model is unpriced', () => {
    // The honest outcome: a day that ran codex-auto-review alongside priced
    // work has an unknowable bill, and a partial sum would read as a complete,
    // smaller one.
    expect(
      dayCost([
        ['gpt-5.6-sol', only('input', M)],
        ['codex-auto-review', only('input', M)],
      ]),
    ).toBeNull();
  });

  it('surfaces null however the unpriced model is ordered', () => {
    expect(
      dayCost([
        ['codex-auto-review', only('input', M)],
        ['gpt-5.6-sol', only('input', M)],
      ]),
    ).toBeNull();
  });

  it('costs a day with no usage at nothing rather than nothing-known', () => {
    expect(dayCost([])).toBe(0);
  });

  it('costs a day of zero-token buckets at nothing', () => {
    expect(dayCost([['claude-opus-5', only('input', 0)]])).toBe(0);
  });
});
