import {
  type AdminOp,
  type Position,
  serverToWebSchema,
  type WebToServer,
} from '@sloppers/protocol';
import { bridge } from '../game/bridge.js';
import { useStore } from '../store.js';

/**
 * The browser's connection to the office. Joins (creating or resuming an
 * identity kept in localStorage per room), relays movement from the game,
 * reports human-presence, and reconnects with backoff using the saved
 * identity so a dropped laptop lid doesn't mean re-entering a name.
 */

interface StoredIdentity {
  memberId: string;
  memberSecret: string;
}

const RECONNECT_BASE_MS = 800;
const RECONNECT_CAP_MS = 15_000;
const INPUT_FRESH_MS = 5 * 60 * 1000;
const MOVE_INTERVAL_MS = 100;

function identityKey(roomCode: string): string {
  return `sloppers:identity:${roomCode}`;
}

export function loadIdentity(roomCode: string): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(identityKey(roomCode));
    return raw ? (JSON.parse(raw) as StoredIdentity) : null;
  } catch {
    return null;
  }
}

function saveIdentity(roomCode: string, identity: StoredIdentity): void {
  localStorage.setItem(identityKey(roomCode), JSON.stringify(identity));
}

export function clearIdentity(roomCode: string): void {
  localStorage.removeItem(identityKey(roomCode));
}

/** The three ways into an office, mirroring the join protocol. */
export type JoinIntent =
  | { kind: 'resume'; roomCode: string }
  | { kind: 'invited'; roomCode: string; displayName: string; avatar: string }
  | { kind: 'create'; roomName: string; displayName: string; avatar: string };

/**
 * The currently live connection, if any — set for the lifetime of one
 * `start()`..`stop()` span. UI components never hold a socket reference;
 * they reach the network layer through module-level functions like this one
 * and `mintPairingCode` below.
 */
let activeSocket: OfficeSocket | null = null;

export class OfficeSocket {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closed = false;
  private joined = false;
  private lastInputAt = Date.now();
  private lastPresent: boolean | null = null;
  private moveTimer: number | null = null;
  private pendingMove: Position | null = null;
  private cleanups: (() => void)[] = [];

  constructor(private intent: JoinIntent) {}

