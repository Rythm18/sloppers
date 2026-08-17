import { useEffect, useState } from 'react';
import { useStore } from '../store.js';

export function HUD() {
  const roomCode = useStore((s) => s.roomCode);
  const roomName = useStore((s) => s.roomName);
  const connection = useStore((s) => s.connection);
  const you = useStore((s) => s.you);
  const sharing = useStore((s) => (you ? (s.members[you]?.sharing ?? false) : false));
  const leaderboardOpen = useStore((s) => s.leaderboardOpen);
  const setShareOpen = useStore((s) => s.setShareOpen);
  const setLeaderboardOpen = useStore((s) => s.setLeaderboardOpen);
  const [copied, setCopied] = useState(false);

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
        <button type="button" className="btn" onClick={() => setShareOpen(true)}>
          {sharing ? 'Sharing on' : 'Share agents'}
        </button>
      </div>

      <div className="hud-hint">WASD or arrows to walk · click a teammate to peek</div>

      {connection === 'reconnecting' ? (
        <div className="conn-lost panel">connection lost — retrying…</div>
      ) : null}
    </div>
  );
}
