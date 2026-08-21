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

/**
 * Lineage: Codex writes every subagent thread and every fork as its own rollout
 * file. See the header of codex.ts for what the local corpus says about them.
 */
describe('codex lineage', () => {
  const path = (name: string) => `${HOME}/.codex/sessions/2026/08/17/rollout-${name}.jsonl`;

  /** A `session_meta` line. `id` is the rollout's own thread id. */
  function metaFor(
    id: string,
    extra: {
      parent_thread_id?: string;
      forked_from_id?: string;
      thread_source?: string;
      cwd?: string;
    } = {},
    timestamp = '2026-08-17T10:00:00.000Z',
  ) {
    return {
      timestamp,
      type: 'session_meta',
      payload: { id, session_id: extra.parent_thread_id ?? id, cwd: '/home/dev/myapp', ...extra },
    };
  }

  const usage = (input: number, output = 0) => ({
    input_tokens: input,
    cached_input_tokens: 0,
    output_tokens: output,
  });

  /** Fold `lines` into a fresh accumulator for `file` on a shared adapter. */
  function fold(a: ReturnType<typeof createCodexAdapter>, file: string, lines: object[]) {
    const acc = a.newAccumulator(file);
    for (const line of lines) a.ingestLine(JSON.stringify(line), acc);
    return acc;
  }

  it('reports a subagent under its lineage root, not its own thread id', () => {
    const a = createCodexAdapter(HOME);
    const sub = fold(a, path('sub'), [
      metaFor('child', { parent_thread_id: 'root', thread_source: 'subagent' }),
      tokenCount(usage(500)),
    ]);
    expect(sub.sessionId).toBe('root');
    // Its spend is real and disjoint from the parent's, so it still counts.
    expect(totalUsage(sub)).toMatchObject({ input: 500 });
  });

  it('marks a subagent rollout usage-only so it never shows as its own session', () => {
    const a = createCodexAdapter(HOME);
    const sub = fold(a, path('sub'), [
      metaFor('child', { parent_thread_id: 'root', thread_source: 'subagent' }),
    ]);
    expect(sub.usageOnly).toBe(true);

    const user = fold(a, path('user'), [metaFor('root', { thread_source: 'user' })]);
    expect(user.usageOnly).toBe(false);
    expect(user.sessionId).toBe('root');
  });

  it('prefers forked_from_id over parent_thread_id when both are set', () => {
    // 192 of the 720 local rollouts carry both; the fork link is the one that
    // says whose accumulator this rollout continues.
    const a = createCodexAdapter(HOME);
    const acc = fold(a, path('fork'), [
      metaFor('child', {
        parent_thread_id: 'other',
        forked_from_id: 'origin',
        thread_source: 'subagent',
      }),
    ]);
    expect(acc.sessionId).toBe('origin');
  });

  it('follows a chain to the root, not just one hop', () => {
    const a = createCodexAdapter(HOME);
    fold(a, path('mid'), [metaFor('mid', { parent_thread_id: 'root', thread_source: 'subagent' })]);
    const leaf = fold(a, path('leaf'), [
      metaFor('leaf', { parent_thread_id: 'mid', thread_source: 'subagent' }),
    ]);
    expect(leaf.sessionId).toBe('root');
  });

  it('re-resolves a lineage when the missing middle link turns up later', () => {
    // Directory order is not lineage order, so a leaf routinely lands before
    // the rollout that connects it to its root.
    const a = createCodexAdapter(HOME);
    const leaf = fold(a, path('leaf'), [
      metaFor('leaf', { parent_thread_id: 'mid', thread_source: 'subagent' }),
      tokenCount(usage(10)),
    ]);
    expect(leaf.sessionId).toBe('mid');

    fold(a, path('mid'), [metaFor('mid', { parent_thread_id: 'root', thread_source: 'subagent' })]);
    // The next line the leaf receives re-resolves it onto the real root.
    a.ingestLine(JSON.stringify(tokenCount(usage(20))), leaf);
    expect(leaf.sessionId).toBe('root');
  });

  it('keeps a lineage whose root rollout is absent under the root id it names', () => {
    // The parent may have rolled out of the seed window or been archived. The
    // id is real — it came off the child's own session_meta — so the lineage
    // keeps it rather than vanishing or inventing one.
    const a = createCodexAdapter(HOME);
    const acc = fold(a, path('orphan'), [
      metaFor('child', { parent_thread_id: 'gone-forever', thread_source: 'subagent' }),
      tokenCount(usage(700)),
    ]);
    expect(acc.sessionId).toBe('gone-forever');
    expect(acc.usageOnly).toBe(true);
    // ...and it asks to be displayed anyway, so its spend still reaches the
    // ledger instead of being held in a group nobody ever reports.
    expect(acc.displayIfOrphaned).toBe(true);
    expect(totalUsage(acc)).toMatchObject({ input: 700 });
  });

  it('does not hang or lose a rollout on a malformed parent cycle', () => {
    const a = createCodexAdapter(HOME);
    const one = fold(a, path('one'), [
      metaFor('alpha', { parent_thread_id: 'beta', thread_source: 'subagent' }),
      tokenCount(usage(11)),
    ]);
    const two = fold(a, path('two'), [
      metaFor('beta', { parent_thread_id: 'alpha', thread_source: 'subagent' }),
      tokenCount(usage(22)),
    ]);
    // Before the loop closed, beta looked like a perfectly ordinary root.
    expect(one.sessionId).toBe('beta');
    // Once both links are known, both members of the cycle settle on the same
    // id — the lowest in the loop, not wherever the walk started — so a
    // malformed chain still groups instead of splitting into two half-sessions.
    expect(two.sessionId).toBe('alpha');
    a.ingestLine(JSON.stringify(tokenCount(usage(33))), one);
    expect(one.sessionId).toBe('alpha');

    expect(totalUsage(one)).toMatchObject({ input: 33 });
    expect(totalUsage(two)).toMatchObject({ input: 22 });
  });

  it('survives a rollout that names itself as its own parent', () => {
    const a = createCodexAdapter(HOME);
    const acc = fold(a, path('self'), [
      metaFor('self', { parent_thread_id: 'self', thread_source: 'subagent' }),
      tokenCount(usage(5)),
    ]);
    expect(acc.sessionId).toBe('self');
    expect(totalUsage(acc)).toMatchObject({ input: 5 });
  });

  it('leaves a plain user rollout with no parent exactly as it was', () => {
    const a = createCodexAdapter(HOME);
    const acc = fold(a, path('solo'), [
      metaFor('solo', { thread_source: 'user' }),
      tokenCount(usage(1234, 56)),
    ]);
    expect(acc.sessionId).toBe('solo');
    expect(acc.usageOnly).toBe(false);
    expect(acc.displayIfOrphaned).toBeFalsy();
    expect(totalUsage(acc)).toMatchObject({ input: 1234, output: 56 });
  });

  it('keeps the rollout its own identity when a copied session_meta follows', () => {
    // A fork file embeds the parent's whole transcript, session_meta lines and
    // all: 38 of the 39 metas in one local fork carry the parent's id. Letting
    // the last one win is how a fork ended up reporting as its parent.
    const a = createCodexAdapter(HOME);
    const acc = fold(a, path('fork'), [
      metaFor(
        'fork',
        { forked_from_id: 'origin', thread_source: 'subagent', cwd: '/home/dev/fork' },
        '2026-08-17T10:00:00.000Z',
      ),
      metaFor('origin', { thread_source: 'user' }, '2026-08-01T00:00:00.000Z'),
    ]);
    expect(acc.sessionId).toBe('origin');
    expect(acc.startedAtMs).toBe(Date.parse('2026-08-17T10:00:00.000Z'));
    expect(acc.cwd).toBe('/home/dev/fork');
  });

  it('books a replayed cumulative once for the lineage, not once per rollout', () => {
    // THE defect. A fork replays its parent's whole token_count history into
    // its own file — 9681 events verbatim in the worst local case — so summing
    // the rollouts books the same spend again for every fork.
    const a = createCodexAdapter(HOME);
    const shared = [tokenCount(usage(1_000_000)), tokenCount(usage(2_000_000))];

    const origin = fold(a, path('origin'), [
      metaFor('origin', { thread_source: 'user' }),
      ...shared,
    ]);
    expect(totalUsage(origin)).toMatchObject({ input: 2_000_000 });

    // Two forks of the same point, each replaying the same two events and then
    // doing a little work of their own.
    const forkA = fold(a, path('fork-a'), [
      metaFor('a', { forked_from_id: 'origin', thread_source: 'subagent' }),
      ...shared,
      tokenCount(usage(2_100_000)),
    ]);
    const forkB = fold(a, path('fork-b'), [
      metaFor('b', { forked_from_id: 'origin', thread_source: 'subagent' }),
      ...shared,
      tokenCount(usage(2_050_000)),
    ]);

    expect(totalUsage(forkA)).toMatchObject({ input: 100_000 });
    expect(totalUsage(forkB)).toMatchObject({ input: 50_000 });
    // 2.15M across the lineage, not the 6.15M summing the rollouts would give.
    const lineage = [origin, forkA, forkB].reduce((n, acc) => n + (totalUsage(acc)?.input ?? 0), 0);
    expect(lineage).toBe(2_150_000);
  });

  it('still counts a subagent whose spend never appears in its parent', () => {
    // The other half of the verdict: 0 of the 503 non-fork subagent rollouts
    // share a single cumulative with any ancestor. Their spend is their own and
    // denying it would trade a 6x over-count for a large under-count.
    const a = createCodexAdapter(HOME);
    const parent = fold(a, path('parent'), [
      metaFor('root', { thread_source: 'user' }),
      tokenCount(usage(9_000_000)),
    ]);
    const sub = fold(a, path('sub'), [
      metaFor('kid', { parent_thread_id: 'root', thread_source: 'subagent' }),
      tokenCount(usage(40_000)),
      tokenCount(usage(120_000)),
    ]);
    expect(totalUsage(parent)).toMatchObject({ input: 9_000_000 });
    expect(totalUsage(sub)).toMatchObject({ input: 120_000 });
  });

  it('re-reading the same rollout never denies it its own spend', () => {
    // The tailer replays a truncated file from the top. A claim is held by a
    // path, so a file always re-owns its own cumulatives.
    const a = createCodexAdapter(HOME);
    const lines = [metaFor('solo', { thread_source: 'user' }), tokenCount(usage(4242))];
    expect(totalUsage(fold(a, path('solo'), lines))).toMatchObject({ input: 4242 });
    expect(totalUsage(fold(a, path('solo'), lines))).toMatchObject({ input: 4242 });
  });

  it('bounds the claim index rather than growing it forever', () => {
    const a = createCodexAdapter(HOME, 2);
    const first = fold(a, path('one'), [
      metaFor('one', { thread_source: 'user' }),
      tokenCount(usage(1)),
      tokenCount(usage(2)),
      tokenCount(usage(3)),
    ]);
    expect(totalUsage(first)).toMatchObject({ input: 3 });
    // Eviction can only ever let a claim go, which costs precision on a replay,
    // never a rollout's own spend.
    const second = fold(a, path('two'), [
      metaFor('two', { thread_source: 'user' }),
      tokenCount(usage(1)),
    ]);
    expect(totalUsage(second)).toMatchObject({ input: 1 });
  });
});
