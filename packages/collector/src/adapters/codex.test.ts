import { dayOf } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import type { SessionAccumulator } from '../core/types.js';
import { totalUsage } from '../core/types.js';
import { createCodexAdapter } from './codex.js';

const HOME = '/home/dev';
const adapter = createCodexAdapter(HOME);
const FILE = `${HOME}/.codex/sessions/2026/08/17/rollout-2026-08-17T10-00-00-xyz.jsonl`;

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

const meta = {
  timestamp: '2026-08-17T10:00:00.000Z',
  type: 'session_meta',
  payload: {
    id: 'xyz-1',
    cwd: '/home/dev/myapp',
    cli_version: '0.146.0',
    git: { commit_hash: 'deadbeef', branch: 'feat/rooms' },
  },
};

function tokenCount(total: object, timestamp = '2026-08-17T10:05:00.000Z') {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total } },
  };
}

describe('codex adapter', () => {
  it('matches rollout files only', () => {
    expect(adapter.matches(FILE)).toBe(true);
    expect(adapter.matches(`${HOME}/.codex/history.jsonl`)).toBe(false);
    expect(adapter.matches(`${HOME}/.codex/sessions/2026/08/17/notes.jsonl`)).toBe(false);
  });

  it('reads identity from session_meta and model from turn_context', () => {
    const acc = ingest([
      meta,
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: '/home/dev/myapp' } },
    ]);
    expect(acc.sessionId).toBe('xyz-1');
    expect(acc.cwd).toBe('/home/dev/myapp');
    expect(acc.branch).toBe('feat/rooms');
    expect(acc.model).toBe('gpt-5.6-sol');
    expect(acc.startedAtMs).toBe(Date.parse(meta.timestamp));
  });

  it('splits cached tokens out of input to match protocol semantics', () => {
    const acc = ingest([
      meta,
      tokenCount({
        input_tokens: 6_115_878,
        cached_input_tokens: 5_616_640,
        cache_write_input_tokens: 0,
        output_tokens: 4303,
        reasoning_output_tokens: 1176,
        total_tokens: 6_120_181,
      }),
    ]);
    expect(totalUsage(acc)).toEqual({
      input: 6_115_878 - 5_616_640,
      output: 4303,
      cacheRead: 5_616_640,
      cacheWrite: 0,
    });
  });

  it('uses the latest cumulative token_count, not a sum', () => {
    const acc = ingest([
      meta,
      tokenCount({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }),
      tokenCount({ input_tokens: 250, cached_input_tokens: 50, output_tokens: 30 }),
    ]);
    expect(totalUsage(acc)).toEqual({ input: 200, output: 30, cacheRead: 50, cacheWrite: 0 });
  });

  it('buckets codex cumulative totals under the current day and model', () => {
    const acc = ingest([
      meta,
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      tokenCount({ input_tokens: 250, cached_input_tokens: 50, output_tokens: 30 }),
    ]);
    const bucket = [...acc.usage.values()][0];
    expect(bucket?.model).toBe('gpt-5.6-sol');
    expect(bucket).toMatchObject({ input: 200, output: 30, cacheRead: 50 });
  });

  it('files each cumulative increment under the day it happened on', () => {
    // The bug this guards: bucketing the raw cumulative would leave day 1
    // holding 1000 and day 2 holding 1500 — 2500 booked against 1500 spent.
    const before = localIso(2026, 8, 18, 23, 50);
    const after = localIso(2026, 8, 19, 0, 10);
    const acc = ingest([
      meta,
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      tokenCount({ input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0 }, before),
      tokenCount({ input_tokens: 1500, cached_input_tokens: 0, output_tokens: 0 }, after),
    ]);
    expect(acc.usage.get(`${localDay(before)}|gpt-5.6-sol`)).toMatchObject({ input: 1000 });
    expect(acc.usage.get(`${localDay(after)}|gpt-5.6-sol`)).toMatchObject({ input: 500 });
    expect(totalUsage(acc)?.input).toBe(1500);
  });

  it('charges a mid-session model switch to the model that spent the tokens', () => {
    const acc = ingest([
      meta,
      { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      tokenCount({ input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0 }),
      { type: 'turn_context', payload: { model: 'gpt-5.6-mini' } },
      tokenCount({ input_tokens: 1500, cached_input_tokens: 0, output_tokens: 0 }),
    ]);
    const byModel = Object.fromEntries([...acc.usage.values()].map((b) => [b.model, b.input]));
    expect(byModel).toEqual({ 'gpt-5.6-sol': 1000, 'gpt-5.6-mini': 500 });
  });

  it('a cumulative that goes backwards never un-books or negates a bucket', () => {
    const day1 = localIso(2026, 8, 18, 23, 50);
    const day2 = localIso(2026, 8, 19, 0, 10);
    const acc = adapter.newAccumulator(FILE);
    const feed = (line: object) => adapter.ingestLine(JSON.stringify(line), acc);
    feed(meta);
    feed({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } });
    feed(tokenCount({ input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0 }, day1));

    // A truncated file is replayed from the top by the tailer, so a cumulative
    // can come back lower than one already booked — and land on a different
    // day than the spend it is re-covering. A plain difference would push that
    // day's bucket to -600 and claw back spend already counted.
    feed(tokenCount({ input_tokens: 400, cached_input_tokens: 0, output_tokens: 0 }, day2));
    for (const bucket of acc.usage.values()) expect(bucket.input).toBeGreaterThanOrEqual(0);
    expect(totalUsage(acc)?.input).toBe(1000);

    // Growth past the previous peak is new spend, and only the excess counts.
    feed(tokenCount({ input_tokens: 1200, cached_input_tokens: 0, output_tokens: 0 }, day2));
    expect(totalUsage(acc)?.input).toBe(1200);
    expect(acc.usage.get(`${localDay(day2)}|gpt-5.6-sol`)?.input).toBe(200);
  });

  it('books usage seen before any turn_context rather than dropping it', () => {
    const acc = ingest([meta, tokenCount({ input_tokens: 90, output_tokens: 10 })]);
    expect(totalUsage(acc)).toMatchObject({ input: 90, output: 10 });
  });

  it('records the minute of each token_count', () => {
    const acc = ingest([
      meta,
      tokenCount({ input_tokens: 1 }, '2026-08-17T10:05:00.000Z'),
      tokenCount({ input_tokens: 2 }, '2026-08-17T10:05:30.000Z'),
      tokenCount({ input_tokens: 3 }, '2026-08-17T10:07:00.000Z'),
    ]);
    const minutes = [...acc.activeMinutes.values()][0];
    expect(minutes?.size).toBe(2);
  });

  it('classifies turn boundaries', () => {
    const working = ingest([
      meta,
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'function_call' } },
    ]);
    expect(working.lastEventKind).toBe('other');

    const done = ingest([
      meta,
      { type: 'event_msg', payload: { type: 'agent_message' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ]);
    expect(done.lastEventKind).toBe('agent-final');

    const doneThenCounted = ingest([
      meta,
      { type: 'event_msg', payload: { type: 'task_complete' } },
      tokenCount({ input_tokens: 1 }),
    ]);
    expect(doneThenCounted.lastEventKind).toBe('agent-final');

    const blocked = ingest([
      meta,
      { type: 'event_msg', payload: { type: 'exec_approval_request' } },
    ]);
    expect(blocked.lastEventKind).toBe('agent-tool');

    const aborted = ingest([meta, { type: 'event_msg', payload: { type: 'turn_aborted' } }]);
    expect(aborted.lastEventKind).toBe('agent-final');
  });

  it('mid-task agent narration does not end the turn', () => {
    const acc = ingest([
      meta,
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'event_msg', payload: { type: 'agent_message' } },
    ]);
    expect(acc.lastEventKind).toBe('other');
  });

  it('survives malformed lines and null info', () => {
    const acc = adapter.newAccumulator(FILE);
    adapter.ingestLine('garbage', acc);
    adapter.ingestLine(
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
      acc,
    );
    expect(acc.usage.size).toBe(0);
  });
});
