import type { HarnessId, SessionSnapshot, TokenTotals, UsageBucket } from '@sloppers/protocol';
import { dayOf, emptyTokens, minuteOfDay } from '@sloppers/protocol';

/**
 * What the most recent transcript entry implies about who acts next.
 * Feeds shared session-state derivation (see state.ts).
 *
 * - agent-final: the agent finished a turn; the human acts next
 * - agent-tool:  the agent issued a tool call whose result hasn't landed —
 *   either the tool is still running or a permission prompt is blocking
 * - other:       anything else (user input, tool results, bookkeeping)
 */
export type LastEventKind = 'agent-final' | 'agent-tool' | 'other';

/**
 * Everything an adapter accumulates about one session file. Adapters stash
 * harness-specific working state in `scratch`; the core only reads the
 * declared fields.
 */
export interface SessionAccumulator {
  filePath: string;
  sessionId?: string;
  title?: string;
  /** Absolute path of the workspace; projected to its basename on snapshot. */
  cwd?: string;
  branch?: string;
  model?: string;
  /**
   * Spend bucketed by the day and model it actually happened on, keyed
   * `` `${day}|${model}` ``. A single flat total files a session's whole
   * spend under whichever day and model it happened to end on: on this
   * machine 26 of 590 Claude Code transcripts span more than one day and 16
   * use more than one model, so that mis-attribution is routine, not exotic.
   */
  usage: Map<string, UsageBucket>;
  /** Local day -> minute-of-day indices (0-1439) that saw agent activity. */
  activeMinutes: Map<string, Set<number>>;
  /**
   * Count this file's spend but never show it as its own session. Subagent
   * ("sidechain") transcripts carry the *parent's* sessionId, so surfacing
   * them would duplicate the parent in the room — but discarding them, which
   * is what we used to do, threw their tokens away. They are not cheap: on
   * this machine 548 of 590 transcripts are sidechains carrying 22.4M of the
   * 44.9M billed tokens, and none of that spend appears anywhere else (0 of
   * 37512 requestIds occur in both a sidechain file and a main one).
   */
  usageOnly: boolean;
  startedAtMs?: number;
  lastEventKind: LastEventKind;
  /** True once the adapter decides this file is not a reportable session. */
  ignored: boolean;
  scratch: Record<string, unknown>;
}

/**
 * Teaches the collector core to read one harness's on-disk session format.
 * Implementations must be pure per-line folds: the core owns file watching,
 * incremental reads, debouncing, and state timing.
 */
export interface HarnessAdapter {
  id: HarnessId;
  /** Directories to watch. May not exist on this machine. */
  roots(): string[];
  /** Is this path a session file this adapter understands? */
  matches(filePath: string): boolean;
  newAccumulator(filePath: string): SessionAccumulator;
  /** Fold one complete transcript line into the accumulator. */
  ingestLine(line: string, acc: SessionAccumulator): void;
}

/** Byte-offset cursor so only appended bytes are ever re-parsed. */
export interface TailCursor {
  offset: number;
  /** Trailing bytes of an incomplete final line, carried to the next read. */
  partial: Buffer;
}

export function newAccumulator(filePath: string): SessionAccumulator {
  return {
    filePath,
    lastEventKind: 'other',
    ignored: false,
    usageOnly: false,
    usage: new Map(),
    activeMinutes: new Map(),
    scratch: {},
  };
}

/**
 * Model name for spend a harness reported before it said which model was
 * running. Deliberately a real bucket rather than a dropped one: on this
 * machine 26 of 493 Codex rollouts (multi-agent threads, which never emit an
 * early `turn_context`) report a third of their tokens that way, and losing
 * those tokens is a worse error than an unpriced slice — `estimateCostUsd`
 * already returns null for models it has no price for.
 */
export const UNKNOWN_MODEL = 'unknown';

/** The key `acc.usage` is bucketed by. */
export function usageKey(day: string, model: string): string {
  return `${day}|${model}`;
}

/**
 * Fold `totals` into the bucket for (local day of `ms`, `model`), returning
 * the key it landed in so a caller that may later restate this contribution
 * knows where to unwind it from.
 */
export function addUsage(
  acc: SessionAccumulator,
  ms: number,
  model: string | undefined,
  totals: TokenTotals,
): string {
  const day = dayOf(ms);
  const named = model && model.length > 0 ? model : UNKNOWN_MODEL;
  const key = usageKey(day, named);
  const bucket = acc.usage.get(key) ?? { day, model: named, ...emptyTokens() };
  bucket.input += totals.input;
  bucket.output += totals.output;
  bucket.cacheRead += totals.cacheRead;
  bucket.cacheWrite += totals.cacheWrite;
  acc.usage.set(key, bucket);
  return key;
}

/**
 * Unwind a contribution from the bucket it originally landed in, which is not
 * necessarily the bucket its replacement belongs in — a request restated after
 * midnight, or after a model switch, moves between keys, and subtracting from
 * the new key would corrupt both. A bucket left at zero is deleted rather than
 * kept as a ghost with no contributions behind it.
 */
export function removeUsage(acc: SessionAccumulator, key: string, totals: TokenTotals): void {
  const bucket = acc.usage.get(key);
  if (!bucket) return;
  // Clamped so a bookkeeping slip can never emit a negative count, which the
  // wire schema rejects outright.
  bucket.input = Math.max(0, bucket.input - totals.input);
  bucket.output = Math.max(0, bucket.output - totals.output);
  bucket.cacheRead = Math.max(0, bucket.cacheRead - totals.cacheRead);
  bucket.cacheWrite = Math.max(0, bucket.cacheWrite - totals.cacheWrite);
  if (!bucket.input && !bucket.output && !bucket.cacheRead && !bucket.cacheWrite) {
    acc.usage.delete(key);
  }
}

/** Note that `ms` fell inside a minute this session was working. */
export function markMinute(acc: SessionAccumulator, ms: number): void {
  const day = dayOf(ms);
  let minutes = acc.activeMinutes.get(day);
  if (!minutes) {
    minutes = new Set();
    acc.activeMinutes.set(day, minutes);
  }
  minutes.add(minuteOfDay(ms));
}

/**
 * Every bucket summed back into one flat total, for the wire's legacy
 * `tokens` field. Undefined when nothing was ever recorded, so a session with
 * no usage still reports no `tokens` rather than a row of zeroes.
 */
export function totalUsage(acc: SessionAccumulator): TokenTotals | undefined {
  if (acc.usage.size === 0) return undefined;
  const total = emptyTokens();
  for (const bucket of acc.usage.values()) {
    total.input += bucket.input;
    total.output += bucket.output;
    total.cacheRead += bucket.cacheRead;
    total.cacheWrite += bucket.cacheWrite;
  }
  return total;
}

/** A snapshot plus which adapter produced it; used by tests and the tracker. */
export interface TrackedSession {
  adapterId: HarnessId;
  snapshot: SessionSnapshot;
}
