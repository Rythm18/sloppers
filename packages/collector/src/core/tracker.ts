import { basename } from 'node:path';
import type { SessionSnapshot } from '@sloppers/protocol';
import { deriveSessionState, EXPIRE_MS } from './state.js';
import { newCursor, readAppended } from './tailer.js';
import type { HarnessAdapter, SessionAccumulator, TailCursor } from './types.js';

interface Entry {
  adapter: HarnessAdapter;
  cursor: TailCursor;
  acc: SessionAccumulator;
  lastActivityMs: number;
}

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

  /** Project the live sessions into wire snapshots, newest first. */
  snapshot(now: number): SessionSnapshot[] {
    const out: SessionSnapshot[] = [];
    for (const [filePath, entry] of this.entries) {
      const { acc } = entry;
      if (acc.ignored || !acc.sessionId) continue;
      const quietMs = now - entry.lastActivityMs;
      if (quietMs >= EXPIRE_MS) {
        this.entries.delete(filePath);
        continue;
      }
      // File mtimes carry fractional milliseconds; the wire wants integers.
      const snapshot: SessionSnapshot = {
        id: acc.sessionId,
        harness: entry.adapter.id,
        state: deriveSessionState(acc.lastEventKind, quietMs),
        startedAt: Math.round(acc.startedAtMs ?? entry.lastActivityMs),
        lastActivityAt: Math.round(entry.lastActivityMs),
      };
      if (acc.title) snapshot.title = acc.title;
      if (acc.cwd) snapshot.project = basename(acc.cwd);
      if (acc.branch) snapshot.branch = acc.branch;
      if (acc.model) snapshot.model = acc.model;
      if (acc.tokens) snapshot.tokens = acc.tokens;
      out.push(snapshot);
    }
    out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return out.slice(0, 64);
  }
}
