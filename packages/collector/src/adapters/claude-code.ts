import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { emptyTokens, type TokenTotals } from '@sloppers/protocol';
import type { HarnessAdapter, SessionAccumulator } from '../core/types.js';
import { newAccumulator } from '../core/types.js';

/**
 * Claude Code appends every session to
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. Entries are typed
 * JSON lines; the ones we care about:
 *
 * - `user` / `assistant`: carry `cwd`, `gitBranch`, `timestamp`. Assistant
 *   entries add `message.model` and `message.usage` (token counts) plus a
 *   `requestId` — one API request's usage may appear on several entries
 *   (one per content block), so usage is deduplicated by request.
 * - `ai-title` / `custom-title`: a human-readable session title.
 * - Entries with `isSidechain: true` are subagent transcripts; whole files
 *   of them are ignored so popups don't fill with phantom sessions.
 *
 * "Who acts next" is read off the last assistant entry: a text-only message
 * ends the turn (the human acts); a message with a `tool_use` block means a
 * tool is running or a permission prompt is blocking.
 */

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface Scratch {
  usageByRequest: Map<string, TokenTotals>;
  running: TokenTotals;
}

function scratchOf(acc: SessionAccumulator): Scratch {
  if (!acc.scratch.claude) {
    acc.scratch.claude = {
      usageByRequest: new Map<string, TokenTotals>(),
      running: emptyTokens(),
    } satisfies Scratch;
  }
  return acc.scratch.claude as Scratch;
}

function toTotals(u: ClaudeUsage): TokenTotals {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

export function createClaudeCodeAdapter(home: string = homedir()): HarnessAdapter {
  const root = join(home, '.claude', 'projects');
  return {
    id: 'claude-code',
    roots: () => [root],
    matches: (filePath) =>
      filePath.startsWith(root + sep) &&
      filePath.endsWith('.jsonl') &&
      !filePath.includes(`${sep}memory${sep}`),
    newAccumulator,
    ingestLine(line, acc) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = entry.type;
      if (!acc.scratch.sidechainDecided && typeof entry.isSidechain === 'boolean') {
        // The first positioned entry tells us whether this whole file is a
        // subagent sidechain rather than a real session.
        acc.scratch.sidechainDecided = true;
        if (entry.isSidechain) {
          acc.ignored = true;
          return;
        }
      }
      if (acc.ignored) return;

      if (typeof entry.sessionId === 'string' && !acc.sessionId) {
        acc.sessionId = entry.sessionId;
      }
      if (typeof entry.cwd === 'string' && entry.cwd.length > 0) {
        acc.cwd = entry.cwd;
      }
      if (typeof entry.gitBranch === 'string' && entry.gitBranch.length > 0) {
        acc.branch = entry.gitBranch;
      }
      if (!acc.startedAtMs && typeof entry.timestamp === 'string') {
        const ms = Date.parse(entry.timestamp);
        if (!Number.isNaN(ms)) acc.startedAtMs = ms;
      }

      switch (type) {
        case 'ai-title':
          if (typeof entry.aiTitle === 'string') acc.title ??= entry.aiTitle;
          break;
        case 'custom-title':
          if (typeof entry.customTitle === 'string') acc.title = entry.customTitle;
          break;
        case 'user':
        case 'attachment':
        case 'system':
          acc.lastEventKind = 'other';
          break;
        case 'assistant': {
          const message = (entry.message ?? {}) as Record<string, unknown>;
          const model = message.model;
          if (typeof model === 'string' && model !== '<synthetic>') {
            acc.model = model;
            const usage = message.usage as ClaudeUsage | undefined;
            const requestId = entry.requestId;
            if (usage && typeof requestId === 'string') {
              const s = scratchOf(acc);
              const next = toTotals(usage);
              const prev = s.usageByRequest.get(requestId);
              s.usageByRequest.set(requestId, next);
              // Keep a running sum with O(1) updates: replace this request's
              // previous contribution instead of resumming every request.
              s.running = {
                input: s.running.input - (prev?.input ?? 0) + next.input,
                output: s.running.output - (prev?.output ?? 0) + next.output,
                cacheRead: s.running.cacheRead - (prev?.cacheRead ?? 0) + next.cacheRead,
                cacheWrite: s.running.cacheWrite - (prev?.cacheWrite ?? 0) + next.cacheWrite,
              };
              acc.tokens = s.running;
            }
          }
          const content = message.content;
          const hasToolUse =
            Array.isArray(content) &&
            content.some((block) => (block as { type?: string }).type === 'tool_use');
          acc.lastEventKind = hasToolUse ? 'agent-tool' : 'agent-final';
          break;
        }
        default:
          // Bookkeeping entries (titles, modes, snapshots...) say nothing
          // about who acts next; leave the classification alone.
          break;
      }
    },
  };
}
