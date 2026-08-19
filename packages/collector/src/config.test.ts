import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addPairing,
  type CollectorConfig,
  dropPairing,
  isCatchAll,
  loadConfig,
  matchesPairing,
  newConfig,
  samplePathFor,
  saveConfig,
  shadowedBy,
} from './config.js';

/** Two pairings, distinguishable by device key — the shape `dropPairing` acts on. */
function twoPairingConfig(): CollectorConfig {
  return {
    version: 2,
    pairings: [
      {
        server: { httpUrl: 'https://a', wsUrl: 'wss://a' },
        deviceKey: 'k-dead',
        memberId: 'm-dead',
        displayName: 'dead',
        roomCode: 'room-dead',
        match: ['**'],
        visibility: { title: true, project: true, branch: true, model: true, tokens: true },
        paused: false,
      },
      {
        server: { httpUrl: 'https://b', wsUrl: 'wss://b' },
        deviceKey: 'k-live',
        memberId: 'm-live',
        displayName: 'live',
        roomCode: 'room-live',
        match: ['~/work/**'],
        visibility: { title: true, project: true, branch: true, model: true, tokens: true },
        paused: false,
      },
    ],
  };
}

describe('collector config', () => {
  it('round-trips through disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-config-'));
    const config = newConfig({
      httpUrl: 'https://office.example.com',
      wsUrl: 'wss://office.example.com',
      deviceKey: 'k'.repeat(32),
      memberId: 'm1',
      displayName: 'Ridham',
      roomCode: 'the-lab',
    });
    saveConfig(config, home);
    expect(loadConfig(home)).toEqual(config);
  });

  it('returns null for a missing or corrupt file', () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-config-'));
    expect(loadConfig(home)).toBeNull();
  });

  it('new configs are a single catch-all pairing, shared and not paused', () => {
    const config = newConfig({
      httpUrl: 'x',
      wsUrl: 'y',
      deviceKey: 'k',
      memberId: 'm',
      displayName: 'd',
      roomCode: 'r',
    });
    expect(config.version).toBe(2);
    const pairing = config.pairings[0];
    expect(pairing?.match).toEqual(['**']);
    expect(pairing?.paused).toBe(false);
    expect(Object.values(pairing?.visibility ?? {}).every(Boolean)).toBe(true);
  });

  it('upgrades a v1 config into a single catch-all pairing', () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-cfg-'));
    mkdirSync(join(home, '.sloppers'), { recursive: true });
    writeFileSync(
      join(home, '.sloppers', 'config.json'),
      JSON.stringify({
        version: 1,
        server: { httpUrl: 'https://x', wsUrl: 'wss://x' },
        deviceKey: 'k',
        memberId: 'm',
        displayName: 'ridham',
        roomCode: 'the-lab-k4xp2q',
        visibility: { title: true, project: true, branch: true, model: true, tokens: true },
        paused: false,
      }),
    );
    const config = loadConfig(home);
    expect(config?.version).toBe(2);
    expect(config?.pairings).toHaveLength(1);
    expect(config?.pairings[0]?.match).toEqual(['**']);
    expect(config?.pairings[0]?.deviceKey).toBe('k');
    expect(config?.pairings[0]?.roomCode).toBe('the-lab-k4xp2q');
  });

  it('does not rewrite a v1 file on disk merely by reading it', () => {
    // Hazard: sloppers@0.1.1 is published and in use, and writes v1. If
    // loadConfig silently upgraded the file in place, a user who
    // upgrades the collector, is read once (no actual change made), and
    // then downgrades back to 0.1.1 would find 0.1.1's schema
    // (`version: z.literal(1)`) reject the now-v2 file — its loadConfig
    // returns null on any parse failure, so their existing pairing would
    // look lost even though nothing they did actually changed it.
    // Deferring the rewrite to the first genuine mutation (pause, hide,
    // a new pairing, ...) means a pure upgrade-then-downgrade with no
    // intervening change never loses anything.
    const home = mkdtempSync(join(tmpdir(), 'sloppers-cfg-'));
    mkdirSync(join(home, '.sloppers'), { recursive: true });
    const v1 = {
      version: 1,
      server: { httpUrl: 'https://x', wsUrl: 'wss://x' },
      deviceKey: 'k',
      memberId: 'm',
      displayName: 'ridham',
      roomCode: 'the-lab-k4xp2q',
      visibility: { title: true, project: true, branch: true, model: true, tokens: true },
      paused: false,
    };
    const path = join(home, '.sloppers', 'config.json');
    writeFileSync(path, JSON.stringify(v1));

    loadConfig(home);
    loadConfig(home);

    const onDisk: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk).toEqual(v1);
  });

  it('addPairing appends a pairing without disturbing the existing ones', () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-cfg-'));
    const first = newConfig({
      httpUrl: 'https://a',
      wsUrl: 'wss://a',
      deviceKey: 'k-a',
      memberId: 'm-a',
      displayName: 'a',
      roomCode: 'room-a',
    });
    const withSecond = addPairing(first, {
      server: { httpUrl: 'https://b', wsUrl: 'wss://b' },
      deviceKey: 'k-b',
      memberId: 'm-b',
      displayName: 'b',
      roomCode: 'room-b',
      match: ['~/personal/**'],
      visibility: { title: true, project: true, branch: true, model: true, tokens: true },
      paused: false,
    });
    saveConfig(withSecond, home);

    const loaded = loadConfig(home);
    expect(loaded?.pairings).toHaveLength(2);
    expect(loaded?.pairings[0]?.deviceKey).toBe('k-a');
    expect(loaded?.pairings[1]?.deviceKey).toBe('k-b');
  });

  it('matches a session cwd against a pairing pattern', () => {
    expect(matchesPairing({ match: ['~/work/**'] } as never, `${homedir()}/work/api`)).toBe(true);
    expect(matchesPairing({ match: ['~/work/**'] } as never, `${homedir()}/personal/blog`)).toBe(
      false,
    );
    expect(matchesPairing({ match: ['**'] } as never, '/anywhere')).toBe(true);
  });

  it('a directory pattern also matches the directory itself, trailing slash or not', () => {
    // Path semantics, decided deliberately: "~/work/**" reads naturally
    // as "this directory and everything under it". A session whose cwd
    // is exactly ~/work (not a subdirectory) is the ordinary case of
    // cd'ing straight into a paired directory and starting an agent
    // there — excluding it would be exactly the kind of silent surprise
    // that sends a session to the wrong office. Whether the cwd carries
    // a trailing slash must not change the answer.
    const pairing = { match: ['~/work/**'] } as never;
    expect(matchesPairing(pairing, `${homedir()}/work`)).toBe(true);
    expect(matchesPairing(pairing, `${homedir()}/work/`)).toBe(true);
    expect(matchesPairing(pairing, `${homedir()}/work/api`)).toBe(true);
  });

  it('does not match a sibling directory that merely shares a prefix', () => {
    const pairing = { match: ['~/work/**'] } as never;
    expect(matchesPairing(pairing, `${homedir()}/workshop`)).toBe(false);
  });

  it('an absolute pattern works without a tilde, and a tilde pattern never escapes home', () => {
    const pairing = { match: ['/srv/apps/**'] } as never;
    expect(matchesPairing(pairing, '/srv/apps/api')).toBe(true);
    expect(matchesPairing(pairing, '/etc/nginx')).toBe(false);
    // A path that is not under `~` at all simply does not match a
    // tilde-scoped pattern — there is no fallback or partial credit.
    expect(matchesPairing({ match: ['~/work/**'] } as never, '/srv/apps/api')).toBe(false);
  });

  it('escapes regex metacharacters in a directory name before expanding wildcards', () => {
    // Hazard: a naive `**`→`.*` / `*`→`[^/]*` pass over an unescaped
    // path turns "." into "match any character" and "+" / "(" / "["
    // into quantifiers and groups — "my.project" would then also match
    // "myXproject". Cover all four: `.`, `+`, `(`, `[`.
    const pairing = { match: ['~/my.proj+ect(v1)[beta]/**'] } as never;
    expect(matchesPairing(pairing, `${homedir()}/my.proj+ect(v1)[beta]`)).toBe(true);
    expect(matchesPairing(pairing, `${homedir()}/my.proj+ect(v1)[beta]/sub`)).toBe(true);
    expect(matchesPairing(pairing, `${homedir()}/myXprojXectXv1XXbetaX`)).toBe(false);
  });

  it('leaves ** intact instead of corrupting it via a naive * replacement first', () => {
    const pairing = { match: ['~/work/**'] } as never;
    // If `*` were replaced before `**`, "**" would become "[^/]*[^/]*"
    // (same-segment only) instead of ".*" — a nested path would then
    // wrongly fail to match.
    expect(matchesPairing(pairing, `${homedir()}/work/deeply/nested/dir`)).toBe(true);
  });

  it('answers each pairing independently when more than one could match', () => {
    // matchesPairing is a pure per-pairing predicate — it has no view of
    // sibling pairings, so "first match wins" is the router's job (a
    // later task), not something matchesPairing decides on its own.
    const broad = { match: ['**'] } as never;
    const narrow = { match: ['~/work/**'] } as never;
    const cwd = `${homedir()}/work/api`;
    expect(matchesPairing(broad, cwd)).toBe(true);
    expect(matchesPairing(narrow, cwd)).toBe(true);
  });
});

