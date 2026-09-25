import { timingSafeEqual } from 'node:crypto';
import {
  defaultWorkspaceSettings,
  isKnownTimeZone,
  type MemberRole,
  type MemberStatus,
  parseSettings,
  type RosterEntry,
  type WorkspaceSettings,
} from '@sloppers/protocol';
import type { Db } from '../db/index.js';
import { memberId, memberSecret, randomAvatar, roomSuffix, workspaceId } from '../ids.js';
import { TokenLedger } from '../ledger.js';
import { pruneChat } from './chat.js';
import { Room } from './live.js';

/**
 * Hard ceilings so an unauthenticated stranger can't grow the database and
 * world state without bound. Generous for the friends-scale product.
 */
const MAX_WORKSPACES = 200;
const MAX_MEMBERS_PER_WORKSPACE = 64;
/** Members that never paired a device and haven't been seen this long go. */
const STALE_MEMBER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Everything a member row scoped to one workspace is deleted from.
 *
 * `daily_usage` and `usage_watermarks` must stay here **together**, and the
 * ledger quietly depends on it. Watermarks carry two facts the ledger treats
 * as one-way — `shrunk`, which makes a session permanently ineligible for
 * downtime recovery, and `banked_*`, which says how much a bucket contributed
 * to `daily_usage` — and it reasons about both on the basis that nothing
 * removes a watermark row while its banked spend survives. Deleting only
 * `usage_watermarks` would strand `daily_usage` totals no watermark admits to,
 * and re-open the double-counting the ledger's re-basing and reconciliation
 * exist to prevent.
 *
 * Safe as written because the two are erased in one transaction and member ids
 * are random 16-hex that are never reused, so nothing can bank against a
 * half-erased member. Keep it that way.
 *
 * `chat_messages` is here for a different reason from everything else in the
 * list, and a stronger one. The rest is measurement — how many tokens somebody
 * burned on a Tuesday — and deleting a member erases it because attribution
 * with nobody to attribute to is just clutter. Chat is what a person wrote.
 * "Delete me" has to mean the office stops holding their sentences, or it does
 * not mean much; a member row removed while their words stay on the wall is
 * the thin version of the promise. It is also the one table here with a
 * foreign key back to `members`, which makes dropping it from this list loud
 * rather than silent — but loud in the wrong place: `admin.ts` evicts the
 * member from the live room *before* calling this, so the constraint fires
 * after their sockets are already shut and leaves the room and the row
 * disagreeing. The test is the guard here; the foreign key is only the noise
 * that would send somebody looking for it.
 */
const MEMBER_OWNED_TABLES = [
  'chat_messages',
  'daily_usage',
  'daily_activity',
  'usage_watermarks',
  'legacy_sessions',
  'relink_tokens',
  'pairings',
  'devices',
] as const;

function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** The `the-lab` half of `the-lab-k4xp2q`. Never empty. */
function slugify(vanityName: string): string {
  return (
    vanityName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/g, '') || 'office'
  );
}

export interface MemberRecord {
  id: string;
  workspaceId: string;
  secret: string;
  displayName: string;
  avatar: string;
  role: MemberRole;
  status: MemberStatus;
}

interface MemberRow {
  id: string;
  workspace_id: string;
  secret: string;
  display_name: string;
  avatar: string;
  role: MemberRole;
  status: MemberStatus;
}

const MEMBER_COLUMNS = 'id, workspace_id, secret, display_name, avatar, role, status';

function toRecord(row: MemberRow): MemberRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    secret: row.secret,
    displayName: row.display_name,
    avatar: row.avatar,
    role: row.role,
    status: row.status,
  };
}

interface WorkspaceRow {
  id: string;
  name: string;
  invite_code: string;
  settings: string;
}

/** One audit-log line, oldest fields first. */
export interface WorkspaceEvent {
  at: number;
  actorId: string | null;
  action: string;
  targetId: string | null;
  detail: string | null;
}

/**
 * Creates and indexes workspaces, and owns the identity and moderation
 * operations that span the database and a live room (member creation,
 * credential checks, roles, invite rotation).
 *
 * Live rooms are cached by workspace id — the one identifier that never
 * changes — with `byInvite` as a secondary index that rotation maintains.
 */
