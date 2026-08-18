import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from './game/bridge.js';
import { PhaserStage } from './game/PhaserStage.js';
import { type JoinIntent, loadIdentity, OfficeSocket, redeemRelinkToken } from './net/socket.js';
import { useStore } from './store.js';
import { BubbleLayer } from './ui/BubbleLayer.js';
import { HUD } from './ui/HUD.js';
import { JoinScreen } from './ui/JoinScreen.js';
import { Leaderboard } from './ui/Leaderboard.js';
import { MemberCard } from './ui/MemberCard.js';
import { ShareModal } from './ui/ShareModal.js';

/**
 * Entry orchestration. Ways someone lands here:
 * - bare URL              → create an office (or paste an invite)
 * - invite link (?room=)  → greeted by the office, pick a name, step in
 * - return visit          → identity in localStorage, straight back in
 * - relink link (?relink=)→ a collector vouched for them; become that member
 */
export function App() {
  const phase = useStore((s) => s.phase);
  const connection = useStore((s) => s.connection);
  const roomCode = useStore((s) => s.roomCode);
  const socketRef = useRef<OfficeSocket | null>(null);
  const [urlRoom, setUrlRoom] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('room'),
  );
  const [resuming, setResuming] = useState(false);

  const start = useCallback((intent: JoinIntent) => {
    socketRef.current?.stop();
    useStore.getState().setJoinError(null);
    const socket = new OfficeSocket(intent);
    socketRef.current = socket;
    socket.start();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    // Relink tokens travel ONLY in the fragment so they never hit server
    // logs, proxies, or Referer headers.
    const relink = new URLSearchParams(location.hash.replace(/^#/, '')).get('relink');

    if (relink) {
      setResuming(true);
      void redeemRelinkToken(relink).then((redeemedRoom) => {
        if (redeemedRoom) {
          history.replaceState(null, '', `?room=${encodeURIComponent(redeemedRoom)}`);
          setUrlRoom(redeemedRoom);
          start({ kind: 'resume', roomCode: redeemedRoom });
        } else {
          history.replaceState(null, '', room ? `?room=${encodeURIComponent(room)}` : '/');
          setResuming(false);
          useStore
            .getState()
            .setJoinError(
              'That sign-in link was already used or expired — run `sloppers relink` again.',
            );
        }
      });
      return () => socketRef.current?.stop();
    }

    if (room && loadIdentity(room)) {
      setResuming(true);
      useStore.getState().setRoomCode(room);
      start({ kind: 'resume', roomCode: room });
    }
    return () => socketRef.current?.stop();
    // `start` is stable; URL params are read once at mount.
  }, [start]);

  // Once we're in, the URL always reflects the real office code — created
  // offices mint theirs server-side, and this URL *is* the invite.
  useEffect(() => {
    if (phase === 'world' && roomCode) {
      history.replaceState(null, '', `?room=${encodeURIComponent(roomCode)}`);
    }
  }, [phase, roomCode]);

  // A failed resume (cleared server, revoked member) lands back on the form.
  useEffect(() => {
    if (phase === 'join' && connection !== 'connecting' && connection !== 'open') {
      setResuming(false);
    }
  }, [phase, connection]);

  useEffect(
    () =>
      bridge.on('avatar-click', (memberId) => {
        useStore.getState().setFocused(memberId);
      }),
    [],
  );

  if (phase === 'join') {
    return (
      <div className="app">
        <JoinScreen
          invitedRoom={urlRoom}
          resuming={resuming}
          connecting={connection === 'connecting'}
          onCreate={(roomName, displayName, avatar) =>
            start({ kind: 'create', roomName, displayName, avatar })
          }
          onJoin={(code, displayName, avatar) =>
            start({ kind: 'invited', roomCode: code, displayName, avatar })
          }
          onFollowInvite={(code) => {
            history.replaceState(null, '', `?room=${encodeURIComponent(code)}`);
            setUrlRoom(code);
            if (loadIdentity(code)) {
              setResuming(true);
              start({ kind: 'resume', roomCode: code });
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <PhaserStage />
      <BubbleLayer />
      <HUD />
      <Leaderboard />
      <MemberCard />
      <ShareModal />
    </div>
  );
}
