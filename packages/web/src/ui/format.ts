import type { PresenceState, SessionSnapshot, TokenTotals } from '@sloppers/protocol';
import { billedTokens, PRICING } from '@sloppers/protocol';

/** 1234 → "1.2k", 5_400_000 → "5.4M" — leaderboard-friendly. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}

function trim(n: number): string {
  const fixed = n >= 100 ? n.toFixed(0) : n.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

export function burned(tokens: TokenTotals): string {
  return formatTokens(billedTokens(tokens));
}

/**
 * What an unknown cost reads as. Not an em dash on its own: beside a column of
 * real dollars a bare dash is ambiguous — nobody can tell "we don't know" from
 * "nothing". The word says which, and `COST_UNKNOWN_TITLE` says why.
 */
export const COST_UNKNOWN = 'no est.';

export const COST_UNKNOWN_TITLE =
  'No estimate: this day used a model with no published price, so any total would be missing part of the bill.';

/** The one sentence that keeps "est." from being read as an invoice. */
export function costTitle(): string {
  return `Estimated from list prices published ${PRICING.asOf}: tokens counted locally, multiplied by each model's public rate. Not a bill — it ignores subscriptions, plan credits and negotiated discounts.`;
}

/**
 * Dollars at a precision the number can actually support.
 *
 * These are list-price estimates, so cents on a three-figure total would be
 * invented precision — but rounding everything to cents would collapse a real
 * few-tenths-of-a-cent day to "$0.00" and read as free. So: cents while cents
 * are the story, whole dollars once they aren't, and an explicit "<$0.01" for
 * spend too small to show but too real to call zero.
 */
export function formatCostUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  const rounded = Math.round(usd * 100) / 100;
  if (rounded < 0.01) return '<$0.01';
  if (rounded < 10) return `$${rounded.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

export const PRESENCE_LABEL: Record<PresenceState, string> = {
  active: 'at the desk',
  grinding: 'agents cooking',
  'needs-attention': 'agent needs input',
  afk: 'afk',
  offline: 'offline',
};

export const PRESENCE_VAR: Record<PresenceState, string> = {
  active: 'var(--p-active)',
  grinding: 'var(--p-grinding)',
  'needs-attention': 'var(--p-attention)',
  afk: 'var(--p-afk)',
  offline: 'var(--p-offline)',
};

export function harnessLabel(id: string): string {
  if (id === 'claude-code') return 'claude';
  return id;
}

export function sessionLine(session: SessionSnapshot): string {
  if (session.title) return session.title;
  if (session.project) return session.project;
  return `${harnessLabel(session.harness)} session`;
}

export function sessionAge(session: SessionSnapshot, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((now - session.startedAt) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
