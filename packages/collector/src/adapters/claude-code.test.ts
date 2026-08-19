import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayOf } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import { EXPIRE_MS } from '../core/state.js';
import { SessionTracker } from '../core/tracker.js';
import type { SessionAccumulator } from '../core/types.js';
import { totalUsage } from '../core/types.js';
import { createClaudeCodeAdapter } from './claude-code.js';

const HOME = '/home/dev';
const adapter = createClaudeCodeAdapter(HOME);
const FILE = `${HOME}/.claude/projects/-home-dev-myapp/abc-123.jsonl`;

function ingest(lines: object[]): SessionAccumulator {
  const acc = adapter.newAccumulator(FILE);
  for (const line of lines) adapter.ingestLine(JSON.stringify(line), acc);
  return acc;
}

const localDay = (iso: string) => dayOf(Date.parse(iso));

/**
 * An ISO timestamp for a given *local* wall-clock moment. Bucketing is by
 * local day, so day-boundary tests have to name local times or they only
 * exercise the boundary in whichever timezone the test runner happens to use.
 */
function localIso(y: number, month: number, d: number, h: number, min: number): string {
  return new Date(y, month - 1, d, h, min).toISOString();
}

const base = {
  sessionId: 'abc-123',
  cwd: '/home/dev/myapp',
  gitBranch: 'main',
  isSidechain: false,
  timestamp: '2026-08-17T10:00:00.000Z',
};

function assistant(overrides: {
  requestId: string;
  usage?: object;
  content?: unknown;
  model?: string;
}) {
  return {
    ...base,
    type: 'assistant',
    requestId: overrides.requestId,
    message: {
      model: overrides.model ?? 'claude-fable-5',
      content: overrides.content ?? [{ type: 'text', text: 'hi' }],
      usage: overrides.usage ?? {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
      },
    },
  };
}

