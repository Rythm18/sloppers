import type { TokenTotals } from '@sloppers/protocol';
import { billedTokens, estimateCostUsd } from '@sloppers/protocol';
import { useStore } from '../store.js';
import { AvatarThumb } from './AvatarThumb.js';
import {
  burned,
  COST_UNKNOWN,
  COST_UNKNOWN_TITLE,
  costTitle,
  formatCostUsd,
  harnessLabel,
  PRESENCE_LABEL,
  PRESENCE_VAR,
  sessionAge,
  sessionLine,
} from './format.js';

/** Heaviest model first — the one worth explaining leads the list. */
function byModelRows(byModel: Record<string, TokenTotals> | undefined): [string, TokenTotals][] {
  return Object.entries(byModel ?? {})
    .filter(([, t]) => billedTokens(t) > 0)
    .sort((a, b) => billedTokens(b[1]) - billedTokens(a[1]));
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
  const models = byModelRows(member.today.byModel);

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

      <div className="member-today">
        <span>
          today <b>{burned(member.today.tokens)}</b> tok
        </span>
        <span>
          <b>{member.today.sessionsRun}</b> session{member.today.sessionsRun === 1 ? '' : 's'}
        </span>
        <span>
          <b>{member.today.activeMinutes}</b> active min
        </span>
        <Cost usd={member.today.estimatedCostUsd ?? null} />
      </div>
    </section>
  );
}
