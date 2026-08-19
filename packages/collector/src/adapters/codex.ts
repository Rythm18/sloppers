import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { emptyTokens, type TokenTotals } from '@sloppers/protocol';
import type { HarnessAdapter, SessionAccumulator } from '../core/types.js';
import { addUsage, markMinute, newAccumulator } from '../core/types.js';

/**
 * Codex CLI writes each session to
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. Lines are
 * `{timestamp, type, payload}`:
 *
 * - `session_meta`: session id, cwd, git branch — the session's identity.
 * - `turn_context`: per-turn settings; carries the current `model`.
 * - `event_msg`: the live event stream. `token_count` events carry
 *   cumulative usage in `info.total_token_usage`; `task_complete` /
 *   `turn_aborted` mean the agent finished and the human acts next;
 *   `*_approval_request` means the agent is blocked on a permission prompt.
 *
 * Codex reports input tokens inclusive of cache hits, so cached tokens are
 * subtracted out of `input` to match the protocol's disjoint fields.
 *
 * Because those totals are cumulative for the whole session, what gets
 * bucketed is the *growth* since the previous `token_count`, not the raw
 * cumulative. Bucketing the cumulative is right only while a session stays on
 * one day and one model: a session reporting 1000 at 23:50 and 1500 at 00:10
 * would leave day 1 holding 1000 and day 2 holding 1500 — 2500 booked against
 * 1500 actually spent — and a mid-session model switch would charge the whole
 * session to whichever model happened to come last. 83 of 493 local rollouts
 * span more than one day and 7 use more than one model, so both cases are
 * ordinary.
 */

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
}

interface Scratch {
  /**
   * Highest cumulative total seen so far, per field. A high-water mark rather
   * than "the previous value" so a cumulative that goes *backwards* — a
   * truncated file replayed from the top, which the tailer does by design —
   * re-covers ground already booked instead of double-counting it, and can
   * never yield a negative delta. No local rollout has ever gone backwards
   * (0 of 493), so this is purely a guard.
   */
  seen: TokenTotals;
}

function scratchOf(acc: SessionAccumulator): Scratch {
  if (!acc.scratch.codex) {
    acc.scratch.codex = { seen: emptyTokens() } satisfies Scratch;
  }
  return acc.scratch.codex as Scratch;
}

/** How much of `cumulative` is above the high-water mark, per field. */
function growth(seen: TokenTotals, cumulative: TokenTotals): TokenTotals {
  return {
    input: Math.max(0, cumulative.input - seen.input),
    output: Math.max(0, cumulative.output - seen.output),
    cacheRead: Math.max(0, cumulative.cacheRead - seen.cacheRead),
    cacheWrite: Math.max(0, cumulative.cacheWrite - seen.cacheWrite),
  };
}

function highWater(seen: TokenTotals, cumulative: TokenTotals): TokenTotals {
  return {
    input: Math.max(seen.input, cumulative.input),
    output: Math.max(seen.output, cumulative.output),
    cacheRead: Math.max(seen.cacheRead, cumulative.cacheRead),
    cacheWrite: Math.max(seen.cacheWrite, cumulative.cacheWrite),
  };
}

/**
 * When this event happened. All 479298 local `token_count` events carry a
 * parseable timestamp; the fallbacks keep a malformed one from costing the
 * tokens it reports.
 */
function eventMs(timestamp: unknown, acc: SessionAccumulator): number {
  if (typeof timestamp === 'string') {
    const ms = Date.parse(timestamp);
    if (!Number.isNaN(ms)) return ms;
  }
  return acc.startedAtMs ?? Date.now();
}

export function createCodexAdapter(home: string = homedir()): HarnessAdapter {
  const root = join(home, '.codex', 'sessions');
  return {
    id: 'codex',
    roots: () => [root],
    matches: (filePath) =>
      filePath.startsWith(root + sep) &&
      basename(filePath).startsWith('rollout-') &&
      filePath.endsWith('.jsonl'),
    newAccumulator,
    ingestLine(line, acc) {
      let entry: {
        timestamp?: string;
        type?: string;
        payload?: Record<string, unknown>;
      };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        return;
      }
      const payload = entry.payload;
      if (!payload) return;

      switch (entry.type) {
        case 'session_meta': {
          const id = payload.id ?? payload.session_id;
          if (typeof id === 'string') acc.sessionId = id;
          if (typeof payload.cwd === 'string') acc.cwd = payload.cwd;
          const git = payload.git as { branch?: unknown } | undefined;
          if (git && typeof git.branch === 'string') acc.branch = git.branch;
          if (typeof entry.timestamp === 'string') {
            const ms = Date.parse(entry.timestamp);
            if (!Number.isNaN(ms)) acc.startedAtMs = ms;
          }
          break;
        }
        case 'turn_context':
          if (typeof payload.model === 'string') acc.model = payload.model;
          if (typeof payload.cwd === 'string') acc.cwd = payload.cwd;
          break;
        case 'event_msg': {
          const kind = payload.type;
          if (kind === 'token_count') {
            const info = payload.info as { total_token_usage?: CodexTokenUsage } | null | undefined;
            const usage = info?.total_token_usage;
            if (usage) {
              const ms = eventMs(entry.timestamp, acc);
              markMinute(acc, ms);
              const cached = usage.cached_input_tokens ?? 0;
              const cumulative: TokenTotals = {
                input: Math.max(0, (usage.input_tokens ?? 0) - cached),
                output: usage.output_tokens ?? 0,
                cacheRead: cached,
                cacheWrite: usage.cache_write_input_tokens ?? 0,
              };
              const s = scratchOf(acc);
              const delta = growth(s.seen, cumulative);
              s.seen = highWater(s.seen, cumulative);
              if (delta.input || delta.output || delta.cacheRead || delta.cacheWrite) {
                addUsage(acc, ms, acc.model, delta);
              }
            }
            // Token counts stream during work; they say nothing about turns.
            break;
          }
          if (kind === 'task_complete' || kind === 'turn_aborted') {
            acc.lastEventKind = 'agent-final';
          } else if (typeof kind === 'string' && kind.endsWith('approval_request')) {
            acc.lastEventKind = 'agent-tool';
          } else if (kind === 'agent_message') {
            // Mid-task narration; the task may well continue. Leave as-is —
            // a following task_complete settles it.
          } else {
            acc.lastEventKind = 'other';
          }
          break;
        }
        case 'response_item':
          acc.lastEventKind = 'other';
          break;
        default:
          break;
      }
    },
  };
}
