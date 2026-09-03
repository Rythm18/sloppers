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

/**
 * True when the identity is actually on disk. localStorage can refuse —
 * quota, private windows, storage partitioning — and this runs inside
 * `onmessage` on the resume path, where an escaping exception would hang the
 * tab on "Stepping in…" with a live socket and no reconnect. A session that
 * carries on un-saved (this visit works, the next reload re-asks for a name)
 * is the honest degradation; a hang is not.
 */
function saveIdentity(roomCode: string, identity: StoredIdentity): boolean {
  try {
    localStorage.setItem(identityKey(roomCode), JSON.stringify(identity));
    return true;
  } catch {
    return false;
  }
}

export function clearIdentity(roomCode: string): void {
  localStorage.removeItem(identityKey(roomCode));
}

/**
 * Move a stored identity from one invite code to another.
 *
 * The invite code is the only name this browser has for an office, so it is
 * what credentials are filed under — and an owner can change it. Rotation
 * moves everybody to the new code and rewrites the address bar to match,
 * which used to leave the credentials sitting under a code nothing looks up
 * again: on the next reload the office met a stranger, offered them their own
 * name, and refused it as taken. A member with a paired collector could climb
 * back in with `sloppers relink`; everybody else lost their seat and their
 * history to a click they did not make.
 *
 * The server never needed the code to let them in — `memberId` and
 * `memberSecret` name the office by themselves — so this is only ever about
 * where the browser goes looking. Moved rather than copied: two entries for
 * one seat is one of them going stale, filed under a dead code.
 */
