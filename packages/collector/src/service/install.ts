import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { logPath } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * Auto-start for the collector daemon, so sharing is a run-once affair:
 * launchd on macOS, a systemd user unit on Linux. Both invoke the exact
 * node binary and CLI script that ran `sloppers share`, which keeps working
 * for npx installs as long as the npx cache lives — `sloppers share` heals
 * a broken install by simply rewriting the service.
 */

const LAUNCHD_LABEL = 'dev.sloppers.collector';
const SYSTEMD_UNIT = 'sloppers-collector.service';

export function serviceSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

export function launchdPlist(nodeBin: string, cliScript: string, home: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${cliScript}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${logPath(home)}</string>
  <key>StandardErrorPath</key><string>${logPath(home)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(nodeBin: string, cliScript: string): string {
  return `[Unit]
Description=sloppers collector — share coding-agent activity with your office

[Service]
ExecStart=${nodeBin} ${cliScript} run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function launchdPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

export async function installService(cliScript: string, home: string = homedir()): Promise<void> {
  const nodeBin = process.execPath;
  if (process.platform === 'darwin') {
    const plist = launchdPlistPath(home);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, launchdPlist(nodeBin, cliScript, home));
    const uid = userInfo().uid;
    // Replace any previous incarnation, then load. bootout failing is fine
    // (nothing was loaded); bootstrap falling back to legacy load covers
    // older macOS.
    await execFileAsync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]).catch(() => {});
    await execFileAsync('launchctl', ['bootstrap', `gui/${uid}`, plist]).catch(async () => {
      await execFileAsync('launchctl', ['load', '-w', plist]);
    });
    return;
  }
  if (process.platform === 'linux') {
    const unit = systemdUnitPath(home);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, systemdUnit(nodeBin, cliScript));
    await execFileAsync('systemctl', ['--user', 'daemon-reload']);
    await execFileAsync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
    return;
  }
  throw new Error(`Auto-start is not supported on ${process.platform}; use \`sloppers run\`.`);
}

export async function uninstallService(home: string = homedir()): Promise<void> {
  if (process.platform === 'darwin') {
    const plist = launchdPlistPath(home);
    const uid = userInfo().uid;
    await execFileAsync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]).catch(() => {});
    if (existsSync(plist)) rmSync(plist);
    return;
  }
  if (process.platform === 'linux') {
    const unit = systemdUnitPath(home);
    await execFileAsync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]).catch(() => {});
    if (existsSync(unit)) rmSync(unit);
    await execFileAsync('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  }
}
