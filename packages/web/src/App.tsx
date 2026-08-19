import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from './game/bridge.js';
import { PhaserStage } from './game/PhaserStage.js';
import { Landing } from './landing/Landing.js';
import {
  clearIdentity,
  type JoinIntent,
  loadIdentity,
  OfficeSocket,
  redeemRelinkToken,
} from './net/socket.js';
import { useStore } from './store.js';
import { BubbleLayer } from './ui/BubbleLayer.js';
import { DeviceLinkModal } from './ui/DeviceLinkModal.js';
import { HUD } from './ui/HUD.js';
import { JoinScreen } from './ui/JoinScreen.js';
import { Leaderboard } from './ui/Leaderboard.js';
import { MemberCard } from './ui/MemberCard.js';
import { RemovedScreen } from './ui/RemovedScreen.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { ShareModal } from './ui/ShareModal.js';

/**
 * Entry orchestration. Ways someone lands here:
 * - bare URL              → create an office (or paste an invite)
 * - invite link (?room=)  → greeted by the office, pick a name, step in
 * - return visit          → identity in localStorage, straight back in
 * - relink link (?relink=)→ a collector vouched for them; become that member
 *
 * And one way back out: removed, which lands here rather than in the world.
 */
export function App() {
  const phase = useStore((s) => s.phase);
  const connection = useStore((s) => s.connection);
  const roomCode = useStore((s) => s.roomCode);
  const roomName = useStore((s) => s.roomName);
  const removed = useStore((s) => s.removed);
  const deviceLink = useStore((s) => s.deviceLink);
  const socketRef = useRef<OfficeSocket | null>(null);
  const [urlRoom, setUrlRoom] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('room'),
  );
  const [resuming, setResuming] = useState(false);
  /** Bare visits see the landing page until they choose to open an office. */
  const [entry, setEntry] = useState<'landing' | 'create'>('landing');

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

  // The one way back to the front page, wherever this browser had got to.
  // Both edges of the door use it rather than each inventing a way home.
  const toLanding = useCallback(() => {
    useStore.getState().reset();
    history.replaceState(null, '', '/');
    setUrlRoom(null);
    setResuming(false);
    setEntry('landing');
  }, []);

  // Losing a seat lands here rather than in the world. The credentials died
  // with it, so both ways off this card forget them first — otherwise the
  // next visit tries to resume with a member the office no longer has and
  // stalls on "stepping back in…" before failing.
  if (removed) {
    const office = roomCode;
    const forgetIdentity = () => {
      if (office) clearIdentity(office);
    };
    return (
      <div className="app">
        <RemovedScreen
          reason={removed}
          officeName={roomName}
          onJoinAgain={() => {
            forgetIdentity();
            useStore.getState().reset();
            history.replaceState(null, '', office ? `?room=${encodeURIComponent(office)}` : '/');
            setUrlRoom(office || null);
          }}
          onLeave={() => {
            forgetIdentity();
            toLanding();
          }}
        />
      </div>
    );
  }

  if (phase === 'join') {
    if (!urlRoom && !resuming && entry === 'landing') {
      return (
        <div className="app">
          <Landing onOpenOffice={() => setEntry('create')} />
        </div>
      );
    }
    return (
      <div className="app">
        {!urlRoom && entry === 'create' ? (
          <button
            type="button"
            className="btn btn-quiet"
            style={{ position: 'absolute', top: 14, left: 14, zIndex: 40 }}
            onClick={() => setEntry('landing')}
          >
            ← back
          </button>
        ) : null}
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
          onGiveUpKnocking={() => {
            // Dropping the connection is the withdrawal: the office removes
            // the knock in its socket close handler and pushes the shortened
            // queue, so nobody is left holding a place in line for someone
            // who walked away. Nothing client-side could do that.
            socketRef.current?.stop();
            socketRef.current = null;
            toLanding();
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
      {/* One at a time. Both are modal and both trap Tab, and two traps on
          one page fight over it — so the link, which is the answer to the
          thing the panel was asked for, takes the panel's place and hands it
          back when it closes. */}
      {deviceLink ? <DeviceLinkModal /> : <SettingsPanel />}
    </div>
  );
}
