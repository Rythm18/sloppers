import { billedTokens, type SessionSnapshot, type Visibility } from '@sloppers/protocol';
import pc from 'picocolors';
import { type CollectorConfig, isCatchAll, type PairingConfig } from './config.js';
import type { RoutableSession } from './core/types.js';
import { routeSessions, unroutedSessions } from './daemon.js';

/**
 * The pure logic behind the CLI commands, kept out of `cli.ts` so it can be
 * tested without running the executable (cli.ts calls `main()` on import).
 */

export interface ShareArgs {
  /** The pairing code (or URL); the one positional argument. */
  target: string | undefined;
  foreground: boolean;
  /** `--match '<glob>'`, which skips the interactive prompt. */
  match: string | undefined;
}

/**
 * Parse `sloppers share`'s arguments.
 *
 * Written as a real scan rather than "the first argument that isn't a flag",
 * because `--match` takes a value: `sloppers share --match '~/work/**' CODE`
 * would otherwise pair with the *glob* as its code. The value is consumed
 * whatever it looks like, so a pattern that begins with a dash still works.
 */
export function parseShareArgs(args: readonly string[]): ShareArgs {
  const MATCH_EQ = '--match=';
  let target: string | undefined;
  let match: string | undefined;
  let foreground = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--foreground') {
      foreground = true;
    } else if (arg.startsWith(MATCH_EQ)) {
      match = arg.slice(MATCH_EQ.length);
    } else if (arg === '--match') {
      i += 1;
      match = args[i];
    } else if (!arg.startsWith('--')) {
      target ??= arg;
    }
  }
  return { target, foreground, match };
}

/**
 * Which pairings a command targets: every one when no workspace is named
 * (the default, so `sloppers pause` still means "stop sharing, everywhere"),
 * otherwise those whose room code — or, failing that, display name — matches.
 * An empty result means the name matched nothing, which callers report rather
 * than silently applying to everything.
 */
export function selectPairings(
  pairings: readonly PairingConfig[],
  target: string | undefined,
): number[] {
  if (target === undefined) return pairings.map((_, index) => index);
  const needle = target.trim().toLowerCase();
  const indicesWhere = (pick: (pairing: PairingConfig) => string) =>
    pairings.flatMap((pairing, index) => (pick(pairing).toLowerCase() === needle ? [index] : []));
  const byRoom = indicesWhere((pairing) => pairing.roomCode);
  return byRoom.length > 0 ? byRoom : indicesWhere((pairing) => pairing.displayName);
}

/** The room codes a command is about to act on, for its confirmation line. */
export function describeTargets(pairings: readonly PairingConfig[], chosen: number[]): string {
  return chosen.map((index) => pairings[index]?.roomCode ?? '?').join(', ');
}

function describeSession(snapshot: SessionSnapshot): string {
  const tokens = snapshot.tokens ? ` · ${billedTokens(snapshot.tokens).toLocaleString()} tok` : '';
  const title = snapshot.title ? ` — ${snapshot.title}` : '';
  return `${pc.bold(snapshot.harness)} ${snapshot.state.padEnd(7)} ${snapshot.project ?? '?'}${title}${tokens}`;
}

/**
 * What `sloppers status` prints: every workspace with the directories it
 * claims and the sessions currently routed to it, then — the part that only
 * exists because routing can silently drop work — the live sessions no
 * workspace matches at all.
 *
 * That last block is the whole reason this is a rendered list rather than a
 * count. A session under no pattern is shared with nobody and reported
 * nowhere; without seeing it here, someone whose tokens stopped counting has
 * no way to find out that a pattern is wrong. Their cwd is printed in full,
 * which is safe (this is the owner's own terminal, and it never reaches a
 * wire) and is exactly the information needed to fix the pattern.
 *
 * `configFilePath` is printed for the same reason: changing what a workspace
 * claims means editing `match` in that file, and there is no command for it.
 * Naming the path makes hand-editing a documented escape hatch instead of
 * something a person has to guess at.
 */
export function renderStatus(
  config: CollectorConfig,
  sessions: readonly RoutableSession[],
  configFilePath: string,
): string[] {
  const lines: string[] = [`config   ${configFilePath}`, ''];
  const routed = routeSessions(sessions, config.pairings);

  config.pairings.forEach((pairing, index) => {
    if (index > 0) lines.push('');
    lines.push(
      `workspace ${index + 1}  room ${pc.bold(pairing.roomCode)}  as ${pairing.displayName}`,
    );
    lines.push(`  server   ${pairing.server.httpUrl}`);
    // A catch-all is the fallback whatever line it sits on, so say so here —
    // otherwise an empty catch-all listed first reads like a bug.
    const fallback = isCatchAll(pairing) ? pc.dim('  (fallback — claims whatever is left)') : '';
    lines.push(`  match    ${pairing.match.join(', ')}${fallback}`);
    lines.push(`  sharing  ${pairing.paused ? pc.yellow('paused') : pc.green('on')}`);
    const hidden = (Object.entries(pairing.visibility) as [keyof Visibility, boolean][])
      .filter(([, shared]) => !shared)
      .map(([field]) => field);
    if (hidden.length > 0) lines.push(`  hidden   ${hidden.join(', ')}`);
    const mine = routed.get(pairing) ?? [];
    if (mine.length === 0) {
      lines.push('  sessions none routed here');
    } else {
      lines.push(`  sessions ${mine.length} routed here:`);
      for (const session of mine) lines.push(`    ${describeSession(session.snapshot)}`);
    }
  });

  if (sessions.length === 0) {
    lines.push('');
    lines.push('no live agent sessions found');
    return lines;
  }

  const orphans = unroutedSessions(sessions, config.pairings);
  if (orphans.length > 0) {
    lines.push('');
    lines.push(
      `${orphans.length} live session(s) match no workspace — their tokens count nowhere:`,
    );
    for (const session of orphans) {
      lines.push(
        `    ${describeSession(session.snapshot)}  ${pc.dim(session.cwd ?? '(directory unknown)')}`,
      );
    }
    lines.push(
      pc.dim('  fix it with: sloppers share <code> --match \'<glob>\', or edit "match" above'),
    );
  }
  return lines;
}