describe('claude-code adapter', () => {
  it('matches session files and ignores the memory directory', () => {
    expect(adapter.matches(FILE)).toBe(true);
    expect(adapter.matches(`${HOME}/.claude/projects/-x/memory/notes.jsonl`)).toBe(false);
    expect(adapter.matches(`${HOME}/.claude/history.jsonl`)).toBe(false);
  });

  it('extracts identity, branch, model, and start time', () => {
    const acc = ingest([{ ...base, type: 'user', message: { role: 'user' } }]);
    expect(acc.sessionId).toBe('abc-123');
    expect(acc.cwd).toBe('/home/dev/myapp');
    expect(acc.branch).toBe('main');
    expect(acc.startedAtMs).toBe(Date.parse(base.timestamp));
  });

  it('marks a sidechain file usage-only rather than discarding it', () => {
    const acc = ingest([
      {
        ...assistant({ requestId: 'r-sub', usage: { input_tokens: 42, output_tokens: 8 } }),
        isSidechain: true,
      },
    ]);
    expect(acc.usageOnly).toBe(true);
    expect(acc.ignored).toBe(false);
    expect([...acc.usage.values()][0]?.input).toBe(42);
  });

  it('buckets usage by the day and model of each message', () => {
    const day1 = localIso(2026, 8, 18, 23, 50);
    const day2 = localIso(2026, 8, 19, 0, 10);
    const acc = ingest([
      {
        ...base,
        timestamp: day1,
        type: 'assistant',
        requestId: 'r1',
        message: {
          model: 'claude-opus-5',
          content: [],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      },
      {
        ...base,
        timestamp: day2,
        type: 'assistant',
        requestId: 'r2',
        message: {
          model: 'claude-fable-5',
          content: [],
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
    ]);
    const buckets = [...acc.usage.values()];
    expect(buckets).toHaveLength(2);
    const opus = buckets.find((b) => b.model === 'claude-opus-5');
    expect(opus?.input).toBe(100);
    expect(opus?.day).toBe(localDay(day1));
    expect(buckets.find((b) => b.model === 'claude-fable-5')?.day).toBe(localDay(day2));
  });

  it('splits one model across days when a session runs through midnight', () => {
    const before = localIso(2026, 8, 18, 23, 50);
    const after = localIso(2026, 8, 19, 0, 10);
    const usage = { input_tokens: 100, output_tokens: 10 };
    const acc = ingest([
      {
        ...base,
        timestamp: before,
        type: 'assistant',
        requestId: 'r1',
        message: { model: 'm', content: [], usage },
      },
      {
        ...base,
        timestamp: after,
        type: 'assistant',
        requestId: 'r2',
        message: { model: 'm', content: [], usage },
      },
    ]);
    expect([...acc.usage.values()].map((b) => b.day).sort()).toEqual([
      localDay(before),
      localDay(after),
    ]);
    expect(totalUsage(acc)).toMatchObject({ input: 200, output: 20 });
  });

  it('records the minute of each assistant message', () => {
    const acc = ingest([
      {
        ...base,
        timestamp: '2026-08-19T05:30:00.000Z',
        type: 'assistant',
        requestId: 'r1',
        message: {
          model: 'claude-opus-5',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]);
    const minutes = [...acc.activeMinutes.values()][0];
    expect(minutes?.size).toBe(1);
  });

  it('unwinds a re-reported request from the bucket it first landed in', () => {
    // r1 is first reported on day 1 under `old`, then re-reported on day 2
    // under `new`. Subtracting from the *new* key would leave day 1 holding
    // r1's tokens forever and drive day 2 negative; r2 pins day 1 so the test
    // can tell "unwound correctly" from "bucket dropped wholesale".
    const day1 = localIso(2026, 8, 18, 10, 0);
    const day2 = localIso(2026, 8, 19, 10, 0);
    const acc = ingest([
      {
        ...base,
        timestamp: day1,
        type: 'assistant',
        requestId: 'r1',
        message: { model: 'old', content: [], usage: { input_tokens: 100, output_tokens: 10 } },
      },
      {
        ...base,
        timestamp: day1,
        type: 'assistant',
        requestId: 'r2',
        message: { model: 'old', content: [], usage: { input_tokens: 7, output_tokens: 3 } },
      },
      {
        ...base,
        timestamp: day2,
        type: 'assistant',
        requestId: 'r1',
        message: { model: 'new', content: [], usage: { input_tokens: 500, output_tokens: 50 } },
      },
    ]);
    const first = acc.usage.get(`${localDay(day1)}|old`);
    const second = acc.usage.get(`${localDay(day2)}|new`);
    expect(first).toMatchObject({ input: 7, output: 3 });
    expect(second).toMatchObject({ input: 500, output: 50 });
    expect(totalUsage(acc)).toMatchObject({ input: 507, output: 53 });
  });

  it('prefers a custom title over the generated one', () => {
    const acc = ingest([
      { type: 'ai-title', aiTitle: 'Fixing the build', sessionId: 'abc-123' },
      { type: 'custom-title', customTitle: 'My spike', sessionId: 'abc-123' },
      { type: 'ai-title', aiTitle: 'Regenerated later', sessionId: 'abc-123' },
    ]);
    expect(acc.title).toBe('My spike');
  });

  it('deduplicates usage shared by multi-block assistant entries', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
    };
    const acc = ingest([
      assistant({ requestId: 'r1', usage, content: [{ type: 'text', text: 'a' }] }),
      assistant({ requestId: 'r1', usage, content: [{ type: 'tool_use', name: 'Bash' }] }),
      assistant({ requestId: 'r2', usage }),
    ]);
    expect(totalUsage(acc)).toEqual({ input: 20, output: 40, cacheRead: 200, cacheWrite: 10 });
  });

  it('takes the latest usage when a request is re-reported', () => {
    const acc = ingest([
      assistant({ requestId: 'r1', usage: { input_tokens: 1, output_tokens: 1 } }),
      assistant({ requestId: 'r1', usage: { input_tokens: 3, output_tokens: 9 } }),
    ]);
    expect(totalUsage(acc)).toEqual({ input: 3, output: 9, cacheRead: 0, cacheWrite: 0 });
  });

  it('skips synthetic assistant entries', () => {
    const acc = ingest([
      assistant({ requestId: 'r1', model: '<synthetic>', usage: { input_tokens: 999 } }),
    ]);
    expect(acc.model).toBeUndefined();
    expect(acc.usage.size).toBe(0);
  });

  it('classifies who acts next from the last entry', () => {
    const finished = ingest([assistant({ requestId: 'r1' })]);
    expect(finished.lastEventKind).toBe('agent-final');

    const toolRunning = ingest([
      assistant({ requestId: 'r1', content: [{ type: 'tool_use', name: 'Bash' }] }),
    ]);
    expect(toolRunning.lastEventKind).toBe('agent-tool');

    const userTurn = ingest([assistant({ requestId: 'r1' }), { ...base, type: 'user' }]);
    expect(userTurn.lastEventKind).toBe('other');

    const bookkeepingAfter = ingest([
      assistant({ requestId: 'r1' }),
      { type: 'last-prompt', leafUuid: 'x', sessionId: 'abc-123' },
    ]);
    expect(bookkeepingAfter.lastEventKind).toBe('agent-final');
  });

  it('turn-end system and attachment entries do not mask a finished turn', () => {
    const acc = ingest([
      assistant({ requestId: 'r-sys' }),
      { ...base, type: 'system', subtype: 'turn_duration', content: '12s' },
      { ...base, type: 'attachment', attachment: {} },
    ]);
    expect(acc.lastEventKind).toBe('agent-final');
  });

  it('a resumed transcript does not re-count copied usage (cross-file dedup)', () => {
    const fresh = createClaudeCodeAdapter(HOME);
    const original = `${HOME}/.claude/projects/-home-dev-myapp/original.jsonl`;
    const resumed = `${HOME}/.claude/projects/-home-dev-myapp/resumed.jsonl`;
    const usage = { input_tokens: 100, output_tokens: 50 };

    const accA = fresh.newAccumulator(original);
    fresh.ingestLine(JSON.stringify(assistant({ requestId: 'shared-1', usage })), accA);
    expect(totalUsage(accA)).toMatchObject({ input: 100, output: 50 });

    // Resume copies history (same requestIds) into a new file, then adds new work.
    const accB = fresh.newAccumulator(resumed);
    fresh.ingestLine(JSON.stringify(assistant({ requestId: 'shared-1', usage })), accB);
    fresh.ingestLine(
      JSON.stringify(
        assistant({ requestId: 'new-2', usage: { input_tokens: 7, output_tokens: 3 } }),
      ),
      accB,
    );
    expect(totalUsage(accB)).toMatchObject({ input: 7, output: 3 });
    // The original file's totals are untouched.
    expect(totalUsage(accA)).toMatchObject({ input: 100, output: 50 });
  });

  it('a same-day resume is not re-counted after the original transcript expires', () => {
    // The server cannot catch this one. Its only resume guard seeds a new
    // session's watermark at current totals when `startedAt < startOfToday`,
    // and a same-day resume inherits a `startedAt` of *today*; the copy also
    // carries a distinct sessionId, so no watermark row matches and
    // `daily_usage` just adds the replayed totals a second time. The claim has
    // to outlive the file for the rest of the day, which is exactly as long as
    // the server stays blind.
    const home = mkdtempSync(join(tmpdir(), 'sloppers-claude-'));
    try {
      const dir = join(home, '.claude', 'projects', '-home-dev-myapp');
      mkdirSync(dir, { recursive: true });
      const tracker = new SessionTracker([createClaudeCodeAdapter(home)]);
      const at = localIso(2026, 8, 19, 9, 0);
      const transcript = (sessionId: string) =>
        `${JSON.stringify({
          ...base,
          sessionId,
          timestamp: at,
          type: 'assistant',
          requestId: 'req-1',
          message: {
            model: 'claude-opus-5',
            content: [],
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        })}\n`;

      const original = join(dir, 'original.jsonl');
      writeFileSync(original, transcript('sess-a'));
      tracker.ingestFile(original, 1000);
      expect(tracker.snapshot(2000)[0]?.tokens).toMatchObject({ input: 100, output: 50 });

      // The original goes quiet and the tracker drops it entirely.
      expect(tracker.snapshot(1000 + EXPIRE_MS)).toEqual([]);

      // Same day, the user resumes it: a new file, a new sessionId, the same
      // requestId replayed verbatim. Those tokens were already reported.
      const resumed = join(dir, 'resumed.jsonl');
      writeFileSync(resumed, transcript('sess-b'));
      tracker.ingestFile(resumed, 1000 + EXPIRE_MS);
      expect(tracker.snapshot(2000 + EXPIRE_MS)[0]?.tokens).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('retires claims older than the retention window, keeping recent ones', () => {
    // Safe precisely because the server takes over at the day boundary: a
    // resume replaying yesterday's requests inherits yesterday's `startedAt`,
    // so `startedAt < startOfToday` seeds its watermark at current totals and
    // the replay adds nothing. Holding the claim past that point would only
    // cost memory. 25h apart, so the older claim is unambiguously outside the
    // 24h window rather than sitting exactly on its edge.
    const fresh = createClaudeCodeAdapter(HOME);
    const yesterday = localIso(2026, 8, 18, 9, 0);
    const today = localIso(2026, 8, 19, 10, 0);
    const entry = (requestId: string, timestamp: string) =>
      JSON.stringify({
        ...base,
        timestamp,
        type: 'assistant',
        requestId,
        message: {
          model: 'claude-opus-5',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });

    const accA = fresh.newAccumulator(`${HOME}/.claude/projects/-p/a.jsonl`);
    fresh.ingestLine(entry('old-1', yesterday), accA);
    // Any work today retires yesterday's claims.
    fresh.ingestLine(entry('new-1', today), accA);

    const accB = fresh.newAccumulator(`${HOME}/.claude/projects/-p/b.jsonl`);
    fresh.ingestLine(entry('old-1', yesterday), accB);
    expect(totalUsage(accB)).toMatchObject({ input: 100, output: 50 });
    // Today's claim is still held, so a copy of it is still deduplicated.
    fresh.ingestLine(entry('new-1', today), accB);
    expect(totalUsage(accB)).toMatchObject({ input: 100, output: 50 });
  });

  it('a newer transcript landing between resume halves does not retire the claim', () => {
    // `seedTracker` folds every recently-touched transcript in directory
    // order, so lines do not reach the adapter in global date order and a file
    // carrying a later day can land between the two halves of a same-day
    // resume pair. Retiring claims wholesale on day rollover would drop the
    // claim exactly here; a window anchored to the newest timestamp does not.
    const fresh = createClaudeCodeAdapter(HOME);
    const at = localIso(2026, 8, 19, 9, 0);
    const nextDay = localIso(2026, 8, 20, 8, 0);
    const entry = (requestId: string, timestamp: string) =>
      JSON.stringify({
        ...base,
        timestamp,
        type: 'assistant',
        requestId,
        message: {
          model: 'claude-opus-5',
          content: [],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });

    const accA = fresh.newAccumulator(`${HOME}/.claude/projects/-p/a.jsonl`);
    fresh.ingestLine(entry('req-1', at), accA);

    // An unrelated transcript, walked next, whose entries are on the next day.
    const accC = fresh.newAccumulator(`${HOME}/.claude/projects/-p/c.jsonl`);
    fresh.ingestLine(entry('req-9', nextDay), accC);

    const accB = fresh.newAccumulator(`${HOME}/.claude/projects/-p/b.jsonl`);
    fresh.ingestLine(entry('req-1', at), accB);
    expect(totalUsage(accB)).toBeUndefined();
  });

  it('bounds the resume-dedup index, evicting the oldest claim first', () => {
    // The index holds one entry per distinct requestId for the life of the
    // process, and sidechains now feed it too. Cap of 3 here; 100k in
    // production, which is ~3 months of uninterrupted uptime away.
    const capped = createClaudeCodeAdapter(HOME, 3);
    const usage = { input_tokens: 10, output_tokens: 1 };
    const first = `${HOME}/.claude/projects/-home-dev-myapp/first.jsonl`;
    const accA = capped.newAccumulator(first);
    for (const requestId of ['a', 'b', 'c', 'd']) {
      capped.ingestLine(JSON.stringify(assistant({ requestId, usage })), accA);
    }
    expect(totalUsage(accA)).toMatchObject({ input: 40, output: 4 });

    const accB = capped.newAccumulator(`${HOME}/.claude/projects/-home-dev-myapp/second.jsonl`);
    // 'd' is one of the 3 most recent claims, so the first file still owns it
    // and a resumed copy does not double-count it.
    capped.ingestLine(JSON.stringify(assistant({ requestId: 'd', usage })), accB);
    expect(totalUsage(accB)).toBeUndefined();
    // 'a' was evicted as the oldest, so it can be claimed again. That is the
    // deliberate cost of the bound, paid only by ids far older than the 30
    // minutes it takes the tracker to forget the file that claimed them.
    capped.ingestLine(JSON.stringify(assistant({ requestId: 'a', usage })), accB);
    expect(totalUsage(accB)).toMatchObject({ input: 10, output: 1 });
  });

  it('survives malformed lines', () => {
    const acc = adapter.newAccumulator(FILE);
    adapter.ingestLine('{"broken', acc);
    adapter.ingestLine('not json at all', acc);
    expect(acc.ignored).toBe(false);
  });
});
