import { describe, expect, it } from 'vitest';
import {
  COST_UNKNOWN,
  COST_UNKNOWN_TITLE,
  costTitle,
  formatCostUsd,
  formatTokens,
  sessionLine,
} from './format.js';

describe('formatTokens', () => {
  it('keeps small numbers plain', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatTokens(1_200)).toBe('1.2k');
    expect(formatTokens(45_000)).toBe('45k');
    expect(formatTokens(999_999)).toBe('1000k');
    expect(formatTokens(5_400_000)).toBe('5.4M');
    expect(formatTokens(123_000_000)).toBe('123M');
  });

  it('drops trailing .0', () => {
    expect(formatTokens(2_000)).toBe('2k');
    expect(formatTokens(3_000_000)).toBe('3M');
  });
});

describe('formatCostUsd', () => {
  it('keeps cents while cents are the story', () => {
    expect(formatCostUsd(0.01)).toBe('$0.01');
    expect(formatCostUsd(0.42)).toBe('$0.42');
    expect(formatCostUsd(3.07)).toBe('$3.07');
    expect(formatCostUsd(9.99)).toBe('$9.99');
  });

  it('drops invented precision once the total is large', () => {
    // An estimate from list prices cannot really justify cents at this size.
    expect(formatCostUsd(10)).toBe('$10');
    expect(formatCostUsd(12.34)).toBe('$12');
    expect(formatCostUsd(340.7)).toBe('$341');
    expect(formatCostUsd(1234.5)).toBe('$1,235');
  });

  it('never collapses real spend to $0.00', () => {
    // The failure this rule exists to prevent: a day that cost four tenths of
    // a cent must not render as free.
    expect(formatCostUsd(0.004)).toBe('<$0.01');
    expect(formatCostUsd(0.0000051)).toBe('<$0.01');
    expect(formatCostUsd(0.009)).toBe('$0.01');
  });

  it('says $0.00 only for genuinely nothing', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
  });

  it('crosses the cents/dollars boundary on the rounded value', () => {
    // 9.999 rounds to 10.00; showing "$10.00" beside "$10" would look like two
    // different formats for the same number.
    expect(formatCostUsd(9.999)).toBe('$10');
    expect(formatCostUsd(9.994)).toBe('$9.99');
  });

  it('is never blank or NaN for a hostile number', () => {
    expect(formatCostUsd(Number.NaN)).toBe('$0.00');
    expect(formatCostUsd(Number.POSITIVE_INFINITY)).toBe('$0.00');
    expect(formatCostUsd(-5)).toBe('$0.00');
  });
});

describe('cost wording', () => {
  it('names unknown in words, not as a bare dash', () => {
    // A dash beside real dollars cannot be told apart from zero.
    expect(COST_UNKNOWN).not.toBe('—');
    expect(COST_UNKNOWN).toMatch(/est/i);
    expect(COST_UNKNOWN).not.toBe(formatCostUsd(0));
  });

  it('explains why an unknown cost is missing', () => {
    expect(COST_UNKNOWN_TITLE).toMatch(/no published price/i);
  });

  it('dates the estimate and denies being a bill', () => {
    const title = costTitle();
    expect(title).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(title).toMatch(/estimat/i);
    expect(title).toMatch(/not a bill/i);
    // The three things it must not be mistaken for.
    expect(title).toMatch(/subscription/i);
    expect(title).toMatch(/discount/i);
  });
});

describe('sessionLine', () => {
  const base = {
    id: 's',
    harness: 'claude-code',
    state: 'working',
    startedAt: 1,
    lastActivityAt: 1,
  } as const;

  it('prefers title, then project, then harness', () => {
    expect(sessionLine({ ...base, title: 'Fixing the build', project: 'app' })).toBe(
      'Fixing the build',
    );
    expect(sessionLine({ ...base, project: 'app' })).toBe('app');
    expect(sessionLine(base)).toBe('claude session');
  });
});
