#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { defaultVisibility, relinkMintResponseSchema, type Visibility } from '@sloppers/protocol';
import pc from 'picocolors';
import { builtinAdapters } from './adapters/index.js';
import { describeTargets, parseShareArgs, renderStatus, selectPairings } from './cli-support.js';
import {
  addPairing,
  type CollectorConfig,
  configPath,
  loadConfig,
  type PairingConfig,
  saveConfig,
  shadowedBy,
} from './config.js';
import { SessionTracker } from './core/tracker.js';
import { seedTracker } from './core/watcher.js';
import { exitCodeFor, routingOrder, startDaemon } from './daemon.js';
import { parseShareTarget, redeemPairingCode, wsUrlFor } from './net/pair.js';
import { installService, serviceSupported, uninstallService } from './service/install.js';

const CLI_PATH = fileURLToPath(import.meta.url);
const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

const HELP = `sloppers ${VERSION} — share what your coding agents are doing with your office

usage:
  sloppers share <code>     pair this machine (get the code from the office web app)
     --match '<glob>'         directories this workspace claims, e.g. '~/work/**'
     --foreground             run in this terminal instead of installing auto-start
  sloppers run              run the collector in the foreground
  sloppers status           show every workspace, what it claims, and what is shared
  sloppers pause [ws]       stop sharing (stays paired; office shows you as not sharing)
  sloppers resume [ws]      resume sharing
  sloppers hide <field> [ws]  stop sharing a field: title | project | branch | model | tokens
  sloppers show <field> [ws]  share a field again
  sloppers relink [ws]      sign a fresh browser back in as you (new laptop, cleared storage)
  sloppers uninstall        remove auto-start (config stays; delete ~/.sloppers to forget)

Pair more than once to share different directories with different offices.
Each session goes to the first workspace whose --match claims its directory,
in config order — except a workspace matching everything, which is always the
fallback. [ws] names one by room code (default: all of them). \`sloppers
status\` lists any session that matches none, since those are shared with
nobody, and prints the config file to edit a workspace's directories.

Only derived status ever leaves this machine — never prompts, code, or files.
Directory paths stay local too: the office sees a project name, never a path.
`;

function log(message: string): void {
  console.log(`${pc.dim(new Date().toISOString())} ${message}`);
}

function fail(message: string): never {
  console.error(pc.red(message));
  // Every non-`run` command lands here for an ordinary usage/network
  // failure (standard Unix "the command failed" convention); `run` also
  // lands here when `startDaemon` refuses to start at all (its config could
  // not be read) — see `exitCodeFor`'s doc for why that specific case is
  // deliberately treated as retryable rather than terminal.
  process.exit(exitCodeFor('error'));
}

/**
 * Which directories the workspace being paired should claim.
 *
 * The first pairing on a machine is a catch-all, which is the
 * single-workspace behaviour every 0.1.1 user already has. A second one has
 * to say what is its own, because routing is first-match-wins: without a
 * pattern it would either claim everything (stealing from the workspace
 * already there) or nothing at all.
 *
 * Asked *before* the code is redeemed, so backing out at the prompt does not
 * burn a one-time pairing code.
 */
