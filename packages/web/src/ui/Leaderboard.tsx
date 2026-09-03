import type { LeaderboardRow } from '@sloppers/protocol';
import { processedTokens } from '@sloppers/protocol';
import { memo, useState } from 'react';
import { useStore } from '../store.js';
import {
  COST_FLOOR_RANK_NOTE,
  type CostView,
  dayCostView,
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
 * Today's burn, per teammate, resetting at local midnight. Friendly
 * competition is the point: rank one gets the lamp-gold rank number.
 */
export const Leaderboard = memo(function Leaderboard() {
  const rows = useStore((s) => s.leaderboard);
  const open = useStore((s) => s.leaderboardOpen);
  const [sort, setSort] = useState<LeaderboardSort>('tokens');
  if (!open) return null;

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
    <aside className="leaderboard panel" aria-label="today's token burn">
      <div className="leaderboard-head">
        <span className="panel-title">Today&rsquo;s burn</span>
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
      {shown.length === 0 && withheld.length === 0 ? (
        <p className="lb-empty">No tokens burned yet today. The office is suspiciously quiet.</p>
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
