import { basename } from 'node:path';
import type { MinuteReport, SessionSnapshot, TokenTotals, UsageBucket } from '@sloppers/protocol';
import { emptyTokens, encodeMinutes } from '@sloppers/protocol';
import { deriveSessionState, EXPIRE_MS } from './state.js';
import { newCursor, readAppended } from './tailer.js';
import type { HarnessAdapter, RoutableSession, SessionAccumulator, TailCursor } from './types.js';

interface Entry {
  adapter: HarnessAdapter;
  cursor: TailCursor;
  acc: SessionAccumulator;
  lastActivityMs: number;
}

/**
 * One displayed session and every file whose spend belongs to it. A subagent
 * ("sidechain") transcript is a separate file carrying the *parent's*
 * sessionId, so the session a person sees in the room is a group, not a file.
 */
interface Group {
  /**
   * Whose fields the snapshot shows. Absent for a group that is held but never
   * displayed: an orphaned sidechain, an `ignored` file, or one that has not
   * declared a sessionId yet.
   */
  display: Entry | undefined;
  /** Map keys of every file in the group, so expiry can reap them together. */
  paths: string[];
  /** Every accumulator whose spend counts toward the session. */
  accs: SessionAccumulator[];
  /** Newest activity across the whole group; drives state and expiry. */
  lastActivityMs: number;
}

/** Wire cap on `usage`; see `sessionSnapshotSchema` in the protocol. */
const MAX_USAGE_BUCKETS = 30;
/** Wire cap on `activeMinutes`; same. */
const MAX_ACTIVE_DAYS = 7;

/**
 * Owns every session file the collector knows about. The watcher feeds it
 * file events; it feeds adapters the appended lines and projects the live
 * set into wire snapshots. Pure with respect to time — callers pass `now` —
 * so the whole lifecycle is testable without clocks.
 */
export class SessionTracker {
  private entries = new Map<string, Entry>();

  constructor(private adapters: HarnessAdapter[]) {}

  adapterFor(filePath: string): HarnessAdapter | undefined {
    return this.adapters.find((a) => a.matches(filePath));
  }

  /**
   * Read whatever was appended to `filePath` and fold it in. Returns true if
   * new lines were consumed (i.e. the world may have changed).
   */
  ingestFile(filePath: string, mtimeMs: number): boolean {
    let entry = this.entries.get(filePath);
    if (!entry) {
      const adapter = this.adapterFor(filePath);
      if (!adapter) return false;
      entry = {
        adapter,
        cursor: newCursor(),
        acc: adapter.newAccumulator(filePath),
        lastActivityMs: mtimeMs,
      };
      this.entries.set(filePath, entry);
    }
    if (entry.acc.ignored) return false;

    let lines: string[];
    try {
      ({ lines, cursor: entry.cursor } = readAppended(filePath, entry.cursor));
    } catch {
      // File vanished or became unreadable; forget it.
      this.entries.delete(filePath);
      return false;
    }
    for (const line of lines) {
      entry.adapter.ingestLine(line, entry.acc);
    }
    if (lines.length > 0) {
      entry.lastActivityMs = Math.max(entry.lastActivityMs, mtimeMs);
    }
    return lines.length > 0;
  }

  removeFile(filePath: string): void {
    this.entries.delete(filePath);
  }

  /** Paths currently tracked; the watcher's polling fallback re-stats these. */
  trackedFiles(): string[] {
    return [...this.entries.keys()];
  }

  /** Project the live sessions into wire snapshots, newest first. */
  snapshot(now: number): SessionSnapshot[] {
    return this.routableSnapshot(now).map((s) => s.snapshot);
  }