describe('isCatchAll', () => {
  it('recognises a pattern that constrains nothing, however it is spelled', () => {
    // Decided by behaviour, not by the literal string `**`: these all match
    // every path there is, so they are all fallbacks.
    expect(isCatchAll({ match: ['**'] } as never)).toBe(true);
    expect(isCatchAll({ match: ['***'] } as never)).toBe(true);
    expect(isCatchAll({ match: ['*/**'] } as never)).toBe(true);
    // An `or` across `match`, so one catch-all pattern makes the whole
    // pairing a fallback whatever else it lists.
    expect(isCatchAll({ match: ['~/work/**', '**'] } as never)).toBe(true);
  });

  it('does not treat a sweeping-looking pattern as universal when it is not', () => {
    // `~/**` claims nothing under /srv or /tmp.
    expect(isCatchAll({ match: ['~/**'] } as never)).toBe(false);
    // `/**` is every path on POSIX and no path at all on Windows. Auto-start
    // only installs on darwin and linux, so on every platform the daemon
    // actually runs on today this *is* universal — excluding it is a
    // portability choice matching `globToRegExp`'s own handling of `\`, and a
    // deliberate one: detection that varied by platform would route the same
    // config differently on different machines. `shadowedBy` covers the gap.
    expect(isCatchAll({ match: ['/**'] } as never)).toBe(false);
    expect(shadowedBy([{ match: ['/**'] } as never], ['~/work/**'])).toBeDefined();
    // `**/` only matches paths that end in a separator.
    expect(isCatchAll({ match: ['**/'] } as never)).toBe(false);
    // A single `*` stops at a separator.
    expect(isCatchAll({ match: ['*'] } as never)).toBe(false);
    expect(isCatchAll({ match: ['~/work/**'] } as never)).toBe(false);
    expect(isCatchAll({ match: [] } as never)).toBe(false);
  });

  it('accepts the empty cwd, since that is how an unknown directory routes', () => {
    // `routeSessions` routes a session with no cwd as the empty path, and
    // only a fallback may claim it — so a catch-all has to match it.
    expect(matchesPairing({ match: ['**'] } as never, '')).toBe(true);
  });
});

