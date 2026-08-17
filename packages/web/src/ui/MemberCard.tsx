import { useStore } from '../store.js';
import { AvatarThumb } from './AvatarThumb.js';
import {
  burned,
  harnessLabel,
  PRESENCE_LABEL,
  PRESENCE_VAR,
  sessionAge,
  sessionLine,
} from './format.js';

/** Full detail for a clicked teammate: every visible session, today's totals. */
export function MemberCard() {
  const focusedId = useStore((s) => s.focusedId);
  const member = useStore((s) => (focusedId ? s.members[focusedId] : undefined));
  const setFocused = useStore((s) => s.setFocused);
  if (!member) return null;

  const presenceVar = PRESENCE_VAR[member.presence];

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
      </div>
    </section>
  );
}
