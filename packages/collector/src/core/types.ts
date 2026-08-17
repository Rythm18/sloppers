import type { HarnessId, SessionSnapshot } from '@sloppers/protocol';

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
  tokens?: import('@sloppers/protocol').TokenTotals;
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
  return { filePath, lastEventKind: 'other', ignored: false, scratch: {} };
}

/** A snapshot plus which adapter produced it; used by tests and the tracker. */
export interface TrackedSession {
  adapterId: HarnessId;
  snapshot: SessionSnapshot;
}
