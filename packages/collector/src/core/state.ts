import type { SessionState } from '@sloppers/protocol';
import type { LastEventKind } from './types.js';

/** A tool call unanswered this long probably means a permission prompt. */
const TOOL_STALL_MS = 90 * 1000;
/** Nothing for this long means the session has gone quiet. */
export const IDLE_MS = 10 * 60 * 1000;
/** Quiet longer than this and the session drops out of snapshots entirely. */
export const EXPIRE_MS = 30 * 60 * 1000;

/**
 * Shared session-state heuristic. Adapters classify the last transcript
 * entry; time does the rest.
 */
export function deriveSessionState(
  lastEventKind: LastEventKind,
  msSinceActivity: number,
): SessionState {
  if (msSinceActivity >= IDLE_MS) return 'idle';
  switch (lastEventKind) {
    case 'agent-final':
      return 'waiting';
    case 'agent-tool':
      return msSinceActivity >= TOOL_STALL_MS ? 'waiting' : 'working';
    case 'other':
      return 'working';
  }
}
