import { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { Greeting } from './Greeting.js';
import { nudgeSettled, settleNudge } from './nudge.js';
import { useTouchSession } from './viewport.js';

/** The one line of instruction the office gives, for the controls in hand. */
function hintFor(touch: boolean, alone: boolean): string {
  const walk = touch ? 'Tap the floor to walk' : 'WASD or arrows to walk';
  // Nobody to peek at is not a smaller version of somebody to peek at. An
  // office of one is where a new arrival starts, and telling them to click a
  // teammate who is not there is the hint sending them looking for a bug.
  if (alone) return walk;
  return touch ? `${walk} · tap a teammate to peek` : `${walk} · click a teammate to peek`;
}

export function HUD() {
  const roomCode = useStore((s) => s.roomCode);
  const roomName = useStore((s) => s.roomName);
  const connection = useStore((s) => s.connection);
  const you = useStore((s) => s.you);
  const sharing = useStore((s) => (you ? (s.members[you]?.sharing ?? false) : false));
  const alone = useStore((s) => Object.keys(s.members).length <= 1);
  const leaderboardOpen = useStore((s) => s.leaderboardOpen);
  const knocks = useStore((s) => s.knocks);
  const myRole = useStore((s) => s.myRole);
  const setShareOpen = useStore((s) => s.setShareOpen);
  const setLeaderboardOpen = useStore((s) => s.setLeaderboardOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const [copied, setCopied] = useState(false);
  /**
   * Read once, at mount, from the member this browser arrived as — the HUD
   * only exists inside an office, so `you` is already settled by the time it
   * renders. Reading it here rather than in an effect is what keeps a nudge
   * somebody dismissed months ago from flashing up for a frame on every visit.
   */
  const [nudgeDone, setNudgeDone] = useState(() => (you === null ? false : nudgeSettled(you)));
  // The hint is the only instruction in the whole office, so it has to
  // describe the controls this person actually has. Nobody arriving on a
  // phone has a W key, and telling them to click is telling them nothing.
  const touch = useTouchSession();

  // Somebody standing at the door is waiting on a person, not on a panel
  // being opened — so the wait is visible from the floor.
  const canAnswerDoor = myRole === 'owner' || myRole === 'moderator';

  /**
   * An empty avatar is a thing worth mentioning once. It is not worth
   * mentioning to somebody who has already answered — so sharing settles it
   * for good, and so does saying "not now".
   *
   * `sharing` is "a collector is connected right now", which falls again when
   * a laptop shuts. That is the honest thing for the button beside it to read,
   * and exactly the wrong thing to re-nag on: `nudgeDone` is what remembers
   * that this person has already been told, and it never comes back down.
   */
  const showNudge = you !== null && !sharing && !nudgeDone;

  useEffect(() => {
    if (you === null || !sharing || nudgeDone) return;
    settleNudge(you);
    setNudgeDone(true);
  }, [you, sharing, nudgeDone]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // The URL is the invite — the room code is the capability that opens it.
  const invite = async () => {
    const url = `${location.origin}/?room=${encodeURIComponent(roomCode)}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
  };

  return (
    <div className="hud">
      <div className="hud-brand panel">
        <span className="name">sloppers</span>
        <span className="room">{roomName || roomCode}</span>
      </div>

      <div className="hud-actions">
        {canAnswerDoor && knocks.length > 0 ? (
          <button type="button" className="btn knock-alert" onClick={() => setSettingsOpen(true)}>
            <i className="knock-dot" />
            {knocks.length === 1 ? 'Someone at the door' : `${knocks.length} at the door`}
          </button>
        ) : null}
        <button type="button" className="btn btn-quiet" onClick={invite}>
          {copied ? 'Invite copied' : 'Invite'}
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setLeaderboardOpen(!leaderboardOpen)}
        >
          {leaderboardOpen ? 'Hide board' : 'Board'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
        <button type="button" className="btn" onClick={() => setShareOpen(true)}>
          {sharing ? 'Sharing on' : 'Share agents'}
        </button>
      </div>

      {/* Four buttons of equal weight is the office declining to say which one
          matters, to the one person for whom exactly one of them does. Said
          once, in words rather than by pointing — the buttons sit in a row on
          a laptop and in a wrapped column on a phone, and "the lit one" is
          true in both. Never said again after an answer either way.

          The nudge outranks the greeting, and they share this corner rather
          than stacking in it: two panels over somebody's first four seconds is
          the office talking over itself. The nudge wins because it is the
          blocking problem — an avatar with nothing behind it — and because it
          is asked once ever, where a greeting comes back on the next real
          absence. And for exactly this person the greeting is its weakest: with
          nothing sharing there are no numbers of their own to hand back, which
          is the line that makes it worth reading. */}
      {showNudge ? (
        <div className="hud-nudge panel" role="status">
          <p>
            Your avatar is here, but it has nothing to show — nothing is sharing from your machine
            yet. <strong>Share agents</strong>, the lit button up top, hands you the one command
            that fixes that.
          </p>
          <button
            type="button"
            className="nudge-dismiss"
            onClick={() => {
              if (you) settleNudge(you);
              setNudgeDone(true);
            }}
          >
            don't ask again
          </button>
        </div>
      ) : (
        <Greeting />
      )}

      <div className="hud-hint">{hintFor(touch, alone)}</div>

      {connection === 'reconnecting' ? (
        <div className="conn-lost panel">connection lost — retrying…</div>
      ) : null}
    </div>
  );
}