  /**
   * The same projection, each snapshot paired with the accumulator's `cwd`.
   *
   * The cwd is read here, *before* projection, because it is exactly what the
   * projection throws away: the wire carries `project`, the basename, and
   * never the path. Routing a session to a workspace needs the whole path, so
   * the daemon takes this view and hands only the `snapshot` half onward.
   */
  routableSnapshot(now: number): RoutableSession[] {
    const out: RoutableSession[] = [];
    for (const group of this.groups()) {
      // Expiry is group-wide and checked before the display filters. Group-wide
      // because a parent transcript is not appended to while a subagent runs —
      // the tool result lands only when the subagent finishes — so per-file
      // expiry reaps the parent out from under live work: 28 of 554 local
      // sidechains wrote while their parent had been quiet longer than
      // EXPIRE_MS, the worst by 155 minutes. Before the filters because entries
      // that are never displayed still have to be reaped: sidechain
      // accumulators keep growing buckets and minute sets for as long as they
      // are held, and they outnumber displayable sessions better than ten to
      // one.
      const quietMs = now - group.lastActivityMs;
      if (quietMs >= EXPIRE_MS) {
        for (const path of group.paths) this.entries.delete(path);
        continue;
      }
      const display = group.display;
      if (!display) continue;
      const { acc } = display;
      const { sessionId } = acc;
      if (!sessionId) continue;

      // File mtimes carry fractional milliseconds; the wire wants integers.
      const snapshot: SessionSnapshot = {
        id: wireIdFor(sessionId, acc.filePath),
        harness: display.adapter.id,
        // Both derived from the group's newest activity, so a session whose
        // subagent is mid-task reads `working` rather than decaying to
        // `waiting`/`idle` while the parent file sits untouched.
        state: deriveSessionState(acc.lastEventKind, quietMs),
        startedAt: Math.round(acc.startedAtMs ?? display.lastActivityMs),
        lastActivityAt: Math.round(group.lastActivityMs),
      };
      if (acc.title) snapshot.title = acc.title;
      if (acc.cwd) snapshot.project = basename(acc.cwd);
      if (acc.branch) snapshot.branch = acc.branch;
      if (acc.model) snapshot.model = acc.model;
      const { total, buckets } = mergeUsage(group.accs);
      // `tokens` is summed over every bucket *before* the wire cap, because it
      // is the field the server's ledger actually banks. Capping `usage` is a
      // schema limit on an array, not a decision to forget spend.
      if (total) snapshot.tokens = total;
      if (buckets.length > 0) snapshot.usage = buckets;
      const minutes = mergeMinutes(group.accs);
      if (minutes.length > 0) snapshot.activeMinutes = minutes;
      out.push({ snapshot, cwd: acc.cwd });
    }
    out.sort((a, b) => b.snapshot.lastActivityAt - a.snapshot.lastActivityAt);
    return out.slice(0, 64);
  }

  /**
   * Fold the tracked files into the sessions a person would recognise.
   *
   * Only `usageOnly` entries merge into a parent. Two non-`usageOnly` entries
   * never merge, whatever their session ids — grouping on the id alone is safe
   * for Claude Code but wrong for Codex, which reassigns `sessionId` on every
   * `session_meta` and never sets `usageOnly`: 7 ids span more than one of the
   * 494 local rollout files, one of them 29 files, and merging on the id would
   * hide 92 real rollouts behind other people's sessions.
   */
  private groups(): Group[] {
    // Which entry a sidechain folds into, per session id. Ties break on the
    // lowest file path rather than Map insertion order: insertion order is
    // whatever `seedTracker`'s unsorted directory walk produced, which varies
    // by filesystem and shifts as files come and go, while the path ordering
    // is total and identical on every run.
    const parents = new Map<string, Entry>();
    for (const entry of this.entries.values()) {
      const { acc } = entry;
      if (acc.usageOnly || acc.ignored || !acc.sessionId) continue;
      const held = parents.get(acc.sessionId);
      if (!held || acc.filePath < held.acc.filePath) parents.set(acc.sessionId, entry);
    }

    // Keyed by the display entry's path, so a sidechain reaching this loop
    // before its parent still lands in the same group the parent will.
    const groups = new Map<string, Group>();
    for (const [filePath, entry] of this.entries) {
      const { acc } = entry;
      const displays = !acc.ignored && !acc.usageOnly && acc.sessionId !== undefined;
      // An orphaned sidechain — parent not tracked yet, expired, or deleted —
      // gets a private, undisplayed group rather than being thrown away, so a
      // parent that turns up in a later ingest absorbs its spend instead of it
      // being discarded at first sight.
      const display = displays
        ? entry
        : acc.ignored || !acc.sessionId
          ? undefined
          : parents.get(acc.sessionId);
      const key = display ? display.acc.filePath : filePath;
      let group = groups.get(key);
      if (!group) {
        group = { display, paths: [], accs: [], lastActivityMs: entry.lastActivityMs };
        groups.set(key, group);
      }
      group.paths.push(filePath);
      // An `ignored` file is not a reportable session, so its spend counts
      // toward nothing; it is still held here so expiry can reap it.
      if (!acc.ignored) group.accs.push(acc);
      group.lastActivityMs = Math.max(group.lastActivityMs, entry.lastActivityMs);
    }
    return [...groups.values()];
  }
}

/** Longest id the wire accepts; see `sessionSnapshotSchema`. */
const MAX_ID_LENGTH = 128;
/** Separator between a contested session id and its disambiguating suffix. */
const ID_SUFFIX_SEP = '#';

