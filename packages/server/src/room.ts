import {
  billedTokens,
  type CollectorSnapshot,
  type LeaderboardRow,
  type MemberView,
  type Position,
  type PresenceState,
  type ServerToWeb,
  type SessionSnapshot,
  type WebWorld,
} from '@sloppers/protocol';
import type { WebSocket } from 'ws';
import type { Db } from './db.js';
import type { TokenLedger } from './ledger.js';
import { derivePresence } from './presence.js';

const LEADERBOARD_DEBOUNCE_MS = 2000;
/** Open floor near the centre of the default 512×352 office map. */
const SPAWN = { x: 256, y: 240 };

export interface WebClient {
  ws: WebSocket;
  memberId: string;
  present: boolean;
}

interface CollectorLink {
  ws: WebSocket;
  lastSeenAt: number;
  idleSeconds: number | undefined;
  sessions: SessionSnapshot[];
}

interface MemberRuntime {
  id: string;
  displayName: string;
  avatar: string;
  sharing: boolean;
  position: Position;
  webClients: Set<WebClient>;
  collector: CollectorLink | null;
  /** Serialized last presence broadcast, for change detection. */
  lastPresenceKey: string;
}

interface MemberRow {
  id: string;
  display_name: string;
  avatar: string;
}

/**
 * One office. Holds the live world (positions, connections, current
 * sessions) in memory and folds token updates into the ledger. Fan-out
 * policy: positions relay immediately, presence broadcasts on change,
 * the leaderboard debounces.
 */
