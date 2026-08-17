import { z } from 'zod';

/**
 * Identifies which agent harness a session belongs to. Open set: built-in
 * adapters use 'claude-code' and 'codex'; community adapters register their
 * own ids.
 */
export const harnessIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case');
export type HarnessId = z.infer<typeof harnessIdSchema>;

const count = z.number().int().nonnegative();

/** Cumulative token usage for one agent session. */
export const tokenTotalsSchema = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
});
export type TokenTotals = z.infer<typeof tokenTotalsSchema>;

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** input + output, the number people mean by "tokens burned". */
export function billedTokens(t: TokenTotals): number {
  return t.input + t.output;
}

/**
 * What one agent session is doing right now.
 * - working: the transcript is actively being appended
 * - waiting: the agent is blocked on human input (prompt or permission)
 * - idle: session is open but nothing has happened for a while
 */
export const sessionStateSchema = z.enum(['working', 'waiting', 'idle']);
export type SessionState = z.infer<typeof sessionStateSchema>;

/**
 * One live agent session, as reported by a collector. Optional fields are
 * subject to the owner's visibility settings and may be absent by choice.
 */
export const sessionSnapshotSchema = z.object({
  id: z.string().min(1).max(128),
  harness: harnessIdSchema,
  state: sessionStateSchema,
  /** Harness-generated session title, e.g. Claude Code's ai-title. */
  title: z.string().min(1).max(200).optional(),
  project: z.string().min(1).max(120).optional(),
  branch: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(120).optional(),
  tokens: tokenTotalsSchema.optional(),
  startedAt: z.number().int().positive(),
  lastActivityAt: z.number().int().positive(),
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

/**
 * A member's overall presence, derived server-side from browser activity and
 * collector snapshots. Order here is priority order.
 */
export const presenceStateSchema = z.enum([
  'needs-attention',
  'active',
  'grinding',
  'afk',
  'offline',
]);
export type PresenceState = z.infer<typeof presenceStateSchema>;

/**
 * Which facts a member shares with the room. Enforced in the collector:
 * a field turned off never leaves the machine.
 */
export const visibilitySchema = z.object({
  title: z.boolean(),
  project: z.boolean(),
  branch: z.boolean(),
  model: z.boolean(),
  tokens: z.boolean(),
});
export type Visibility = z.infer<typeof visibilitySchema>;

export const defaultVisibility: Visibility = {
  title: true,
  project: true,
  branch: true,
  model: true,
  tokens: true,
};

/** Facing direction of an avatar. */
export const directionSchema = z.enum(['up', 'down', 'left', 'right']);
export type Direction = z.infer<typeof directionSchema>;

export const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  dir: directionSchema,
  moving: z.boolean(),
});
export type Position = z.infer<typeof positionSchema>;

/** Today's aggregates for one member, for the leaderboard. */
export const dailyStatsSchema = z.object({
  tokens: tokenTotalsSchema,
  sessionsRun: count,
  activeMinutes: count,
});
export type DailyStats = z.infer<typeof dailyStatsSchema>;

/** Everything a browser client knows about one member of the room. */
export const memberViewSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(32),
  avatar: z.string().min(1).max(32),
  presence: presenceStateSchema,
  position: positionSchema,
  sessions: z.array(sessionSnapshotSchema),
  today: dailyStatsSchema,
  sharing: z.boolean(),
});
export type MemberView = z.infer<typeof memberViewSchema>;

export const roomCodeSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, 'letters, digits, dashes');
export const displayNameSchema = z.string().trim().min(1).max(32);
export const avatarIdSchema = z.string().min(1).max(32);
