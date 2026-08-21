import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { emptyTokens, type TokenTotals } from '@sloppers/protocol';
import type { HarnessAdapter, SessionAccumulator } from '../core/types.js';
import { addUsage, markMinute, newAccumulator } from '../core/types.js';

/**
 * Codex CLI writes each session to
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`, and moves
 * retired threads to `~/.codex/archived_sessions/` as a flat directory of the
 * same files. Both are read: archiving a thread does not retire its
 * *conversation*, and an archived rollout is very often the root every live
 * fork replays. Lines are `{timestamp, type, payload}`:
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
 *
 * ## Lineage: one conversation, many rollout files
 *
 * A rollout file is a *thread*, not a conversation. Every subagent Codex runs
 * and every fork of a thread becomes its own file with its own id, linked back
 * by `parent_thread_id` or `forked_from_id`. On the local corpus of 720
 * rollouts, 695 are `thread_source: "subagent"` and only 25 are `"user"`;
 * following the links collapses all 720 into 23 conversations, the largest
 * spanning 131 files and the deepest three hops.
 *
 * So a rollout reports its *lineage root* as its session id, and a subagent
 * rollout is marked `usageOnly` — the same treatment a Claude Code sidechain
 * gets, for the same reason: its spend is real but its identity belongs to the
 * conversation, not to itself.
 *
 * ## Why the totals overlap, and what that costs
 *
 * Whether summing a lineage is right depends on whether the members' totals
 * are disjoint, and the two kinds of link answer differently. Measured on the
 * corpus:
 *
 * - **Fork links overlap.** A forked rollout continues its parent's
 *   accumulator: it copies the parent's transcript into its own file first,
 *   token counts and all. One local fork replays 9681 of its parent's
 *   `token_count` events verbatim before its own first turn; others start
 *   mid-series at whatever cumulative the parent had reached. All 194 fork
 *   rollouts carry such a prefix, and across the corpus those prefixes are
 *   103.0B of the 122.6B that summing the files would report — 78% of every
 *   `token_count` event on disk (469755 of 603639) is a replay of one already
 *   written somewhere else.
 * - **Subagent links are disjoint.** A non-fork subagent starts a fresh
 *   accumulator with its own system prompt (`total_token_usage` equals
 *   `last_token_usage` on its first event) and none of its spend appears in
 *   its parent: 0 of the 503 such rollouts share a single cumulative with any
 *   ancestor. Their 2.3B is real, and folding it away would trade an
 *   over-count for an under-count.
 *
 * Which rules out both simple answers. Summing the lineage reports 122.6B
 * against 19.5B actually spent (6.3x); taking the lineage maximum, or the
 * root's own final, reports 13.7B and loses every fork's post-fork work and
 * every subagent's spend with it.
 *
 * What separates the two is exactly the Claude Code `--resume` problem, and it
 * gets the same answer: attribute across files. There, one API request is
 * identified by its `requestId` and the first transcript to report it owns it.
 * Here, one point in a thread's accumulator is identified by its cumulative
 * `(input, cached, output, cacheWrite)` — monotone, and unique in practice:
 * across 133884 distinct cumulatives in the corpus, not one appears in two
 * different conversations. The first rollout to report a cumulative owns it;
 * a copy of it in a fork counts for nothing. Replaying the corpus that way
 * books 19.5428B against a ground truth of 19.5429B.
 *
 * Ownership is by *file*, so a rollout always re-owns its own cumulatives when
 * the tailer replays it from the top, and claims are bounded by count rather
 * than by age: a fork stamps the events it replays with the moment it copied
 * them, not the moment they happened, so a time window keyed on transcript
 * time would have expired the original's claim long before the copy arrives.
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
   * (0 of 720), so this is purely a guard.
   */
  seen: TokenTotals;
  /**
   * This rollout's own thread id, taken from the *first* `session_meta` and
   * never from a later one. A fork file embeds its parent's whole transcript,
   * `session_meta` lines included — 38 of the 39 metas in one local fork carry
   * the parent's id — so letting the last one win made a fork report itself as
   * its parent, and made two unrelated rollouts collide on one wire id.
   */
  threadId?: string;
  /** Link-table version `sessionId` was resolved against; see `links`. */
  resolvedAt: number;
}

