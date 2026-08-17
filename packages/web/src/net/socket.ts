import { type Position, serverToWebSchema, type WebToServer } from '@sloppers/protocol';
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

  constructor(
    private roomCode: string,
    private createProfile: { displayName: string; avatar: string } | null,
  ) {}

  start(): void {
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
    if (this.moveTimer) clearInterval(this.moveTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.ws?.close();
  }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/web`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      const identity = loadIdentity(this.roomCode);
      if (identity) {
        this.send({ type: 'join', roomCode: this.roomCode, ...identity });
      } else if (this.createProfile) {
        this.send({ type: 'join', roomCode: this.roomCode, ...this.createProfile });
      } else {
        useStore.getState().setJoinError('No identity for this room yet — pick a name.');
        this.stop();
        return;
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
          saveIdentity(this.roomCode, {
            memberId: msg.you.memberId,
            memberSecret: msg.you.memberSecret,
          });
        }
        this.lastPresent = null;
        this.reportPresence();
      }
      if (msg.type === 'error' && (msg.code === 'bad-join' || msg.code === 'name-taken')) {
        // A stale identity (wiped server db) reads as bad-join; forget it so
        // the person can just pick a name again.
        if (msg.code === 'bad-join') clearIdentity(this.roomCode);
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
  });
  if (!res.ok) return null;
  return (await res.json()) as { pairingCode: string; expiresAt: number };
}
