import type { LeaderboardRow, WebHistoryResult } from '@sloppers/protocol';
import { emptyTokens, processedTokens } from '@sloppers/protocol';
import { memo, useEffect, useState } from 'react';
import { requestHistory } from '../net/socket.js';
import { useStore } from '../store.js';
import {
  COST_FLOOR_RANK_NOTE,
  type CostView,
  dayCostView,
  dayLabel,
  formatTokens,
  TOKENS_PRIVATE,
  TOKENS_PRIVATE_TITLE,
} from './format.js';

export type LeaderboardSort = 'tokens' | 'cost';

/**
 * What this row is ranked and metered by: today's estimate, or the floor under
 * it when the estimate is unknowable but part of the day is priced. Null only
 * when there is no number of any kind — the same value the row prints, so the
 * column can never be sorted by one quantity and read as another.
 */
function costOf(row: LeaderboardRow): number | null {
  return dayCostView(row.stats).usd;
}

/** The hover sentence, plus what the ranking is doing, where ranking happens. */
function titleFor(view: CostView, sort: LeaderboardSort): string {
  if (view.kind !== 'floor' || sort !== 'cost') return view.title;
  return `${view.title} ${COST_FLOOR_RANK_NOTE}`;
}

/**
 * Whether this row is a person who has opted out of being counted.
 *
 * They used to be dropped by the activity filter below, alongside everyone who
 * simply had not started yet — an omission indistinguishable from an absence,
 * with nothing anywhere saying which it was. They are still not ranked, because
 * we have no number to rank them by, but the board says so in its own margin
 * instead of quietly closing over the gap.
 */
export function isPrivate(row: LeaderboardRow): boolean {
  return row.stats.tokensShared === false;
}

/**
 * Tokens by default; cost on request.
 *
 * Rows with no number at all sort last, below every row that has one, however
 * large their token count. Ranking them anywhere else would be a claim we
 * can't make — treating unknown as zero buries a possibly-huge day at the
 * bottom *as if we knew*, and treating it as huge invents a leader. Last, with
 * the reason on the row, is the only honest place. Among themselves they keep
 * token order, so the section stays stable rather than shuffling per render.
 *
 * A day with a floor is not one of those rows. It ranks on its floor, against
 * exact totals and other floors alike: the priced share is money that was
 * certainly spent, so the row's true place is *at least* here. That can seat a
 * heavily unpriced day too low, which is the direction that understates rather
 * than the one that invents — and the tooltip says so.
 */
export function sortRows(rows: LeaderboardRow[], sort: LeaderboardSort): LeaderboardRow[] {
  const byTokens = (a: LeaderboardRow, b: LeaderboardRow) =>
    processedTokens(b.stats.tokens) - processedTokens(a.stats.tokens);
  if (sort === 'tokens') return [...rows].sort(byTokens);
  return [...rows].sort((a, b) => {
    const ca = costOf(a);
    const cb = costOf(b);
    if (ca === null && cb === null) return byTokens(a, b);
    if (ca === null) return 1;
    if (cb === null) return -1;
    return cb - ca || byTokens(a, b);
  });
}

/**
 * A past day's board, built from the office's history answer.
 *
 * The same `LeaderboardRow` shape today's board is handed, so one day ranks,
 * meters, prices and hedges exactly like another — the sort, the cost floors
 * and the withheld margin are all the code that was already here. A member the
 * history covers but that day does not is a real zero and stays in the list;
 * the activity filter below is what decides whether a zero is worth a row, and
 * it decides that identically for every day.
 *
 * A withholding member arrives with no days at all, so their row is
 * synthesized from the flag alone: no numbers to show, and `isPrivate` puts
 * them in the margin where the board says so out loud.
 */
export function historyRows(history: WebHistoryResult, offset: number): LeaderboardRow[] {
  const day = history.days[offset];
  if (day === undefined) return [];
  return history.members.map((member) => ({
    memberId: member.memberId,
    displayName: member.displayName,
    avatar: member.avatar,
    stats: member.days.find((d) => d.day === day)?.stats ?? {
      tokens: emptyTokens(),
      sessionsRun: 0,
      activeMinutes: 0,
      ...(member.tokensShared === false ? { tokensShared: false } : {}),
    },
  }));
}

/**
 * Today's burn, per teammate, resetting at local midnight — and, since the
 * office started keeping days, yesterday's alongside it. Friendly competition
 * is the point: rank one gets the lamp-gold rank number.
 */
