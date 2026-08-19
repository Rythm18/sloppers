import type { AdminOp, MemberRole } from '@sloppers/protocol';
import { can, canActOn } from '../domain/permissions.js';
import { knockIsLive } from './knocks.js';
import type { Room } from './live.js';
import type { MemberRecord, WorkspaceManager } from './manager.js';

export interface AdminContext {
  manager: WorkspaceManager;
  room: Room;
  /**
   * Who is asking. Only their id is trusted — the role on this record is
   * whatever it was when their socket opened, and the handler re-reads it.
   */
  actor: MemberRecord;
}

export type AdminResult =
  | { ok: true }
  | { ok: false; code: 'forbidden' | 'not-found' | 'invalid'; message: string };

const forbidden = (message: string): AdminResult => ({ ok: false, code: 'forbidden', message });
const notFound = (message: string): AdminResult => ({ ok: false, code: 'not-found', message });
const invalid = (message: string): AdminResult => ({ ok: false, code: 'invalid', message });

/**
 * Every administrative action, behind the permission check that decides it.
 *
 * Refusals come back as values rather than exceptions: a moderator reaching
 * past their rank, or aiming at someone who just left, is an ordinary
 * outcome the caller turns into a protocol error. Every mutation that lands
 * writes a `workspace_events` row, because a moderation system with no
 * record of who did what is how friend groups end up arguing.
 */
