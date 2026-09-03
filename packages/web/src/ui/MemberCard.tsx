import type { DailyStats, TokenTotals } from '@sloppers/protocol';
import { estimateCostUsd, processedTokens } from '@sloppers/protocol';
import { useEffect } from 'react';
import { requestHistory } from '../net/socket.js';
import { useStore } from '../store.js';
import { AvatarThumb } from './AvatarThumb.js';
import {
  activeMinutes,
  burned,
  type CostView,
  dayCostView,
  dayTitle,
  harnessLabel,
  modelCostView,
  PRESENCE_LABEL,
  PRESENCE_VAR,
  SESSIONS_COARSE_TITLE,
  SESSIONS_MEASURED_TITLE,
  sessionAge,
  sessionLine,
  sessionsLabel,
  TOKENS_PRIVATE_LINE,
  TOKENS_PRIVATE_TITLE,
  weekdayInitial,
} from './format.js';

/**
 * Heaviest model first — the one worth explaining leads the list.
 *
 * Filtered and ranked on total tokens processed, the same number the row
 * displays and the same four fields its cost is computed from. On input +
 * output a model whose day was pure cache reads dropped out of the breakdown
 * while still contributing its whole cost to the total underneath it, which
 * left an unexplainable dollar figure and, when that model was unpriced, an
 * unexplainable "no est.".
 */
function byModelRows(byModel: Record<string, TokenTotals> | undefined): [string, TokenTotals][] {
  return Object.entries(byModel ?? {})
    .filter(([, t]) => processedTokens(t) > 0)
    .sort((a, b) => processedTokens(b[1]) - processedTokens(a[1]));
}

/**
 * Today's counts, or the fact that they are not ours to show.
 *
 * Split out because the withheld case is not a formatting variant of the
 * numbers — it replaces them. Rendering `0 tok · 0 sessions · est. $0.00`
 * next to a member's own running sessions was the office asserting something
 * the member had specifically declined to say.
 */
function TodayLine({ today }: { today: DailyStats }) {
  if (today.tokensShared === false) {
    return (
      <div className="member-today member-today-private" title={TOKENS_PRIVATE_TITLE}>
        <span>{TOKENS_PRIVATE_LINE}</span>
      </div>
    );
  }
  const minutes = activeMinutes(today);
  return (
    <div className="member-today">
      <span>
        today <b>{burned(today.tokens)}</b> tok
      </span>
      <span
        title={today.precision === 'measured' ? SESSIONS_MEASURED_TITLE : SESSIONS_COARSE_TITLE}
      >
        <b>{today.sessionsRun}</b> {sessionsLabel(today, today.sessionsRun)}
      </span>
      <span title={minutes.title}>
        {minutes.prefix}
        <b>{today.activeMinutes}</b> active min
      </span>
      <Cost view={dayCostView(today)} />
    </div>
  );
}

/**
 * One cost, as a dollar estimate, as a floor under one, or as a named absence.
 *
 * The day total is the only thing that can be a floor. A per-model row is
 * already the finest grain there is — either that model has a price or it
 * doesn't — so it keeps saying `no est.`, and stays the place a reader finds
 * out *which* model put the `≥` on the line below.
 */
function Cost({ view }: { view: CostView }) {
  if (view.kind === 'unknown') {
    return (
      <span className="cost cost-unknown" title={view.title}>
        {view.text}
      </span>
    );
  }
  return (
    <span className={view.kind === 'floor' ? 'cost cost-floor' : 'cost'} title={view.title}>
      <i className="cost-est">est.</i>
      {view.text}
    </span>
  );
}

/**
 * The smallest bar a day that happened gets, as a percentage of the track.
 *
 * Two pixels of ink at the track's height, which is the same mark the office
 * draws everywhere else. Without it a day that burned a thousand tokens beside
 * a day that burned a billion is rounded to nothing and reads as a day off —
 * and the difference between "a little" and "none" is most of what a rhythm is.
 */
const MIN_BAR_PERCENT = 7;

/**
 * One member's last seven days as a shape.
 *
 * Drawn in the same language as the board's meters — a track and a filled `i`,
 * no chart library, no axes — because a number's neighbours are the whole point
 * and a reader should be able to take it in without reading anything. Scaled
 * against this person's own week rather than the office's, since the question a
 * strip answers is "how does today compare to my week", not "who is winning";
 * that is what the board is for, and it is right there.
 *
 * Oldest on the left, today on the right and lit, so today reads as the end of
 * a run rather than as a figure on its own.
 *
 * A day with nothing in it draws no bar and keeps its cell — the baseline under
 * the track is what says the day existed. Dropping empty days would slide every
 * later bar along and quietly turn a rest day into a working one; that is the
 * one thing a strip must not do.
 *
 * Absent entirely for somebody who withholds: the office serves them no days at
 * all, so there is nothing here to draw and nothing to explain — the line below
 * already says they keep their numbers to themselves.
 *
 * Shown at every width. It is one row of bars and one row of letters, about the
 * height of the session line above it, and putting a fifty-pixel thing behind a
 * tap costs more attention than it saves.
 */