  start(): void {
    activeSocket = this;
    useStore.getState().setConnection('connecting');
    this.trackActivity();
    this.cleanups.push(
      bridge.on('self-move', (position) => {
        this.pendingMove = position;
      }),
    );
    this.moveTimer = window.setInterval(() => {
      if (this.pendingMove) {
        this.send({ type: 'move', position: this.pendingMove });
        this.pendingMove = null;
      }
    }, MOVE_INTERVAL_MS);
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (activeSocket === this) activeSocket = null;
    if (this.moveTimer) clearInterval(this.moveTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.ws?.close();
  }

  /** Dispatch an admin op, role-gated UI's only way to reach the wire. */
  sendAdmin(op: AdminOp): void {
    this.send({ type: 'admin', op });
  }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/web`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      const intent = this.intent;
      if (intent.kind === 'resume') {
        const identity = loadIdentity(intent.roomCode);
        if (!identity) {
          useStore.getState().setJoinError('No identity for this office here — pick a name.');
          this.stop();
          return;
        }
        this.send({ type: 'join', ...identity });
      } else if (intent.kind === 'invited') {
        this.send({
          type: 'join',
          roomCode: intent.roomCode,
          displayName: intent.displayName,
          avatar: intent.avatar,
        });
      } else {
        this.send({
          type: 'join',
          createRoom: intent.roomName,
          displayName: intent.displayName,
          avatar: intent.avatar,
        });
      }
    };

    ws.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const result = serverToWebSchema.safeParse(parsed);
      if (!result.success) return;
      const msg = result.data;

      if (msg.type === 'world') {
        this.joined = true;
        if (msg.you.memberSecret) {
          // The world tells us the real room code (created offices mint it
          // server-side); the identity is keyed by that.
          saveIdentity(msg.roomCode, {
            memberId: msg.you.memberId,
            memberSecret: msg.you.memberSecret,
          });
        }
        this.lastPresent = null;
        this.reportPresence();
      }
      if (
        msg.type === 'error' &&
        (msg.code === 'bad-join' || msg.code === 'name-taken' || msg.code === 'room-not-found')
      ) {
        // A stale identity (wiped server db) reads as bad-join; forget it so
        // the person can just pick a name again.
        if (msg.code === 'bad-join' && this.intent.kind === 'resume') {
          clearIdentity(this.intent.roomCode);
        }
        this.closed = true;
      }
      if (msg.type === 'removed') {
        // Terminal: the server is about to close this socket because the
        // member is gone (kicked, banned, deleted). Mark closed *before*
        // that close arrives, so `onclose`'s reconnect loop doesn't retry
        // with credentials that were just revoked — that would flash the
        // connection through 'reconnecting' and fail again with bad-join
        // instead of leaving the store's 'removed' state alone.
        this.closed = true;
      }
      useStore.getState().applyServer(msg);
    };

    ws.onclose = () => {
      if (this.closed) return;
      useStore.getState().setConnection('reconnecting');
      if (!this.joined) {
        // Never made it into the office — say so instead of a silent button.
        useStore.getState().setJoinError("Can't reach the office server — retrying…");
      }
      const backoff = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.attempts);
      this.attempts += 1;
      setTimeout(() => this.connect(), backoff / 2 + Math.random() * (backoff / 2));
    };
  }

  private send(msg: WebToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** present = tab visible and input within the last few minutes. */
  private reportPresence(): void {
    const present =
      document.visibilityState === 'visible' && Date.now() - this.lastInputAt < INPUT_FRESH_MS;
    if (present !== this.lastPresent && this.joined) {
      this.lastPresent = present;
      this.send({ type: 'activity', present });
    }
  }

  private trackActivity(): void {
    const onInput = () => {
      this.lastInputAt = Date.now();
      this.reportPresence();
    };
    const onVisibility = () => this.reportPresence();
    window.addEventListener('pointerdown', onInput);
    window.addEventListener('keydown', onInput);
    document.addEventListener('visibilitychange', onVisibility);
    const heartbeat = window.setInterval(() => this.reportPresence(), 30_000);
    this.cleanups.push(() => {
      window.removeEventListener('pointerdown', onInput);
      window.removeEventListener('keydown', onInput);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(heartbeat);
    });
  }
}

/**
 * Redeem a relink token from a `sloppers relink` URL: this browser becomes
 * the member the collector vouched for. Returns the room to resume into,
 * or null (used/expired token, unreachable server).
 */
export async function redeemRelinkToken(token: string): Promise<string | null> {
  const res = await fetch('/api/relink/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const redeemed = (await res.json()) as {
    memberId: string;
    memberSecret: string;
    roomCode: string;
  };
  saveIdentity(redeemed.roomCode, {
    memberId: redeemed.memberId,
    memberSecret: redeemed.memberSecret,
  });
  return redeemed.roomCode;
}

/** Invite preview for the join screen; null when the code is dead. */
export async function fetchRoomPreview(
  roomCode: string,
): Promise<{ name: string; memberCount: number } | null> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomCode)}`).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as { name: string; memberCount: number };
}

/** Mint a pairing code for the share modal. */
export async function mintPairingCode(
  roomCode: string,
): Promise<{ pairingCode: string; expiresAt: number } | null> {
  const identity = loadIdentity(roomCode);
  if (!identity) return null;
  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(identity),
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as { pairingCode: string; expiresAt: number };
}

/**
 * Dispatch an admin op on the live office connection, if there is one — the
 * same module-level pattern as `mintPairingCode`, so role-gated UI never
 * needs to hold a socket reference. A no-op with nothing connected (e.g. a
 * stray click after disconnect); the op just goes nowhere.
 */
export function sendAdmin(op: AdminOp): void {
  activeSocket?.sendAdmin(op);
}
