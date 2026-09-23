import { describe, expect, it } from 'vitest';
import {
  adminOpSchema,
  DEFAULT_TIMEZONE,
  defaultWorkspaceSettings,
  parseSettings,
  timeZoneSchema,
  workspaceSettingsSchema,
} from './index.js';

describe('workspace settings', () => {
  it('fills defaults for a row written before a toggle existed', () => {
    expect(parseSettings('{}')).toEqual({
      joinMode: 'link',
      publicLeaderboard: false,
      timezone: 'UTC',
    });
  });

  it('keeps stored values and rejects unknown join modes', () => {
    expect(parseSettings('{"joinMode":"knock","publicLeaderboard":true,"timezone":"UTC"}')).toEqual(
      { joinMode: 'knock', publicLeaderboard: true, timezone: 'UTC' },
    );
    expect(workspaceSettingsSchema.safeParse({ joinMode: 'invite-only' }).success).toBe(false);
  });

  it('falls back to defaults on unparseable JSON rather than throwing', () => {
    expect(parseSettings('not json')).toEqual(defaultWorkspaceSettings);
  });
});

/**
 * The default is a promise, not a convenience: every office that existed
 * before this field did goes on cutting its day exactly where it always has —
 * the production server's own clock, which is UTC. A row with no `timezone`
 * key is the normal case for all of them, and it must never shift.
 */
describe('office timezone', () => {
  it('reads as UTC for an office written before the field existed', () => {
    expect(DEFAULT_TIMEZONE).toBe('UTC');
    expect(parseSettings('{"joinMode":"locked","publicLeaderboard":false}').timezone).toBe('UTC');
    expect(defaultWorkspaceSettings.timezone).toBe('UTC');
  });

  it('keeps a zone an owner chose, whatever side of UTC it is on', () => {
    expect(parseSettings('{"timezone":"Asia/Kolkata"}').timezone).toBe('Asia/Kolkata');
    expect(parseSettings('{"timezone":"America/Los_Angeles"}').timezone).toBe(
      'America/Los_Angeles',
    );
  });

  it('refuses a zone the runtime does not know', () => {
    expect(timeZoneSchema.safeParse('Mars/Olympus').success).toBe(false);
    expect(timeZoneSchema.safeParse('').success).toBe(false);
    expect(timeZoneSchema.safeParse('  ').success).toBe(false);
    expect(timeZoneSchema.safeParse('UTC; DROP TABLE workspaces').success).toBe(false);
    expect(timeZoneSchema.safeParse('x'.repeat(200)).success).toBe(false);
  });

  it('accepts the aliases a real browser may report', () => {
    // `Intl.supportedValuesOf` lists neither, and `Intl.DateTimeFormat` takes
    // both — which is the whole reason validation is by construction.
    expect(timeZoneSchema.safeParse('Asia/Calcutta').success).toBe(true);
    expect(timeZoneSchema.safeParse('US/Pacific').success).toBe(true);
  });

  it('refuses a garbage zone on the settings op, rather than storing it', () => {
    expect(
      adminOpSchema.safeParse({
        kind: 'settings',
        settings: { joinMode: 'link', publicLeaderboard: false, timezone: 'Nowhere/Nothing' },
      }).success,
    ).toBe(false);
    expect(
      adminOpSchema.safeParse({
        kind: 'settings',
        settings: { joinMode: 'link', publicLeaderboard: false, timezone: 'Asia/Kolkata' },
      }).success,
    ).toBe(true);
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
