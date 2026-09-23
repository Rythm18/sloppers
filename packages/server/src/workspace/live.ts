import {
  type CollectorSnapshot,
  type DailyStats,
  type LeaderboardRow,
  MAX_HISTORY_DAYS,
  type MemberRole,
  type MemberView,
  type Position,
  type PresenceState,
  processedTokens,
  recentDays,
  type ServerToWeb,
  type SessionSnapshot,
  type WebHistoryResult,
  type WebRemoved,
  type WebWorld,
  type WorkspaceSettings,
} from '@sloppers/protocol';
import type { WebSocket } from 'ws';
import type { Db } from '../db/index.js';
import { can } from '../domain/permissions.js';
import { relinkToken } from '../ids.js';
// A value import, not a type-only one: `TokenLedger.dayIn` is the one answer
// to "which day is this office in", and `history` below has to serve the same
// day the live board is serving.
import { TokenLedger } from '../ledger.js';
import { derivePresence } from '../presence.js';
import { type Knock, KnockRegistry, knockIsLive } from './knocks.js';
import type { MemberRecord, WorkspaceManager } from './manager.js';

const LEADERBOARD_DEBOUNCE_MS = 2000;
/** A week, when a browser does not say. Long enough to read as a rhythm. */
const DEFAULT_HISTORY_DAYS = 7;
/** Open floor near the centre of the default 512×352 office map. */
const SPAWN = { x: 256, y: 240 };
/** Long enough to walk to the other device, short enough to be worth stealing. */
const DEVICE_LINK_TTL_MS = 10 * 60 * 1000;

/** Why a seat emptied, told to the person who lost it before their socket goes. */
type RemovalReason = WebRemoved['reason'];

function send(ws: WebSocket, message: ServerToWeb): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

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
  role: MemberRole;
  /**
   * Whether a collector is attached for this member **right now**.
   *
   * It used to mean "has ever paired a device" — read once off the `devices`
   * table, raised on the first attach and never lowered again. So an office
   * went on saying "Sharing on" over a member card reading "no live agent
   * sessions right now" for as long as the row survived: two sentences, each
   * true on its own, telling one lie together. The wire field keeps its name
   * and its shape; what it claims is now something the room can actually see.
   */
  sharing: boolean;
  /**
   * What this member's collector last said about `visibility.tokens`.
   *
   * True until a collector says otherwise, because `sloppers@0.1.x` never says
   * anything at all and the room must not accuse a silent machine of
   * withholding. It lives on the member rather than on the collector link so
   * that a laptop closing does not turn "keeps their numbers to themselves"
   * back into "$0.00" — the setting is a fact about the person, and the last
   * thing we were told about it stays true until we are told something else.
   */
  sharesTokens: boolean;
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
  role: MemberRole;
}

/**
 * One office. Holds the live world (positions, connections, current
 * sessions) in memory and folds token updates into the ledger. Fan-out
 * policy: positions relay immediately, presence broadcasts on change,
 * the leaderboard debounces.
 *
 * `id` is the workspace's permanent identity; `code` is the invite code and
 * `name` the display name, both of which an owner can change under us — so
 * they are mutable and the manager writes through to them.
 */
export class Room {
  private members = new Map<string, MemberRuntime>();
  private leaderboardTimer: NodeJS.Timeout | null = null;
  /** Everyone waiting at the door right now. Empty unless joinMode is knock. */
  readonly knocks = new KnockRegistry();
  /**
   * What the people at the door were last told about their chances. A fresh
   * room has nobody connected yet, so it starts false and every change from
   * there is announced.
   */
  private doorAnswerable = false;

  constructor(
    readonly id: string,
    public code: string,
    public name: string,
    public settings: WorkspaceSettings,
    private db: Db,
    private ledger: TokenLedger,
    private manager: WorkspaceManager,
  ) {
    // Only active members are part of the live world; kicked and banned rows
    // survive in the database for the roster and for usage attribution.
    const rows = this.db
      .prepare(
        "SELECT id, display_name, avatar, role FROM members WHERE workspace_id = ? AND status = 'active'",
      )
      .all(this.id) as MemberRow[];
    for (const row of rows) this.ensureRuntime(row);
  }