function WeekStrip({ memberId }: { memberId: string }) {
  const history = useStore((s) => s.history);
  const historyPending = useStore((s) => s.historyPending);

  // Opening a card is a reason to want the week, exactly as opening the board
  // is. Idempotent, so the two of them together still cost one request.
  useEffect(() => {
    requestHistory();
  }, []);

  if (!history) {
    return historyPending ? <p className="member-week-wait">Fetching the week…</p> : null;
  }
  const mine = history.members.find((m) => m.memberId === memberId);
  if (!mine || mine.days.length === 0) return null;

  const today = history.days[0];
  // The wire is newest-first; a week is read left to right.
  const days = [...mine.days].reverse();
  const peak = Math.max(1, ...days.map((d) => processedTokens(d.stats.tokens)));

  return (
    <div className="member-week">
      {/* Counted from what arrived rather than written out, so the heading
          cannot outlive the window the office actually serves. */}
      <h3 className="member-week-title">Last {days.length} days</h3>
      <div className="week-strip">
        {days.map((entry) => {
          const total = processedTokens(entry.stats.tokens);
          const height =
            total === 0 ? 0 : Math.max(MIN_BAR_PERCENT, Math.round((total / peak) * 100));
          return (
            <div
              className={`week-day${entry.day === today ? ' week-day-now' : ''}`}
              key={entry.day}
              title={dayTitle(entry.day, entry.stats)}
            >
              <span className="week-track">
                <i style={{ height: `${height}%` }} />
              </span>
              <span className="week-initial">{weekdayInitial(entry.day)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Full detail for a clicked teammate: every visible session, today's totals. */
export function MemberCard() {
  const focusedId = useStore((s) => s.focusedId);
  const member = useStore((s) => (focusedId ? s.members[focusedId] : undefined));
  const setFocused = useStore((s) => s.setFocused);
  if (!member) return null;

  const presenceVar = PRESENCE_VAR[member.presence];
  // Withholding hides the breakdown too. A member who shared this morning and
  // turned it off at lunch still has real rows in the ledger, and showing them
  // under a line that says they share nothing would make the line a lie in the
  // one direction that matters.
  const models = member.today.tokensShared === false ? [] : byModelRows(member.today.byModel);

  return (
    <section
      className="member-card panel"
      style={{ ['--presence' as string]: presenceVar }}
      aria-label={`${member.displayName} status`}
    >
      <header className="member-card-head">
        <AvatarThumb avatar={member.avatar} scale={2} />
        <span className="who">{member.displayName}</span>
        <span
          className={`presence-chip${member.presence === 'needs-attention' ? ' presence-attention' : ''}`}
        >
          <i className="presence-dot" />
          {PRESENCE_LABEL[member.presence]}
        </span>
        <button type="button" className="close" onClick={() => setFocused(null)} aria-label="close">
          ×
        </button>
      </header>

      {!member.sharing ? (
        <p className="member-empty">Not sharing agent activity.</p>
      ) : member.sessions.length === 0 ? (
        <p className="member-empty">No live agent sessions right now.</p>
      ) : (
        <div className="session-list">
          {member.sessions.map((session) => (
            <div className="session-row" key={session.id}>
              <div className="session-top">
                <span className="harness-tag">{harnessLabel(session.harness)}</span>
                <span className="session-title">{sessionLine(session)}</span>
              </div>
              <div className="session-sub">
                <span className={`state-${session.state}`}>{session.state}</span>
                {session.project && session.title ? <span>{session.project}</span> : null}
                {session.branch ? <span>{session.branch}</span> : null}
                {session.model ? <span>{session.model}</span> : null}
                {session.tokens ? <span>{burned(session.tokens)} tok</span> : null}
                <span>{sessionAge(session)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {models.length > 0 ? (
        <div className="member-models">
          <h3 className="member-models-title">Today by model</h3>
          {models.map(([model, tokens]) => (
            <div className="model-row" key={model}>
              <span className="model-name" title={model}>
                {model}
              </span>
              <span className="model-tok">{burned(tokens)}</span>
              <Cost view={modelCostView(estimateCostUsd(model, tokens))} />
            </div>
          ))}
        </div>
      ) : null}

      {/* Directly above today's counts, so the last bar and the number under
          it are plainly the same day seen twice — one as a shape, one as a
          figure. That adjacency is the whole point of the strip. */}
      <WeekStrip memberId={member.id} />
      <TodayLine today={member.today} />
    </section>
  );
}
