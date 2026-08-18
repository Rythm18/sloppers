import { z } from 'zod';
import {
  avatarIdSchema,
  dailyStatsSchema,
  displayNameSchema,
  memberViewSchema,
  positionSchema,
  presenceStateSchema,
  roomCodeSchema,
  roomNameSchema,
  sessionSnapshotSchema,
} from './core.js';
import {
  adminOpSchema,
  knockViewSchema,
  rosterEntrySchema,
  workspaceSettingsSchema,
} from './workspace.js';

/**
 * Messages between a browser client and the server, over `WS /ws/web`.
 *
 * A browser either creates a member (join with a name) or resumes one (join
 * with credentials from localStorage). Movement flows up at the client's
 * tick rate; everything else flows down on change.
 */

/**
 * Three ways in, checked in this order server-side:
 * - resume:  memberId + memberSecret (the member's room is authoritative)
 * - create:  createRoom (vanity name) + displayName — mints a new office
 *            with a server-generated capability code
 * - invited: roomCode (from an invite link) + displayName
 */
export const webJoinSchema = z.object({
  type: z.literal('join'),
  roomCode: roomCodeSchema.optional(),
  createRoom: roomNameSchema.optional(),
  memberId: z.string().optional(),
  memberSecret: z.string().optional(),
  displayName: displayNameSchema.optional(),
  avatar: avatarIdSchema.optional(),
});
export type WebJoin = z.infer<typeof webJoinSchema>;

export const webMoveSchema = z.object({
  type: z.literal('move'),
  position: positionSchema,
});
export type WebMove = z.infer<typeof webMoveSchema>;

/** Tab focus / recent-interaction heartbeat; feeds presence derivation. */
export const webActivitySchema = z.object({
  type: z.literal('activity'),
  present: z.boolean(),
});
export type WebActivity = z.infer<typeof webActivitySchema>;

/** An admin action against the workspace, dispatched by role-gated UI. */
export const webAdminSchema = z.object({
  type: z.literal('admin'),
  op: adminOpSchema,
});
export type WebAdmin = z.infer<typeof webAdminSchema>;

export const webToServerSchema = z.discriminatedUnion('type', [
  webJoinSchema,
  webMoveSchema,
  webActivitySchema,
  webAdminSchema,
]);
export type WebToServer = z.infer<typeof webToServerSchema>;

export const leaderboardRowSchema = z.object({
  memberId: z.string(),
  displayName: z.string(),
  avatar: z.string(),
  stats: dailyStatsSchema,
});
export type LeaderboardRow = z.infer<typeof leaderboardRowSchema>;

/** Full room state, sent once on successful join. */
export const webWorldSchema = z.object({
  type: z.literal('world'),
  you: z.object({
    memberId: z.string(),
    memberSecret: z.string().optional(),
  }),
  roomCode: roomCodeSchema,
  /** Display name of the office, e.g. "the lab". */
  roomName: z.string(),
  members: z.array(memberViewSchema),
  leaderboard: z.array(leaderboardRowSchema),
});
export type WebWorld = z.infer<typeof webWorldSchema>;

export const webMemberUpsertSchema = z.object({
  type: z.literal('member'),
  member: memberViewSchema,
});
export const webMemberLeftSchema = z.object({
  type: z.literal('member-left'),
  memberId: z.string(),
});

export const webPositionSchema = z.object({
  type: z.literal('pos'),
  memberId: z.string(),
  position: positionSchema,
});

/** A member's live agent status changed. */
export const webPresenceSchema = z.object({
  type: z.literal('presence'),
  memberId: z.string(),
  presence: presenceStateSchema,
  sessions: z.array(sessionSnapshotSchema),
  today: dailyStatsSchema,
});

export const webLeaderboardSchema = z.object({
  type: z.literal('leaderboard'),
  rows: z.array(leaderboardRowSchema),
});

export const webErrorSchema = z.object({
  type: z.literal('error'),
  code: z.enum([
    'bad-join',
    'room-not-found',
    'name-taken',
    'bad-message',
    'server-error',
    'forbidden',
    'workspace-locked',
    'knock-pending',
  ]),
  message: z.string(),
});
export type WebError = z.infer<typeof webErrorSchema>;

/** Sent to a knocking browser: it's waiting on an owner/moderator decision. */
export const webKnockingSchema = z.object({ type: z.literal('knocking') });
export type WebKnocking = z.infer<typeof webKnockingSchema>;

/** The pending-knock queue, sent to admins. */
export const webKnocksSchema = z.object({
  type: z.literal('knocks'),
  knocks: z.array(knockViewSchema),
});
export type WebKnocks = z.infer<typeof webKnocksSchema>;

export const webWorkspaceSchema = z.object({
  type: z.literal('workspace'),
  roomCode: roomCodeSchema, // wire name frozen; this is the invite code
  roomName: z.string(),
  settings: workspaceSettingsSchema,
});
export type WebWorkspace = z.infer<typeof webWorkspaceSchema>;

export const webRosterSchema = z.object({
  type: z.literal('roster'),
  members: z.array(rosterEntrySchema),
});
export type WebRoster = z.infer<typeof webRosterSchema>;

export const webRemovedSchema = z.object({
  type: z.literal('removed'),
  reason: z.enum(['kicked', 'banned', 'deleted']),
});
export type WebRemoved = z.infer<typeof webRemovedSchema>;

export const webDeviceLinkSchema = z.object({
  type: z.literal('device-link'),
  url: z.string(),
  expiresAt: z.number().int().positive(),
});
export type WebDeviceLink = z.infer<typeof webDeviceLinkSchema>;

export const serverToWebSchema = z.discriminatedUnion('type', [
  webWorldSchema,
  webMemberUpsertSchema,
  webMemberLeftSchema,
  webPositionSchema,
  webPresenceSchema,
  webLeaderboardSchema,
  webErrorSchema,
  webKnockingSchema,
  webKnocksSchema,
  webWorkspaceSchema,
  webRosterSchema,
  webRemovedSchema,
  webDeviceLinkSchema,
]);
export type ServerToWeb = z.infer<typeof serverToWebSchema>;
