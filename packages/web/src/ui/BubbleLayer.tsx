import { memo } from 'react';
import { registerAnchor } from '../game/bridge.js';
import { useStore } from '../store.js';
import { burned, PRESENCE_LABEL, PRESENCE_VAR, sessionLine } from './format.js';

/**
 * Ambient status bubbles above nearby teammates. React renders the content;
 * Phaser positions the elements imperatively every frame via the anchor
 * registry, so walking stays 60fps with zero re-renders.
 */
export const BubbleLayer = memo(function BubbleLayer() {
  const nearby = useStore((s) => s.nearby);
  const members = useStore((s) => s.members);

  return (
    <div className="bubble-layer">
      {nearby.map((id) => {
        const member = members[id];
        if (!member || member.sessions.length === 0) return null;
        const top = member.sessions[0];
        if (!top) return null;
        return (
          <div
            key={id}
            className="bubble"
            ref={(el) => registerAnchor(id, el)}
            style={{ ['--presence' as string]: PRESENCE_VAR[member.presence] }}
          >
            <div className="bubble-card">
              <div className="bubble-name">
                {member.displayName}
                <span className="bubble-presence">{PRESENCE_LABEL[member.presence]}</span>
              </div>
              <div className="bubble-line">{sessionLine(top)}</div>
              <div className="bubble-meta">
                {member.today.tokens ? (
                  <span className="tokens">{burned(member.today.tokens)} tok today</span>
                ) : null}
                <span>
                  {member.sessions.length} session{member.sessions.length === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
});
