import { describe, expect, it } from 'vitest';
import type { SessionAccumulator } from '../core/types.js';
import { createClaudeCodeAdapter } from './claude-code.js';

const HOME = '/home/dev';
const adapter = createClaudeCodeAdapter(HOME);
const FILE = `${HOME}/.claude/projects/-home-dev-myapp/abc-123.jsonl`;

function ingest(lines: object[]): SessionAccumulator {
  const acc = adapter.newAccumulator(FILE);
  for (const line of lines) adapter.ingestLine(JSON.stringify(line), acc);
  return acc;
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

  it('ignores sidechain (subagent) transcript files entirely', () => {
    const acc = ingest([
      { ...base, isSidechain: true, type: 'user', message: {} },
      assistant({ requestId: 'r1' }),
    ]);
    expect(acc.ignored).toBe(true);
    expect(acc.tokens).toBeUndefined();
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
    expect(acc.tokens).toEqual({ input: 20, output: 40, cacheRead: 200, cacheWrite: 10 });
  });

  it('takes the latest usage when a request is re-reported', () => {
    const acc = ingest([
      assistant({ requestId: 'r1', usage: { input_tokens: 1, output_tokens: 1 } }),
      assistant({ requestId: 'r1', usage: { input_tokens: 3, output_tokens: 9 } }),
    ]);
    expect(acc.tokens).toEqual({ input: 3, output: 9, cacheRead: 0, cacheWrite: 0 });
  });

  it('skips synthetic assistant entries', () => {
    const acc = ingest([
      assistant({ requestId: 'r1', model: '<synthetic>', usage: { input_tokens: 999 } }),
    ]);
    expect(acc.model).toBeUndefined();
    expect(acc.tokens).toBeUndefined();
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

  it('survives malformed lines', () => {
    const acc = adapter.newAccumulator(FILE);
    adapter.ingestLine('{"broken', acc);
    adapter.ingestLine('not json at all', acc);
    expect(acc.ignored).toBe(false);
  });
});
