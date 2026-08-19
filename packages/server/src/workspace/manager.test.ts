import type { SessionSnapshot } from '@sloppers/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/index.js';
import { WorkspaceManager } from './manager.js';

/** Enough of a snapshot to make the ledger write a row for the member. */
function workingSession(now: number): SessionSnapshot {
  return {
    id: 's1',
    harness: 'claude-code',
    state: 'working',
    tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
    startedAt: now,
    lastActivityAt: now,
  };
}

describe('WorkspaceManager', () => {
  let db: Db;
  let manager: WorkspaceManager;

  beforeEach(() => {
    db = openDb(':memory:');
    manager = new WorkspaceManager(db);
  });

  it('makes the first member of a new workspace its owner', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    const first = manager.createMember(room.id, 'ridham');
    const second = manager.createMember(room.id, 'sam');
    if (typeof first === 'string' || typeof second === 'string') throw new Error('member refused');
    expect(first.role).toBe('owner');
    expect(second.role).toBe('member');
  });

  it('rotates the invite code without losing members', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    const member = manager.createMember(room.id, 'ridham');
    if (typeof member === 'string') throw new Error('member refused');
    const original = room.code;
    const rotated = manager.rotateInvite(room.id);

    expect(rotated).not.toBe(original);
    expect(manager.getRoom(original)).toBeNull();
    expect(manager.getRoom(rotated)?.id).toBe(room.id);
    expect(manager.memberById(member.id)?.workspaceId).toBe(room.id);
  });

  it('refuses a banned member on lookup but keeps their usage rows addressable', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    const member = manager.createMember(room.id, 'ridham');
    if (typeof member === 'string') throw new Error('member refused');
    manager.setStatus(member.id, 'banned');
    expect(manager.authMember(member.id, member.secret)).toBeNull();
    expect(manager.roster(room.id).find((r) => r.id === member.id)?.status).toBe('banned');
  });

  it('records an audit row for every logged action', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    manager.logEvent(room.id, 'm_actor', 'member.kick', 'm_target', 'noisy');
    const events = manager.events(room.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('member.kick');
  });

  it('hands ownership over in one step, demoting the outgoing owner', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    const owner = manager.createMember(room.id, 'ridham');
    const heir = manager.createMember(room.id, 'sam');
    if (typeof owner === 'string' || typeof heir === 'string') throw new Error('member refused');
    manager.transferOwnership(owner.id, heir.id);
    expect(manager.memberById(heir.id)?.role).toBe('owner');
    expect(manager.memberById(owner.id)?.role).toBe('moderator');
  });

  it('adopts an ownerless workspace to the next member through the door', () => {
    // Migration 002 can leave a workspace with no members at all, and a
    // banned owner leaves one with no *active* owner.
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    const owner = manager.createMember(room.id, 'ridham');
    if (typeof owner === 'string') throw new Error('member refused');
    manager.setStatus(owner.id, 'banned');
    const next = manager.createMember(room.id, 'sam');
    if (typeof next === 'string') throw new Error('member refused');
    expect(next.role).toBe('owner');
  });

  it('only addresses a removed member when asked to', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    const member = manager.createMember(room.id, 'ridham');
    if (typeof member === 'string') throw new Error('member refused');
    manager.setStatus(member.id, 'kicked');
    expect(manager.memberById(member.id)).toBeNull();
    expect(manager.memberById(member.id, { includeRemoved: true })?.status).toBe('kicked');
  });

  it('erases a deleted member from every table that references them', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    const member = manager.createMember(room.id, 'ridham');
    if (typeof member === 'string') throw new Error('member refused');
    db.prepare('INSERT INTO devices (key, member_id, created_at) VALUES (?, ?, ?)').run(
      'k',
      member.id,
      1,
    );
    db.prepare('INSERT INTO pairings (code, member_id, expires_at) VALUES (?, ?, ?)').run(
      'c',
      member.id,
      1,
    );
    db.prepare('INSERT INTO relink_tokens (token, member_id, expires_at) VALUES (?, ?, ?)').run(
      't',
      member.id,
      1,
    );
    manager.ledger.ingest(member.id, [workingSession(Date.now())], Date.now());

    manager.deleteMember(member.id);
    for (const table of [
      'members',
      'devices',
      'pairings',
      'relink_tokens',
      'daily_usage',
      'daily_activity',
      'usage_watermarks',
    ]) {
      expect([table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()]).toEqual([
        table,
        { n: 0 },
      ]);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('sweeps a stale member out, then the workspace they left empty', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    const member = manager.createMember(room.id, 'ridham');
    if (typeof member === 'string') throw new Error('member refused');
    manager.logEvent(room.id, member.id, 'member.join');
    // Age everything past the seven-day cutoff.
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE members SET created_at = ?, last_seen_at = ?').run(old, old);
    db.prepare('UPDATE workspaces SET created_at = ?').run(old);

    expect(manager.cleanupStaleMembers()).toBe(1);
    expect(manager.getRoom(room.code)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()).toEqual({ n: 0 });
    // The audit trail goes with the workspace it belonged to, or the delete
    // would trip the foreign key.
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_events').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rename and settings write through to the live room', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    expect(room.settings).toEqual({ joinMode: 'link', publicLeaderboard: false });
    manager.rename(room.id, 'the annex');
    manager.setSettings(room.id, { joinMode: 'knock', publicLeaderboard: true });
    expect(room.name).toBe('the annex');
    expect(room.settings.joinMode).toBe('knock');
    // ...and survive a reload from the database.
    const reloaded = new WorkspaceManager(db).getRoom(room.code);
    expect(reloaded?.name).toBe('the annex');
    expect(reloaded?.settings.joinMode).toBe('knock');
  });
});
