import { billedTokens } from '@sloppers/protocol';
import { memo } from 'react';
import { useStore } from '../store.js';
import { formatTokens } from './format.js';

/**
 * Today's burn, per teammate, resetting at local midnight. Friendly
 * competition is the point: rank one gets the lamp-gold rank number.
 */
export const Leaderboard = memo(function Leaderboard() {
  const rows = useStore((s) => s.leaderboard);
  const open = useStore((s) => s.leaderboardOpen);
  if (!open) return null;

  const shown = rows.filter((r) => billedTokens(r.stats.tokens) > 0 || r.stats.sessionsRun > 0);
  const max = Math.max(1, ...shown.map((r) => billedTokens(r.stats.tokens)));

  return (
    <aside className="leaderboard panel" aria-label="today's token burn">
      <div className="leaderboard-head">
        <span className="panel-title">Today&rsquo;s burn</span>
      </div>
      {shown.length === 0 ? (
        <p className="lb-empty">No tokens burned yet today. The office is suspiciously quiet.</p>
      ) : (
        <div className="leaderboard-rows">
          {shown.map((row, i) => {
            const total = billedTokens(row.stats.tokens);
            return (
              <div className="lb-row" key={row.memberId}>
                <span className="rank">{i + 1}</span>
                <span className="who">{row.displayName}</span>
                <span className="burn">{formatTokens(total)}</span>
                <span className="lb-meter">
                  <i style={{ width: `${Math.max(2, Math.round((total / max) * 100))}%` }} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
});