describe('dropPairing', () => {
  it('removes only the pairing whose device the server rejected', () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-cfg-'));
    saveConfig(twoPairingConfig(), home);
    dropPairing('k-dead', home);
    const config = loadConfig(home);
    expect(config?.pairings.map((p) => p.deviceKey)).toEqual(['k-live']);
  });

  it('leaves every pairing untouched when the given key matches none of them', () => {
    // A defensive no-op, not an error: a stale or mistyped key must not
    // silently take out an unrelated pairing.
    const home = mkdtempSync(join(tmpdir(), 'sloppers-cfg-'));
    saveConfig(twoPairingConfig(), home);
    dropPairing('k-nonexistent', home);
    const config = loadConfig(home);
    expect(config?.pairings.map((p) => p.deviceKey)).toEqual(['k-dead', 'k-live']);
  });

  it('drops the last pairing down to an empty, still-loadable config', () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-cfg-'));
    saveConfig({ version: 2, pairings: [twoPairingConfig().pairings[0] as never] }, home);
    const result = dropPairing('k-dead', home);
    expect(result.pairings).toEqual([]);
    const config = loadConfig(home);
    expect(config?.version).toBe(2);
    expect(config?.pairings).toEqual([]);
  });

  it('is a real write: it upgrades a v1 file to v2 on disk, unlike loadConfig', () => {
    // Deliberately different from loadConfig's read-only v1->v2 upgrade (see
    // the module doc): dropping a pairing is a genuine edit to the pairing
    // itself, which is exactly the kind of change that doc says is safe —
    // and necessary — to persist.
    const home = mkdtempSync(join(tmpdir(), 'sloppers-cfg-'));
    mkdirSync(join(home, '.sloppers'), { recursive: true });
    const path = join(home, '.sloppers', 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        server: { httpUrl: 'https://x', wsUrl: 'wss://x' },
        deviceKey: 'k-only',
        memberId: 'm',
        displayName: 'ridham',
        roomCode: 'the-lab',
        visibility: { title: true, project: true, branch: true, model: true, tokens: true },
        paused: false,
      }),
    );
    dropPairing('k-only', home);
    const onDisk: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect((onDisk as { version: number }).version).toBe(2);
    expect((onDisk as { pairings: unknown[] }).pairings).toEqual([]);
  });
});

