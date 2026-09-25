import { describe, expect, it } from 'vitest';
import { can, canActOn } from './permissions.js';

describe('can', () => {
  it('lets owners do everything', () => {
    for (const action of [
      'workspace.rename',
      'workspace.settings',
      'workspace.rotate-invite',
      'workspace.transfer',
      'member.kick',
      'member.ban',
      'member.unban',
      'member.promote',
      'member.demote',
      'member.delete',
      'knock.decide',
      'chat.delete',
    ] as const) {
      expect(can('owner', action)).toBe(true);
    }
  });

  it('lets moderators moderate but not configure', () => {
    expect(can('moderator', 'member.kick')).toBe(true);
    expect(can('moderator', 'member.ban')).toBe(true);
    expect(can('moderator', 'knock.decide')).toBe(true);
    // Anybody who can show a person the door can take down a line they said —
    // the realistic case is a secret pasted into the wrong window, and making
    // that wait for the owner to wake up is a gesture rather than a tool.
    expect(can('moderator', 'chat.delete')).toBe(true);
    expect(can('moderator', 'workspace.settings')).toBe(false);
    expect(can('moderator', 'workspace.rotate-invite')).toBe(false);
    expect(can('moderator', 'member.promote')).toBe(false);
    expect(can('moderator', 'workspace.transfer')).toBe(false);
  });

  it('lets plain members do none of it', () => {
    expect(can('member', 'member.kick')).toBe(false);
    expect(can('member', 'knock.decide')).toBe(false);
    expect(can('member', 'workspace.rename')).toBe(false);
    // Taking back their *own* message asks nothing of this — `handleAdminOp`
    // checks authorship first, the way `member.delete` checks for self.
    expect(can('member', 'chat.delete')).toBe(false);
  });
});

describe('canActOn', () => {
  it('stops moderators acting on each other or on the owner', () => {
    expect(canActOn('moderator', 'moderator')).toBe(false);
    expect(canActOn('moderator', 'owner')).toBe(false);
    expect(canActOn('moderator', 'member')).toBe(true);
  });

  it('lets the owner act on anyone except another owner', () => {
    expect(canActOn('owner', 'moderator')).toBe(true);
    expect(canActOn('owner', 'member')).toBe(true);
    expect(canActOn('owner', 'owner')).toBe(false);
  });

  it('never lets a plain member act on anyone', () => {
    expect(canActOn('member', 'member')).toBe(false);
  });
});
