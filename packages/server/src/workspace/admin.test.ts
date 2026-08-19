import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { handleAdminOp } from './admin.js';
import { WorkspaceManager } from './manager.js';

function setup() {
  const manager = new WorkspaceManager(openDb(':memory:'));
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
  return { manager, room, owner, mod, plain };
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

  it('will not let unban be used as a kick that skips the rank check', () => {
    const { manager, room, mod, owner } = setup();
    const stealth = handleAdminOp(
      { manager, room, actor: mod },
      { kind: 'unban', memberId: owner.id },
    );
    expect(stealth.ok).toBe(false);
    expect(manager.memberById(owner.id)?.status).toBe('active');
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
});
