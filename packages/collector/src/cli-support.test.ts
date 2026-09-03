import type { SessionSnapshot } from '@sloppers/protocol';
import { defaultVisibility } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import { describeTargets, parseShareArgs, renderStatus, selectPairings } from './cli-support.js';
import type { CollectorConfig, PairingConfig } from './config.js';
import type { RoutableSession } from './core/types.js';
import type { Liveness } from './service/liveness.js';

/** picocolors may or may not emit escapes depending on the terminal. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (lines: string[]) => lines.map((line) => line.replace(ANSI, ''));

function pairing(overrides: Partial<PairingConfig> = {}): PairingConfig {
  return {
    server: { httpUrl: 'https://office.example', wsUrl: 'wss://office.example' },
    deviceKey: 'k'.repeat(32),
    memberId: 'm1',
    displayName: 'ridham',
    roomCode: 'the-lab',
    match: ['**'],
    visibility: { ...defaultVisibility },
    paused: false,
    ...overrides,
  };
}

function config(...pairings: PairingConfig[]): CollectorConfig {
  return { version: 2, pairings };
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1',
    harness: 'claude-code',
    state: 'working',
    startedAt: 1,
    lastActivityAt: 2,
    ...overrides,
  };
}

describe('parseShareArgs', () => {
  it('takes the code as the single positional argument', () => {
    expect(parseShareArgs(['ABCD-1234'])).toEqual({
      target: 'ABCD-1234',
      foreground: false,
      match: undefined,
    });
  });

  it('does not mistake --match’s value for the pairing code', () => {
    // The bug this exists to prevent: "the first argument that isn't a flag"
    // picks up the glob when --match comes first, and the user pairs with a
    // pattern as their code.
    expect(parseShareArgs(['--match', '~/work/**', 'ABCD-1234'])).toEqual({
      target: 'ABCD-1234',
      foreground: false,
      match: '~/work/**',
    });
  });

  it('accepts --match=glob, and --match after the code', () => {
    expect(parseShareArgs(['ABCD-1234', '--match=~/work/**']).match).toBe('~/work/**');
    expect(parseShareArgs(['ABCD-1234', '--match', '~/work/**']).match).toBe('~/work/**');
  });

  it('still recognises --foreground alongside a match', () => {
    const parsed = parseShareArgs(['--match', '~/work/**', '--foreground', 'ABCD-1234']);
    expect(parsed).toEqual({ target: 'ABCD-1234', foreground: true, match: '~/work/**' });
  });

  it('reports a missing match value as missing, so the prompt still happens', () => {
    expect(parseShareArgs(['ABCD-1234', '--match']).match).toBeUndefined();
  });
});

describe('selectPairings', () => {
  const work = pairing({ roomCode: 'work-room', displayName: 'ridham' });
  const personal = pairing({ roomCode: 'personal-room', displayName: 'rk' });

  it('defaults to every workspace when none is named', () => {
    expect(selectPairings([work, personal], undefined)).toEqual([0, 1]);
  });

  it('selects one workspace by room code, case-insensitively', () => {
    expect(selectPairings([work, personal], 'PERSONAL-ROOM')).toEqual([1]);
  });

  it('falls back to the display name', () => {
    expect(selectPairings([work, personal], 'rk')).toEqual([1]);
  });

  it('prefers a room code over a display name that collides with it', () => {
    const odd = pairing({ roomCode: 'x', displayName: 'work-room' });
    expect(selectPairings([odd, work], 'work-room')).toEqual([1]);
  });

  it('selects nothing for an unknown name, rather than everything', () => {
    // Falling back to "all" here would pause every workspace on a typo.
    expect(selectPairings([work, personal], 'nope')).toEqual([]);
  });

  it('names what it acted on', () => {
    expect(describeTargets([work, personal], [0, 1])).toBe('work-room, personal-room');
  });
});

describe('renderStatus', () => {
  const CONFIG_FILE = '/home/dev/.sloppers/config.json';
  const work = pairing({ roomCode: 'work-room', match: ['/work/**'] });
  const personal = pairing({ roomCode: 'personal-room', match: ['**'] });
  const routable = (snapshot: SessionSnapshot, cwd: string | undefined): RoutableSession => ({
    snapshot,
    cwd,
  });
  const RUNNING: Liveness = { state: 'running', pid: 4321 };
  const show = (
    cfg: CollectorConfig,
    sessions: RoutableSession[] = [],
    daemon: Liveness = RUNNING,
  ) => plain(renderStatus(cfg, sessions, CONFIG_FILE, daemon)).join('\n');

  it('names the config file, since editing a match pattern has no command', () => {
    // The only way to change what a workspace claims is to edit `match` in
    // this file. Printing the path makes that a documented escape hatch
    // rather than something to guess at.
    expect(show(config(work))).toContain(CONFIG_FILE);
  });

  it('prints each workspace with its pattern and the sessions routed to it', () => {
    const out = show(config(work, personal), [
      routable(session({ id: 'a', project: 'api' }), '/work/api'),
      routable(session({ id: 'b', project: 'blog' }), '/personal/blog'),
    ]);
    expect(out).toContain('workspace 1  room work-room');
    expect(out).toContain('match    /work/**');
    expect(out).toContain('workspace 2  room personal-room');
    expect(out).toContain('match    **');
    // Each session appears under exactly the workspace that claimed it.
    const workBlock = out.slice(out.indexOf('workspace 1'), out.indexOf('workspace 2'));
    expect(workBlock).toContain('api');
    expect(workBlock).not.toContain('blog');
  });

  it('marks a catch-all as the fallback, so an empty one does not read as a bug', () => {
    // A catch-all sorts behind every specific pairing whatever line it is
    // written on, so the listing has to say why it may be holding nothing.
    const out = show(config(personal, work));
    const catchAllBlock = out.slice(out.indexOf('workspace 1'), out.indexOf('workspace 2'));
    expect(catchAllBlock).toContain('fallback');
    expect(out.slice(out.indexOf('workspace 2'))).not.toContain('fallback');
  });

  it('says so when a workspace has nothing routed to it', () => {
    expect(show(config(work))).toContain('sessions none routed here');
  });

  it('shows the sessions that match no workspace, with the directory to blame', () => {
    // The requirement: a session under no pattern is shared with nobody and
    // reported nowhere. Someone whose tokens stopped counting has to be able
    // to see why, so it is named here along with the cwd that missed.
    const out = show(config(work), [
      routable(session({ id: 'a', project: 'api' }), '/work/api'),
      routable(session({ id: 'b', project: 'blog' }), '/personal/blog'),
    ]);
    expect(out).toContain('1 live session(s) match no workspace');
    expect(out).toContain('/personal/blog');
    expect(out).toContain("sloppers share <code> --match '<glob>'");
  });

  it('says nothing about unrouted sessions when every session found a home', () => {
    const out = show(config(personal), [routable(session({ project: 'api' }), '/work/api')]);
    expect(out).not.toContain('match no workspace');
  });

  it('reports no sessions at all separately from unrouted ones', () => {
    const out = show(config(work));
    expect(out).toContain('no live agent sessions found');
    expect(out).not.toContain('match no workspace');
  });

  it('shows each workspace’s own paused state and hidden fields', () => {
    const out = show(
      config(
        pairing({ roomCode: 'a-room', paused: true }),
        pairing({ roomCode: 'b-room', visibility: { ...defaultVisibility, tokens: false } }),
      ),
    );
    expect(out).toContain('sharing  paused');
    expect(out).toContain('sharing  on');
    expect(out).toContain('hidden   tokens');
  });

  /**
   * The failure this whole parameter exists for: somebody's office showed
   * them as not sharing while `sloppers status` said `sharing on`, in green,
   * because that line was read off `paused === false` in a config file and
   * nothing had ever asked whether a daemon was running.
   */
  describe('and whether anything is actually running', () => {
    it('says a workspace is on only when a daemon is', () => {
      expect(show(config(work), [], RUNNING)).toContain('sharing  on');
      expect(show(config(work), [], RUNNING)).toContain('collector running');
    });

    it('refuses to call it on when nothing is running', () => {
      const out = show(config(work), [], { state: 'stopped' });
      expect(out).not.toMatch(/sharing {2}on$/m);
      expect(out).toContain('sharing  off — the collector is not running');
      expect(out).toContain('collector not running');
      // And says what to do about it, rather than leaving the log file as
      // the only place left to look.
      expect(out).toContain('sloppers run');
    });

    it('prints uncertainty as uncertainty where liveness cannot be known', () => {
      const out = show(config(work), [], { state: 'unknown', why: 'no auto-start on win32' });
      expect(out).toContain('could not tell');
      expect(out).toContain('no auto-start on win32');
      expect(out).not.toMatch(/sharing {2}on$/m);
    });

    it('still calls a paused workspace paused, whatever the daemon is doing', () => {
      // Paused is the one thing the config does know for certain.
      const out = show(config(pairing({ paused: true })), [], { state: 'stopped' });
      expect(out).toContain('sharing  paused');
    });
  });
});
