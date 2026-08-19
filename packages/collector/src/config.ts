import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultVisibility, visibilitySchema } from '@sloppers/protocol';
import { z } from 'zod';

/**
 * `~/.sloppers/config.json` — written by `sloppers share`, read by the
 * daemon. Contains device keys, so it is chmod 600.
 *
 * v1 shipped in `sloppers@0.1.1` (published, in real use) and holds
 * exactly one pairing inline. v2 generalizes to a `pairings` list, each
 * scoped to one or more directory `match` globs, so a single collector
 * can route sessions from different working directories to different
 * offices (wired up in a later task; this one only defines the shape
 * and the matching function).
 *
 * Write-back timing, decided deliberately: `loadConfig` upgrades a v1
 * document to v2 only in memory — it never writes the upgraded shape
 * back to disk on its own. The file on disk is rewritten only the next
 * time something actually calls `saveConfig` (pausing, hiding a field,
 * adding a pairing, ...). This matters because 0.1.1 is published and in
 * use today: if merely *reading* the file rewrote it as v2, a user who
 * upgrades the collector, is read once with no actual change made, and
 * then downgrades back to 0.1.1 would find 0.1.1's schema
 * (`version: z.literal(1)`) reject the now-v2 file outright — 0.1.1's
 * `loadConfig` returns null on any parse failure, so their existing
 * pairing would look lost even though nothing they did actually changed
 * it. Deferring the rewrite to the first genuine mutation means a pure
 * upgrade-then-downgrade, with no intervening change, never loses
 * anything; only a real edit (which only happens once the user is
 * already committed to the new collector) commits to the new format.
 */

const pairingSchema = z.object({
  server: z.object({
    httpUrl: z.string(),
    wsUrl: z.string(),
  }),
  deviceKey: z.string(),
  memberId: z.string(),
  displayName: z.string(),
  roomCode: z.string(),
  /** Directory globs this pairing applies to — see `matchesPairing`. */
  match: z.array(z.string()),
  visibility: visibilitySchema,
  paused: z.boolean(),
});
export type PairingConfig = z.infer<typeof pairingSchema>;

const configSchemaV1 = z.object({
  version: z.literal(1),
  server: z.object({
    httpUrl: z.string(),
    wsUrl: z.string(),
  }),
  deviceKey: z.string(),
  memberId: z.string(),
  displayName: z.string(),
  roomCode: z.string(),
  visibility: visibilitySchema,
  paused: z.boolean(),
});
type ConfigFileV1 = z.infer<typeof configSchemaV1>;

const configSchemaV2 = z.object({
  version: z.literal(2),
  pairings: z.array(pairingSchema),
});
export type CollectorConfig = z.infer<typeof configSchemaV2>;

/** Accepts either generation as read from disk; see the module doc for why. */
export const configSchema = z.discriminatedUnion('version', [configSchemaV1, configSchemaV2]);

/** Lift a v1 document into the v2 shape (a v2 document passes through unchanged). */
export function upgradeConfig(raw: ConfigFileV1 | CollectorConfig): CollectorConfig {
  if (raw.version === 2) return raw;
  return {
    version: 2,
    pairings: [
      {
        server: raw.server,
        deviceKey: raw.deviceKey,
        memberId: raw.memberId,
        displayName: raw.displayName,
        roomCode: raw.roomCode,
        match: ['**'],
        visibility: raw.visibility,
        paused: raw.paused,
      },
    ],
  };
}

export function configDir(home: string = homedir()): string {
  return join(home, '.sloppers');
}

export function configPath(home: string = homedir()): string {
  return join(configDir(home), 'config.json');
}

export function logPath(home: string = homedir()): string {
  return join(configDir(home), 'collector.log');
}

export function loadConfig(home?: string): CollectorConfig | null {
  const path = configPath(home);
  if (!existsSync(path)) return null;
  try {
    const raw = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return upgradeConfig(raw);
  } catch {
    return null;
  }
}

