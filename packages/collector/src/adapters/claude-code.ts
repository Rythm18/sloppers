import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { TokenTotals } from '@sloppers/protocol';
import type { HarnessAdapter, SessionAccumulator } from '../core/types.js';
import { addUsage, markMinute, newAccumulator, removeUsage } from '../core/types.js';

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
 * - Entries with `isSidechain: true` are subagent transcripts. A whole file
 *   is one or the other — no local transcript mixes the two — and a sidechain
 *   file carries its *parent's* sessionId, so it is marked `usageOnly`: its
 *   spend counts, but it is never shown as a session of its own.
 *
 * "Who acts next" is read off the last assistant entry: a text-only message
 * ends the turn (the human acts); a message with a `tool_use` block means a
 * tool is running or a permission prompt is blocking. Only a `user` entry
 * resets the classification — `system` entries (turn_duration, hook
 * summaries) and attachments trail the assistant's final message, and
 * treating them as activity would mask the "agent needs you" signal.
 *
 * `--resume` copies a transcript into a NEW file with a new sessionId but
 * the ORIGINAL usage entries and requestIds. Usage is therefore attributed
 * across files: the first file to report a requestId owns it, and copies in
 * other files don't count, so a resumed session reports only post-resume
 * usage and the server's ledger never double-counts the copied history.
 */

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Where one request's tokens currently sit, so they can be moved. */
interface Contribution {
  /** The `acc.usage` key this request's totals were added to. */
  key: string;
  totals: TokenTotals;
}

interface Scratch {
  usageByRequest: Map<string, Contribution>;
}

function scratchOf(acc: SessionAccumulator): Scratch {
  if (!acc.scratch.claude) {
    acc.scratch.claude = {
      usageByRequest: new Map<string, Contribution>(),
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

/**
 * When this entry happened. Every one of the 82952 usage-bearing entries on
 * this machine carries a parseable timestamp; the fallbacks exist so a
 * malformed one costs its bucket accuracy rather than its tokens.
 */
function entryMs(entry: Record<string, unknown>, acc: SessionAccumulator): number {
  if (typeof entry.timestamp === 'string') {
    const ms = Date.parse(entry.timestamp);
    if (!Number.isNaN(ms)) return ms;
  }
  return acc.startedAtMs ?? Date.now();
}

/**
 * Ceiling on the resume-dedup index. It holds one entry per distinct
 * requestId the daemon has ever seen, which grows for as long as the process
 * lives — and now grows 2.3x faster, since sidechain requests are no longer
 * thrown away at the first line.
 *
 * 100k is a ceiling, not a working size: the busiest single day in 49 active
 * days of local transcripts produced 2939 distinct requestIds, and the
 * heaviest 30-day window 31225, so eviction is roughly three months of
 * *uninterrupted* uptime away. At ~150 bytes an entry (a 28-character id
 * plus a Map slot; the file path is a shared reference, not a copy) the cap
 * bounds this at ~15MB.
 *
 * Evicting the oldest is safe because ownership only has to outlive the file
 * that claimed it: the tracker drops a transcript 30 minutes (`EXPIRE_MS`)
 * after it goes quiet, so an id old enough to be evicted here belongs to a
 * file nothing is reporting on any more.
 */
const MAX_TRACKED_REQUESTS = 100_000;

export function createClaudeCodeAdapter(
  home: string = homedir(),
  maxTrackedRequests: number = MAX_TRACKED_REQUESTS,
): HarnessAdapter {
  const root = join(home, '.claude', 'projects');
  /** requestId → transcript file that first reported it (resume dedup). */
  const requestOwner = new Map<string, string>();
  /** Claim `requestId` for `owner`, evicting the oldest claim past the cap. */
  const remember = (requestId: string, owner: string) => {
    requestOwner.set(requestId, owner);
    // Map iterates in insertion order, and re-setting an existing key does
    // not reorder it, so the first key is always the oldest claim.
    while (requestOwner.size > maxTrackedRequests) {
      const oldest = requestOwner.keys().next().value;
      if (oldest === undefined) break;
      requestOwner.delete(oldest);
    }
  };
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
        // subagent sidechain rather than a real session. Keep folding it
        // either way — a sidechain's tokens are real spend that appears in no
        // other transcript; it is only its *identity* that must not surface,
        // since it borrows the parent's sessionId.
        acc.scratch.sidechainDecided = true;
        if (entry.isSidechain) acc.usageOnly = true;
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
              const ms = entryMs(entry, acc);
              // The machine was busy at this moment whoever owns the tokens,
              // so the minute is recorded even for a resume copy.
              markMinute(acc, ms);
              const owner = requestOwner.get(requestId) ?? acc.filePath;
              remember(requestId, owner);
              if (owner === acc.filePath) {
                const s = scratchOf(acc);
                const next = toTotals(usage);
                // A restated request may belong to a different day or model
                // than it first did, so unwind it from the bucket it actually
                // landed in — subtracting from the new one would leave the old
                // bucket overstated and drive the new one negative.
                const prev = s.usageByRequest.get(requestId);
                if (prev) removeUsage(acc, prev.key, prev.totals);
                const key = addUsage(acc, ms, model, next);
                s.usageByRequest.set(requestId, { key, totals: next });
              }
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
          // Bookkeeping entries (titles, modes, snapshots, and the system/
          // attachment entries that trail a finished turn) say nothing about
          // who acts next; leave the classification alone.
          break;
      }
    },
  };
}
