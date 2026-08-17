import { useEffect, useRef, useState } from 'react';
import { bridge } from './game/bridge.js';
import { PhaserStage } from './game/PhaserStage.js';
import { loadIdentity, OfficeSocket } from './net/socket.js';
import { useStore } from './store.js';
import { BubbleLayer } from './ui/BubbleLayer.js';
import { HUD } from './ui/HUD.js';
import { JoinScreen } from './ui/JoinScreen.js';
import { Leaderboard } from './ui/Leaderboard.js';
import { MemberCard } from './ui/MemberCard.js';
import { ShareModal } from './ui/ShareModal.js';

function roomFromUrl(): string {
  return new URLSearchParams(location.search).get('room')?.toLowerCase() ?? 'lobby';
}

export function App() {
  const phase = useStore((s) => s.phase);
  const connection = useStore((s) => s.connection);
  const socketRef = useRef<OfficeSocket | null>(null);
  const [room] = useState(roomFromUrl);

  // A returning visitor with a saved identity skips the join screen.
  useEffect(() => {
    useStore.getState().setRoomCode(room);
    if (loadIdentity(room)) {
      const socket = new OfficeSocket(room, null);
      socketRef.current = socket;
      socket.start();
    }
    return () => socketRef.current?.stop();
  }, [room]);

  useEffect(
    () =>
      bridge.on('avatar-click', (memberId) => {
        useStore.getState().setFocused(memberId);
      }),
    [],
  );

  const join = (roomCode: string, displayName: string, avatar: string) => {
    socketRef.current?.stop();
    useStore.getState().setRoomCode(roomCode);
    useStore.getState().setJoinError(null);
    history.replaceState(null, '', `?room=${encodeURIComponent(roomCode)}`);
    const socket = new OfficeSocket(roomCode, { displayName, avatar });
    socketRef.current = socket;
    socket.start();
  };

  if (phase === 'join') {
    return (
      <div className="app">
        <JoinScreen initialRoom={room} connecting={connection === 'connecting'} onJoin={join} />
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