export class WorkspaceManager {
  private rooms = new Map<string, Room>();
  private byInvite = new Map<string, string>();
  readonly ledger: TokenLedger;

  constructor(private db: Db) {
    this.ledger = new TokenLedger(db);
  }

  /** An existing workspace by its current invite code, or null. Never creates. */
  getRoom(inviteCode: string): Room | null {
    const cachedId = this.byInvite.get(inviteCode);
    const cached = cachedId ? this.rooms.get(cachedId) : undefined;
    if (cached) return cached;
    const row = this.db
      .prepare('SELECT id, name, invite_code, settings FROM workspaces WHERE invite_code = ?')
      .get(inviteCode) as WorkspaceRow | undefined;
    if (!row) {
      this.byInvite.delete(inviteCode);
      return null;
    }
    return this.materialize(row);
  }

  /** An existing workspace by its permanent id, or null. Never creates. */
  roomById(id: string): Room | null {
    const cached = this.rooms.get(id);
    if (cached) return cached;
    const row = this.db
      .prepare('SELECT id, name, invite_code, settings FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;
    if (!row) return null;
    return this.materialize(row);
  }

  private materialize(row: WorkspaceRow): Room {
    const room = new Room(
      row.id,
      row.invite_code,
      row.name,
      parseSettings(row.settings),
      this.db,
      this.ledger,
      this,
    );
    this.rooms.set(row.id, room);
    this.byInvite.set(row.invite_code, row.id);
    return room;
  }

  /**
   * Mint a new office: slugified vanity name plus a random suffix. The full
   * code is the capability — invite links carry it, nothing else guards the
   * door. Returns null at the workspace cap.
   *
   * `timezone` is whatever the creator's browser said it was in. Taken as a
   * hint rather than a promise: an unrecognized zone falls back to the default
   * instead of refusing the join, because somebody opening their first office
   * on an unusual runtime should get an office, not an error about a field
   * they never filled in. The owner can set it deliberately in Settings, and
   * *that* path refuses garbage outright.
   */
  createRoom(vanityName: string, timezone?: string): Room | null {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    if (count.n >= MAX_WORKSPACES) return null;
    const slug = slugify(vanityName);
    const settings = JSON.stringify({
      ...defaultWorkspaceSettings,
      ...(timezone && isKnownTimeZone(timezone) ? { timezone } : {}),
    });
    // Suffix collisions are ~one in a billion; retry regardless.
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = workspaceId();
      const code = `${slug}-${roomSuffix()}`;
      try {
        this.db
          .prepare(
            'INSERT INTO workspaces (id, name, invite_code, settings, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(id, vanityName, code, settings, Date.now());
      } catch {
        continue;
      }
      return this.materialize({ id, name: vanityName, invite_code: code, settings });
    }
    return null;
  }

  /**
   * A workspace with a fixed, knowable invite code — only for server-managed
   * spaces like the demo floor, never reachable through the public create path.
   */
  ensureInternalRoom(code: string, name: string): Room {
    const existing = this.getRoom(code);
    if (existing) return existing;
    const id = workspaceId();
    const settings = JSON.stringify(defaultWorkspaceSettings);
    this.db
      .prepare(
        'INSERT INTO workspaces (id, name, invite_code, settings, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, name, code, settings, Date.now());
    return this.materialize({ id, name, invite_code: code, settings });
  }

  createMember(
    workspace: string,
    displayName: string,
    avatar?: string,
  ): MemberRecord | 'name-taken' | 'room-full' {
    const count = this.db
      .prepare("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND status = 'active'")
      .get(workspace) as { n: number };
    if (count.n >= MAX_MEMBERS_PER_WORKSPACE) return 'room-full';
    // Somebody already in the office inherits ahead of somebody arriving at
    // it: a leaked link should not hand the keys to a stranger while a
    // moderator the owner themselves promoted is sitting inside.
    this.ensureOwner(workspace);
    // Adoption, not "first ever member": migration 002 can leave a workspace
    // with no members at all (a room that was empty when it migrated), and an
    // owner who was deleted or banned leaves one ownerless. With nobody left
    // to inherit, whoever walks in next takes the keys.
    const owned = this.db
      .prepare(
        "SELECT 1 FROM members WHERE workspace_id = ? AND role = 'owner' AND status = 'active' LIMIT 1",
      )
      .get(workspace);
    // Founding an office is not a change of hands — there were no hands, and
    // the roster says who opened it from the first second. Walking into one
    // that already had people in it and leaving with the keys is, and that is
    // the row somebody will want later. Only asked when the office turns out
    // to be ownerless, which is rare.
    const adopting =
      owned === undefined &&
      this.db.prepare('SELECT 1 FROM members WHERE workspace_id = ? LIMIT 1').get(workspace) !==
        undefined;
    const record: MemberRecord = {
      id: memberId(),
      workspaceId: workspace,
      secret: memberSecret(),
      displayName,
      avatar: avatar ?? randomAvatar(),
      role: owned === undefined ? 'owner' : 'member',
      status: 'active',
    };
    try {
      this.db
        .prepare(
          'INSERT INTO members (id, workspace_id, secret, display_name, avatar, role, status, created_at, last_seen_at, last_present_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.id,
          workspace,
          record.secret,
          displayName,
          record.avatar,
          record.role,
          record.status,
          Date.now(),
          Date.now(),
          // Somebody is standing here right now — a member is only ever minted
          // by a browser walking in. Seeding this with the present rather than
          // with zero is what makes a first-ever arrival not a return: there is
          // no "away" before you exist, and an office that greeted a stranger
          // with what they missed would be greeting them for missing the years
          // before they had heard of it.
          Date.now(),
        );
    } catch {
      // Unique index on (workspace, lower(name)) WHERE status = 'active'.
      return 'name-taken';
    }
    // The largest privilege change the system can make, and nobody clicked
    // anything to cause it. `workspace.adopt` is what answers "who made them
    // the owner?" — see `ensureOwner` for the other way it happens.
    if (adopting) this.logEvent(workspace, null, 'workspace.adopt', record.id, 'new member');
    return record;
  }

  /**
   * Make sure this office has an owner, and say who just inherited if one had
   * to. Null when it already had one, or when nobody is left who could take
   * it. Idempotent, so it is safe to call on any path that might be looking
   * at an ownerless office.
   *
   * An office loses its owner mostly through the stale sweep: whoever opened
   * it never paired a device and stopped coming back. `createMember` used to
   * be the only thing that noticed, which a `knock` or `locked` door never
   * reaches — so every knock waited forever at a door nobody could answer,
   * and the setting that closed it is owner-only to change. Sealed shut.
   *
   * The heir is the most senior person still inside: a moderator first (the
   * owner picked them, which is the closest thing left to their intent), then
   * the longest-standing member. Deliberately *not* a fallback to `link`
   * mode — the door was set that way on purpose, and quietly opening it is a
   * bigger liberty than handing the keys to somebody already trusted with a
   * seat. Tombstones are records, not residents, so a room whose only rows
   * are kicked or banned stays ownerless and ages out.
   */
  ensureOwner(workspace: string): string | null {
    const owned = this.db
      .prepare(
        "SELECT 1 FROM members WHERE workspace_id = ? AND role = 'owner' AND status = 'active' LIMIT 1",
      )
      .get(workspace);
    if (owned !== undefined) return null;
    const heir = this.db
      .prepare(`
        SELECT id, role FROM members
        WHERE workspace_id = ? AND status = 'active'
        ORDER BY CASE role WHEN 'moderator' THEN 0 ELSE 1 END, created_at, id
        LIMIT 1
      `)
      .get(workspace) as { id: string; role: MemberRole } | undefined;
    if (!heir) return null;
    this.db.prepare("UPDATE members SET role = 'owner' WHERE id = ?").run(heir.id);
    // Nobody is the actor: this is the office repairing itself, and the log
    // should not name a person who did not decide it. The detail carries what
    // they were before, which is the whole reason they were chosen.
    this.logEvent(workspace, null, 'workspace.adopt', heir.id, heir.role);
    return heir.id;
  }

  /**
   * "Something spoke for this member just now" — a browser resuming, a relink
   * redeemed, a collector saying hello.
   *
   * Deliberately that broad, because what reads it is the stale sweep: a member
   * whose laptop has been reporting all week is plainly not a stray join, and
   * erasing them would take their history with it. It is *not* "they were in
   * the office", and nothing that needs that meaning may use it — see
   * `markPresent`.
   */
  touchMember(memberIdValue: string): void {
    this.db
      .prepare('UPDATE members SET last_seen_at = ? WHERE id = ?')
      .run(Date.now(), memberIdValue);
  }

  /**
   * "A browser of theirs has the office open" — the honest source for absence,
   * and the narrow half of `touchMember`.
   *
   * Written on arrival, refreshed while somebody is actually here, and stamped
   * again when their last tab goes. A collector never touches it: a machine
   * reporting tokens overnight is the *subject* of the greeting, not evidence
   * that anybody was reading it.
   */
  markPresent(memberIdValue: string, now: number = Date.now()): void {
    this.db.prepare('UPDATE members SET last_present_at = ? WHERE id = ?').run(now, memberIdValue);
  }

  /** When a browser of theirs was last here; 0 for a member who never has been. */
  lastPresentAt(memberIdValue: string): number {
    const row = this.db
      .prepare('SELECT last_present_at FROM members WHERE id = ?')
      .get(memberIdValue) as { last_present_at: number } | undefined;
    return row?.last_present_at ?? 0;
  }

  /**
   * Forget members that never paired a device and haven't been seen in a
   * week — stray joins, not teammates. Runs at startup and daily.
   *
   * Banned rows are exempt: the row *is* the ban. It is what the roster
   * reports, what an unban flips back, and what moderation addresses through
   * `memberById(id, { includeRemoved: true })` — erase it and the ban has
   * quietly expired on a timer nobody chose. A ban ends with an unban.
   * Kicked rows carry no such record (a kicked member may rejoin freely), so
   * they age out like anyone else.
   */
  cleanupStaleMembers(now: number = Date.now()): number {
    const cutoff = now - STALE_MEMBER_MS;
    // Retention, run where the other daily forgetting happens. Ahead of the
    // member sweep rather than after it, so a conversation ages out on its own
    // schedule whether or not anybody in it turned out to be stale.
    pruneChat(this.db, now);
    const stale = this.db
      .prepare(`
        SELECT id, workspace_id FROM members
        WHERE last_seen_at < ? AND created_at < ?
          AND status != 'banned'
          AND NOT EXISTS (SELECT 1 FROM devices WHERE devices.member_id = members.id)
      `)
      .all(cutoff, cutoff) as { id: string; workspace_id: string }[];
    const remove = this.db.transaction((ids: string[]) => {
      for (const id of ids) this.eraseMember(id);
    });
    remove(stale.map((s) => s.id));
    for (const s of stale) this.rooms.get(s.workspace_id)?.forgetMember(s.id);

    // This is where offices go ownerless: the sweep has no exemption for an
    // owner, so the friend who opened one from a browser, never ran `sloppers
    // share`, and did not come back for a week takes the keys with them. Fix
    // it here, where the loss actually happens, rather than waiting for
    // somebody to walk in — a knock-mode door has nobody who can let them in,
    // so nobody may ever walk in again.
    for (const workspace of new Set(stale.map((s) => s.workspace_id))) {
      const heir = this.ensureOwner(workspace);
      if (heir) this.rooms.get(workspace)?.refreshMember(heir);
    }

    // Workspaces whose last member aged out go too — otherwise abandoned
    // offices accumulate until the cap permanently locks out creation. A
    // surviving banned row counts as a member here, and deliberately so: the
    // ban has nothing to attach to once its workspace is gone.
    const empty = this.db
      .prepare(`
        SELECT id, invite_code FROM workspaces
        WHERE created_at < ?
          AND NOT EXISTS (SELECT 1 FROM members WHERE members.workspace_id = workspaces.id)
      `)
      .all(cutoff) as { id: string; invite_code: string }[];
    const drop = this.db.transaction((ids: string[]) => {
      const events = this.db.prepare('DELETE FROM workspace_events WHERE workspace_id = ?');
      // Every message here belongs to a member, and every member of this
      // office has just been erased — so this should always find nothing. It
      // is not decoration: `chat_messages` references `workspaces(id)`, and if
      // the invariant ever failed, the line below would not leave an orphan,
      // it would throw and take the whole sweep down with it.
      const chat = this.db.prepare('DELETE FROM chat_messages WHERE workspace_id = ?');
      const workspace = this.db.prepare('DELETE FROM workspaces WHERE id = ?');
      for (const id of ids) {
        events.run(id);
        chat.run(id);
        workspace.run(id);
      }
    });
    drop(empty.map((w) => w.id));
    for (const { id, invite_code } of empty) {
      this.rooms.get(id)?.close();
      this.rooms.delete(id);
      this.byInvite.delete(invite_code);
    }
    return stale.length;
  }

  /** Credentials check for a live identity. Removed members never pass. */
  authMember(memberIdValue: string, secret: string): MemberRecord | null {
    const row = this.db
      .prepare(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = ? AND status = 'active'`)
      .get(memberIdValue) as MemberRow | undefined;
    if (!row || !secretsMatch(row.secret, secret)) return null;
    return toRecord(row);
  }

  /**
   * The tombstone behind credentials `authMember` just refused, when there is
   * one — so a refusal can say what actually happened instead of "unknown
   * member". Never a way in: it hands back a row, and every caller of it is
   * writing a sentence.
   *
   * Still secret-checked, and for the usual reason: without it, holding an id
   * would be enough to ask the office whether that person is banned.
   */
  removedMember(memberIdValue: string, secret: string): MemberRecord | null {
    const row = this.db
      .prepare(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = ? AND status != 'active'`)
      .get(memberIdValue) as MemberRow | undefined;
    if (!row || !secretsMatch(row.secret, secret)) return null;
    return toRecord(row);
  }

  memberByName(workspace: string, displayName: string): MemberRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${MEMBER_COLUMNS} FROM members WHERE workspace_id = ? AND lower(display_name) = lower(?) AND status = 'active'`,
      )
      .get(workspace, displayName) as MemberRow | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * A member by id. Auth and join paths take the default — a kicked or banned
   * row must not resolve to a usable identity. Moderation passes
   * `includeRemoved` so it can still address someone it just removed.
   */
  memberById(memberIdValue: string, opts?: { includeRemoved?: boolean }): MemberRecord | null {
    const filter = opts?.includeRemoved ? '' : " AND status = 'active'";
    const row = this.db
      .prepare(`SELECT ${MEMBER_COLUMNS} FROM members WHERE id = ?${filter}`)
      .get(memberIdValue) as MemberRow | undefined;
    return row ? toRecord(row) : null;
  }

  setRole(memberIdValue: string, role: MemberRole): void {
    this.db.prepare('UPDATE members SET role = ? WHERE id = ?').run(role, memberIdValue);
  }

  setStatus(memberIdValue: string, status: MemberStatus): void {
    this.db.prepare('UPDATE members SET status = ? WHERE id = ?').run(status, memberIdValue);
  }

  /**
   * Hand the office over. One transaction, because a crash between the two
   * updates would leave the workspace with two owners or none.
   */
  transferOwnership(fromId: string, toId: string): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE members SET role = 'moderator' WHERE id = ?").run(fromId);
      this.db.prepare("UPDATE members SET role = 'owner' WHERE id = ?").run(toId);
    })();
  }

  /** Mint a new invite code, invalidating every link already handed out. */
  rotateInvite(workspace: string): string {
    const row = this.db
      .prepare('SELECT name, invite_code FROM workspaces WHERE id = ?')
      .get(workspace) as { name: string; invite_code: string } | undefined;
    if (!row) throw new Error(`unknown workspace ${workspace}`);
    const update = this.db.prepare('UPDATE workspaces SET invite_code = ? WHERE id = ?');
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = `${slugify(row.name)}-${roomSuffix()}`;
      // Re-minting the code we already have would UPDATE cleanly and revoke
      // nothing, while reporting a rotation to the caller. Vanishingly rare,
      // silently wrong; mint again instead.
      if (code === row.invite_code) continue;
      try {
        update.run(code, workspace);
      } catch {
        continue; // suffix collision; try again
      }
      const room = this.rooms.get(workspace);
      if (room) room.code = code;
      this.byInvite.delete(row.invite_code);
      this.byInvite.set(code, workspace);
      return code;
    }
    throw new Error('could not mint a unique invite code');
  }

  rename(workspace: string, name: string): void {
    this.db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, workspace);
    const room = this.rooms.get(workspace);
    if (room) room.name = name;
  }

  setSettings(workspace: string, settings: WorkspaceSettings): void {
    this.db
      .prepare('UPDATE workspaces SET settings = ? WHERE id = ?')
      .run(JSON.stringify(settings), workspace);
    const room = this.rooms.get(workspace);
    if (!room) return;
    // Changing the timezone changes which 24 hours every number on the board
    // is about. No rows move — the day keys are the days the work was done —
    // but the room has to re-read and re-announce, or the office goes on
    // showing the old window until something else happens to push.
    const dayWindowMoved = room.settings.timezone !== settings.timezone;
    room.settings = settings;
    if (dayWindowMoved) room.refreshDayWindow();
  }

  /**
   * Everyone the workspace has ever admitted, removed members included.
   *
   * `sharing` here is "has ever paired a device", which is not what the same
   * word means on a `MemberView` — that one is "a collector is attached right
   * now", because the HUD beside it has to stop saying "Sharing on" when a
   * laptop shuts. This is the durable fact, and the right one for a list that
   * includes people who have not been seen in a week: it answers "is this
   * person set up at all", which no live socket can.
   */
  roster(workspace: string): RosterEntry[] {
    const rows = this.db
      .prepare(`
        SELECT m.id, m.display_name, m.avatar, m.role, m.status, m.last_seen_at,
               EXISTS(SELECT 1 FROM devices d WHERE d.member_id = m.id) AS sharing
        FROM members m WHERE m.workspace_id = ?
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
                 lower(m.display_name)
      `)
      .all(workspace) as {
      id: string;
      display_name: string;
      avatar: string;
      role: MemberRole;
      status: MemberStatus;
      last_seen_at: number;
      sharing: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      avatar: r.avatar,
      role: r.role,
      status: r.status,
      lastSeenAt: r.last_seen_at,
      sharing: r.sharing === 1,
    }));
  }

  logEvent(
    workspace: string,
    actorId: string | null,
    action: string,
    targetId?: string,
    detail?: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO workspace_events (workspace_id, at, actor_id, action, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(workspace, Date.now(), actorId, action, targetId ?? null, detail ?? null);
  }

  events(workspace: string, limit = 50): WorkspaceEvent[] {
    const rows = this.db
      .prepare(
        'SELECT at, actor_id, action, target_id, detail FROM workspace_events WHERE workspace_id = ? ORDER BY at DESC LIMIT ?',
      )
      .all(workspace, limit) as {
      at: number;
      actor_id: string | null;
      action: string;
      target_id: string | null;
      detail: string | null;
    }[];
    return rows.map((r) => ({
      at: r.at,
      actorId: r.actor_id,
      action: r.action,
      targetId: r.target_id,
      detail: r.detail,
    }));
  }

  /** Erase a member and everything attributable to them. */
  deleteMember(memberIdValue: string): void {
    this.db.transaction(() => this.eraseMember(memberIdValue))();
  }

  /** The row deletions behind `deleteMember`; callers supply the transaction. */
  private eraseMember(memberIdValue: string): void {
    for (const table of MEMBER_OWNED_TABLES) {
      this.db.prepare(`DELETE FROM ${table} WHERE member_id = ?`).run(memberIdValue);
    }
    this.db.prepare('DELETE FROM members WHERE id = ?').run(memberIdValue);
  }

  /** Periodic time-driven refresh across every live room. */
  sweep(now: number = Date.now()): void {
    for (const room of this.rooms.values()) room.sweep(now);
  }

  close(): void {
    for (const room of this.rooms.values()) room.close();
  }
}
