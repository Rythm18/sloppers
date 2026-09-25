import type { DailyStats, PresenceState, SessionSnapshot, TokenTotals } from '@sloppers/protocol';
import { estimateCostFloorUsd, PRICING, processedTokens } from '@sloppers/protocol';

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
 * A `YYYY-MM-DD` day key as a UTC instant, or null if it is not one.
 *
 * UTC because the key is a *label*, not a moment: it was cut from somebody
 * else's local calendar and is only ever read back as the same three numbers.
 * Rehydrating it into this browser's local midnight would let a timezone west
 * of the writer's shift the whole strip a day, so that Monday's bar sat under
 * Sunday's initial. Nothing here converts between clocks, and nothing should.
 */
function parseDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * The one letter a week strip has room for under a bar.
 *
 * Ambiguous on its own — two Ts and two Ss in every week — and deliberately so:
 * the strip is a shape to be read at a glance, and the day each bar actually is
 * lives in its hover, where there is room to say it properly. Seven initials in
 * order is enough to find today at the right-hand end and count backwards.
 */
export function weekdayInitial(day: string): string {
  const parsed = parseDay(day);
  return parsed ? (WEEKDAYS[parsed.getUTCDay()]?.charAt(0) ?? '') : '';
}

/**
 * A day key as a date somebody can read: `Wed 2 Sep`.
 *
 * Spelled out here rather than handed to `toLocaleDateString`, which would
 * render the same office differently for two people sitting next to each other
 * and, worse, could reformat the *label* according to the reader's locale when
 * the label belongs to whoever did the work. Short enough for a tooltip, and
 * unambiguous about which day it means, which the initial is not.
 */
