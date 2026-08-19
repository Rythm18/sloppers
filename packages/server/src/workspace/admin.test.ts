import type { AdminOp } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { handleAdminOp } from './admin.js';
import { WorkspaceManager } from './manager.js';

/**
 * Enough of a browser socket for the knock paths. `readyState` is what
 * separates someone still waiting from someone who closed the tab.
 */
const fakeSocket = (readyState = 1) =>
  ({ readyState, OPEN: 1, send: () => {}, close: () => {}, once: () => {} }) as never;

function setup() {
  const db = openDb(':memory:');
  const manager = new WorkspaceManager(db);
  const room = manager.createRoom('the lab');
  if (!room) throw new Error('room not created');
  const owner = manager.createMember(room.id, 'ridham');
  const mod = manager.createMember(room.id, 'sam');
  const plain = manager.createMember(room.id, 'nina');
  if (typeof owner === 'string' || typeof mod === 'string' || typeof plain === 'string') {
    throw new Error('member refused');
  }
  // Deliberately not refreshed: `mod` is the record the socket captured at
  // join time, still claiming 'member'. The handler must read the live role.
  manager.setRole(mod.id, 'moderator');
  return { db, manager, room, owner, mod, plain };
}

describe('handleAdminOp', () => {
  it('lets an owner promote and a moderator kick', () => {
    const { manager, room, owner, mod, plain } = setup();
    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'promote', memberId: plain.id }).ok,
    ).toBe(true);
    expect(manager.memberById(plain.id)?.role).toBe('moderator');

    const target = manager.createMember(room.id, 'theo');
    if (typeof target === 'string') throw new Error('member refused');
    expect(
      handleAdminOp({ manager, room, actor: mod }, { kind: 'kick', memberId: target.id }).ok,
    ).toBe(true);
    expect(manager.memberById(target.id)).toBeNull();
  });

  it('refuses a moderator configuring the workspace or touching a peer', () => {
    const { manager, room, mod, owner } = setup();
    const other = manager.createMember(room.id, 'zoe');
    if (typeof other === 'string') throw new Error('member refused');
    manager.setRole(other.id, 'moderator');

    const rename = handleAdminOp({ manager, room, actor: mod }, { kind: 'rename', name: 'nope' });
    expect(rename).toEqual({ ok: false, code: 'forbidden', message: expect.any(String) });
    expect(
      handleAdminOp({ manager, room, actor: mod }, { kind: 'kick', memberId: other.id }).ok,
    ).toBe(false);
    expect(
      handleAdminOp({ manager, room, actor: mod }, { kind: 'kick', memberId: owner.id }).ok,
    ).toBe(false);
  });

  it('transfers ownership and demotes the outgoing owner to moderator', () => {
    const { manager, room, owner, plain } = setup();
    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'transfer', memberId: plain.id }).ok,
    ).toBe(true);
    expect(manager.memberById(plain.id)?.role).toBe('owner');
    expect(manager.memberById(owner.id)?.role).toBe('moderator');
  });

  it('writes an audit row for every successful mutation', () => {
    const { manager, room, owner, plain } = setup();
    handleAdminOp(
      { manager, room, actor: owner },
      { kind: 'ban', memberId: plain.id, reason: 'spam' },
    );
    const events = manager.events(room.id);
    expect(events[0]?.action).toBe('member.ban');
    expect(events[0]?.targetId).toBe(plain.id);
  });

  it('reads the actor’s live role, so losing it lands mid-session', () => {
    const { manager, room, owner, plain } = setup();
    manager.transferOwnership(owner.id, plain.id);
    // The record their socket still holds says otherwise; the row wins.
    expect(owner.role).toBe('owner');
    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'rename', name: 'nope' }).ok,
    ).toBe(false);

    manager.setStatus(owner.id, 'kicked');
    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'kick', memberId: plain.id }).ok,
    ).toBe(false);
  });

  it('refuses to leave the office ownerless, but lets anyone else delete themselves', () => {
    const { manager, room, owner, plain } = setup();
    const suicide = handleAdminOp(
      { manager, room, actor: owner },
      { kind: 'delete', memberId: owner.id },
    );
    expect(suicide).toEqual({ ok: false, code: 'invalid', message: expect.any(String) });
    expect(manager.memberById(owner.id)?.role).toBe('owner');

    // No member.delete permission needed to erase yourself.
    expect(
      handleAdminOp({ manager, room, actor: plain }, { kind: 'delete', memberId: plain.id }).ok,
    ).toBe(true);
    expect(manager.memberById(plain.id, { includeRemoved: true })).toBeNull();
  });

  it('unbans into a tombstone rather than reactivating a freed name', () => {
    const { manager, room, owner, plain } = setup();
    handleAdminOp({ manager, room, actor: owner }, { kind: 'ban', memberId: plain.id });
    // The name is free the moment the ban lands, so someone else may hold it.
    const successor = manager.createMember(room.id, 'nina');
    if (typeof successor === 'string') throw new Error('member refused');

    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'unban', memberId: plain.id }).ok,
    ).toBe(true);
    expect(manager.memberById(plain.id, { includeRemoved: true })?.status).toBe('kicked');
    expect(manager.memberByName(room.id, 'nina')?.id).toBe(successor.id);
  });

  it('will not let unban be used as a kick that skips the status check', () => {
    // Unban is the one removal op that takes a target it did not just find
    // removed, so an active member reached this way would be quietly kicked.
    const { manager, room, owner, plain } = setup();
    const stealth = handleAdminOp(
      { manager, room, actor: owner },
      { kind: 'unban', memberId: plain.id },
    );
    expect(stealth).toEqual({ ok: false, code: 'invalid', message: expect.any(String) });
    expect(manager.memberById(plain.id)?.status).toBe('active');
  });

  it('will not let a moderator unban over the owner’s head', () => {
    const { manager, room, owner, mod } = setup();
    const peer = manager.createMember(room.id, 'zoe');
    if (typeof peer === 'string') throw new Error('member refused');
    manager.setRole(peer.id, 'moderator');
    handleAdminOp({ manager, room, actor: owner }, { kind: 'ban', memberId: peer.id });

    // Undoing a ban obeys the same rank rule as placing one.
    const undo = handleAdminOp({ manager, room, actor: mod }, { kind: 'unban', memberId: peer.id });
    expect(undo).toEqual({ ok: false, code: 'forbidden', message: expect.any(String) });
    expect(manager.memberById(peer.id, { includeRemoved: true })?.status).toBe('banned');

    // The owner, who does outrank them, can.
    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'unban', memberId: peer.id }).ok,
    ).toBe(true);
  });

  it('refuses an op aimed at someone in another workspace', () => {
    const { manager, room, owner } = setup();
    const elsewhere = manager.createRoom('the annex');
    if (!elsewhere) throw new Error('room not created');
    const stranger = manager.createMember(elsewhere.id, 'mallory');
    if (typeof stranger === 'string') throw new Error('member refused');

    const result = handleAdminOp(
      { manager, room, actor: owner },
      { kind: 'kick', memberId: stranger.id },
    );
    expect(result).toEqual({ ok: false, code: 'not-found', message: expect.any(String) });
    expect(manager.memberById(stranger.id)?.status).toBe('active');
  });

  it('renames, re-settles, and rotates the invite for an owner, logging each', () => {
    const { manager, room, owner } = setup();
    const original = room.code;
    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'rename', name: 'annex' }).ok,
    ).toBe(true);
    expect(
      handleAdminOp(
        { manager, room, actor: owner },
        { kind: 'settings', settings: { joinMode: 'knock', publicLeaderboard: true } },
      ).ok,
    ).toBe(true);
    expect(handleAdminOp({ manager, room, actor: owner }, { kind: 'rotate-invite' }).ok).toBe(true);

    expect(room.name).toBe('annex');
    expect(room.settings.joinMode).toBe('knock');
    expect(room.code).not.toBe(original);
    expect(manager.events(room.id).map((e) => e.action)).toEqual([
      'workspace.rotate-invite',
      'workspace.settings',
      'workspace.rename',
    ]);
  });

  it('admits one knock into a real member and turns another away', () => {
    const { manager, room, owner } = setup();
    const waiting = room.knocks.add(fakeSocket(), 'theo', 'pixel');
    const rejected = room.knocks.add(fakeSocket(), 'mallory', 'pixel');

    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'knock-admit', knockId: waiting.id })
        .ok,
    ).toBe(true);
    const admitted = manager.memberByName(room.id, 'theo');
    expect(admitted?.role).toBe('member');
    expect(room.knocks.get(waiting.id)).toBeUndefined();

    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'knock-deny', knockId: rejected.id })
        .ok,
    ).toBe(true);
    expect(manager.memberByName(room.id, 'mallory')).toBeNull();
    expect(room.knocks.list()).toEqual([]);

    // Admissions are audited; a denial writes nobody into the office.
    expect(manager.events(room.id).map((e) => [e.action, e.targetId])).toEqual([
      ['knock.admit', admitted?.id],
    ]);
    expect(
      handleAdminOp({ manager, room, actor: owner }, { kind: 'knock-admit', knockId: 'k_gone' }),
    ).toEqual({ ok: false, code: 'not-found', message: expect.any(String) });
  });

  it('refuses a knock nobody is behind any more, and drops it', () => {
    const { manager, room, owner } = setup();
    const gone = room.knocks.add(fakeSocket(3 /* CLOSED */), 'theo', 'pixel');

    const result = handleAdminOp(
      { manager, room, actor: owner },
      { kind: 'knock-admit', knockId: gone.id },
    );
    expect(result).toEqual({ ok: false, code: 'invalid', message: expect.any(String) });
    // No phantom member for a socket nobody is holding, and no stale queue.
    expect(manager.memberByName(room.id, 'theo')).toBeNull();
    expect(room.knocks.list()).toEqual([]);
  });

  it('keeps a knocker queued when their name was taken while they waited', () => {
    const { manager, room, owner, plain } = setup();
    const waiting = room.knocks.add(fakeSocket(), plain.displayName, 'pixel');

    const result = handleAdminOp(
      { manager, room, actor: owner },
      { kind: 'knock-admit', knockId: waiting.id },
    );
    expect(result.ok).toBe(false);
    expect(room.knocks.get(waiting.id)?.displayName).toBe(plain.displayName);
    expect(manager.events(room.id)).toEqual([]);
  });

  it('hands the roster to a moderator, and a device link to any member', () => {
    const { db, manager, room, mod, plain } = setup();
    expect(handleAdminOp({ manager, room, actor: mod }, { kind: 'roster' }).ok).toBe(true);

    // Nobody is listening for this one, so nothing is minted — and an audit
    // row for a credential that was never handed out would be a lie.
    expect(handleAdminOp({ manager, room, actor: mod }, { kind: 'link-device' }).ok).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relink_tokens').get()).toEqual({ n: 0 });
    expect(manager.events(room.id)).toEqual([]);

    room.memberJoined(plain);
    expect(handleAdminOp({ manager, room, actor: plain }, { kind: 'link-device' }).ok).toBe(true);
    expect(db.prepare('SELECT member_id FROM relink_tokens').all()).toEqual([
      { member_id: plain.id },
    ]);
    expect(manager.events(room.id).map((e) => [e.action, e.actorId])).toEqual([
      ['member.link-device', plain.id],
    ]);
  });
});

