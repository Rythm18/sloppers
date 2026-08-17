import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from './codex.js';
import type { SessionAccumulator } from '../core/types.js';

const HOME = '/home/dev';
const adapter = createCodexAdapter(HOME);
const FILE = `${HOME}/.codex/sessions/2026/08/17/rollout-2026-08-17T10-00-00-xyz.jsonl`;

function ingest(lines: object[]): SessionAccumulator {
  const acc = adapter.newAccumulator(FILE);
  for (const line of lines) adapter.ingestLine(JSON.stringify(line), acc);
  return acc;
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

function tokenCount(total: object) {
  return {
    timestamp: '2026-08-17T10:05:00.000Z',
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
    expect(acc.tokens).toEqual({
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
    expect(acc.tokens).toEqual({ input: 200, output: 30, cacheRead: 50, cacheWrite: 0 });
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
    expect(acc.tokens).toBeUndefined();
  });
});