export function handleAdminOp(ctx: AdminContext, op: AdminOp): AdminResult {
  const { manager, room } = ctx;

  // Never trust the record the socket captured at join time: a role can be
  // taken away mid-session, and the connection would happily keep using the
  // powers it had when it opened.
  const actor = manager.memberById(ctx.actor.id);
  if (!actor || actor.workspaceId !== room.id) return forbidden('you are not in this office');

  /** Resolve a target in this workspace and check the actor outranks them. */
  const target = (memberId: string): MemberRecord | AdminResult => {
    const found = manager.memberById(memberId, { includeRemoved: true });
    if (!found || found.workspaceId !== room.id) return notFound('no such member here');
    if (!canActOn(actor.role, found.role)) return forbidden('they outrank you');
    return found;
  };

  switch (op.kind) {
    case 'kick':
    case 'ban': {
      const action = op.kind === 'kick' ? 'member.kick' : 'member.ban';
      if (!can(actor.role, action)) return forbidden('only moderators can remove people');
      const found = target(op.memberId);
      if ('ok' in found) return found;
      manager.setStatus(found.id, op.kind === 'kick' ? 'kicked' : 'banned');
      room.forgetMember(found.id, op.kind === 'kick' ? 'kicked' : 'banned');
      manager.logEvent(
        room.id,
        actor.id,
        action,
        found.id,
        op.kind === 'ban' ? op.reason : undefined,
      );
      room.broadcastRoster();
      return { ok: true };
    }

    case 'unban': {
      if (!can(actor.role, 'member.unban')) return forbidden('only moderators can unban');
      // Through `target`, so undoing a ban obeys the same rank rule as
      // placing one: a moderator does not overrule the owner or a peer.
      const found = target(op.memberId);
      if ('ok' in found) return found;
      // Without this, "unban" on someone who is not banned is a kick that
      // skips the rank check entirely.
      if (found.status !== 'banned') return invalid('they are not banned');
      // Not back to active: banning already freed the display name (the
      // unique index is partial on active rows), so someone else may hold it
      // by now. The tombstone lets them rejoin as a fresh member instead,
      // which is what "you may come back" means here.
      manager.setStatus(found.id, 'kicked');
      manager.logEvent(room.id, actor.id, 'member.unban', found.id);
      room.broadcastRoster();
      return { ok: true };
    }

    case 'promote':
    case 'demote': {
      const action = op.kind === 'promote' ? 'member.promote' : 'member.demote';
      if (!can(actor.role, action)) return forbidden('only the owner changes roles');
      const found = target(op.memberId);
      if ('ok' in found) return found;
      const role: MemberRole = op.kind === 'promote' ? 'moderator' : 'member';
      manager.setRole(found.id, role);
      manager.logEvent(room.id, actor.id, action, found.id, role);
      room.refreshMember(found.id);
      room.broadcastRoster();
      return { ok: true };
    }

    case 'transfer': {
      if (!can(actor.role, 'workspace.transfer')) return forbidden('only the owner can hand over');
      const found = manager.memberById(op.memberId);
      if (!found || found.workspaceId !== room.id) return notFound('no such member here');
      if (found.id === actor.id) return invalid('you already have the keys');
      // Losing the keys should not also lose the mop.
      manager.transferOwnership(actor.id, found.id);
      manager.logEvent(room.id, actor.id, 'workspace.transfer', found.id);
      room.refreshMember(actor.id);
      room.refreshMember(found.id);
      room.broadcastRoster();
      return { ok: true };
    }

    case 'delete': {
      const isSelf = op.memberId === actor.id;
      if (!isSelf && !can(actor.role, 'member.delete')) {
        return forbidden('only the owner deletes others');
      }
      if (isSelf && actor.role === 'owner') {
        return invalid('hand ownership over before deleting yourself');
      }
      if (!isSelf) {
        const found = target(op.memberId);
        if ('ok' in found) return found;
      }
      room.forgetMember(op.memberId, 'deleted');
      manager.deleteMember(op.memberId);
      manager.logEvent(room.id, actor.id, 'member.delete', op.memberId);
      room.broadcastRoster();
      return { ok: true };
    }

    case 'rename': {
      if (!can(actor.role, 'workspace.rename'))
        return forbidden('only the owner renames the office');
      manager.rename(room.id, op.name);
      manager.logEvent(room.id, actor.id, 'workspace.rename', undefined, op.name);
      room.broadcastWorkspace();
      return { ok: true };
    }

    case 'settings': {
      if (!can(actor.role, 'workspace.settings'))
        return forbidden('only the owner changes settings');
      manager.setSettings(room.id, op.settings);
      manager.logEvent(
        room.id,
        actor.id,
        'workspace.settings',
        undefined,
        JSON.stringify(op.settings),
      );
      room.broadcastWorkspace();
      return { ok: true };
    }

    case 'rotate-invite': {
      if (!can(actor.role, 'workspace.rotate-invite')) {
        return forbidden('only the owner rotates the invite');
      }
      manager.rotateInvite(room.id);
      manager.logEvent(room.id, actor.id, 'workspace.rotate-invite');
      room.broadcastWorkspace();
      return { ok: true };
    }

    case 'knock-admit':
    case 'knock-deny': {
      if (!can(actor.role, 'knock.decide')) return forbidden('only moderators answer the door');
      const knock = room.knocks.get(op.knockId);
      if (!knock) return notFound('that knock is gone');
      if (op.kind === 'knock-deny') {
        room.knocks.remove(knock.id);
        room.denyKnock(knock);
        room.broadcastKnocks();
        return { ok: true };
      }
      // They left while the queue sat there. Minting a member for a socket
      // nobody is holding would put a phantom on the floor forever.
      if (!knockIsLive(knock)) {
        room.knocks.remove(knock.id);
        room.broadcastKnocks();
        return invalid(`${knock.displayName} gave up waiting`);
      }
      // Their name is checked now, not when they knocked, because it may
      // have been taken while they waited. A refusal keeps them in the queue
      // so the decision can be made again once they pick another one.
      const admitted = room.admitKnock(knock);
      if (!admitted) return invalid(`${knock.displayName} could not be let in`);
      room.knocks.remove(knock.id);
      manager.logEvent(room.id, actor.id, 'knock.admit', admitted.id, knock.displayName);
      room.broadcastKnocks();
      return { ok: true };
    }

    case 'roster': {
      if (!can(actor.role, 'member.kick')) return forbidden('roster is for moderators');
      room.sendRoster(actor.id);
      return { ok: true };
    }

    case 'link-device': {
      // Any member may link their own devices — but the link is a credential
      // that signs a browser in as them, so the office keeps a record of it.
      if (room.sendDeviceLink(actor.id)) {
        manager.logEvent(room.id, actor.id, 'member.link-device', actor.id);
      }
      return { ok: true };
    }
  }
}
