#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { billedTokens, type Visibility } from '@sloppers/protocol';
import pc from 'picocolors';
import { builtinAdapters } from './adapters/index.js';
import { loadConfig, newConfig, saveConfig } from './config.js';
import { SessionTracker } from './core/tracker.js';
import { seedTracker } from './core/watcher.js';
import { startDaemon } from './daemon.js';
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
     --foreground             run in this terminal instead of installing auto-start
  sloppers run              run the collector in the foreground
  sloppers status           show pairing, live sessions, and what is shared
  sloppers pause            stop sharing (stays paired; office shows you as not sharing)
  sloppers resume           resume sharing
  sloppers hide <field>     stop sharing a field: title | project | branch | model | tokens
  sloppers show <field>     share a field again
  sloppers uninstall        remove auto-start (config stays; delete ~/.sloppers to forget)

Only derived status ever leaves this machine — never prompts, code, or files.
`;

function log(message: string): void {
  console.log(`${pc.dim(new Date().toISOString())} ${message}`);
}

function fail(message: string): never {
  console.error(pc.red(message));
  process.exit(1);
}

async function share(args: string[]): Promise<void> {
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) fail('usage: sloppers share <code>  (mint one in the office web app)');
  const foreground = args.includes('--foreground');

  const { code, httpUrl } = parseShareTarget(target);
  const redeemed = await redeemPairingCode(httpUrl, code);
  saveConfig(
    newConfig({
      httpUrl,
      wsUrl: wsUrlFor(httpUrl),
      deviceKey: redeemed.deviceKey,
      memberId: redeemed.memberId,
      displayName: redeemed.displayName,
      roomCode: redeemed.roomCode,
    }),
  );
  console.log(
    `${pc.green('✓')} paired as ${pc.bold(redeemed.displayName)} in room ${pc.bold(redeemed.roomCode)}`,
  );

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
    // Exit non-zero so launchd/systemd restart us; once the user re-pairs,
    // the restarted daemon reads the new config and recovers on its own.
    onUnknownDevice: () => process.exit(1),
    // Another machine took over — exit clean so the service does NOT restart.
    onSuperseded: () => process.exit(0),
  });
  const shutdown = () => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function status(): void {
  const config = loadConfig();
  if (!config) {
    console.log('not paired — run `sloppers share <code>` (mint one in the office web app)');
    return;
  }
  console.log(`server   ${config.server.httpUrl}`);
  console.log(`room     ${config.roomCode}`);
  console.log(`name     ${config.displayName}`);
  console.log(`sharing  ${config.paused ? pc.yellow('paused') : pc.green('on')}`);
  const hidden = (Object.entries(config.visibility) as [keyof Visibility, boolean][])
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (hidden.length > 0) console.log(`hidden   ${hidden.join(', ')}`);

  const adapters = builtinAdapters();
  const tracker = new SessionTracker(adapters);
  seedTracker(adapters, tracker);
  const sessions = tracker.snapshot(Date.now());
  if (sessions.length === 0) {
    console.log('\nno live agent sessions found');
    return;
  }
  console.log(`\n${sessions.length} live session(s):`);
  for (const s of sessions) {
    const tokens = s.tokens ? ` · ${billedTokens(s.tokens).toLocaleString()} tok` : '';
    const title = s.title ? ` — ${s.title}` : '';
    console.log(
      `  ${pc.bold(s.harness)} ${s.state.padEnd(7)} ${s.project ?? '?'}${title}${tokens}`,
    );
  }
}

function setPaused(paused: boolean): void {
  const config = loadConfig();
  if (!config) fail('not paired yet');
  saveConfig({ ...config, paused });
  console.log(paused ? 'sharing paused' : 'sharing resumed');
}

function setVisibility(field: string | undefined, value: boolean): void {
  const config = loadConfig();
  if (!config) fail('not paired yet');
  const fields = Object.keys(config.visibility) as (keyof Visibility)[];
  if (!field || !fields.includes(field as keyof Visibility)) {
    fail(`expected one of: ${fields.join(', ')}`);
  }
  saveConfig({
    ...config,
    visibility: { ...config.visibility, [field]: value },
  });
  console.log(`${field} is now ${value ? 'shared' : 'hidden'}`);
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
      setPaused(true);
      break;
    case 'resume':
      setPaused(false);
      break;
    case 'hide':
      setVisibility(args[0], false);
      break;
    case 'show':
      setVisibility(args[0], true);
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
