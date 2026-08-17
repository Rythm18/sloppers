import { AVATAR_IDS } from '@sloppers/protocol';
import type { Db } from './db.js';
import { memberId, memberSecret } from './ids.js';
import { TokenLedger } from './ledger.js';
import { Room } from './room.js';

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

  getOrCreate(code: string): Room {
    let room = this.rooms.get(code);
    if (room) return room;
    this.db
      .prepare('INSERT OR IGNORE INTO rooms (code, created_at) VALUES (?, ?)')
      .run(code, Date.now());
    room = new Room(code, this.db, this.ledger);
    this.rooms.set(code, room);
    return room;
  }

  existing(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  createMember(roomCode: string, displayName: string, avatar?: string): MemberRecord | 'name-taken' {
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
          'INSERT INTO members (id, room_code, secret, display_name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(record.id, roomCode, record.secret, displayName, record.avatar, Date.now());
    } catch {
      // Unique index on (room, lower(name)).
      return 'name-taken';
    }
    return record;
  }

  authMember(memberIdValue: string, secret: string): MemberRecord | null {
    const row = this.db
      .prepare('SELECT id, room_code, secret, display_name, avatar FROM members WHERE id = ?')
      .get(memberIdValue) as
      | { id: string; room_code: string; secret: string; display_name: string; avatar: string }
      | undefined;
    if (!row || row.secret !== secret) return null;
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