async function resolveMatch(existing: number, flag: string | undefined): Promise<string[]> {
  if (existing === 0) return ['**'];
  const given = flag?.trim();
  if (given) return [given];
  if (!process.stdin.isTTY) {
    fail(
      "this machine is already paired — pass --match '<glob>' to say which directories belong to the new workspace",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question('which directories belong to this workspace? (e.g. ~/work/**) ')
  ).trim();
  rl.close();
  if (!answer) fail("no pattern given — re-run with --match '<glob>'");
  return [answer];
}

async function share(args: string[]): Promise<void> {
  const { target, foreground, match } = parseShareArgs(args);
  if (!target) fail("usage: sloppers share <code> [--match '<glob>']  (mint one in the web app)");

  const existing = loadConfig();
  const before = existing?.pairings ?? [];
  const patterns = await resolveMatch(before.length, match);

  const { code, httpUrl } = parseShareTarget(target);
  const redeemed = await redeemPairingCode(httpUrl, code);
  const pairing: PairingConfig = {
    server: { httpUrl, wsUrl: wsUrlFor(httpUrl) },
    deviceKey: redeemed.deviceKey,
    memberId: redeemed.memberId,
    displayName: redeemed.displayName,
    roomCode: redeemed.roomCode,
    match: patterns,
    visibility: { ...defaultVisibility },
    paused: false,
  };
  const next: CollectorConfig = existing
    ? addPairing(existing, pairing)
    : { version: 2, pairings: [pairing] };
  saveConfig(next);
  console.log(
    `${pc.green('✓')} paired as ${pc.bold(redeemed.displayName)} in room ${pc.bold(redeemed.roomCode)}`,
  );
  if (before.length > 0) {
    console.log(pc.dim(`  claiming ${patterns.join(', ')}`));
    // First match wins, so a pairing ahead of this one that already claims
    // the same directories leaves it permanently empty. Say so now, rather
    // than letting them wonder why the new office stays silent. "Ahead" is
    // routing order, not config order: an inherited catch-all sorts behind
    // this pairing and starves nothing, so it must not be reported.
    const effective = routingOrder(next.pairings);
    const shadow = shadowedBy(effective.slice(0, effective.indexOf(pairing)), patterns);
    if (shadow) {
      console.log(
        pc.yellow(
          `  heads-up: room ${shadow.roomCode} comes first and already claims ${shadow.match.join(', ')},`,
        ),
      );
      console.log(
        pc.yellow(
          `  so nothing will route here until you narrow it (edit "match" in ~/.sloppers/config.json)`,
        ),
      );
    }
  }

  if (!foreground && serviceSupported()) {
    try {
      await installService(CLI_PATH);
      console.log(`${pc.green('✓')} auto-start installed — your avatar is live from now on`);
      console.log(pc.dim('  logs: ~/.sloppers/collector.log · stop sharing: sloppers pause'));
      return;
    } catch (error) {
      console.log(
        pc.yellow(`auto-start failed (${(error as Error).message}); running in foreground`),
      );
    }
  }
  console.log(pc.dim('running in foreground — ctrl-c to stop'));
  runForeground();
}

function runForeground(): void {
  const daemon = startDaemon({
    collectorVersion: VERSION,
    log,
    // The daemon already dropped every rejected pairing on the way here —
    // this only fires once none are left, so restarting would just throw
    // straight back out of `startDaemon` ("Not paired yet"). Exit clean so
    // launchd (KeepAlive: SuccessfulExit:false) and systemd (Restart=on-
    // failure) do NOT restart us; the user has to run `sloppers share
    // <code>` again to get back in.
    onUnknownDevice: () => process.exit(exitCodeFor('unknown-device')),
    // Another machine took over — exit clean so the service does NOT restart.
    onSuperseded: () => process.exit(exitCodeFor('superseded')),
  });
  const shutdown = () => {
    // A deliberate stop signal (`sloppers uninstall`, or the OS itself
    // stopping/restarting the service) — not a stand-down and not an error,
    // so it is intentionally not routed through `exitCodeFor`.
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * The paired config, or a clean exit explaining there isn't one. Every
 * command below acts on one or more of its pairings, chosen with `[workspace]`.
 */
function paired(): CollectorConfig {
  const config = loadConfig();
  if (!config || config.pairings.length === 0) {
    fail('not paired — run `sloppers share <code>` (mint one in the office web app)');
  }
  return config;
}

/**
 * The pairings a `[workspace]` argument names, or all of them when it is
 * absent. An unknown name is an error listing the real ones, never a silent
 * fallback to "all" — `sloppers pause typo` must not pause everything.
 */
function targeted(config: CollectorConfig, target: string | undefined): number[] {
  const chosen = selectPairings(config.pairings, target);
  if (chosen.length === 0) {
    fail(
      `no workspace called "${target}" — try one of: ${config.pairings.map((p) => p.roomCode).join(', ')}`,
    );
  }
  return chosen;
}

function status(): void {
  const config = loadConfig();
  if (!config || config.pairings.length === 0) {
    console.log('not paired — run `sloppers share <code>` (mint one in the office web app)');
    return;
  }
  const adapters = builtinAdapters();
  const tracker = new SessionTracker(adapters);
  seedTracker(adapters, tracker);
  for (const line of renderStatus(config, tracker.routableSnapshot(Date.now()), configPath())) {
    console.log(line);
  }
}

/**
 * Identity rescue: this machine's device key proves who we are, so it can
 * mint a link that signs any browser back in as this member — no login,
 * no password reset, just open the URL.
 */
async function relink(target: string | undefined): Promise<void> {
  const config = paired();
  // One link signs a browser in as one member in one office, so this is the
  // one command that cannot default to "all". With a single workspace that
  // is unchanged; with several, name the one you mean.
  const chosen = targeted(config, target);
  if (chosen.length > 1) {
    fail(
      `several workspaces are paired — say which: ${config.pairings.map((p) => p.roomCode).join(', ')}`,
    );
  }
  const pairing = config.pairings[chosen[0] ?? 0];
  if (!pairing) fail('not paired yet — run `sloppers share <code>` first');
  const res = await fetch(`${pairing.server.httpUrl}/api/relink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: pairing.deviceKey }),
  }).catch(() => null);
  if (!res?.ok) {
    fail(
      res?.status === 403
        ? 'the server no longer recognizes this device — run `sloppers share` again'
        : `could not reach ${pairing.server.httpUrl}`,
    );
  }
  const minted = relinkMintResponseSchema.parse(await res.json());
  // The token rides in the URL fragment: fragments never reach the server,
  // so it stays out of access logs and Referer headers.
  const url = `${pairing.server.httpUrl}/?room=${encodeURIComponent(minted.roomCode)}#relink=${minted.token}`;
  console.log(`${pc.green('✓')} open this link in the browser you want to sign in:`);
  console.log(`  ${pc.cyan(url)}`);
  console.log(pc.dim('  works once, expires in 10 minutes'));
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (opener) {
    execFile(opener, [url], () => {
      // Best effort — the printed link is the real interface.
    });
  }
}

/** Rewrite just the chosen pairings, leaving the rest of the list untouched. */
function updatePairings(
  config: CollectorConfig,
  chosen: number[],
  edit: (pairing: PairingConfig) => PairingConfig,
): void {
  saveConfig({
    ...config,
    pairings: config.pairings.map((pairing, index) =>
      chosen.includes(index) ? edit(pairing) : pairing,
    ),
  });
}

function setPaused(paused: boolean, target: string | undefined): void {
  const config = paired();
  const chosen = targeted(config, target);
  updatePairings(config, chosen, (pairing) => ({ ...pairing, paused }));
  console.log(
    `${paused ? 'sharing paused' : 'sharing resumed'} for ${describeTargets(config.pairings, chosen)}`,
  );
}

function setVisibility(
  field: string | undefined,
  value: boolean,
  target: string | undefined,
): void {
  const config = paired();
  const chosen = targeted(config, target);
  const fields = Object.keys(config.pairings[0]?.visibility ?? {}) as (keyof Visibility)[];
  if (!field || !fields.includes(field as keyof Visibility)) {
    fail(`expected one of: ${fields.join(', ')}`);
  }
  updatePairings(config, chosen, (pairing) => ({
    ...pairing,
    visibility: { ...pairing.visibility, [field]: value },
  }));
  console.log(
    `${field} is now ${value ? 'shared' : 'hidden'} for ${describeTargets(config.pairings, chosen)}`,
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'share':
      await share(args);
      break;
    case 'run':
      runForeground();
      break;
    case 'status':
      status();
      break;
    case 'pause':
      setPaused(true, args[0]);
      break;
    case 'resume':
      setPaused(false, args[0]);
      break;
    case 'hide':
      setVisibility(args[0], false, args[1]);
      break;
    case 'show':
      setVisibility(args[0], true, args[1]);
      break;
    case 'relink':
      await relink(args[0]);
      break;
    case 'uninstall':
      await uninstallService();
      console.log('auto-start removed · delete ~/.sloppers to forget this pairing');
      break;
    case '--version':
    case '-v':
      console.log(VERSION);
      break;
    default:
      console.log(HELP);
      process.exit(command === undefined || command === 'help' ? 0 : 1);
  }
}

main().catch((error: unknown) => fail((error as Error).message));
