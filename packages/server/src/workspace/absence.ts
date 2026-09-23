import { dayIn } from '@sloppers/protocol';

/**
 * What counts as having been away, and the only place that is decided.
 *
 * Server-side on purpose. The browser's clock is nobody's authority — a
 * laptop back from a week's suspend can be minutes wrong, and a tab that has
 * just woken has no idea how long it was asleep — and the office is the one
 * thing that watched the door.
 */

/**
 * How long a gap has to be before the office says anything about it.
 *
 * Six hours. Longer than every routine interruption — a reload, a wifi blip, a
 * tab switch, lunch, a commute, the longest meeting anybody sits through — so
 * nothing that happens inside a working day trips it. Short enough that a
 * night's sleep always clears it, including for somebody who works late and
 * starts early, and a night is both the commonest real absence and the one with
 * the best thing to say: a machine that kept burning tokens while nobody was
 * looking. Well under a day, so somebody who looks in each morning and each
 * evening is greeted per gap rather than once per calendar date.
 *
 * Minutes would have been the product being needy. Twenty-four hours would have
 * meant the office never mentioning the night, which is the whole feature.
 */
export const AWAY_MS = 6 * 60 * 60 * 1000;

/**
 * The office day this member was last here on, when their return is worth
 * mentioning — and `undefined` for every arrival that is not a return.
 *
 * Three ways to get nothing, and each is a case the greeting must not fire on:
 *
 * - **Never here before.** A member minted seconds ago is stamped with the
 *   present (see `createMember`), so this only catches rows that predate the
 *   column; either way there is no "away" before you exist.
 * - **Not long enough.** See `AWAY_MS`.
 * - **Came and went inside one office day.** The ledger buckets by day, so the
 *   finest thing this office can honestly say about "since you left" is about
 *   days that *began* after you left. Somebody who closed the tab at eight and
 *   opened it at six has been genuinely away, and the office still says nothing
 *   — not because nothing happened, but because it cannot separate their own
 *   morning from the room's afternoon, and counting a person's own work back to
 *   them as news is the one thing this panel must never do. Silence is the true
 *   answer there, and it is also the quiet one.
 *
 * Both gates are load-bearing together. The day gate alone would greet a
 * ninety-second reload that happened to straddle midnight; the hours gate alone
 * would hand the browser a window with no whole day in it to describe.
 */
export function lastHereDay(
  lastPresentAt: number,
  now: number,
  timeZone: string,
): string | undefined {
  if (lastPresentAt <= 0) return undefined;
  if (now - lastPresentAt < AWAY_MS) return undefined;
  const then = dayIn(lastPresentAt, timeZone);
  // String comparison, because these are `YYYY-MM-DD` labels cut by the same
  // function — the same comparison the browser will make against the history
  // answer's keys.
  if (then >= dayIn(now, timeZone)) return undefined;
  return then;
}
