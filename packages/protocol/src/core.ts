import { z } from 'zod';
import { minuteReportSchema, usageBucketSchema } from './usage.js';

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

/**
 * input + output — the two classes a pay-as-you-go invoice charges at full
 * rate. **Not** the board's metric; see `processedTokens`.
 *
 * It was the board's metric, and that is the mistake this pair of functions
 * exists to keep from coming back. Measured on production, Claude Code runs a
 * 99.9996% cache hit rate, so `input + output` for a Claude Code member is
 * *output and nothing else* (`billed / output = 1.00`), while for Codex the
 * same expression is 8.35x output. Per dollar actually spent that handed Codex
 * 10x the points; one member's Claude Code work was 10.2% of their spend and
 * 0.49% of their score. The number is not wrong — it is a real quantity — it
 * simply means something different per harness, which makes it unusable for
 * comparing friends.
 *
 * Kept, exported and named for what it is, because the cost side of the
 * product still has a legitimate use for "the expensive half" and because
 * quietly redefining a function under its callers is how a metric changes
 * meaning without anyone noticing. Nothing in this repo displays it today.
 */
export function billedTokens(t: TokenTotals): number {
  return t.input + t.output;
}

/**
 * Every token the agent chewed through: input + output + cacheRead +
 * cacheWrite. The leaderboard's metric and the member card's headline.
 *
 * Chosen over ranking by estimated cost because it needs no pricing data — it
 * works today, and for models nobody publishes a price for — and because
 * "tokens burned" is the honest framing for a game. An agent that read 365M
 * cached tokens did real work; charging it a tenth of a cent per thousand does
 * not make those tokens not exist. Cost stays alongside as a clearly labelled
 * secondary estimate.
 *
 * Cache reads dominate the sum by two to three orders of magnitude, so this is
 * a much larger number than the one it replaced — `formatTokens` carries B and
 * T tiers for exactly that reason.
 */
export function processedTokens(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
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
  /**
   * Cumulative usage bucketed by day and model, superseding the flat
   * `tokens` total for collectors new enough to report it. Optional so a
   * pre-0.2 collector (which only ever sends `tokens`) keeps working.
   */
  usage: z.array(usageBucketSchema).max(30).optional(),
  /** Per-day activity bitmaps for this session. Same compatibility note. */
  activeMinutes: z.array(minuteReportSchema).max(7).optional(),
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

/**
 * How much a day's `sessionsRun` and `activeMinutes` can be trusted to mean
 * what their names say. One enum for both because they have one cause: which
 * side of the 0.2 collector line the day was recorded on.
 *
 * - `measured`: a 0.2-or-later collector reported it. `sessionsRun` counts
 *   conversations, with forks, resumes and subagent runs folded into the
 *   lineage they came from; `activeMinutes` counts minutes that actually
 *   contained output.
 * - `coarse`: the pre-0.2 fallbacks. `sessionsRun` counts *transcript files*,
 *   which on the local corpus ran 4.3x the number of real conversations (599
 *   files, 139 lineages), and `activeMinutes` is the server's one-bit-per-
 *   snapshot mark, which stays lit for up to ten minutes after an agent's last
 *   output — one production day reads 1,315 minutes, or 21.9 hours.
 *
 * Absent means undecidable, which a day with no usage rows always is. Callers
 * treat absent as `coarse` for anything they hedge, because claiming precision
 * we cannot demonstrate is the failure this field exists to stop.
 */
export const statsPrecisionSchema = z.enum(['measured', 'coarse']);
export type StatsPrecision = z.infer<typeof statsPrecisionSchema>;

/** Today's aggregates for one member, for the leaderboard. */
export const dailyStatsSchema = z.object({
  tokens: tokenTotalsSchema,
  sessionsRun: count,
  activeMinutes: count,
  /** Today's totals split out per model, for the per-model leaderboard view. */
  byModel: z.record(z.string(), tokenTotalsSchema).optional(),
  /** Null when any contributing model has no known price; see `estimateCostUsd`. */
  estimatedCostUsd: z.number().nullable().optional(),
  /**
   * What the day's *priced* models add up to — a floor under the real spend,
   * and equal to `estimatedCostUsd` whenever that is not null. See
   * `estimateCostFloorUsd` for why a floor exists beside a contract that
   * refuses partial totals.
   *
   * Not nullable, unlike its sibling: there is always a priced sum, and 0 says
   * "nothing here could be priced" rather than "this day was free" — which is
   * why a 0 floor must never be rendered as a dollar amount. Optional because
   * a server older than this field cannot send one; absent means the same as 0.
   */
  estimatedCostFloorUsd: z.number().optional(),
  /**
   * False when this member's collector says they keep their numbers to
   * themselves — `visibility.tokens` off, so `tokens`, `usage` and
   * `activeMinutes` never left their machine.
   *
   * The third thing in this protocol called some variant of "sharing", and the
   * one that is about the *numbers*: `MemberView.sharing` is "a collector is
   * attached right now" and `RosterEntry.sharing` is "a device was ever
   * paired". A member can be all three at once and still be withholding this
   * one, which is exactly the case that used to render as `0 tok / 0 sessions
   * / est. $0.00` beside a list of their live sessions — privacy displayed as
   * an affirmative claim of idleness.
   *
   * Optional because a 0.1.x collector cannot say either way. Absent means
   * "not withheld as far as we know", which is what every reading of this
   * field before it existed already assumed.
   */
  tokensShared: z.boolean().optional(),
  /** See `statsPrecisionSchema`. Absent when the day holds nothing to judge. */
  precision: statsPrecisionSchema.optional(),
});
export type DailyStats = z.infer<typeof dailyStatsSchema>;

/**
 * What a member may do in their workspace. Lives here rather than beside the
 * rest of the workspace vocabulary because `memberViewSchema` needs it and
 * `workspace.ts` already depends on this module — putting it there would make
 * the two files import each other in a cycle.
 */
export const roleSchema = z.enum(['owner', 'moderator', 'member']);
export type MemberRole = z.infer<typeof roleSchema>;

/** Everything a browser client knows about one member of the room. */
export const memberViewSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(32),
  avatar: z.string().min(1).max(32),
  role: roleSchema,
  presence: presenceStateSchema,
  position: positionSchema,
  sessions: z.array(sessionSnapshotSchema),
  today: dailyStatsSchema,
  sharing: z.boolean(),
});
export type MemberView = z.infer<typeof memberViewSchema>;

/**
 * The cast of avatars. Each id maps to a palette variant of the character
 * spritesheet in the web app; the server hands new members a random one.
 */
export const AVATAR_IDS = [
  'clementine',
  'juniper',
  'marlow',
  'sable',
  'biscuit',
  'pixel',
  'mochi',
  'rusty',
  'fern',
  'ziggy',
  'plum',
  'comet',
] as const;

/**
 * A room code is a capability: `<vanity-slug>-<random suffix>`, generated
 * server-side. Knowing the code (via an invite link) is what grants entry,
 * so codes are never guessable words. The demo room is the one deliberate
 * exception.
 */
export const roomCodeSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-]*$/i, 'letters, digits, dashes');
/** The human name of an office, e.g. "the lab" — display only. */
export const roomNameSchema = z.string().trim().min(1).max(32);
export const displayNameSchema = z.string().trim().min(1).max(32);
export const avatarIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case');
