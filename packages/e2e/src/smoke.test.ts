import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerToWeb, serverToWebSchema, type WebWorld } from '@sloppers/protocol';
import { createSloppersServer, type SloppersServer } from '@sloppers/server';
import { newConfig, redeemPairingCode, saveConfig, startDaemon } from 'sloppers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

/**
 * The whole product, headless: synthetic Claude Code and Codex session
 * files in a temp HOME, the real collector daemon watching them, the real
 * server ingesting, and a protocol-level web client observing what a
 * browser would render. If this passes, only pixels are unverified.
 */

const NOW = Date.now();

function writeClaudeSession(home: string): string {
  const dir = join(home, '.claude', 'projects', '-work-myapp');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'e2e-claude-session.jsonl');
  const base = {
    sessionId: 'e2e-claude-session',
    cwd: '/work/myapp',
    gitBranch: 'feat/office',
    isSidechain: false,
    timestamp: new Date(NOW - 5 * 60_000).toISOString(),
  };
  const lines = [
    { ...base, type: 'user', message: { role: 'user', content: 'build it' } },
    { type: 'ai-title', aiTitle: 'Building the pixel office', sessionId: base.sessionId },
    {
      ...base,
      type: 'assistant',
      requestId: 'req-1',
      timestamp: new Date(NOW - 4 * 60_000).toISOString(),
      message: {
        model: 'claude-fable-5',
        content: [{ type: 'tool_use', name: 'Bash' }],
        usage: {
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_input_tokens: 40_000,
          cache_creation_input_tokens: 500,
        },
      },
    },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

function writeCodexSession(home: string): void {
  const dir = join(home, '.codex', 'sessions', '2026', '08', '17');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-08-17T09-00-00-e2e-codex.jsonl');
  const lines = [
    {
      timestamp: new Date(NOW - 10 * 60_000).toISOString(),
      type: 'session_meta',
      payload: {
        id: 'e2e-codex-session',
        cwd: '/work/pipeline',
        cli_version: '0.146.0',
        git: { branch: 'main' },
      },
    },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol', cwd: '/work/pipeline' } },
    {
      timestamp: new Date(NOW - 60_000).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 90_000,
            cached_input_tokens: 60_000,
            cache_write_input_tokens: 0,
            output_tokens: 4_000,
          },
        },
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

class WebProbe {
  private ws: WebSocket;
  private queue: ServerToWeb[] = [];
  private waiters: ((msg: ServerToWeb) => void)[] = [];
  /** Everything seen, for timeout diagnostics on slow CI runners. */
  private seen: string[] = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws/web`);
    this.ws.on('message', (data) => {
      const msg = serverToWebSchema.parse(JSON.parse(String(data)));
      this.seen.push(
        msg.type === 'presence'
          ? `presence(${msg.presence},${msg.sessions.length} sessions)`
          : msg.type === 'error'
            ? `error(${msg.code}:${msg.message})`
            : msg.type,
      );
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  async join(roomCode: string, name: string): Promise<WebWorld> {
    await new Promise<void>((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.send(JSON.stringify({ type: 'join', roomCode, displayName: name }));
    return (await this.next((m) => m.type === 'world')) as WebWorld;
  }

  async next(match: (msg: ServerToWeb) => boolean, timeoutMs = 15_000): Promise<ServerToWeb> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queued = this.queue.shift();
      const msg =
        queued ??
        (await new Promise<ServerToWeb>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(`timed out waiting for message; saw: [${this.seen.join(', ')}]`),
              ),
            Math.max(1, deadline - Date.now()),
          );
          this.waiters.push((m) => {
            clearTimeout(timer);
            resolve(m);
          });
        }));
      if (match(msg)) return msg;
    }
  }

  close(): void {
    this.ws.close();
  }
}

describe('end-to-end smoke', () => {
  let server: SloppersServer;
  let home: string;
  let probe: WebProbe;
  let daemon: { stop(): Promise<void> } | null = null;

  beforeEach(async () => {
    server = await createSloppersServer({ port: 0, hostname: '127.0.0.1', dbPath: ':memory:' });
    home = mkdtempSync(join(tmpdir(), 'sloppers-e2e-home-'));
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    probe?.close();
    await server.close();
  });

  // Generous timeout: CI runners take a while through daemon debounce +
  // watcher startup + real websocket round-trips.
  it('synthetic sessions flow from disk to a joined browser', { timeout: 30_000 }, async () => {
    const claudeFile = writeClaudeSession(home);
    writeCodexSession(home);

    probe = new WebProbe(server.port);
    const world = await probe.join('e2e', 'ridham');
    expect(world.you.memberSecret).toBeTruthy();

    // Pair exactly the way the web app and CLI do.
    const base = `http://127.0.0.1:${server.port}`;
    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      }),
    });
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    const redeemed = await redeemPairingCode(base, pairingCode);
    saveConfig(
      newConfig({
        httpUrl: base,
        wsUrl: `ws://127.0.0.1:${server.port}`,
        deviceKey: redeemed.deviceKey,
        memberId: redeemed.memberId,
        displayName: redeemed.displayName,
        roomCode: redeemed.roomCode,
      }),
      home,
    );

    daemon = startDaemon({ collectorVersion: 'e2e', home, log: () => {} });

    const presence = await probe.next((m) => m.type === 'presence' && m.sessions.length === 2);
    if (presence.type !== 'presence') throw new Error('unreachable');

    const claude = presence.sessions.find((s) => s.harness === 'claude-code');
    const codex = presence.sessions.find((s) => s.harness === 'codex');
    expect(claude).toMatchObject({
      title: 'Building the pixel office',
      project: 'myapp',
      branch: 'feat/office',
      model: 'claude-fable-5',
      tokens: { input: 1200, output: 300, cacheRead: 40_000, cacheWrite: 500 },
    });
    expect(codex).toMatchObject({
      project: 'pipeline',
      branch: 'main',
      model: 'gpt-5.6-sol',
      state: 'waiting',
      tokens: { input: 30_000, output: 4_000, cacheRead: 60_000, cacheWrite: 0 },
    });
    // Both sessions started today, so the ledger counts them fully.
    expect(presence.today.tokens).toMatchObject({ input: 31_200, output: 4_300 });
    expect(presence.today.sessionsRun).toBe(2);

    // A live append flows through within the debounce window.
    appendFileSync(
      claudeFile,
      `${JSON.stringify({
        sessionId: 'e2e-claude-session',
        cwd: '/work/myapp',
        gitBranch: 'feat/office',
        isSidechain: false,
        timestamp: new Date().toISOString(),
        type: 'assistant',
        requestId: 'req-2',
        message: {
          model: 'claude-fable-5',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 500, output_tokens: 100 },
        },
      })}\n`,
    );
    const updated = await probe.next(
      (m) =>
        m.type === 'presence' &&
        m.sessions.some((s) => s.harness === 'claude-code' && s.tokens?.input === 1700),
    );
    if (updated.type !== 'presence') throw new Error('unreachable');
    expect(updated.today.tokens.input).toBe(31_700);

    // The leaderboard follows.
    const leaderboard = await probe.next((m) => m.type === 'leaderboard');
    if (leaderboard.type !== 'leaderboard') throw new Error('unreachable');
    expect(leaderboard.rows[0]?.displayName).toBe('ridham');
  });
});
