import { timingSafeEqual } from 'node:crypto';
import { AVATAR_IDS } from '@sloppers/protocol';
import type { Db } from './db.js';
import { memberId, memberSecret } from './ids.js';
import { TokenLedger } from './ledger.js';
import { Room } from './room.js';

/**
 * Hard ceilings so an unauthenticated stranger can't grow the database and
 * world state without bound. Generous for the friends-scale product.
 */
const MAX_ROOMS = 200;
const MAX_MEMBERS_PER_ROOM = 64;
/** Members that never paired a device and haven't been seen this long go. */
const STALE_MEMBER_MS = 7 * 24 * 60 * 60 * 1000;

function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export interface MemberRecord {
  id: string;
  roomCode: string;
  secret: string;
  displayName: string;
  avatar: string;
}

/**
 * Creates and indexes rooms, and owns the identity operations that span
 * the database and a live room (member creation, credential checks).
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  readonly ledger: TokenLedger;

  constructor(private db: Db) {
    this.ledger = new TokenLedger(db);
  }

  /** Returns null when the room doesn't exist and the room cap is reached. */
  getOrCreate(code: string): Room | null {
    let room = this.rooms.get(code);
    if (room) return room;
    const exists = this.db.prepare('SELECT 1 FROM rooms WHERE code = ?').get(code);
    if (!exists) {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number };
      if (count.n >= MAX_ROOMS) return null;
      this.db.prepare('INSERT INTO rooms (code, created_at) VALUES (?, ?)').run(code, Date.now());
    }
    room = new Room(code, this.db, this.ledger);
    this.rooms.set(code, room);
    return room;
  }

  existing(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  createMember(
    roomCode: string,
    displayName: string,
    avatar?: string,
  ): MemberRecord | 'name-taken' | 'room-full' {
    const count = this.db
      .prepare('SELECT COUNT(*) AS n FROM members WHERE room_code = ?')
      .get(roomCode) as { n: number };
    if (count.n >= MAX_MEMBERS_PER_ROOM) return 'room-full';
    const record: MemberRecord = {
      id: memberId(),
      roomCode,
      secret: memberSecret(),
      displayName,
      avatar: avatar ?? AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)] ?? 'pixel',
    };
    try {
      this.db
        .prepare(
          'INSERT INTO members (id, room_code, secret, display_name, avatar, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          record.id,
          roomCode,
          record.secret,
          displayName,
          record.avatar,
          Date.now(),
          Date.now(),
        );
    } catch {
      // Unique index on (room, lower(name)).
      return 'name-taken';
    }
    return record;
  }

  touchMember(memberIdValue: string): void {
    this.db
      .prepare('UPDATE members SET last_seen_at = ? WHERE id = ?')
      .run(Date.now(), memberIdValue);
  }

  /**
   * Forget members that never paired a device and haven't been seen in a
   * week — stray joins, not teammates. Runs at startup and daily.
   */
  cleanupStaleMembers(now: number = Date.now()): number {
    const cutoff = now - STALE_MEMBER_MS;
    const stale = this.db
      .prepare(`
        SELECT id, room_code FROM members
        WHERE last_seen_at < ? AND created_at < ?
          AND NOT EXISTS (SELECT 1 FROM devices WHERE devices.member_id = members.id)
      `)
      .all(cutoff, cutoff) as { id: string; room_code: string }[];
    const remove = this.db.transaction((ids: string[]) => {
      const stats = this.db.prepare('DELETE FROM daily_stats WHERE member_id = ?');
      const marks = this.db.prepare('DELETE FROM session_watermarks WHERE member_id = ?');
      const pairs = this.db.prepare('DELETE FROM pairings WHERE member_id = ?');
      const member = this.db.prepare('DELETE FROM members WHERE id = ?');
      for (const id of ids) {
        stats.run(id);
        marks.run(id);
        pairs.run(id);
        member.run(id);
      }
    });
    remove(stale.map((s) => s.id));
    for (const s of stale) this.rooms.get(s.room_code)?.forgetMember(s.id);
    return stale.length;
  }

  authMember(memberIdValue: string, secret: string): MemberRecord | null {
    const row = this.db
      .prepare('SELECT id, room_code, secret, display_name, avatar FROM members WHERE id = ?')
      .get(memberIdValue) as
      | { id: string; room_code: string; secret: string; display_name: string; avatar: string }
      | undefined;
    if (!row || !secretsMatch(row.secret, secret)) return null;
    return {
      id: row.id,
      roomCode: row.room_code,
      secret: row.secret,
      displayName: row.display_name,
      avatar: row.avatar,
    };
  }

  memberByName(roomCode: string, displayName: string): MemberRecord | null {
    const row = this.db
      .prepare(
        'SELECT id, room_code, secret, display_name, avatar FROM members WHERE room_code = ? AND lower(display_name) = lower(?)',
      )
      .get(roomCode, displayName) as
      | { id: string; room_code: string; secret: string; display_name: string; avatar: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      roomCode: row.room_code,
      secret: row.secret,
      displayName: row.display_name,
      avatar: row.avatar,
    };
  }

  memberById(memberIdValue: string): MemberRecord | null {
    const row = this.db
      .prepare('SELECT id, room_code, secret, display_name, avatar FROM members WHERE id = ?')
      .get(memberIdValue) as
      | { id: string; room_code: string; secret: string; display_name: string; avatar: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      roomCode: row.room_code,
      secret: row.secret,
      displayName: row.display_name,
      avatar: row.avatar,
    };
  }

  /** Periodic time-driven refresh across every live room. */
  sweep(now: number = Date.now()): void {
    for (const room of this.rooms.values()) room.sweep(now);
  }

  close(): void {
    for (const room of this.rooms.values()) room.close();
  }
}