function scratchOf(acc: SessionAccumulator): Scratch {
  if (!acc.scratch.codex) {
    acc.scratch.codex = { seen: emptyTokens(), resolvedAt: -1 } satisfies Scratch;
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
 * A stable 64-bit fingerprint of one cumulative, as 16 hex characters: FNV-1a
 * run twice with the roles of offset and prime swapped.
 *
 * Hashed rather than stored whole because the index holds a quarter of a
 * million of these; a fixed 16 characters is a third of the longest literal
 * key and, unlike the literal, cannot grow with the numbers. Two *different*
 * cumulatives colliding would deny the second one's tokens, so the width is
 * deliberate: at the index's cap the odds of any collision at all are about
 * one in 600 million.
 */
function fingerprint(t: TokenTotals): string {
  const text = `${t.input},${t.output},${t.cacheRead},${t.cacheWrite}`;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x811c9dc5);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
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

/**
 * Backstop on the claim index. The working set is one seed window's worth of
 * cumulatives: `seedTracker` folds files touched in the last 24 hours, and the
 * busiest local day produced 62009 `token_count` events, so this sits about 4x
 * above it. At ~80 bytes an entry (a 16-character fingerprint plus a Map slot;
 * the file path is a shared reference, not a copy) it bounds the index at
 * ~20MB even if a very long-lived daemon never fell quiet.
 *
 * Eviction is safe in the direction that matters. Dropping a claim can only
 * let a replayed cumulative be booked a second time — the over-count this
 * whole mechanism exists to shrink, back by one prefix — and can never deny a
 * rollout its own spend, because the high-water mark is per file and a file
 * always re-claims what it reports.
 */
const MAX_TRACKED_CLAIMS = 250_000;

/**
 * How far a lineage walk will follow parent links before giving up. Never
 * reached in practice — the deepest local lineage is three hops — and the
 * cycle guard already guarantees termination; this only keeps a pathological
 * chain from making resolution quadratic.
 */
const MAX_LINEAGE_HOPS = 128;

export function createCodexAdapter(
  home: string = homedir(),
  maxTrackedClaims: number = MAX_TRACKED_CLAIMS,
): HarnessAdapter {
  // Archived first, so a retired root is seeded before the live forks that
  // replay it and owns its own cumulatives; `seedTracker` takes the roots in
  // this order. Within each root the walk is sorted, which for Codex is
  // chronological — the filename carries the creation timestamp.
  const roots = [join(home, '.codex', 'archived_sessions'), join(home, '.codex', 'sessions')];

  /**
   * thread id -> the thread it continues, or undefined for a root. Learned
   * from *every* `session_meta`, including the parent's own metas embedded in
   * a fork file, so a lineage still resolves even when the parent's rollout is
   * missing from both directories.
   */
  const parentOf = new Map<string, string | undefined>();
  /** Bumped whenever a link is added, so resolutions can be cached per file. */
  let links = 0;

  /** cumulative fingerprint -> the rollout that first reported it. */
  const claimOwner = new Map<string, string>();

  const registerLink = (id: string, parent: string | undefined): void => {
    // A thread may be seen first as somebody's parent and only later declare
    // its own; and a `null` parent is a fact (this is a root), so a later
    // sighting must not quietly downgrade a known link to nothing.
    const held = parentOf.get(id);
    if (parentOf.has(id) && (held !== undefined || parent === undefined)) return;
    parentOf.set(id, parent);
    links++;
  };

  /**
   * The conversation `threadId` belongs to: follow `forked_from_id`, else
   * `parent_thread_id`, until a thread declares no parent or names one whose
   * own link we have never seen. An unseen parent is still a real id off a
   * real transcript, so the lineage keeps it rather than inventing one.
   *
   * A malformed chain that loops always terminates, and settles on the lowest
   * id the walk visited rather than on wherever it happened to start. For a
   * pure cycle every member visits the same set and so agrees on one id. For a
   * chain that runs *into* a cycle the set also holds the tail it came from,
   * so a tail node can settle lower than the loop's own members and the
   * conversation splits in two. That is a wrong grouping, not a hang or a lost
   * rollout, and no local rollout has ever produced a loop of either shape
   * (0 of 720) — the guard exists so malformed input degrades rather than
   * wedges the fold.
   */
  const lineageRoot = (threadId: string): string => {
    const seen = new Set<string>([threadId]);
    let current = threadId;
    for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop++) {
      const parent = parentOf.get(current);
      if (parent === undefined) return current;
      if (seen.has(parent)) {
        let lowest = parent;
        for (const id of seen) if (id < lowest) lowest = id;
        return lowest;
      }
      seen.add(parent);
      current = parent;
    }
    return current;
  };

  /** Point `acc.sessionId` at the lineage root, if the links have moved on. */
  const resolve = (acc: SessionAccumulator, s: Scratch): void => {
    if (s.threadId === undefined || s.resolvedAt === links) return;
    s.resolvedAt = links;
    acc.sessionId = lineageRoot(s.threadId);
  };

  /**
   * Record that `filePath` owns this cumulative unless another rollout already
   * claimed it, and say who owns it. See the header for why one cumulative is
   * one point in one accumulator, and why ownership is by file.
   */
  const claim = (fingerprint: string, filePath: string): string => {
    const owner = claimOwner.get(fingerprint) ?? filePath;
    claimOwner.set(fingerprint, owner);
    // Re-setting an existing key does not reorder it, so the head is still the
    // oldest claim when the backstop has to bite.
    while (claimOwner.size > maxTrackedClaims) {
      const oldest = claimOwner.keys().next().value;
      if (oldest === undefined) break;
      claimOwner.delete(oldest);
    }
    return owner;
  };

  return {
    id: 'codex',
    roots: () => [...roots],
    matches: (filePath) =>
      roots.some((r) => filePath.startsWith(r + sep)) &&
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
          if (typeof id !== 'string' || id.length === 0) break;
          const fork = payload.forked_from_id;
          const parent = payload.parent_thread_id;
          // The fork link wins: 192 of the 720 local rollouts set both, and it
          // is the fork that says whose accumulator this rollout continues.
          const named = typeof fork === 'string' && fork.length > 0 ? fork : parent;
          registerLink(id, typeof named === 'string' && named.length > 0 ? named : undefined);

          const s = scratchOf(acc);
          if (s.threadId === undefined) {
            // Only the first `session_meta` is this rollout's own. Everything
            // after it is either a resume marker for the same thread or a
            // parent's meta copied in with the transcript, and neither may
            // restate the file's identity, cwd or start time.
            s.threadId = id;
            if (payload.thread_source === 'subagent') {
              acc.usageOnly = true;
              acc.displayIfOrphaned = true;
            }
            if (typeof payload.cwd === 'string') acc.cwd = payload.cwd;
            const git = payload.git as { branch?: unknown } | undefined;
            if (git && typeof git.branch === 'string') acc.branch = git.branch;
            if (typeof entry.timestamp === 'string') {
              const ms = Date.parse(entry.timestamp);
              if (!Number.isNaN(ms)) acc.startedAtMs = ms;
            }
          }
          resolve(acc, s);
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
              // A link learned from another rollout since the last line may
              // have moved this one's lineage; spend must land on the id the
              // conversation is actually reported under.
              resolve(acc, s);
              const delta = growth(s.seen, cumulative);
              // The high-water mark advances whether or not the tokens are
              // ours to book, so a replayed prefix is stepped over rather than
              // re-measured against once the rollout's own work begins.
              s.seen = highWater(s.seen, cumulative);
              if (delta.input || delta.output || delta.cacheRead || delta.cacheWrite) {
                if (claim(fingerprint(cumulative), acc.filePath) === acc.filePath) {
                  addUsage(acc, ms, acc.model, delta);
                }
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
