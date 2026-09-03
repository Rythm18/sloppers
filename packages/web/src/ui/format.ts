import type { DailyStats, PresenceState, SessionSnapshot, TokenTotals } from '@sloppers/protocol';
import { PRICING, processedTokens } from '@sloppers/protocol';

/**
 * 1234 → "1.2k", 5_400_000 → "5.4M", 2_800_000_000 → "2.8B" —
 * leaderboard-friendly.
 *
 * The tiers run to T because token counts do. A single Codex conversation on
 * this machine reached 2.4B billed tokens in 26 days and one member's day in
 * production banked 2.8B cache reads; stopping at M rendered that as
 * "2228833M", nine characters of noise in a column with room for four. T is
 * one tier of headroom past anything measured rather than a prediction — the
 * alternative is discovering the next ceiling the same way, in production.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000_000) return `${trim(n / 1_000_000_000_000)}T`;
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}

function trim(n: number): string {
  const fixed = n >= 100 ? n.toFixed(0) : n.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/**
 * Every token that went through the agent, cache included — the one number
 * the office competes on. See `processedTokens` for why it is not input +
 * output.
 */
export function burned(tokens: TokenTotals): string {
  return formatTokens(processedTokens(tokens));
}

/**
 * How a member who withholds their numbers reads, everywhere a number would
 * otherwise be.
 *
 * The point is that it is a *state*, not a quantity. `0 tok / 0 sessions /
 * est. $0.00` is what the tables genuinely hold for them, and every one of
 * those zeroes is an assertion nobody made — it turned "I would rather not
 * say" into a claim of having done nothing, printed beside their own live
 * sessions. Not competing is a choice a person is allowed to make in the room
 * without it looking like laziness.
 */
export const TOKENS_PRIVATE = 'private';

// "From here on", not "nothing about their day": switching sharing off
// mid-day suppresses the morning's numbers from display, it does not unsend
// them. Claiming more privacy than the system delivers is the same class of
// lie as the zero this state replaced.
export const TOKENS_PRIVATE_TITLE =
  'This teammate keeps their numbers to themselves — token sharing is off in their collector, so their day is not counted here. Not zero: unsaid.';

/** The member card's own sentence for it, where there is room for one. */
export const TOKENS_PRIVATE_LINE = 'Keeps their numbers to themselves.';

/**
 * What a day's session count may call itself.
 *
 * A 0.2 collector groups a conversation's forks, resumes and subagent runs
 * into one lineage before reporting it, so its count really is conversations.
 * Before that, every transcript *file* counted: 599 files for 139 conversations
 * on the local corpus, and one production day read 373 — more sessions than
 * the wire can carry at once, on a day nobody ran anything like that many. The
 * older number is not corrected here (the files are all the server has), so it
 * keeps the older word and explains itself on hover.
 */
export function sessionsLabel(stats: DailyStats, n: number): string {
  const noun = stats.precision === 'measured' ? 'conversation' : 'session';
  return n === 1 ? noun : `${noun}s`;
}

export const SESSIONS_COARSE_TITLE =
  'Counted per transcript file: a fork, a resume or a subagent run each add one, so this reads higher than the number of conversations you actually had. Collectors from 0.2 group them.';

export const SESSIONS_MEASURED_TITLE =
  'Conversations: forks, resumes and subagent runs are folded into the conversation they came from.';

export const MINUTES_COARSE_TITLE =
  'Approximate: the office marks a minute whenever an agent looks busy, and an agent counts as busy for up to ten minutes after its last output. Closer to how long an agent was alive than to time at the keyboard. Collectors from 0.2 measure it per minute of real output.';

export const MINUTES_MEASURED_TITLE =
  'Minutes that actually contained agent output, measured on your own machine.';

/**
 * Active minutes, hedged unless they were actually measured.
 *
 * Two definitions have always shared this column. A 0.2 collector sets one bit
 * per minute that genuinely contained output; before that the server marks a
 * minute whenever any session reads `working`, and a session stays `working`
 * for ten minutes after its last output — so a three-second reply lights about
 * eleven minutes and one production day totalled 1,315 of them, 21.9 hours.
 * The two render identically and always did. The `≈` is the smallest mark that
 * stops the second from being read as the first.
 */
export function activeMinutes(stats: DailyStats): { prefix: string; title: string } {
  if (stats.precision === 'measured') {
    return { prefix: '', title: MINUTES_MEASURED_TITLE };
  }
  return { prefix: '≈', title: MINUTES_COARSE_TITLE };
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

/**
 * Whole seconds as a clock: `600` → `10:00`, `47` → `0:47`.
 *
 * Both dialogs that count a ten-minute credential down show the same TTL, and
 * for a while only one of them showed it as time — the other printed `587s`,
 * which is a number somebody has to divide before it means anything. Negative
 * input clamps to `0:00`: a deadline that has passed is not a countdown, and
 * `-1:-3` is not a thing to put on a screen.
 */
export function countdown(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
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