export const Leaderboard = memo(function Leaderboard() {
  const today = useStore((s) => s.leaderboard);
  const open = useStore((s) => s.leaderboardOpen);
  const history = useStore((s) => s.history);
  const historyPending = useStore((s) => s.historyPending);
  const boardDay = useStore((s) => s.boardDay);
  const setBoardDay = useStore((s) => s.setBoardDay);
  const [sort, setSort] = useState<LeaderboardSort>('tokens');

  // Asked for when the board opens, not when somebody reaches for yesterday:
  // the answer is one message, it is cached for the connection, and having it
  // in hand is the difference between a switch that flips and a switch that
  // waits. `requestHistory` is idempotent, so this costs one request however
  // many times the board is shown and hidden.
  //
  // `history` is a dependency on purpose. A reconnect's `world` clears it
  // while the board sits open, and an effect keyed on `open` alone never
  // refires — leaving the switch showing "try again" while unable to ask.
  // A cleared cache refires this and re-asks; a *refused* request leaves
  // `history` null without changing it, so a refusal cannot loop.
  useEffect(() => {
    if (open && !history) requestHistory();
  }, [open, history]);

  // A connection can quietly outlive midnight, after which every cached
  // label is off by one — "Yesterday" showing two days ago. The store
  // compares the answer's fetch-day against the calendar and drops a stale
  // one; the effect above then re-asks. Checked on every render because the
  // board re-renders on each leaderboard broadcast, so the first activity
  // after midnight corrects it. (The button's title always carries the true
  // date either way.)
  const expireStaleHistory = useStore((s) => s.expireStaleHistory);
  useEffect(() => {
    if (open) expireStaleHistory();
  });

  if (!open) return null;

  // Today comes from the live board — it is still moving, and the history
  // answer is a snapshot from whenever it was fetched. Every other day is
  // finished, so a snapshot is all there is to have.
  const rows = boardDay === 0 ? today : history ? historyRows(history, boardDay) : [];
  // The date behind the word "Yesterday", whichever day is on screen — the
  // switch has to be able to say what it would take you to, not what you are
  // already looking at.
  const yesterdayKey = history?.days[1];
  const withheld = rows.filter(isPrivate);
  const shown = sortRows(
    rows.filter(
      (r) => !isPrivate(r) && (processedTokens(r.stats.tokens) > 0 || r.stats.sessionsRun > 0),
    ),
    sort,
  );
  // The meter tracks whatever the list is ranked by, so a sorted column always
  // reads top-to-bottom. Unknown costs get no bar at all — an empty track is
  // the honest width for a number we don't have.
  const max = Math.max(
    1,
    ...shown.map((r) => (sort === 'cost' ? (costOf(r) ?? 0) : processedTokens(r.stats.tokens))),
  );

  return (
    <aside className="leaderboard panel" aria-label="the office's token burn">
      <div className="leaderboard-head">
        {/* The title says which day, so the switch below never has to be read
            to know what is on screen. */}
        <span className="panel-title">{boardDay === 0 ? 'Today' : 'Yesterday'}&rsquo;s burn</span>
        {/* Each button carries its own full name rather than leaning on a
            group label: "tok" and "est. $" fit the panel but say nothing on
            their own when read aloud. */}
        <span className="lb-sort">
          <button
            type="button"
            className="lb-sort-btn"
            aria-label="sort by tokens"
            aria-pressed={sort === 'tokens'}
            onClick={() => setSort('tokens')}
          >
            tok
          </button>
          <button
            type="button"
            className="lb-sort-btn"
            aria-label="sort by estimated cost"
            aria-pressed={sort === 'cost'}
            onClick={() => setSort('cost')}
          >
            est. $
          </button>
        </span>
      </div>
      {/* Two days, named, and no date picker. Yesterday is the one day anybody
          actually wants back — the day whose numbers were on this board when
          they closed the tab — and every further day is on the member cards,
          where a week has room to be a shape rather than a menu. */}
      <div className="lb-days">
        <button
          type="button"
          className="lb-day-btn"
          aria-pressed={boardDay === 0}
          onClick={() => setBoardDay(0)}
        >
          Today
        </button>
        <button
          type="button"
          className="lb-day-btn"
          aria-pressed={boardDay === 1}
          title={yesterdayKey ? dayLabel(yesterdayKey) : undefined}
          onClick={() => {
            setBoardDay(1);
            // The empty-state copy says "try the switch again" — so the
            // switch asks. Idempotent: with an answer cached or a request
            // out, this line is a no-op.
            requestHistory();
          }}
        >
          Yesterday
        </button>
      </div>
      {boardDay !== 0 && !history ? (
        <p className="lb-empty">
          {historyPending
            ? 'Fetching yesterday…'
            : 'Could not reach yesterday just now — try the switch again.'}
        </p>
      ) : shown.length === 0 && withheld.length === 0 ? (
        <p className="lb-empty">
          {boardDay === 0
            ? 'No tokens burned yet today. The office is suspiciously quiet.'
            : 'Nobody burned anything yesterday. A day off is a day off.'}
        </p>
      ) : (
        <div className="leaderboard-rows">
          {shown.map((row, i) => {
            const total = processedTokens(row.stats.tokens);
            const view = dayCostView(row.stats);
            const cost = view.usd;
            const meter = sort === 'cost' ? (cost ?? 0) : total;
            return (
              <div className="lb-row" key={row.memberId}>
                <span className="rank">{i + 1}</span>
                <span className="who">{row.displayName}</span>
                <span className="burn">{formatTokens(total)}</span>
                {view.kind === 'unknown' ? (
                  <span className="cost cost-unknown" title={view.title}>
                    {view.text}
                  </span>
                ) : (
                  <span
                    className={view.kind === 'floor' ? 'cost cost-floor' : 'cost'}
                    title={titleFor(view, sort)}
                  >
                    <i className="cost-est">est.</i>
                    {view.text}
                  </span>
                )}
                <span className="lb-meter">
                  <i
                    style={{
                      width: `${cost === null && sort === 'cost' ? 0 : Math.max(2, Math.round((meter / max) * 100))}%`,
                    }}
                  />
                </span>
              </div>
            );
          })}
          {/* Unranked by choice, and under the ranks rather than mixed into
              them: a rank is a claim about a quantity, and there is no
              quantity here to make one about. The dash keeps the column
              aligned without inventing a position. */}
          {withheld.map((row) => (
            <div className="lb-row lb-row-private" key={row.memberId}>
              <span className="rank">&ndash;</span>
              <span className="who">{row.displayName}</span>
              <span className="lb-private" title={TOKENS_PRIVATE_TITLE}>
                {TOKENS_PRIVATE}
              </span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
});
