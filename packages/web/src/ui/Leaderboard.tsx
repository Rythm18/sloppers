import type { LeaderboardRow } from '@sloppers/protocol';
import { billedTokens } from '@sloppers/protocol';
import { memo, useState } from 'react';
import { useStore } from '../store.js';
import {
  COST_UNKNOWN,
  COST_UNKNOWN_TITLE,
  costTitle,
  formatCostUsd,
  formatTokens,
} from './format.js';

export type LeaderboardSort = 'tokens' | 'cost';

/** Today's estimated spend, or null when some model in the day has no price. */
function costOf(row: LeaderboardRow): number | null {
  return row.stats.estimatedCostUsd ?? null;
}

/**
 * Tokens by default; cost on request.
 *
 * Rows with no estimate sort last, below every priced row, however large their
 * token count. Ranking them anywhere else would be a claim we can't make —
 * treating unknown as zero buries a possibly-huge day at the bottom *as if we
 * knew*, and treating it as huge invents a leader. Last, with the reason on
 * the row, is the only honest place. Among themselves they keep token order,
 * so the section stays stable rather than shuffling per render.
 */
export function sortRows(rows: LeaderboardRow[], sort: LeaderboardSort): LeaderboardRow[] {
  const byTokens = (a: LeaderboardRow, b: LeaderboardRow) =>
    billedTokens(b.stats.tokens) - billedTokens(a.stats.tokens);
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

  const shown = sortRows(
    rows.filter((r) => billedTokens(r.stats.tokens) > 0 || r.stats.sessionsRun > 0),
    sort,
  );
  // The meter tracks whatever the list is ranked by, so a sorted column always
  // reads top-to-bottom. Unknown costs get no bar at all — an empty track is
  // the honest width for a number we don't have.
  const max = Math.max(
    1,
    ...shown.map((r) => (sort === 'cost' ? (costOf(r) ?? 0) : billedTokens(r.stats.tokens))),
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
      {shown.length === 0 ? (
        <p className="lb-empty">No tokens burned yet today. The office is suspiciously quiet.</p>
      ) : (
        <div className="leaderboard-rows">
          {shown.map((row, i) => {
            const total = billedTokens(row.stats.tokens);
            const cost = costOf(row);
            const meter = sort === 'cost' ? (cost ?? 0) : total;
            return (
              <div className="lb-row" key={row.memberId}>
                <span className="rank">{i + 1}</span>
                <span className="who">{row.displayName}</span>
                <span className="burn">{formatTokens(total)}</span>
                {cost === null ? (
                  <span className="cost cost-unknown" title={COST_UNKNOWN_TITLE}>
                    {COST_UNKNOWN}
                  </span>
                ) : (
                  <span className="cost" title={costTitle()}>
                    <i className="cost-est">est.</i>
                    {formatCostUsd(cost)}
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
        </div>
      )}
    </aside>
  );
});
