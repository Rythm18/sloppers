import { describe, expect, it } from 'vitest';
import {
  adminOpSchema,
  defaultWorkspaceSettings,
  parseSettings,
  workspaceSettingsSchema,
} from './index.js';

describe('workspace settings', () => {
  it('fills defaults for a row written before a toggle existed', () => {
    expect(parseSettings('{}')).toEqual({ joinMode: 'link', publicLeaderboard: false });
  });

  it('keeps stored values and rejects unknown join modes', () => {
    expect(parseSettings('{"joinMode":"knock","publicLeaderboard":true}')).toEqual({
      joinMode: 'knock',
      publicLeaderboard: true,
    });
    expect(workspaceSettingsSchema.safeParse({ joinMode: 'invite-only' }).success).toBe(false);
  });

  it('falls back to defaults on unparseable JSON rather than throwing', () => {
    expect(parseSettings('not json')).toEqual(defaultWorkspaceSettings);
  });
});

describe('admin ops', () => {
  it('parses each op kind', () => {
    expect(adminOpSchema.parse({ kind: 'kick', memberId: 'm1' }).kind).toBe('kick');
    expect(adminOpSchema.parse({ kind: 'rename', name: 'the lab' }).kind).toBe('rename');
    expect(adminOpSchema.parse({ kind: 'rotate-invite' }).kind).toBe('rotate-invite');
    expect(
      adminOpSchema.parse({
        kind: 'settings',
        settings: { joinMode: 'locked', publicLeaderboard: false },
      }).kind,
    ).toBe('settings');
  });

  it('rejects unknown ops and malformed payloads', () => {
    expect(adminOpSchema.safeParse({ kind: 'nuke' }).success).toBe(false);
    expect(adminOpSchema.safeParse({ kind: 'kick' }).success).toBe(false);
    expect(adminOpSchema.safeParse({ kind: 'rename', name: '   ' }).success).toBe(false);
  });
});