export class Room {
  private members = new Map<string, MemberRuntime>();
  private leaderboardTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly code: string,
    private db: Db,
    private ledger: TokenLedger,
  ) {
    const rows = this.db
      .prepare('SELECT id, display_name, avatar FROM members WHERE room_code = ?')
      .all(this.code) as MemberRow[];
    for (const row of rows) this.ensureRuntime(row);
  }

  private ensureRuntime(row: MemberRow): MemberRuntime {
    let runtime = this.members.get(row.id);
    if (!runtime) {
      const shared = this.db
        .prepare('SELECT 1 FROM devices WHERE member_id = ? LIMIT 1')
        .get(row.id);
      runtime = {
        id: row.id,
        displayName: row.display_name,
        avatar: row.avatar,
        sharing: shared !== undefined,
        position: {
          x: SPAWN.x + (Math.random() - 0.5) * 96,
          y: SPAWN.y + (Math.random() - 0.5) * 48,
          dir: 'down',
          moving: false,
        },
        webClients: new Set(),
        collector: null,
        lastPresenceKey: '',
      };
      this.members.set(row.id, runtime);
    }
    return runtime;
  }

  /** A member was just created or re-fetched; make sure the room knows it. */
  memberJoined(row: { id: string; displayName: string; avatar: string }): void {
    this.ensureRuntime({ id: row.id, display_name: row.displayName, avatar: row.avatar });
    this.broadcastMember(row.id);
  }

  addWebClient(client: WebClient): WebWorld | null {
    const runtime = this.members.get(client.memberId);
    if (!runtime) return null;
    runtime.webClients.add(client);
    this.refreshPresence(client.memberId);
    const now = Date.now();
    return {
      type: 'world',
      you: { memberId: client.memberId },
      roomCode: this.code,
      members: [...this.members.keys()].map((id) => this.memberView(id, now)),
      leaderboard: this.leaderboardRows(now),
    };
  }

  removeWebClient(client: WebClient): void {
    const runtime = this.members.get(client.memberId);
    if (!runtime) return;
    runtime.webClients.delete(client);
    this.refreshPresence(client.memberId);
  }

  setWebPresent(client: WebClient, present: boolean): void {
    client.present = present;
    this.refreshPresence(client.memberId);
  }

  attachCollector(memberId: string, ws: WebSocket): boolean {
    const runtime = this.members.get(memberId);
    if (!runtime) return false;
    const previous = runtime.collector;
    if (previous && previous.ws !== ws) {
      // Latest collector wins. Tell the old daemon it was superseded so it
      // stops instead of reconnecting and fighting over the slot forever.
      if (previous.ws.readyState === previous.ws.OPEN) {
        previous.ws.send(
          JSON.stringify({
            type: 'error',
            code: 'superseded',
            message: 'another machine paired for this member took over',
          }),
        );
      }
      previous.ws.close();
    }
    runtime.collector = { ws, lastSeenAt: Date.now(), idleSeconds: undefined, sessions: [] };
    runtime.sharing = true;
    this.refreshPresence(memberId);
    return true;
  }

  detachCollector(memberId: string, ws: WebSocket): void {
    const runtime = this.members.get(memberId);
    if (runtime?.collector?.ws === ws) {
      runtime.collector = null;
      this.refreshPresence(memberId);
    }
  }

  ingestSnapshot(memberId: string, ws: WebSocket, snapshot: CollectorSnapshot, now: number): void {
    const runtime = this.members.get(memberId);
    if (!runtime?.collector) return;
    // A superseded socket may still have snapshots in flight; ignore them.
    if (runtime.collector.ws !== ws) return;
    runtime.collector.lastSeenAt = now;
    runtime.collector.idleSeconds = snapshot.machine.idleSeconds;
    runtime.collector.sessions = snapshot.sessions;
    if (this.ledger.ingest(memberId, snapshot.sessions, now)) {
      this.scheduleLeaderboard();
    }
    this.refreshPresence(memberId);
  }

  updatePosition(memberId: string, position: Position): void {
    const runtime = this.members.get(memberId);
    if (!runtime) return;
    runtime.position = position;
    this.broadcast({ type: 'pos', memberId, position }, memberId);
  }

  /** Remove a member entirely (stale cleanup): sockets, runtime, broadcast. */
  forgetMember(memberId: string): void {
    const runtime = this.members.get(memberId);
    if (!runtime) return;
    for (const client of runtime.webClients) client.ws.close();
    runtime.collector?.ws.close();
    this.members.delete(memberId);
    this.broadcast({ type: 'member-left', memberId });
  }

  /** Recompute time-driven presence (timeouts, idle drift) for everyone. */
  sweep(now: number): void {
    for (const id of this.members.keys()) this.refreshPresence(id, now);
  }

  memberView(memberId: string, now: number): MemberView {
    const runtime = this.members.get(memberId);
    if (!runtime) throw new Error(`unknown member ${memberId}`);
    return {
      id: runtime.id,
      displayName: runtime.displayName,
      avatar: runtime.avatar,
      presence: this.presenceOf(runtime, now),
      position: runtime.position,
      sessions: this.liveSessions(runtime, now),
      today: this.ledger.todayFor(memberId, now),
      sharing: runtime.sharing,
    };
  }

  private liveSessions(runtime: MemberRuntime, now: number): SessionSnapshot[] {
    if (!runtime.collector) return [];
    if (now - runtime.collector.lastSeenAt >= 90_000) return [];
    return runtime.collector.sessions;
  }

  private presenceOf(runtime: MemberRuntime, now: number): PresenceState {
    return derivePresence({
      browserPresent: [...runtime.webClients].some((c) => c.present),
      browserConnected: runtime.webClients.size > 0,
      machineIdleSeconds: runtime.collector?.idleSeconds,
      collectorSeenAt: runtime.collector?.lastSeenAt,
      sessions: runtime.collector?.sessions ?? [],
      now,
    });
  }

  private refreshPresence(memberId: string, now: number = Date.now()): void {
    const runtime = this.members.get(memberId);
    if (!runtime) return;
    const presence = this.presenceOf(runtime, now);
    const sessions = this.liveSessions(runtime, now);
    const today = this.ledger.todayFor(memberId, now);
    const key = JSON.stringify([presence, sessions, today]);
    if (key === runtime.lastPresenceKey) return;
    runtime.lastPresenceKey = key;
    this.broadcast({ type: 'presence', memberId, presence, sessions, today });
  }

  private broadcastMember(memberId: string): void {
    this.broadcast({ type: 'member', member: this.memberView(memberId, Date.now()) });
  }

  private leaderboardRows(now: number): LeaderboardRow[] {
    const rows = [...this.members.values()].map((runtime) => ({
      memberId: runtime.id,
      displayName: runtime.displayName,
      avatar: runtime.avatar,
      stats: this.ledger.todayFor(runtime.id, now),
    }));
    rows.sort((a, b) => billedTokens(b.stats.tokens) - billedTokens(a.stats.tokens));
    return rows;
  }

  private scheduleLeaderboard(): void {
    if (this.leaderboardTimer) return;
    this.leaderboardTimer = setTimeout(() => {
      this.leaderboardTimer = null;
      this.broadcast({ type: 'leaderboard', rows: this.leaderboardRows(Date.now()) });
    }, LEADERBOARD_DEBOUNCE_MS);
  }

  broadcast(message: ServerToWeb, exceptMemberId?: string): void {
    const data = JSON.stringify(message);
    for (const runtime of this.members.values()) {
      for (const client of runtime.webClients) {
        if (exceptMemberId && client.memberId === exceptMemberId) continue;
        if (client.ws.readyState === client.ws.OPEN) client.ws.send(data);
      }
    }
  }

  close(): void {
    if (this.leaderboardTimer) clearTimeout(this.leaderboardTimer);
  }
}