export function saveConfig(config: CollectorConfig, home?: string): void {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  // Write-then-rename so a concurrently-reading daemon never sees a torn file.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Append a pairing to an existing config, leaving the others untouched. */
export function addPairing(config: CollectorConfig, pairing: PairingConfig): CollectorConfig {
  return { version: 2, pairings: [...config.pairings, pairing] };
}

export function newConfig(init: {
  httpUrl: string;
  wsUrl: string;
  deviceKey: string;
  memberId: string;
  displayName: string;
  roomCode: string;
}): CollectorConfig {
  return {
    version: 2,
    pairings: [
      {
        server: { httpUrl: init.httpUrl, wsUrl: init.wsUrl },
        deviceKey: init.deviceKey,
        memberId: init.memberId,
        displayName: init.displayName,
        roomCode: init.roomCode,
        match: ['**'],
        visibility: { ...defaultVisibility },
        paused: false,
      },
    ],
  };
}

/** Standard "escape every regex metacharacter" character class. */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Glob → RegExp for a single `match` pattern.
 *
 * `**` becomes `.*`; `*` becomes a same-segment wildcard (`[^/\\]*`, so
 * it stops at a path separator). Every other character is escaped as a
 * regex literal FIRST, before either wildcard is expanded — tokenizing
 * with one split on `/(\*\*|\*)/` (which tries the two-star alternative
 * before the one-star one) guarantees `**` can never be corrupted by an
 * earlier, naive `*` substitution. Skipping the escaping step is exactly
 * the classic bug: a directory literally named `my.project` would
 * compile to a regex where `.` matches any character, so `myXproject`
 * would wrongly match too.
 *
 * Separators: both `/` and `\` are accepted as path separators, and
 * neither the pattern nor the cwd is ever rewritten. The collector ships
 * for Windows as well as POSIX, and Windows paths use `\`; converting
 * `\` to `/` (or vice versa) would risk corrupting a POSIX path that
 * happens to contain a literal backslash, so instead both characters are
 * simply treated as equivalent separators wherever a separator matters.
 * This is not a full Windows implementation — no case-insensitivity, no
 * drive-letter or UNC handling — just enough that separators are not
 * silently wrong on a platform this was not tested on.
 */
function globToRegExp(pattern: string): RegExp {
  const escapeLiteral = (literal: string) => literal.replace(REGEX_METACHARACTERS, '\\$&');

  // Path semantics, decided deliberately: a trailing "/**" (or "\**")
  // also matches the directory itself, not only what's beneath it —
  // "~/work/**" must match a session whose cwd is exactly "~/work". That
  // is the ordinary case of cd'ing straight into a paired directory and
  // starting an agent there; excluding it would be a silent surprise.
  // Whether the cwd itself carries a trailing separator must not change
  // the answer either. Peel the trailing "/**" off before tokenizing and
  // re-add it as an optional group, so both cases are covered.
  const trailing = /[/\\]\*\*$/.exec(pattern);
  const base = trailing ? pattern.slice(0, -trailing[0].length) : pattern;

  const body = base
    .split(/(\*\*|\*)/)
    .filter((token) => token !== '')
    .map((token) => {
      if (token === '**') return '.*';
      if (token === '*') return '[^/\\\\]*';
      return escapeLiteral(token);
    })
    .join('');

  // Anchored at both ends: without the trailing `$`, "~/work" would
  // match "~/workshop" as a mere prefix.
  return new RegExp(`^${body}${trailing ? '(?:[/\\\\].*)?' : ''}$`);
}

/**
 * Expand a leading `~` to `homedir()`: a bare `~`, or `~/...` / `~\...`.
 * `~otheruser/...` is left as a literal string — no other-user home
 * directory lookup.
 */
function expandTilde(pattern: string): string {
  if (pattern === '~') return homedir();
  if (pattern.startsWith('~/') || pattern.startsWith('~\\')) {
    return homedir() + pattern.slice(1);
  }
  return pattern;
}

/**
 * Whether a session's cwd falls under one of a pairing's `match` globs.
 * A pure per-pairing predicate: it has no view of sibling pairings, so
 * when more than one pairing could match the same cwd, picking a winner
 * is the router's job (a later task), not this function's.
 *
 * See `globToRegExp`'s doc for the wildcard, escaping, trailing-slash,
 * and separator rules — this is the routing primitive a later task uses
 * for every live session, so a silent surprise here sends someone's work
 * to the wrong office. A cwd that is not under `~` (or outside any
 * pattern's literal prefix) at all simply does not match; there is no
 * fallback.
 */
export function matchesPairing(pairing: PairingConfig, cwd: string): boolean {
  return pairing.match.some((pattern) => globToRegExp(expandTilde(pattern)).test(cwd));
}

/**
 * Directories spanning everything a session's `cwd` can be, used to decide
 * whether a pairing constrains anything at all (see `isCatchAll`).
 *
 * Each probe is here to exclude a specific near-miss:
 * - `''` — a harness that never reported a cwd. `routeSessions` routes such a
 *   session as the empty path, so a fallback has to accept it.
 * - `/` — the filesystem root, which a pattern needing at least one path
 *   segment (`~/*`) rejects.
 * - a POSIX path outside home — excludes `~/**`, which looks sweeping but
 *   claims nothing under `/srv`, `/tmp`, or any other root-level tree.
 * - a POSIX path inside home — the converse, so home is not treated as
 *   special.
 * - a Windows path — excludes `/**`, which is every path on POSIX but no path
 *   at all on Windows. To be clear about what this is and is not: auto-start
 *   only installs on darwin and linux (`serviceSupported`), so on every
 *   platform the daemon actually runs on today, `/**` *is* universal.
 *   Excluding it is a portability choice, matching `globToRegExp`'s own
 *   decision to honour `\` as a separator — not a claim that anyone is
 *   running this on Windows. The trade is deliberate: catch-all detection
 *   that varied by platform would give the same config different routing on
 *   different machines, which is worse in a tool people run on several and
 *   compare results between. `shadowedBy` covers the gap, warning at `share`
 *   time when a `/**` pairing ahead of a new one would starve it.
 */
function catchAllProbes(): string[] {
  const home = homedir();
  return ['', '/', '/srv/apps/api', `${home}/work/api`, 'C:\\Users\\dev\\work'];
}

/**
 * Whether a pairing claims every directory there is — which makes it a
 * fallback rather than a competitor, and is why `routingOrder` puts it last.
 *
 * Decided by behaviour, not by spelling: a pairing is a catch-all when it
 * matches every probe above, so `**`, `***`, and a star followed by a
 * separator and two stars all qualify, while `/**`, `~/**` and `**` followed
 * by a separator do not. Keying on the literal string `**` would be both too
 * narrow (missing equivalent spellings) and a lie about what the matcher does.
 *
 * The predicate is over the whole pairing, not one pattern, because
 * `matchesPairing` is an `or` across `match`: a pairing listing both
 * `~/work/**` and `**` claims everything, and is a fallback whatever else it
 * mentions.
 */
export function isCatchAll(pairing: PairingConfig): boolean {
  return catchAllProbes().every((probe) => matchesPairing(pairing, probe));
}

/**
 * A concrete directory standing in for everything a `match` glob claims:
 * the pattern with `~` expanded and truncated at its first wildcard. Used to
 * ask whether some *other* pairing already claims the same region.
 *
 * A catch-all `**` reduces to the empty string, which only another catch-all
 * matches — exactly the answer wanted, since only a catch-all can shadow a
 * catch-all.
 */
export function samplePathFor(pattern: string): string {
  const expanded = expandTilde(pattern);
  const wildcard = expanded.indexOf('*');
  const head = wildcard < 0 ? expanded : expanded.slice(0, wildcard);
  return head.replace(/[/\\]+$/, '');
}

/**
 * The first of `earlier` that already claims every directory `match` would,
 * if any. Routing is first-match-wins, so a pairing ahead of a new one
 * silently starves it: the new workspace connects, stays connected, and never
 * receives a single session. That is a confusing failure to discover from the
 * outside, so `sloppers share` says it out loud at the moment it becomes true.
 *
 * `earlier` must be the pairings that actually precede the new one in
 * *routing* order, not config order — a catch-all sorts behind every specific
 * pairing (see `routingOrder`), so an inherited `**` is not ahead of anything
 * and must not be reported as shadowing it.
 */
export function shadowedBy(
  earlier: readonly PairingConfig[],
  match: readonly string[],
): PairingConfig | undefined {
  const samples = match.map(samplePathFor);
  return earlier.find((pairing) => samples.every((sample) => matchesPairing(pairing, sample)));
}