function refileIdentity(from: string, to: string): void {
  if (from === to) return;
  const identity = loadIdentity(from);
  if (!identity) return;
  // Clear only what was definitely re-saved. If storage refused the write,
  // the old entry is the one copy of this seat's credentials — deleting it
  // on the strength of a save that did not happen would finish rotation's
  // old orphaning bug by hand.
  if (saveIdentity(to, identity)) clearIdentity(from);
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

  /** Ask the office for its recent days. Answered once, to this socket. */
  sendHistory(days?: number): void {
    this.send(days === undefined ? { type: 'history' } : { type: 'history', days });
  }

  private connect(): void {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/web`);
    this.ws = ws;
    /**
     * Whether *this* connection has been let into the office. `joined` says
     * "ever", which is what the reconnect banner wants; this says "now",
     * which is what tells a door refusing a join apart from the office
     * refusing an admin op somebody clicked.
     */
    let entered = false;

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
        entered = true;
        if (msg.you.memberSecret) {
          // The world tells us the real room code (created offices mint it
          // server-side); the identity is keyed by that.
          saveIdentity(msg.roomCode, {
            memberId: msg.you.memberId,
            memberSecret: msg.you.memberSecret,
          });
        } else if (this.intent.kind === 'resume') {
          // Resumed on credentials we already held, and the office answers
          // with the code it has *now*. It may have rotated while this tab was
          // shut: the old link still got us in — the credentials name the
          // office, the code never did — and this is the one moment the
          // browser learns where to file them, before the address bar is
          // rewritten to a code nothing is stored under.
          refileIdentity(this.intent.roomCode, msg.roomCode);
        }
        // From here this connection *is* somebody, somewhere: a member id and
        // an office. Every reconnect from now on has to put that member back
        // in that office, so the intent that got us here is spent. Replaying
        // it would mint a second office ('create'), or offer the office a
        // name it already gave us and be told it is taken ('invited'), or
        // stand us back in a queue we have already been let out of ('knock').
        // The room code it carries is the one identity is filed under, and it
        // follows the office from here — see the `workspace` branch below.
        this.intent = { kind: 'resume', roomCode: msg.roomCode };
        this.lastPresent = null;
        this.reportPresence();
      }
      if (msg.type === 'workspace' && this.intent.kind === 'resume') {
        // The office's own state, pushed whenever it changes — which includes
        // the owner rotating the invite out from under everybody inside.
        // Nobody loses their seat; the drawer their credentials sit in is
        // renamed, and this browser is the only thing that can move them. A
        // no-op on the copy that arrives with every arrival, when the code is
        // the one we came in on.
        refileIdentity(this.intent.roomCode, msg.roomCode);
        this.intent = { kind: 'resume', roomCode: msg.roomCode };
      }
      if (msg.type === 'error' && !entered) {
        // The door refused this connection: a locked office, a taken name, a
        // knock somebody said no to, a code pointing nowhere, credentials the
        // office will not honour. None of them answer differently on a
        // retry, so the attempt ends here rather than reconnecting into the
        // same refusal every few seconds for as long as the tab is open.
        if (msg.code === 'bad-join' && this.intent.kind === 'resume') {
          // The office does not know this member: kicked, banned or deleted
          // while we were disconnected, or a server that lost its database.
          // Forget the credentials so the next attempt is a fresh name
          // rather than the same refusal.
          clearIdentity(this.intent.roomCode);
        }
        // Full teardown, not just the flag: leaving the move timer, the
        // window listeners and the socket itself alive until the next join
        // attempt is a leak on every refused door.
        this.stop();
      }
      if (msg.type === 'removed') {
        // Terminal: the server is about to close this socket because the
        // member is gone (kicked, banned, deleted). Mark closed *before*
        // that close arrives, so `onclose`'s reconnect loop doesn't retry
        // with credentials that were just revoked — that would flash the
        // connection through 'reconnecting' and fail again with bad-join
        // instead of leaving the store's 'removed' state alone. Same full
        // teardown as a door refusal — this socket is finished.
        this.stop();
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

/**
 * Why a pairing code could not be minted. The two are not the same problem
 * and do not have the same fix, and for a while they shared one sentence
 * blaming the network: a 403 is the office looking at this browser's
 * credentials and not recognising them (storage was cleared, the member was
 * removed, this browser never had a seat here), which no amount of trying
 * again resolves.
 */
export type MintFailure =
  /** Nothing answered, or the office answered badly. Trying again may work. */
  | 'unreachable'
  /** The office answered, and said no to *this browser*. `sloppers relink`. */
  | 'refused';

export type MintResult =
  | { ok: true; pairingCode: string; expiresAt: number }
  | { ok: false; reason: MintFailure };

/** Mint a pairing code for the share modal. */
export async function mintPairingCode(roomCode: string): Promise<MintResult> {
  // No identity here means this browser holds nothing to prove it belongs to
  // the office — the same standing a rotated or cleared one leaves it in, and
  // the same remedy, so it is reported as the office's refusal rather than as
  // a network that is in fact perfectly fine.
  const identity = loadIdentity(roomCode);
  if (!identity) return { ok: false, reason: 'refused' };
  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(identity),
  }).catch(() => null);
  if (!res) return { ok: false, reason: 'unreachable' };
  if (res.status === 403) return { ok: false, reason: 'refused' };
  if (!res.ok) return { ok: false, reason: 'unreachable' };
  const minted = (await res.json()) as { pairingCode: string; expiresAt: number };
  return { ok: true, ...minted };
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

/**
 * Ask the office for its recent days, at most once.
 *
 * Two unrelated bits of UI want the same answer — the board's day switch and a
 * member card's week — and both call this whenever they are shown. The guards
 * are what make that safe: an answer already held is not asked for again, and
 * a request already out is not doubled. History does not change while you are
 * looking at it, so one per connection is the right number; a fresh `world`
 * message clears the answer and the next view to open fetches again.
 *
 * A refusal releases `historyPending` without delivering an answer (see the
 * store's error branch), so the very next click retries rather than sitting on
 * a spinner. That is the only retry there is, and it is a human one.
 */
export function requestHistory(days?: number): void {
  const state = useStore.getState();
  if (state.history || state.historyPending || !activeSocket) return;
  state.setHistoryPending(true);
  activeSocket.sendHistory(days);
}
