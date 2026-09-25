import { z } from 'zod';
import { CHAT_BACKLOG, chatMessageSchema, chatTextSchema } from './chat.js';
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
  /**
   * The creating browser's own zone, as the new office's day boundary. Read
   * only alongside `createRoom`; an office already exists and already has one.
   *
   * Bounded but deliberately *not* checked against the zone database here, the
   * one place in this file where a field is looser than the value it carries.
   * This is a hint nobody typed — `Intl.DateTimeFormat().resolvedOptions()`
   * off whatever runtime the visitor has — and refusing the whole join over it
   * would cost somebody their first office to make a point about a default.
   * The server falls back to UTC for anything it does not recognize; the
   * settings op, where an owner chooses on purpose, refuses it instead.
   */
  timezone: z.string().max(64).optional(),
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

/**
 * Something one person wants to say to the room.
 *
 * The first message on this wire a human composes. Everything else a browser
 * sends is either plumbing (`move`, `activity`) or a click on a control the
 * office drew (`admin`, `history`) — refuse one of those and the worst case is
 * a button that does nothing. Refuse this one and somebody's sentence is gone,
 * which is why it is the only client message whose refusal has a code of its
 * own; see `webErrorSchema`.
 *
 * Carries no timestamp and no id. Both are the office's to mint: a client
 * clock decides where a line sorts, and a client id decides what a moderator's
 * delete addresses.
 */
export const webChatSchema = z.object({
  type: z.literal('chat'),
  text: chatTextSchema,
});
export type WebChat = z.infer<typeof webChatSchema>;

export const webToServerSchema = z.discriminatedUnion('type', [
  webJoinSchema,
  webMoveSchema,
  webActivitySchema,
  webAdminSchema,
  webHistorySchema,
  webChatSchema,
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
  /**
   * The office day this member was last here on — present **only** when the
   * server has judged this arrival a return from a real absence, and absent on
   * every other join in the world.
   *
   * On `world` because this is the one message addressed to a single socket
   * rather than to the room: it already carries that socket's own credentials,
   * and this is the second fact on it about the person arriving rather than
   * about the office. It costs no round trip and spends none of the history
   * budget — a browser that wants to say something about those days asks for
   * them through the same cached `history` answer the board and the week strips
   * already share.
   *
   * A day key and not a timestamp, deliberately. A moment would make the
   * browser re-derive the office's calendar to use it, and the office's
   * calendar is server-side knowledge — the timezone setting — that nothing on
   * this wire lets a client guess at (see `boardDay`, which is an index into
   * server-served days for exactly this reason). Serving the day keeps one
   * definition of a day in the client: the same one every key in the history
   * answer is cut on, so "the days since you were last here" is a string
   * comparison rather than arithmetic that could disagree with the labels.
   *
   * Always strictly older than the office's current day when present, because
   * a day that began after somebody left is the finest thing a ledger bucketed
   * by day can honestly say about "since you left".
   */
  lastHereDay: daySchema.optional(),
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
  /**
   * `chat-refused` is the one code here that names *where the answer goes*
   * rather than what went wrong, and it exists because the browser cannot work
   * that out for itself. Every other error arriving inside an open office is
   * the office saying no to a control somebody clicked, and the client puts it
   * beside that control. A refused chat message is not that: the person is
   * looking at a text box, and their sentence did not land. Without a code of
   * its own the refusal goes to the panel holding the admin controls — which
   * may well be shut — and the chat box sits there looking like it worked.
   */
  code: z.enum([
    'bad-join',
    'room-not-found',
    'name-taken',
    'bad-message',
    'server-error',
    'forbidden',
    'workspace-locked',
    'knock-pending',
    'chat-refused',
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
 * Those keys are cut in the office's timezone, the same one the live board
 * already calls "today". The days *inside* each member's entry are their
 * collector's own local days, unconverted, which is what makes the label
 * honest: it is the date that person did the work, on their calendar. Two
 * members in different timezones therefore describe genuinely different
 * 24-hour spans under one label, which is the intended reading and the only
 * one available — nothing on the wire carries a collector's offset. What the
 * office's own zone decides is only which of those labels it counts back from,
 * so that everybody is being read over the same window.
 */
export const webHistoryResultSchema = z.object({
  type: z.literal('history'),
  days: z.array(daySchema),
  members: z.array(memberHistorySchema),
});
export type WebHistoryResult = z.infer<typeof webHistoryResultSchema>;

/** One line somebody just said, to everybody in the office including them. */
export const webChatMessageSchema = z.object({
  type: z.literal('chat'),
  message: chatMessageSchema,
});
export type WebChatMessage = z.infer<typeof webChatMessageSchema>;

/**
 * The conversation as it stands, to one browser that has just walked in.
 *
 * The last N, always — not "the N since you were last here", which reads well
 * until somebody reloads the tab and the panel they were reading goes blank.
 * A reload and a week away are the same event to a WebSocket, and only one of
 * them wants an empty room.
 *
 * `unreadSince` is what separates them: the moment this member's browser was
 * last actually in the office (the same clock the "while you were away"
 * greeting is measured on), present only when at least one line in `messages`
 * landed after it. It is the office's number and never the browser's — what
 * counts as "here" is server-side knowledge, and a client that guessed would
 * mark a page refresh as an absence.
 *
 * Sent on the arriving socket alone rather than to every tab this member has
 * open: it is an answer about *this* arrival, and pushing it to a tab that has
 * been sitting here all afternoon would reset a conversation somebody is in
 * the middle of reading.
 */
export const webChatLogSchema = z.object({
  type: z.literal('chat-log'),
  /** Oldest first, so a panel appends downward without reversing anything. */
  messages: z.array(chatMessageSchema).max(CHAT_BACKLOG),
  unreadSince: z.number().int().positive().optional(),
});
export type WebChatLog = z.infer<typeof webChatLogSchema>;

/**
 * A line is gone — its author took it back, or somebody who can moderate did.
 *
 * The id alone, not the log again: the rest of the conversation did not
 * change, and re-sending it would scroll everybody who is reading.
 */
export const webChatRemovedSchema = z.object({
  type: z.literal('chat-removed'),
  id: z.string().min(1).max(64),
});
export type WebChatRemoved = z.infer<typeof webChatRemovedSchema>;

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
  webChatMessageSchema,
  webChatLogSchema,
  webChatRemovedSchema,
]);
export type ServerToWeb = z.infer<typeof serverToWebSchema>;
