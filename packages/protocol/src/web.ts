import { z } from 'zod';
import {
  avatarIdSchema,
  dailyStatsSchema,
  displayNameSchema,
  memberViewSchema,
  positionSchema,
  presenceStateSchema,
  roomCodeSchema,
  sessionSnapshotSchema,
} from './core.js';

/**
 * Messages between a browser client and the server, over `WS /ws/web`.
 *
 * A browser either creates a member (join with a name) or resumes one (join
 * with credentials from localStorage). Movement flows up at the client's
 * tick rate; everything else flows down on change.
 */

export const webJoinSchema = z.object({
  type: z.literal('join'),
  roomCode: roomCodeSchema,
  /** Resume an existing member... */
  memberId: z.string().optional(),
  memberSecret: z.string().optional(),
  /** ...or create a new one. */
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

export const webToServerSchema = z.discriminatedUnion('type', [
  webJoinSchema,
  webMoveSchema,
  webActivitySchema,
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
  code: z.enum(['bad-join', 'name-taken', 'bad-message', 'server-error']),
  message: z.string(),
});
export type WebError = z.infer<typeof webErrorSchema>;

export const serverToWebSchema = z.discriminatedUnion('type', [
  webWorldSchema,
  webMemberUpsertSchema,
  webMemberLeftSchema,
  webPositionSchema,
  webPresenceSchema,
  webLeaderboardSchema,
  webErrorSchema,
]);
export type ServerToWeb = z.infer<typeof serverToWebSchema>;
