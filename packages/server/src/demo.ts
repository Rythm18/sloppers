import type { CollectorSnapshot, SessionSnapshot } from '@sloppers/protocol';
import type { WebSocket } from 'ws';
import type { RoomManager } from './workspace/manager.js';

/**
 * `--demo` populates a room with simulated teammates whose agents work,
 * block on input, and go idle — driving the exact same ingest paths as real
 * collectors, so it doubles as a manual test harness and a way to feel the
 * product without three friends online.
 */

interface Bot {
  memberId: string;
  socket: WebSocket;
  harness: 'claude-code' | 'codex';
  title: string;
  project: string;
  model: string;
  sessionId: string;
  startedAt: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** working | waiting | idle phase with a deadline to switch. */
  phase: 'working' | 'waiting' | 'idle';
  phaseUntil: number;
  idleSeconds: number;
  target: { x: number; y: number };
  pos: { x: number; y: number };
}

const CAST = [
  { name: 'maya', project: 'checkout-svc', title: 'Migrating payments to the new API' },
  { name: 'arjun', project: 'infra', title: 'Chasing a flaky deploy test' },
  { name: 'nina', project: 'mobile-app', title: 'Rebuilding the onboarding flow' },
  { name: 'theo', project: 'data-pipeline', title: 'Backfilling the events table' },
  { name: 'zoe', project: 'website', title: 'Dark mode for the docs site' },
] as const;

/** Stay on the open floor of the default 512×352 office map. */
const WANDER = { minX: 48, maxX: 464, minY: 80, maxY: 320 };

/** Quacks enough like a ws socket for Room's collector bookkeeping. */
function fakeSocket(): WebSocket {
  return { close: () => {}, readyState: 1, OPEN: 1, send: () => {} } as unknown as WebSocket;
}

export function startDemo(rooms: RoomManager, roomCode = 'demo'): () => void {
  // The demo floor has a knowable code on purpose — it's a public playground.
  const room = rooms.ensureInternalRoom(roomCode, 'demo floor');
  const bots: Bot[] = [];

  for (const [i, cast] of CAST.entries()) {
    const created = rooms.createMember(roomCode, cast.name);
    if (created === 'room-full') continue;
    const memberId =
      created === 'name-taken'
        ? // Server restarted onto an existing demo db; reuse the member.
          findDemoMember(rooms, roomCode, cast.name)
        : created.id;
    if (!memberId) continue;
    if (created !== 'name-taken') room.memberJoined(created);
    const socket = fakeSocket();
    room.attachCollector(memberId, socket);
    bots.push({
      memberId,
      socket,
      harness: i % 2 === 0 ? 'claude-code' : 'codex',
      title: cast.title,
      project: cast.project,
      model: i % 2 === 0 ? 'claude-fable-5' : 'gpt-5.6-sol',
      sessionId: `demo-${cast.name}-${Math.floor(Math.random() * 1e6)}`,
      startedAt: Date.now() - Math.floor(Math.random() * 3_600_000),
      tokens: {
        input: Math.floor(Math.random() * 200_000),
        output: Math.floor(Math.random() * 40_000),
        cacheRead: Math.floor(Math.random() * 2_000_000),
        cacheWrite: 0,
      },
      phase: 'working',
      phaseUntil: Date.now() + 20_000 + Math.random() * 60_000,
      idleSeconds: i < 2 ? 5 : 600,
      target: randomPoint(),
      pos: randomPoint(),
    });
  }

  const move = setInterval(() => {
    for (const bot of bots) {
      const dx = bot.target.x - bot.pos.x;
      const dy = bot.target.y - bot.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 8) {
        if (Math.random() < 0.02) bot.target = randomPoint();
        continue;
      }
      const step = 40 * 0.3; // px per tick at walking speed
      bot.pos.x += (dx / dist) * step;
      bot.pos.y += (dy / dist) * step;
      const dir =
        Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      room.updatePosition(bot.memberId, {
        x: Math.round(bot.pos.x),
        y: Math.round(bot.pos.y),
        dir,
        moving: true,
      });
    }
  }, 300);

  const tick = setInterval(() => {
    const now = Date.now();
    for (const bot of bots) {
      if (now > bot.phaseUntil) advancePhase(bot, now);
      if (bot.phase === 'working') {
        bot.tokens.input += Math.floor(Math.random() * 2_000);
        bot.tokens.output += Math.floor(Math.random() * 800);
        bot.tokens.cacheRead += Math.floor(Math.random() * 30_000);
      }
      room.ingestSnapshot(bot.memberId, bot.socket, snapshotFor(bot, now), now);
    }
  }, 5_000);

  return () => {
    clearInterval(move);
    clearInterval(tick);
  };
}

function advancePhase(bot: Bot, now: number): void {
  if (bot.phase === 'working') {
    const rest = Math.random();
    bot.phase = rest < 0.6 ? 'waiting' : 'idle';
    bot.phaseUntil = now + (bot.phase === 'waiting' ? 20_000 + Math.random() * 60_000 : 60_000);
  } else {
    bot.phase = 'working';
    bot.phaseUntil = now + 30_000 + Math.random() * 120_000;
  }
}

function snapshotFor(bot: Bot, now: number): CollectorSnapshot {
  const session: SessionSnapshot = {
    id: bot.sessionId,
    harness: bot.harness,
    state: bot.phase,
    title: bot.title,
    project: bot.project,
    branch: 'main',
    model: bot.model,
    tokens: { ...bot.tokens },
    startedAt: bot.startedAt,
    lastActivityAt: bot.phase === 'idle' ? now - 11 * 60_000 : now,
  };
  return { type: 'snapshot', sessions: [session], machine: { idleSeconds: bot.idleSeconds } };
}

function randomPoint(): { x: number; y: number } {
  return {
    x: WANDER.minX + Math.random() * (WANDER.maxX - WANDER.minX),
    y: WANDER.minY + Math.random() * (WANDER.maxY - WANDER.minY),
  };
}

function findDemoMember(rooms: RoomManager, roomCode: string, name: string): string | null {
  // RoomManager doesn't expose search-by-name; demo members are stable so a
  // direct query via its db would be circular. Instead re-derive from the
  // room's world after load — simplest is a dedicated lookup:
  return rooms.memberByName(roomCode, name)?.id ?? null;
}
