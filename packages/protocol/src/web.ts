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
import { daySchema } from './usage.js';
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

/**
 * The most days a browser may ask for at once. Seven is the product need — a
 * week reads as a rhythm — and the cap is twice that so a client asking for a
 * fortnight gets one rather than a refusal, while nobody can turn one click
 * into an unbounded scan. The server clamps to this too; the schema is the
 * cheaper of the two places to say no.
 */
export const MAX_HISTORY_DAYS = 14;

/**
 * "Show me the office's recent days." On demand — a click on the board's day
 * switch or a member's week — never a broadcast, because history does not
 * change while you look at it.
 *
 * There is no day on the request. The days come back keyed exactly as the
 * live board keys today, so a browser never has to reconcile two definitions
 * of "today" inside one panel; see `webHistoryResultSchema`.
 */
export const webHistorySchema = z.object({
  type: z.literal('history'),
  /** How many days back, ending today. Defaults to 7, capped at the constant above. */
  days: z.number().int().min(1).max(MAX_HISTORY_DAYS).optional(),
});
export type WebHistoryRequest = z.infer<typeof webHistorySchema>;

export const webToServerSchema = z.discriminatedUnion('type', [
  webJoinSchema,
  webMoveSchema,
  webActivitySchema,
  webAdminSchema,
  webHistorySchema,
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

/**
 * Sent to a knocking browser: it's waiting on an owner/moderator decision.
 *
 * `answerable` is whether anybody who could open the door has a browser
 * connected right now — the difference between waiting and waiting for
 * nobody, which the page at the door has no other way to learn. Optional
 * because it was added after this message shipped: a client that never sees
 * it genuinely cannot tell an empty office from a busy one, and should say
 * neither. Re-sent whenever the answer changes while somebody is still
 * standing there.
 */
export const webKnockingSchema = z.object({
  type: z.literal('knocking'),
  answerable: z.boolean().optional(),
});
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

/** One member's one day, as `dailyStatsSchema` describes any day. */
export const dayStatsSchema = z.object({
  day: daySchema,
  stats: dailyStatsSchema,
});
export type DayStats = z.infer<typeof dayStatsSchema>;

/**
 * One member's recent days, newest first.
 *
 * `days` is empty for a member who withholds — and empty *because* of the
 * withholding, not because their tables are. Their current choice governs
 * their whole history: somebody who turns sharing off this afternoon is not
 * asking the office to keep quiet from here on, they are asking it to stop
 * talking about their numbers, and last Tuesday's are still their numbers.
 * Nothing about those days leaves the server, so this is a real refusal rather
 * than a flag the browser is trusted to honour.
 *
 * Days the member simply did not work are present with zeroes. A rest day is a
 * real value in a rhythm, and dropping it would make a strip of seven bars
 * silently mean something different per member.
 */
export const memberHistorySchema = z.object({
  memberId: z.string(),
  displayName: z.string(),
  avatar: z.string(),
  days: z.array(dayStatsSchema),
  /** False when this member keeps their numbers to themselves; see above. */
  tokensShared: z.boolean().optional(),
});
export type MemberHistory = z.infer<typeof memberHistorySchema>;

/**
 * The office's recent days, answering one `history` request.
 *
 * `days` lists the keys covered, newest first, so a client labels a strip from
 * what the office actually served rather than from date arithmetic of its own —
 * including for a member whose own entry has nothing in it.
 *
 * Those keys are cut on the server's clock, the same one the live board already
 * calls "today". The days *inside* each member's entry are their collector's
 * own local days, unconverted, which is what makes the label honest: it is the
 * date that person did the work, on their calendar. Two members in different
 * timezones therefore describe genuinely different 24-hour spans under one
 * label, which is the intended reading and the only one available — nothing on
 * the wire carries a collector's offset.
 */
export const webHistoryResultSchema = z.object({
  type: z.literal('history'),
  days: z.array(daySchema),
  members: z.array(memberHistorySchema),
});
export type WebHistoryResult = z.infer<typeof webHistoryResultSchema>;

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
  webHistoryResultSchema,
]);
export type ServerToWeb = z.infer<typeof serverToWebSchema>;