/**
 * The id a session reports on the wire: `` `${sessionId}#${fingerprint(path)}` ``.
 *
 * Two rollouts really can share a session id — Codex reassigns `sessionId` on
 * every `session_meta`, and 7 ids span more than one of the 494 local rollout
 * files — and since they no longer merge, a batch could otherwise carry the same
 * id twice. `TokenLedger.ingest` keys its watermark on that id alone, so a
 * duplicate is not cosmetic: the second snapshot restates the first's watermark
 * downward through the ledger's `shrank` branch, and the difference is re-banked
 * on the next cycle, and the next, without bound.
 *
 * Deliberately a pure function of this session's own `sessionId` and file path,
 * with no reference to what else is live and no memory between calls. The
 * tempting cheaper rule — suffix only ids that collide *in this batch* — makes
 * identity a property of the moment rather than of the session: when one of a
 * colliding pair expires, the survivor stops looking contested and silently
 * reverts to the bare id, landing on the watermark row its former neighbour
 * still owns. That loses tokens through the same `shrank` branch, and reopens
 * the inflation path if the neighbour resumes. Memory across calls would not
 * save it either, since it dies on the restart it is needed for.
 *
 * The cost is that every id changes once at upgrade. That is bounded and
 * one-off: the ledger seeds a session first seen today but started earlier at
 * its current totals, so only a session started *today* at the moment of upgrade
 * re-banks, and only its own total, once. Zero sessions on the local corpus were
 * in that state. Suffixing only Codex — the sole measured source of collisions —
 * would have saved 38 claude-code ids, but it puts a correctness decision behind
 * a hardcoded harness name in an open set, so a community adapter that reused
 * ids like Codex would silently regress.
 */
function wireIdFor(sessionId: string, filePath: string): string {
  const suffix = ID_SUFFIX_SEP + fingerprint(filePath);
  // The harness's own id stays readable as the prefix, so a wire id can still
  // be traced back to the transcript it came from.
  return sessionId.slice(0, MAX_ID_LENGTH - suffix.length) + suffix;
}

/**
 * A stable 64-bit fingerprint of a file path, as 16 hex characters: FNV-1a run
 * twice with the roles of offset and prime swapped. Two live sessions colliding
 * here would reintroduce the duplicate-id bug, so the width is deliberate
 * rather than incidental — at the wire's cap of 64 sessions the odds are about
 * one in 10^17.
 */
function fingerprint(filePath: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < filePath.length; i++) {
    const code = filePath.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x811c9dc5);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/**
 * Every accumulator's buckets summed by (day, model), as both the flat total
 * the ledger banks and the capped array the wire carries. Buckets are copied,
 * never aliased: folding a sidechain into the parent's own map would compound
 * it again on every projection.
 */
function mergeUsage(accs: SessionAccumulator[]): {
  total: TokenTotals | undefined;
  buckets: UsageBucket[];
} {
  const merged = new Map<string, UsageBucket>();
  for (const acc of accs) {
    for (const [key, bucket] of acc.usage) {
      const into = merged.get(key);
      if (!into) {
        merged.set(key, { ...bucket });
        continue;
      }
      into.input += bucket.input;
      into.output += bucket.output;
      into.cacheRead += bucket.cacheRead;
      into.cacheWrite += bucket.cacheWrite;
    }
  }
  if (merged.size === 0) return { total: undefined, buckets: [] };
  const total = emptyTokens();
  for (const bucket of merged.values()) {
    total.input += bucket.input;
    total.output += bucket.output;
    total.cacheRead += bucket.cacheRead;
    total.cacheWrite += bucket.cacheWrite;
  }
  // Newest day first so the cap drops the oldest; model breaks ties so the
  // same corpus always yields the same array whatever order the maps were
  // built in.
  const buckets = [...merged.values()].sort(
    (a, b) => b.day.localeCompare(a.day) || a.model.localeCompare(b.model),
  );
  return { total, buckets: buckets.slice(0, MAX_USAGE_BUCKETS) };
}

/** Every accumulator's active minutes unioned per day, newest days first. */
function mergeMinutes(accs: SessionAccumulator[]): MinuteReport[] {
  const merged = new Map<string, Set<number>>();
  for (const acc of accs) {
    for (const [day, minutes] of acc.activeMinutes) {
      let into = merged.get(day);
      if (!into) {
        into = new Set();
        merged.set(day, into);
      }
      for (const minute of minutes) into.add(minute);
    }
  }
  return [...merged.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, MAX_ACTIVE_DAYS)
    .map(([day, minutes]) => ({ day, minutes: encodeMinutes(minutes) }));
}
