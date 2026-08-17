import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import type { HarnessAdapter } from '../core/types.js';
import { newAccumulator } from '../core/types.js';

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
 */

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
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
            const info = payload.info as
              | { total_token_usage?: CodexTokenUsage }
              | null
              | undefined;
            const usage = info?.total_token_usage;
            if (usage) {
              const cached = usage.cached_input_tokens ?? 0;
              acc.tokens = {
                input: Math.max(0, (usage.input_tokens ?? 0) - cached),
                output: usage.output_tokens ?? 0,
                cacheRead: cached,
                cacheWrite: usage.cache_write_input_tokens ?? 0,
              };
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
