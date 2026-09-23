import type { MemberHistory, WebHistoryResult } from '@sloppers/protocol';
import { processedTokens } from '@sloppers/protocol';
import { dayLabel } from './format.js';

/**
 * What the office has to say to somebody walking back in, worked out from the
 * answer it already served — no second request, no second definition of a day,
 * and nothing the browser had to guess.
 */

/** One other member's burn across the window. */
export interface Mover {
  displayName: string;
  total: number;
}

export interface AwayReport {
  /**
   * The office days that began after this member left, newest first. Never
   * empty: the server only names a `lastHereDay` older than the office's
   * current day, so there is always at least today in here.
   */
  days: string[];
  /**
   * True when the absence reaches further back than the office served. The
   * window is then the whole answer rather than the whole absence, and the
   * panel has to say "the last seven days" instead of naming a date it is not
   * actually reporting on.
   */
  clamped: boolean;
  /** This member's own burn across the window. */
  mine: number;
  /** The heaviest *other* burner, or null when nobody else moved. */
  top: Mover | null;
  /** How many other members burned anything at all. */
  movers: number;
  /** Everybody's burn across the window, this member included. */
  office: number;
}

/**
 * Sum one member's history entry across a set of days.
 *
 * A member who withholds arrives with `days: []` — the office refuses to read
 * their stored days at all once their collector says token sharing is off — so
 * this returns zero for them without any special case, and they can neither
 * lead the office nor be counted into its total. That is the withheld rule
 * holding at the only place it can hold: the wire never carried the numbers.
 */
function burnAcross(days: MemberHistory['days'], window: ReadonlySet<string>): number {
  let total = 0;
  for (const entry of days) {
    if (window.has(entry.day)) total += processedTokens(entry.stats.tokens);
  }
  return total;
}

/**
 * The shape of what was missed, or null when there is nothing the office can
 * honestly report on.
 *
 * Null happens when the served days and the named day do not line up — a
 * history answer that arrived from before a timezone change, say. The server's
 * gates make it the unreachable case rather than a routine one, and returning
 * null keeps a panel with a heading and no body from ever rendering.
 */
export function awayReport(
  history: WebHistoryResult,
  lastHereDay: string,
  you: string,
): AwayReport | null {
  // String comparison on `YYYY-MM-DD` labels, which is calendar order — and
  // the same comparison the server made when it decided to name this day.
  const days = history.days.filter((day) => day > lastHereDay);
  if (days.length === 0) return null;
  const oldest = history.days[history.days.length - 1];
  const window = new Set(days);

  let mine = 0;
  let office = 0;
  let movers = 0;
  let top: Mover | null = null;
  for (const member of history.members) {
    const total = burnAcross(member.days, window);
    office += total;
    if (member.memberId === you) {
      mine = total;
      continue;
    }
    if (total <= 0) continue;
    movers += 1;
    if (!top || total > top.total) top = { displayName: member.displayName, total };
  }

  return {
    days,
    clamped: oldest !== undefined && lastHereDay < oldest,
    mine,
    top,
    movers,
    office,
  };
}

/**
 * How long "away" was, in words — the panel's one line of scope.
 *
 * Said in days rather than hours because days are what the numbers under it
 * are: the ledger buckets by calendar day, and "about fourteen hours" over a
 * figure that covers two whole dates would be precision the office does not
 * have. A clamped window names no date at all, because the date it would name
 * is further back than anything it is reporting.
 */
export function awaySpan(report: AwayReport, lastHereDay: string): string {
  if (report.clamped) return `the last ${report.days.length} days`;
  if (report.days.length === 1) return 'since yesterday';
  return `since ${dayLabel(lastHereDay)}`;
}
