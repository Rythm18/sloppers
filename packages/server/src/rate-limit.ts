/**
 * Per-connection message rate limiting. One `TokenBucket` per message kind,
 * so a socket that floods `move` cannot spend the budget meant for `admin`
 * ops, and vice versa. Instantiate one `createMessageLimiter()` per socket —
 * these are not shared across connections.
 */

/** Classic token bucket: refills continuously at `ratePerSecond`, caps at `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.last = Date.now();
  }

  take(now: number = Date.now()): boolean {
    const elapsedMs = Math.max(0, now - this.last);
    this.tokens = Math.min(this.burst, this.tokens + (elapsedMs / 1000) * this.ratePerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** The complete client-to-server message union — see `webToServerSchema`. */
export type MessageKind = 'join' | 'move' | 'activity' | 'admin';

/**
 * Budgets per kind. `move` is generous — it is the tick-rate stream driving
 * the avatar around. `activity` is a rare heartbeat. `admin` and `join` are
 * deliberately tight per-minute rates with just enough burst to cover a
 * legitimate flurry (a moderator working through a queue; a knocker who gets
 * refused once and retries under a new name).
 */
const BUDGETS: Record<MessageKind, { ratePerSecond: number; burst: number }> = {
  move: { ratePerSecond: 20, burst: 40 },
  activity: { ratePerSecond: 1, burst: 10 },
  admin: { ratePerSecond: 10 / 60, burst: 15 },
  join: { ratePerSecond: 1 / 60, burst: 5 },
};

/** How close two full-bucket drains have to land to count as abuse. */
const ABUSE_WINDOW_MS = 10_000;

export interface MessageLimiter {
  /** Whether a message of this kind is allowed right now. */
  allow(kind: MessageKind, now?: number): boolean;
  /**
   * True once a second full bucket has been drained within ten seconds of a
   * previous drain — i.e. the connection kept sending after being refused
   * once, and got refused again almost immediately. A one-off burst that
   * trips a single kind's limit is not abuse; ignoring the "slow down" and
   * doing it again right away is.
   */
  abusive(): boolean;
}

export function createMessageLimiter(): MessageLimiter {
  const buckets: Record<MessageKind, TokenBucket> = {
    move: new TokenBucket(BUDGETS.move.ratePerSecond, BUDGETS.move.burst),
    activity: new TokenBucket(BUDGETS.activity.ratePerSecond, BUDGETS.activity.burst),
    admin: new TokenBucket(BUDGETS.admin.ratePerSecond, BUDGETS.admin.burst),
    join: new TokenBucket(BUDGETS.join.ratePerSecond, BUDGETS.join.burst),
  };

  // The recorded history `abusive()` answers from: the two most recent
  // drain-event timestamps, across every kind on this connection.
  let previousDrainAt: number | null = null;
  let latestDrainAt: number | null = null;

  function allow(kind: MessageKind, now: number = Date.now()): boolean {
    const ok = buckets[kind].take(now);
    if (!ok) {
      previousDrainAt = latestDrainAt;
      latestDrainAt = now;
    }
    return ok;
  }

  function abusive(): boolean {
    if (previousDrainAt === null || latestDrainAt === null) return false;
    return latestDrainAt - previousDrainAt <= ABUSE_WINDOW_MS;
  }

  return { allow, abusive };
}