/**
 * The gates themselves, checked by outcome wherever an outcome can tell them
 * apart. Where rank would refuse the same op anyway (a plain member can never
 * satisfy `canActOn`), the refusal message is the only thing that says which
 * check fired, so these cases pin it exactly.
 */
describe('handleAdminOp permission gates', () => {
  it('keeps owner-only ops away from a moderator', () => {
    const { manager, room, mod, plain } = setup();
    const original = room.code;
    // Every one of these is aimed where rank alone would let it through:
    // a moderator does outrank `plain`. Only the role gate stands in the way.
    const ops: AdminOp[] = [
      { kind: 'promote', memberId: plain.id },
      { kind: 'demote', memberId: plain.id },
      { kind: 'transfer', memberId: plain.id },
      { kind: 'delete', memberId: plain.id },
      { kind: 'rename', name: 'not yours' },
      { kind: 'settings', settings: { joinMode: 'locked', publicLeaderboard: true } },
      { kind: 'rotate-invite' },
    ];
    for (const op of ops) {
      expect([op.kind, handleAdminOp({ manager, room, actor: mod }, op)]).toEqual([
        op.kind,
        { ok: false, code: 'forbidden', message: expect.any(String) },
      ]);
    }

    expect(manager.memberById(plain.id)).toMatchObject({ role: 'member', status: 'active' });
    expect(manager.memberById(mod.id)?.role).toBe('moderator');
    expect([room.name, room.settings.joinMode, room.code]).toEqual(['the lab', 'link', original]);
    // Nothing landed, so nothing was written down.
    expect(manager.events(room.id)).toEqual([]);
  });

  it('keeps moderator ops away from a plain member', () => {
    const { manager, room, mod, plain } = setup();
    const cases: [AdminOp, string][] = [
      [{ kind: 'kick', memberId: mod.id }, 'only moderators can remove people'],
      [{ kind: 'ban', memberId: mod.id }, 'only moderators can remove people'],
      [{ kind: 'unban', memberId: mod.id }, 'only moderators can unban'],
      [{ kind: 'roster' }, 'roster is for moderators'],
      [{ kind: 'knock-admit', knockId: 'k_any' }, 'only moderators answer the door'],
      [{ kind: 'knock-deny', knockId: 'k_any' }, 'only moderators answer the door'],
    ];
    for (const [op, message] of cases) {
      expect([op.kind, handleAdminOp({ manager, room, actor: plain }, op)]).toEqual([
        op.kind,
        { ok: false, code: 'forbidden', message },
      ]);
    }
    expect(manager.memberById(mod.id)).toMatchObject({ role: 'moderator', status: 'active' });
    expect(manager.events(room.id)).toEqual([]);
  });

  it('will not let a moderator promote themselves', () => {
    const { manager, room, mod } = setup();
    // The takeover this handler exists to prevent. Blocked twice — the role
    // gate first, rank second — so the message names the one that fired.
    expect(
      handleAdminOp({ manager, room, actor: mod }, { kind: 'promote', memberId: mod.id }),
    ).toEqual({ ok: false, code: 'forbidden', message: 'only the owner changes roles' });
    expect(manager.memberById(mod.id)?.role).toBe('moderator');
  });
});