export function dayLabel(day: string): string {
  const parsed = parseDay(day);
  if (!parsed) return day;
  return `${WEEKDAYS[parsed.getUTCDay()]} ${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]}`;
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
 * The mark that turns an amount into a lower bound: `≥$12.40`, "at least".
 *
 * Sits with the dollars in the mono face rather than in the Silkscreen `est.`
 * slot, which has no glyph for it, and matches the `≈` that already hedges
 * active minutes — the office has one small-symbol vocabulary for "this number
 * is not the plain reading", and this is the second word in it.
 */
export const COST_FLOOR_MARK = '≥';

/**
 * The sentence a floor needs, which is not the one an estimate needs: what the
 * number leaves out, and that nobody can say how much that is.
 *
 * It names the unpriced models rather than quoting a percentage of tokens.
 * Tokens are not dollars — `codex-auto-review` is 26.7% of a Codex day's
 * tokens and an unknown share of its bill — so "51% unpriced" would be a
 * precise-sounding number about the wrong quantity. A name is something the
 * reader can check against the per-model list on their own card.
 */
export function costFloorTitle(unpriced: readonly string[]): string {
  const named = unpriced.slice(0, 3).join(', ');
  const rest = unpriced.length > 3 ? ` and ${unpriced.length - 3} more` : '';
  const which =
    unpriced.length === 0
      ? 'Something in it ran on a model with no published price'
      : `${named}${rest} ${unpriced.length === 1 ? 'has' : 'have'} no published price`;
  return `At least this much — the part of today we can price. ${which}, so the real total is higher by an amount nobody can state. ${costTitle()}`;
}

/**
 * The caveat that only applies where floors are being ranked against exact
 * numbers: a floor is placed by what we can vouch for, so a day carrying more
 * unpriced work sits lower than its real spend. Added by the board when it is
 * sorted by cost, and nowhere else — a member card ranks nothing.
 */
export const COST_FLOOR_RANK_NOTE =
  'Ranked by that floor, so a day with more unpriced work can sit lower than it belongs.';

/** How one cost renders: what to print, what to say on hover, what to rank by. */
export interface CostView {
  kind: 'exact' | 'floor' | 'unknown';
  /** `$3.07`, `≥$12.40`, or `no est.` */
  text: string;
  title: string;
  /** What sorting and meters use. Null when there is no number at all. */
  usd: number | null;
}

/** One model's cost: a figure, or the named absence of one. */
export function modelCostView(usd: number | null): CostView {
  if (usd === null) return { kind: 'unknown', text: COST_UNKNOWN, title: COST_UNKNOWN_TITLE, usd };
  return { kind: 'exact', text: formatCostUsd(usd), title: costTitle(), usd };
}

/**
 * A whole day's cost, resolved once so the board, the card and the cost sort
 * cannot disagree about it.
 *
 * Three outcomes, in the order they are preferred. An exact total renders as
 * it always has. Failing that, a floor worth a cent renders as a floor: it
 * ranks and it prints, because "≥ $12.40" is strictly more than the nothing
 * this day used to show. Failing *that* — a day where nothing at all could be
 * priced — it stays `no est.`, because a floor of $0.00 is not a small amount
 * of information, it is none, and printing it would read as free.
 *
 * The floor comes off the wire rather than being recomputed from `byModel`, so
 * the number the server ranked is the number the browser prints. `byModel` is
 * used only to name the models in the tooltip.
 */
/**
 * Truncate a floor to the precision `formatCostUsd` will print it at, so the
 * nearest-rounding inside never lifts the printed number above the bound:
 * cents below $10 (the `<$0.01` gate has already run), whole dollars above.
 */
function floorForPrint(usd: number): number {
  return usd < 10 ? Math.floor(usd * 100) / 100 : Math.floor(usd);
}

export function dayCostView(stats: DailyStats): CostView {
  const exact = stats.estimatedCostUsd ?? null;
  if (exact !== null) return modelCostView(exact);
  const floor = stats.estimatedCostFloorUsd ?? 0;
  // Rounded DOWN before printing. `formatCostUsd` rounds to nearest, which
  // is right for an estimate and wrong under a `≥`: "at least $13" on a
  // $12.60 floor is a false claim half the time. A bound only ever
  // understates itself — and the gate below runs on the truncated value, so
  // a $0.007 floor reads `no est.` rather than `≥$0.00`. `!(>=)` rather than
  // `<`: a NaN off a malformed wire falls to `no est.` too.
  const printable = floorForPrint(floor);
  if (!(printable >= 0.01)) return modelCostView(null);
  return {
    kind: 'floor',
    text: `${COST_FLOOR_MARK}${formatCostUsd(printable)}`,
    title: costFloorTitle(estimateCostFloorUsd(stats.byModel ?? {}).unpriced),
    usd: floor,
  };
}

/**
 * One day of a week strip, said properly.
 *
 * The initial under the bar is a hint; this is the sentence behind it — which
 * day it actually was, what went through, how many sessions (in whichever noun
 * that day's own precision has earned), and what it cost or at least cost.
 * Every hedge the office applies to today applies here, per day, because a day
 * in the past is not a day we know more about.
 *
 * A day with nothing in it says so in words. `0 tok · 0 sessions · $0.00` is
 * arithmetically true of a rest day and reads as a report on somebody's
 * spending rather than as a day they did not work.
 */
export function dayTitle(day: string, stats: DailyStats): string {
  const label = dayLabel(day);
  const total = processedTokens(stats.tokens);
  if (total === 0 && stats.sessionsRun === 0) return `${label} — nothing burned`;
  const sessions = `${stats.sessionsRun} ${sessionsLabel(stats, stats.sessionsRun)}`;
  return `${label} — ${formatTokens(total)} tok · ${sessions} · ${dayCostView(stats).text}`;
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

/**
 * A moment on a 24-hour clock: `09:07`.
 *
 * In the reader's own timezone, which is the opposite of what `dayLabel` does
 * two hundred lines up — and the difference is worth naming, because the two
 * look like the same kind of function. A day key is a *label* cut from
 * somebody else's calendar, and rewriting it into the reader's clock would
 * move Monday's work under Sunday. A chat timestamp is a moment: the same
 * instant for everybody, and the only useful way to show it is as the time it
 * was where the person reading is.
 *
 * Built by hand rather than through `toLocaleTimeString`, which would render
 * the same conversation as `09:07` for one friend and `9:07 AM` for another
 * sitting beside them, and would drift with whatever ICU data the browser
 * shipped.
 */
export function chatTime(at: number): string {
  const when = new Date(at);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
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
