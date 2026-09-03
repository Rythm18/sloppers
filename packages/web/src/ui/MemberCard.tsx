import type { DailyStats, TokenTotals } from '@sloppers/protocol';
import { estimateCostUsd, processedTokens } from '@sloppers/protocol';
import { useStore } from '../store.js';
import { AvatarThumb } from './AvatarThumb.js';
import {
  activeMinutes,
  burned,
  COST_UNKNOWN,
  COST_UNKNOWN_TITLE,
  costTitle,
  formatCostUsd,
  harnessLabel,
  PRESENCE_LABEL,
  PRESENCE_VAR,
  SESSIONS_COARSE_TITLE,
  SESSIONS_MEASURED_TITLE,
  sessionAge,
  sessionLine,
  sessionsLabel,
  TOKENS_PRIVATE_LINE,
  TOKENS_PRIVATE_TITLE,
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
      <Cost usd={today.estimatedCostUsd ?? null} />
    </div>
  );
}

/** One number, rendered as a dollar estimate or as a named absence. */
function Cost({ usd }: { usd: number | null }) {
  if (usd === null) {
    return (
      <span className="cost cost-unknown" title={COST_UNKNOWN_TITLE}>
        {COST_UNKNOWN}
      </span>
    );
  }
  return (
    <span className="cost" title={costTitle()}>
      <i className="cost-est">est.</i>
      {formatCostUsd(usd)}
    </span>
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
              <Cost usd={estimateCostUsd(model, tokens)} />
            </div>
          ))}
        </div>
      ) : null}

      <TodayLine today={member.today} />
    </section>
  );
}