  private ensureRuntime(row: MemberRow): MemberRuntime {
    let runtime = this.members.get(row.id);
    if (!runtime) {
      runtime = {
        id: row.id,
        displayName: row.display_name,
        avatar: row.avatar,
        role: row.role,
        // Nothing is attached to a runtime that did not exist a line ago, and
        // that is the whole claim now. Reading the `devices` table here is
        // what made a restarted server greet everyone who had ever paired
        // with "Sharing on", collectors or no collectors.
        sharing: false,
        sharesTokens: true,
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
  memberJoined(row: { id: string; displayName: string; avatar: string; role: MemberRole }): void {
    this.ensureRuntime({
      id: row.id,
      display_name: row.displayName,
      avatar: row.avatar,
      role: row.role,
    });
    this.broadcastMember(row.id);
    // Arriving changes the roster as surely as being kicked does — a new row
    // through the door, or a `sharing` flag flipping as a collector attaches.
    // Every other membership change pushes; this one used to leave whoever is
    // moderating with a list that did not have the newcomer in it.
    this.broadcastRoster();
  }

  addWebClient(client: WebClient): WebWorld | null {
    const runtime = this.members.get(client.memberId);
    if (!runtime) return null;
    runtime.webClients.add(client);
    this.refreshPresence(client.memberId);
    this.tellKnockersWhoIsHome();
    const now = Date.now();
    return {
      type: 'world',
      you: { memberId: client.memberId },
      roomCode: this.code,
      roomName: this.name,
      members: [...this.members.keys()].map((id) => this.memberView(id, now)),
      leaderboard: this.leaderboardRows(now),
    };
  }

  removeWebClient(client: WebClient): void {
    const runtime = this.members.get(client.memberId);
    if (!runtime) return;
    runtime.webClients.delete(client);
    this.refreshPresence(client.memberId);
    this.tellKnockersWhoIsHome();
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
    // The moment a pairing becomes real. `sharing` rides on the member view
    // and on nothing else — a `presence` message carries presence, sessions
    // and today's totals, none of which need have changed when a collector
    // with no live session attaches — so without this the browser that just
    // handed somebody the pairing command learns nothing at all until it is
    // reloaded. Sent only on the edge: a second machine taking over from one
    // that has not detached yet changes nothing anybody can see.
    const becameSharing = !runtime.sharing;
    runtime.sharing = true;
    if (becameSharing) this.broadcastMember(memberId);
    this.refreshPresence(memberId);
    return true;
  }

  /**
   * A collector's socket went away: the daemon stopped, the laptop shut, the
   * heartbeat reaped a half-open connection. Nothing is sharing from that
   * machine any more, and the `sharing` flag has to come back down and say
   * so — otherwise the HUD reads "Sharing on" over an office that has not
   * heard from the machine in a week.
   *
   * On the edge, like the attach, so a member with no collector is not
   * re-announced every time a stray socket drops. The `ws` guard is what
   * keeps a superseded collector — which detaches *after* its replacement
   * attached — from lowering a flag the new machine just raised.
   */
  detachCollector(memberId: string, ws: WebSocket): void {
    const runtime = this.members.get(memberId);
    if (runtime?.collector?.ws !== ws) return;
    runtime.collector = null;
    const wasSharing = runtime.sharing;
    runtime.sharing = false;
    if (wasSharing) this.broadcastMember(memberId);
    this.refreshPresence(memberId);
  }

  ingestSnapshot(memberId: string, ws: WebSocket, snapshot: CollectorSnapshot, now: number): void {
    const runtime = this.members.get(memberId);
    if (!runtime?.collector) return;
    // A superseded socket may still have snapshots in flight; ignore them.
    if (runtime.collector.ws !== ws) return;
    runtime.collector.lastSeenAt = now;
    runtime.collector.idleSeconds = snapshot.machine.idleSeconds;
    runtime.collector.sessions = snapshot.sessions;
    // Absent means "0.1.x, which cannot tell us", not "off": treating silence
    // as withholding would relabel every member who has not upgraded.
    runtime.sharesTokens = snapshot.sharesTokens ?? true;
    if (this.ledger.ingest(memberId, snapshot.sessions, now, this.settings.timezone)) {
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

  /**
   * Remove a member entirely: sockets, runtime, broadcast. `reason` tells
   * their browsers what happened before the socket closes under them — the
   * stale sweep passes none, because nobody is there to be told.
   */
  forgetMember(memberId: string, reason?: RemovalReason): void {
    const runtime = this.members.get(memberId);
    if (!runtime) return;
    for (const client of runtime.webClients) {
      if (reason) send(client.ws, { type: 'removed', reason });
      client.ws.close();
    }
    runtime.collector?.ws.close();
    this.members.delete(memberId);
    this.broadcast({ type: 'member-left', memberId });
    // The last moderator can be shown the door too, and then there is nobody
    // left to answer it.
    this.tellKnockersWhoIsHome();
  }

  /**
   * Re-read a member's row and re-announce them. The runtime caches the role
   * it first saw and `ensureRuntime` keeps that copy, so a promotion is
   * invisible to everyone — even across a rejoin — until something reads the
   * row again. This is that something.
   */
  refreshMember(memberId: string): void {
    const runtime = this.members.get(memberId);
    if (!runtime) return;
    const row = this.db
      .prepare(
        "SELECT id, display_name, avatar, role FROM members WHERE id = ? AND status = 'active'",
      )
      .get(memberId) as MemberRow | undefined;
    if (!row) return;
    runtime.displayName = row.display_name;
    runtime.avatar = row.avatar;
    runtime.role = row.role;
    this.broadcastMember(memberId);
    // A promotion can put somebody at the door who was not there a moment
    // ago, and a demotion can take the last one away.
    this.tellKnockersWhoIsHome();
  }

  /**
   * Let a waiting knocker in: mint their member, then hand them back to their
   * own connection, which finishes the join exactly the way an ordinary
   * joiner's does. Nothing about the admitted socket is special afterwards —
   * it moves, it is seen, it can run admin ops if its role allows, and it
   * cannot join a second time.
   *
   * The name is only checked now, not when they knocked — someone else may
   * have taken it while they waited, or the office may have filled up. Either
   * refusal tells them what went wrong and takes them off the door, so they
   * can knock again under a name that is free; it returns null so the caller
   * drops the knock rather than leaving the queue an entry nobody can act on.
   */
  admitKnock(knock: Knock): MemberRecord | null {
    // A socket that has already gone would never fire the close handler
    // below, so its member would sit in the office forever.
    if (!knockIsLive(knock)) return null;
    const created = this.manager.createMember(this.id, knock.displayName, knock.avatar);
    if (typeof created === 'string') {
      send(
        knock.ws,
        created === 'name-taken'
          ? {
              type: 'error',
              code: 'name-taken',
              message: `someone here is already called ${knock.displayName}`,
            }
          : { type: 'error', code: 'bad-join', message: 'this office is full' },
      );
      // Still their connection's business: it is the only thing that knows
      // this socket was queued, and it has to stop thinking so before the
      // person behind it can offer another name.
      knock.admit(null);
      return null;
    }
    this.memberJoined(created);
    // Everything socket-shaped — sending the world, registering the client,
    // arming the close handler — belongs to the connection that knocked, not
    // to the moderator's op that got us here.
    knock.admit(created);
    return created;
  }

  /** Turn a knocker away. Nothing was written, so nothing is undone. */
  denyKnock(knock: Knock): void {
    send(knock.ws, {
      type: 'error',
      code: 'forbidden',
      message: 'nobody let you in this time',
    });
    knock.ws.close();
  }

  /**
   * The queue as it stands, to one person who has just entered — if they are
   * someone who can answer it.
   *
   * `broadcastKnocks` only fires when the queue itself changes, so without
   * this a moderator who reloads their tab, or comes online after somebody
   * started waiting, sees an empty door while a knocker waits indefinitely
   * with nobody aware of them. Sent even when the queue is empty, so a
   * reconnecting client replaces whatever it remembered rather than keeping
   * a list from before.
   */
  sendStandingKnocks(memberId: string): void {
    const runtime = this.members.get(memberId);
    if (!runtime || !can(runtime.role, 'knock.decide')) return;
    this.sendTo(memberId, { type: 'knocks', knocks: this.knocks.list() });
  }

  /** The waiting queue, to the people allowed to answer it. */
  broadcastKnocks(): void {
    const knocks = this.knocks.list();
    for (const runtime of this.members.values()) {
      if (can(runtime.role, 'knock.decide')) this.sendTo(runtime.id, { type: 'knocks', knocks });
    }
  }

  /**
   * Whether anybody who could open the door has a browser on the other end of
   * it right now. The same audience `broadcastKnocks` fans out to — a knock
   * nobody can hear is the case this exists to name.
   */
  doorIsAnswerable(): boolean {
    for (const runtime of this.members.values()) {
      if (!can(runtime.role, 'knock.decide')) continue;
      for (const client of runtime.webClients) {
        if (client.ws.readyState === client.ws.OPEN) return true;
      }
    }
    return false;
  }

  /**
   * Tell the people at the door whether it can be answered — but only when
   * that changed. Someone who knocked at an empty office is told so, and
   * would otherwise sit reading "nobody's around" long after a moderator
   * walked in; someone who knocked at a busy one deserves to hear the last
   * of them leave.
   */
  private tellKnockersWhoIsHome(): void {
    const answerable = this.doorIsAnswerable();
    if (answerable === this.doorAnswerable) return;
    this.doorAnswerable = answerable;
    for (const knock of this.knocks.waiting()) {
      send(knock.ws, { type: 'knocking', answerable });
    }
  }

  /** The full membership list, to one moderator who asked for it. */
  sendRoster(memberId: string): void {
    this.sendTo(memberId, { type: 'roster', members: this.manager.roster(this.id) });
  }

  /** The roster changed; push it to everyone entitled to see it. */
  broadcastRoster(): void {
    const admins = [...this.members.values()].filter((runtime) => can(runtime.role, 'member.kick'));
    if (admins.length === 0) return;
    const message: ServerToWeb = { type: 'roster', members: this.manager.roster(this.id) };
    for (const admin of admins) this.sendTo(admin.id, message);
  }

  private workspaceState(): ServerToWeb {
    return {
      type: 'workspace',
      roomCode: this.code,
      roomName: this.name,
      settings: this.settings,
    };
  }

  /**
   * How the office is set up, to one person who has just entered.
   *
   * `world` carries the room's name and code but not its settings, and
   * `broadcastWorkspace` fires only when something changes — which in a
   * settled office may be never. Without this a browser has no idea how the
   * door is set, and the settings panel has nothing to show but defaults it
   * would then write back over the truth.
   */
  sendWorkspace(memberId: string): void {
    this.sendTo(memberId, this.workspaceState());
  }

  /** Name, invite code, or settings changed — everyone inside should know. */
  broadcastWorkspace(): void {
    this.broadcast(this.workspaceState());
  }

  /**
   * Mint a one-shot link that signs another browser in as this member: a
   * phone, a second laptop, a cleared localStorage. Relative on purpose —
   * the server has no dependable notion of its own public URL, and the page
   * asking already knows the origin it is talking to.
   *
   * Reports whether a link was actually minted, so the caller only writes an
   * audit row for a credential that exists.
   */
  sendDeviceLink(memberId: string): boolean {
    if (!this.members.has(memberId)) return false;
    const now = Date.now();
    this.db.prepare('DELETE FROM relink_tokens WHERE expires_at < ?').run(now);
    const token = relinkToken();
    const expiresAt = now + DEVICE_LINK_TTL_MS;
    this.db
      .prepare('INSERT INTO relink_tokens (token, member_id, expires_at) VALUES (?, ?, ?)')
      .run(token, memberId, expiresAt);
    this.sendTo(memberId, {
      type: 'device-link',
      url: `/?room=${encodeURIComponent(this.code)}#relink=${token}`,
      expiresAt,
    });
    return true;
  }

  /**
   * The office's recent days, as one answer to one browser that asked.
   *
   * Anchored on the same clock the live board calls "today" — `TokenLedger`'s
   * own `dayIn`, in this office's timezone. A browser cannot name the day, and
   * that is the point: the board's day switch puts "Today" and "Yesterday"
   * side by side, and two definitions of today inside one panel is a bug
   * nobody would ever be able to see. What each day *label* then means per
   * member is their own collector's local day, unconverted, which is the
   * honest reading — the date they did the work, on their calendar.
   *
   * Withholding governs from the present tense. A member whose collector says
   * `visibility.tokens` is off gets an empty `days` and `tokensShared: false`,
   * and their stored days are not read at all — the office does not show a
   * person's past after they have asked it to stop showing their numbers.
   *
   * Costs three queries per member in the office, whatever the day count: see
   * `TokenLedger.recentFor`. An eight-person office is 24 reads for a week.
   */
  history(requestedDays: number | undefined, now: number): WebHistoryResult {
    const endDay = TokenLedger.dayIn(now, this.settings.timezone);
    const wanted = Math.min(Math.max(requestedDays ?? DEFAULT_HISTORY_DAYS, 1), MAX_HISTORY_DAYS);
    // Served from the same helper the ledger reads with, so the labels and the
    // rows under them cannot come apart.
    const days = recentDays(endDay, wanted);
    return {
      type: 'history',
      days,
      members: [...this.members.values()].map((runtime) =>
        runtime.sharesTokens
          ? {
              memberId: runtime.id,
              displayName: runtime.displayName,
              avatar: runtime.avatar,
              days: this.ledger.recentFor(runtime.id, endDay, days.length),
            }
          : {
              memberId: runtime.id,
              displayName: runtime.displayName,
              avatar: runtime.avatar,
              days: [],
              tokensShared: false,
            },
      ),
    };
  }

  /** Recompute time-driven presence (timeouts, idle drift) for everyone. */
  sweep(now: number): void {
    for (const id of this.members.keys()) this.refreshPresence(id, now);
  }

  /**
   * The office's day window moved — its owner changed the timezone — so every
   * number on screen is now about a different 24 hours.
   *
   * Nothing is written and nothing is migrated: the stored days are the days
   * members did the work, and only the window this office reads them through
   * has changed. What has to happen is that the room says so, immediately,
   * rather than leaving yesterday's totals under a heading that now means
   * something else until the next collector happens to report. `refreshPresence`
   * keys on the stats it is about to send, so the ones that genuinely did not
   * move stay quiet; the board is pushed unconditionally, because its rows are
   * ordered against each other and a partial re-read would be a board with two
   * definitions of today in it.
   */
  refreshDayWindow(now: number = Date.now()): void {
    this.sweep(now);
    this.broadcast({ type: 'leaderboard', rows: this.leaderboardRows(now) });
  }

  memberView(memberId: string, now: number): MemberView {
    const runtime = this.members.get(memberId);
    if (!runtime) throw new Error(`unknown member ${memberId}`);
    return {
      id: runtime.id,
      displayName: runtime.displayName,
      avatar: runtime.avatar,
      role: runtime.role,
      presence: this.presenceOf(runtime, now),
      position: runtime.position,
      sessions: this.liveSessions(runtime, now),
      today: this.statsFor(runtime, now),
      sharing: runtime.sharing,
    };
  }

  /**
   * A member's day as the room reports it: the ledger's arithmetic, plus the
   * one thing the ledger cannot know — whether these numbers are all of them.
   *
   * The ledger sees a withholding member as a member who did nothing, because
   * that is exactly what reaches it: `applyVisibility` drops `tokens`, `usage`
   * and `activeMinutes` in the collector, so no row is ever written. Every
   * number below is therefore a truthful zero about an empty table and a false
   * zero about a person, and only the snapshot envelope can say which.
   */
  private statsFor(runtime: MemberRuntime, now: number): DailyStats {
    const stats = this.ledger.todayFor(runtime.id, now, this.settings.timezone);
    return runtime.sharesTokens ? stats : { ...stats, tokensShared: false };
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
    const today = this.statsFor(runtime, now);
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
      stats: this.statsFor(runtime, now),
    }));
    // Total tokens processed, cache included — the board's metric. Ranking on
    // input + output ranked cache *misses*, which is a property of the harness
    // rather than of the work: it scored Claude Code at output alone while
    // Codex banked 8.35x the same ratio.
    rows.sort((a, b) => processedTokens(b.stats.tokens) - processedTokens(a.stats.tokens));
    return rows;
  }

  private scheduleLeaderboard(): void {
    if (this.leaderboardTimer) return;
    this.leaderboardTimer = setTimeout(() => {
      this.leaderboardTimer = null;
      this.broadcast({ type: 'leaderboard', rows: this.leaderboardRows(Date.now()) });
    }, LEADERBOARD_DEBOUNCE_MS);
  }

  /** One member's own browsers, wherever they have the office open. */
  private sendTo(memberId: string, message: ServerToWeb): void {
    const runtime = this.members.get(memberId);
    if (!runtime) return;
    const data = JSON.stringify(message);
    for (const client of runtime.webClients) {
      if (client.ws.readyState === client.ws.OPEN) client.ws.send(data);
    }
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