describe('shadowing', () => {
  it('reduces a pattern to the directory it stands for', () => {
    expect(samplePathFor('~/work/**')).toBe(`${homedir()}/work`);
    expect(samplePathFor('/srv/apps/**')).toBe('/srv/apps');
    expect(samplePathFor('/srv/*/api')).toBe('/srv');
    expect(samplePathFor('/srv/apps')).toBe('/srv/apps');
    // Only a catch-all can shadow a catch-all.
    expect(samplePathFor('**')).toBe('');
  });

  it('spots a preceding pairing that already claims everything a new one would', () => {
    // Routing is first-match-wins, so a pairing ahead of a new workspace
    // starves it: it connects, stays connected, and never gets a session.
    // The caller passes only what actually precedes it in routing order — a
    // demoted catch-all is not ahead of anything and never appears here.
    const home = { match: ['~/**'], roomCode: 'first' } as never;
    expect(shadowedBy([home], ['~/work/**'])).toBe(home);
    const catchAll = { match: ['**'], roomCode: 'first' } as never;
    expect(shadowedBy([catchAll], ['**'])).toBe(catchAll);
  });

  it('does not cry shadow when the earlier pairings claim somewhere else', () => {
    const scoped = { match: ['~/personal/**'] } as never;
    expect(shadowedBy([scoped], ['~/work/**'])).toBeUndefined();
    expect(shadowedBy([], ['~/work/**'])).toBeUndefined();
    // A catch-all added *after* a scoped pairing is the normal, healthy
    // "everything else goes here" shape.
    expect(shadowedBy([scoped], ['**'])).toBeUndefined();
  });
});
