import type { SessionSnapshot } from '@sloppers/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Db, openDb } from '../db/index.js';
import type { Room } from './live.js';
import { WorkspaceManager } from './manager.js';

/**
 * Lets one case drive the invite suffix that is otherwise random. The queue
 * is empty for every other case, which falls through to the real generator.
 */
const ids = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock('../ids.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ids.js')>();
  return { ...actual, roomSuffix: () => ids.suffixes.shift() ?? actual.roomSuffix() };
});

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
    ids.suffixes.length = 0;
    db = openDb(':memory:');
    manager = new WorkspaceManager(db);
  });

  /** A workspace, or a loud failure — every case below starts with one. */
  function office(name = 'the lab'): Room {
    const room = manager.createRoom(name);
    if (!room) throw new Error('room not created');
    return room;
  }

  /** A member, or a loud failure carrying the refusal reason. */
  function join(room: Room, name: string) {
    const member = manager.createMember(room.id, name);
    if (typeof member === 'string') throw new Error(`member refused: ${member}`);
    return member;
  }

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

  it('re-mints rather than handing back the code it was asked to replace', () => {
    // A suffix draw that reproduces the current code would UPDATE cleanly and
    // revoke nothing, while reporting a rotation. Force that draw.
    ids.suffixes.push('aaaaaa');
    const room = office();
    expect(room.code).toBe('the-lab-aaaaaa');

    ids.suffixes.push('aaaaaa', 'bbbbbb');
    const rotated = manager.rotateInvite(room.id);
    expect(rotated).toBe('the-lab-bbbbbb');
    expect(manager.getRoom('the-lab-aaaaaa')).toBeNull();
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

  it('gives an ownerless office to the senior member already in it, not the next arrival', () => {
    // The keys should not go to a stranger holding a link while a moderator
    // the owner themselves promoted is sitting inside.
    const room = office();
    const owner = join(room, 'ridham');
    const early = join(room, 'sam');
    const moderator = join(room, 'nina');
    manager.setRole(moderator.id, 'moderator');
    manager.deleteMember(owner.id);

    expect(manager.ensureOwner(room.id)).toBe(moderator.id);
    expect(manager.memberById(moderator.id)?.role).toBe('owner');
    expect(manager.memberById(early.id)?.role).toBe('member');
    // Idempotent: an office that has an owner is left exactly as it is.
    expect(manager.ensureOwner(room.id)).toBeNull();
  });

  it('falls back to the longest-standing member when no moderator is left', () => {
    const room = office();
    const owner = join(room, 'ridham');
    const early = join(room, 'sam');
    const late = join(room, 'nina');
    db.prepare('UPDATE members SET created_at = ? WHERE id = ?').run(1000, early.id);
    db.prepare('UPDATE members SET created_at = ? WHERE id = ?').run(2000, late.id);
    manager.deleteMember(owner.id);

    expect(manager.ensureOwner(room.id)).toBe(early.id);
  });

  it('leaves an office with nobody in it ownerless rather than inventing an owner', () => {
    const room = office();
    const owner = join(room, 'ridham');
    const banned = join(room, 'mallory');
    manager.setStatus(banned.id, 'banned');
    manager.deleteMember(owner.id);

    // A tombstone is a record, not a resident.
    expect(manager.ensureOwner(room.id)).toBeNull();
    expect(manager.memberById(banned.id, { includeRemoved: true })?.role).toBe('member');
  });

  it('records every change of hands, including the ones nobody clicked', () => {
    const room = office();
    const founder = join(room, 'ridham');
    const heir = join(room, 'sam');
    manager.deleteMember(founder.id);
    manager.ensureOwner(room.id);
    // Nobody is left, so the office is ownerless again and the next person
    // through the door takes it — the shape of the leaked-link case.
    manager.setStatus(heir.id, 'banned');
    const stranger = join(room, 'mallory');

    const adoptions = manager.events(room.id).filter((e) => e.action === 'workspace.adopt');
    expect(adoptions).toHaveLength(2);
    expect(adoptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: null, targetId: heir.id, detail: 'member' }),
        expect.objectContaining({ actorId: null, targetId: stranger.id, detail: 'new member' }),
      ]),
    );
  });

  it('does not call opening an office a change of hands', () => {
    // Nobody handed anything over — the roster has said who owns it since the
    // second it existed. An event here would put a line in every office's log
    // answering a question nobody asks.
    const room = office();
    join(room, 'ridham');
    expect(manager.events(room.id)).toEqual([]);
  });

  it('adopts an office the sweep just emptied of its owner', () => {
    const room = office();
    const gone = join(room, 'ridham');
    const staying = join(room, 'sam');
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE members SET created_at = ?, last_seen_at = ? WHERE id = ?').run(
      old,
      old,
      gone.id,
    );
    db.prepare('UPDATE workspaces SET created_at = ?').run(old);

    expect(manager.cleanupStaleMembers()).toBe(1);
    expect(manager.memberById(staying.id)?.role).toBe('owner');
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

  it('keeps a banned member through the sweep, but not a kicked one', () => {
    // The ban *is* the row: erase it and the ban expires on a timer nobody
    // chose. (It does not reserve the name — the unique index is partial on
    // active, so banning already frees that; see the memberByName case.)
    const room = office();
    const banned = join(room, 'mallory');
    const kicked = join(room, 'noisy');
    const staying = join(room, 'ridham');
    manager.setStatus(banned.id, 'banned');
    manager.setStatus(kicked.id, 'kicked');
    // Everyone is equally stale, and nobody paired a device.
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE members SET created_at = ?, last_seen_at = ?').run(old, old);
    db.prepare('UPDATE workspaces SET created_at = ?').run(old);

    expect(manager.cleanupStaleMembers()).toBe(2);
    expect(manager.memberById(banned.id, { includeRemoved: true })?.status).toBe('banned');
    expect(manager.memberById(kicked.id, { includeRemoved: true })).toBeNull();
    expect(manager.memberById(staying.id, { includeRemoved: true })).toBeNull();
    // ...and the workspace survives with it, or the ban has nothing to bind to.
    expect(manager.getRoom(room.code)?.id).toBe(room.id);
    // The roster — what moderation reads — still shows the ban.
    expect(manager.roster(room.id)).toEqual([
      expect.objectContaining({ id: banned.id, status: 'banned' }),
    ]);
  });

  it('orders the roster by rank, then by name within a rank', () => {
    const room = office();
    // Deliberately scrambled, so insertion order cannot produce the answer.
    const zed = join(room, 'Zed'); // owner, by being first
    join(room, 'carol');
    const bob = join(room, 'Bob');
    join(room, 'alice');
    const ada = join(room, 'Ada');
    manager.setRole(bob.id, 'moderator');
    manager.setRole(ada.id, 'moderator');

    expect(manager.roster(room.id).map((r) => r.displayName)).toEqual([
      'Zed', // owner
      'Ada', // moderators, case-insensitively alphabetical
      'Bob',
      'alice', // members, likewise
      'carol',
    ]);
    expect(manager.roster(room.id)[0]).toMatchObject({ id: zed.id, role: 'owner', sharing: false });
  });

  it('does not let a reopened office claim somebody is sharing because they once paired', () => {
    const room = office();
    const zed = join(room, 'zed');
    db.prepare('INSERT INTO devices (key, member_id, created_at) VALUES (?, ?, ?)').run(
      'dev-key',
      zed.id,
      Date.now(),
    );

    // A restart: the durable state survives, every socket in the world does
    // not. The member view used to read `sharing` off this devices row and
    // never lower it again, so an office greeted a fortnight-old pairing with
    // "Sharing on" while the laptop behind it had been shut the whole time.
    // It says "a collector is attached right now" now, and right now none is.
    const restarted = new WorkspaceManager(db);
    const reopened = restarted.roomById(room.id);
    if (!reopened) throw new Error('the office should still be there');

    expect(reopened.memberView(zed.id, Date.now()).sharing).toBe(false);
  });

  it('reads the audit trail newest first, no further than the limit', () => {
    const room = office();
    vi.useFakeTimers();
    try {
      for (const [i, action] of ['member.join', 'member.kick', 'workspace.rename'].entries()) {
        vi.setSystemTime(1_700_000_000_000 + i);
        manager.logEvent(room.id, 'm_actor', action);
      }
    } finally {
      vi.useRealTimers();
    }

    expect(manager.events(room.id).map((e) => e.action)).toEqual([
      'workspace.rename',
      'member.kick',
      'member.join',
    ]);
    expect(manager.events(room.id).map((e) => e.at)).toEqual([
      1_700_000_000_002, 1_700_000_000_001, 1_700_000_000_000,
    ]);
    // The limit takes the newest end, not an arbitrary slice.
    expect(manager.events(room.id, 2).map((e) => e.action)).toEqual([
      'workspace.rename',
      'member.kick',
    ]);
  });

  it('stops resolving a banned member by name, freeing it for the next arrival', () => {
    const room = office();
    const banned = join(room, 'ridham');
    expect(manager.memberByName(room.id, 'RIDHAM')?.id).toBe(banned.id);

    manager.setStatus(banned.id, 'banned');
    expect(manager.memberByName(room.id, 'ridham')).toBeNull();

    // The partial index releases the name; the lookup must follow the live
    // member, never the tombstone.
    const successor = join(room, 'ridham');
    expect(successor.id).not.toBe(banned.id);
    expect(manager.memberByName(room.id, 'ridham')?.id).toBe(successor.id);
  });

  it('puts each member’s real role on the member view the browser receives', () => {
    const room = office();
    const owner = join(room, 'ridham');
    const regular = join(room, 'sam');
    room.memberJoined(owner);
    room.memberJoined(regular);

    const now = Date.now();
    expect(room.memberView(owner.id, now).role).toBe('owner');
    expect(room.memberView(regular.id, now).role).toBe('member');
    // A room rebuilt from the database reports the same, so the role is not
    // an artefact of the join path.
    const reloaded = new WorkspaceManager(db).getRoom(room.code);
    expect(reloaded?.memberView(owner.id, now).role).toBe('owner');
    expect(reloaded?.memberView(regular.id, now).role).toBe('member');
  });

  it('will not admit a knock whose socket has already gone', () => {
    // The handler checks this too, but `admitKnock` is what actually mints a
    // member: on its own it must never do so for a socket nobody is holding,
    // because the close handler that would clean up has already fired.
    const room = office();
    const closed = { readyState: 3, OPEN: 1, send: () => {}, close: () => {}, once: () => {} };
    let admitted = false;
    const view = room.knocks.add(closed as never, 'theo', 'pixel', () => {
      admitted = true;
    });
    const pending = room.knocks.get(view.id);
    if (!pending) throw new Error('knock not registered');

    expect(room.admitKnock(pending)).toBeNull();
    expect(manager.memberByName(room.id, 'theo')).toBeNull();
    expect(admitted).toBe(false);
  });

  it('rename and settings write through to the live room', () => {
    const room = manager.createRoom('the lab');
    if (!room) throw new Error('room not created');
    expect(room.settings).toEqual({
      joinMode: 'link',
      publicLeaderboard: false,
      timezone: 'UTC',
    });
    manager.rename(room.id, 'the annex');
    manager.setSettings(room.id, {
      joinMode: 'knock',
      publicLeaderboard: true,
      timezone: 'UTC',
    });
    expect(room.name).toBe('the annex');
    expect(room.settings.joinMode).toBe('knock');
    // ...and survive a reload from the database.
    const reloaded = new WorkspaceManager(db).getRoom(room.code);
    expect(reloaded?.name).toBe('the annex');
    expect(reloaded?.settings.joinMode).toBe('knock');
  });

  /**
   * The office's clock, set once at creation from the browser that opened it.
   *
   * Taken as a hint and not as a promise: the value is `Intl` output from
   * whatever runtime the visitor happened to be on, nobody typed it, and
   * turning somebody away from their first office over it would be a poor
   * trade for a field they have never heard of. The settings op is where an
   * owner chooses deliberately, and that one refuses instead.
   */
  describe('the office’s timezone', () => {
    it('opens on the creator’s zone', () => {
      const room = manager.createRoom('the lab', 'Asia/Kolkata');
      expect(room?.settings.timezone).toBe('Asia/Kolkata');
      // ...and it survives a reload, because it is in the stored blob.
      expect(new WorkspaceManager(db).roomById(room?.id ?? '')?.settings.timezone).toBe(
        'Asia/Kolkata',
      );
    });

    it('falls back to UTC rather than refusing a zone it cannot use', () => {
      expect(manager.createRoom('nowhere', 'Mars/Olympus')?.settings.timezone).toBe('UTC');
      expect(manager.createRoom('nothing', '')?.settings.timezone).toBe('UTC');
      expect(manager.createRoom('silence')?.settings.timezone).toBe('UTC');
    });

    it('takes an alias the zone list leaves out but Intl accepts', () => {
      expect(manager.createRoom('the lab', 'Asia/Calcutta')?.settings.timezone).toBe(
        'Asia/Calcutta',
      );
    });

    it('re-reads the board when the owner moves the day boundary', () => {
      const room = office();
      const refreshed = vi.spyOn(room, 'refreshDayWindow');

      // A settings change that leaves the clock alone changes no numbers.
      manager.setSettings(room.id, { ...room.settings, joinMode: 'knock' });
      expect(refreshed).not.toHaveBeenCalled();

      // Moving it means every total on screen is now about a different 24
      // hours, and the room has to say so rather than wait for a collector.
      manager.setSettings(room.id, { ...room.settings, timezone: 'Asia/Kolkata' });
      expect(refreshed).toHaveBeenCalledTimes(1);
      expect(room.settings.timezone).toBe('Asia/Kolkata');
    });
  });
});
