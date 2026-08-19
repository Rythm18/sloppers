import { describe, expect, it } from 'vitest';
import { launchdPlist, systemdUnit } from './install.js';

describe('service file generation', () => {
  it('launchd plist runs the exact node + cli that paired', () => {
    const plist = launchdPlist('/usr/local/bin/node', '/tools/sloppers/dist/cli.js', '/home/dev');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/tools/sloppers/dist/cli.js</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('dev.sloppers.collector');
    expect(plist).toContain('/home/dev/.sloppers/collector.log');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    // A plain boolean `KeepAlive` restarts regardless of exit status — only
    // `SuccessfulExit:false` makes launchd stop relaunching after a clean
    // (status 0) exit, which is what lets the daemon actually stand down
    // instead of restart-looping once every pairing has been dropped.
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
  });

  it('systemd unit restarts on failure', () => {
    const unit = systemdUnit('/usr/bin/node', '/tools/cli.js');
    expect(unit).toContain('ExecStart=/usr/bin/node /tools/cli.js run');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });
});
