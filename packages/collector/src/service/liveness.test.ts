import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configDir, pidPath } from '../config.js';
import {
  awaitDaemon,
  clearPidfile,
  daemonLiveness,
  type Liveness,
  readLaunchctlList,
  readPidfile,
  readSystemctlIsActive,
  writePidfile,
} from './liveness.js';

/**
 * Everything the collector used to say about itself came from a config file:
 * `share` announced the avatar was live the instant a plist was written, and
 * `status` printed `sharing on` off a boolean nobody had checked against a
 * process. These are about the two questions that replaced them — is a
 * process there, and if we cannot tell, do we say so.
 */

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'sloppers-liveness-'));
  mkdirSync(configDir(home), { recursive: true });
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('reading a service manager', () => {
  it('takes a PID out of launchctl list', () => {
    const loaded = [
      '{',
      '\t"LimitLoadToSessionType" = "Aqua";',
      '\t"Label" = "dev.sloppers.collector";',
      '\t"OnDemand" = false;',
      '\t"LastExitStatus" = 0;',
      '\t"PID" = 51234;',
      '}',
    ].join('\n');
    expect(readLaunchctlList(loaded)).toEqual({ state: 'running', pid: 51234 });
  });

  it('reads a loaded job with no PID as stopped, because nothing is sharing', () => {
    // KeepAlive waiting to relaunch, or a job that exited clean and was left
    // alone. Loaded is not running, and only one of the two is the question.
    const idle = [
      '{',
      '\t"Label" = "dev.sloppers.collector";',
      '\t"LastExitStatus" = 0;',
      '}',
    ].join('\n');
    expect(readLaunchctlList(idle)).toEqual({ state: 'stopped' });
  });

  it('reads systemd’s one word', () => {
    expect(readSystemctlIsActive('active\n')).toEqual({ state: 'running' });
    // A unit on its way up is up within a second or two — not a failure for
    // somebody to go and investigate.
    expect(readSystemctlIsActive('activating\n')).toEqual({ state: 'running' });
    expect(readSystemctlIsActive('inactive\n')).toEqual({ state: 'stopped' });
    expect(readSystemctlIsActive('failed\n')).toEqual({ state: 'stopped' });
  });

  it('treats silence as uncertainty rather than as a no', () => {
    expect(readSystemctlIsActive('')).toMatchObject({ state: 'unknown' });
  });
});

describe('the daemon’s own pidfile', () => {
  /** No service installed — so these test the pidfile and nothing else. */
  const noService = async (): Promise<Liveness> => ({ state: 'stopped' });

  it('finds a running process — including one started by hand in a terminal', async () => {
    // The case no service manager can answer: `sloppers run`, in a shell,
    // which is exactly what somebody debugging their setup is doing.
    const home = tempHome();
    writePidfile(home);

    expect(readPidfile(home)).toBe(process.pid);
    await expect(daemonLiveness(home, noService)).resolves.toEqual({
      state: 'running',
      pid: process.pid,
    });
  });

  it('does not believe a pidfile left behind by a dead process', async () => {
    const home = tempHome();
    // Larger than any pid this system will hand out, so nothing answers it.
    writeFileSync(pidPath(home), '4194303\n');

    await expect(daemonLiveness(home, noService)).resolves.toEqual({ state: 'stopped' });
  });

  it('ignores a pidfile that is not a pid', async () => {
    const home = tempHome();
    writeFileSync(pidPath(home), 'not a number\n');

    expect(readPidfile(home)).toBeNull();
    await expect(daemonLiveness(home, noService)).resolves.toMatchObject({ state: 'stopped' });
  });

  it('falls back to the service manager when there is no pidfile at all', async () => {
    // A daemon from a build old enough not to write one, still running under
    // the auto-start it was installed with.
    const home = tempHome();
    const running = async (): Promise<Liveness> => ({ state: 'running', pid: 99 });

    await expect(daemonLiveness(home, running)).resolves.toEqual({ state: 'running', pid: 99 });
  });

  it('passes the service manager’s uncertainty through rather than rounding it to no', async () => {
    const home = tempHome();
    const dunno = async (): Promise<Liveness> => ({ state: 'unknown', why: 'no auto-start here' });

    await expect(daemonLiveness(home, dunno)).resolves.toMatchObject({ state: 'unknown' });
  });

  /**
   * `sloppers share` installs a service and then says what happened. launchd
   * returns from `bootstrap` as soon as the job is loaded and spawns it a
   * moment later, so the answer has to be waited for — but only for a few
   * seconds, and never at the cost of inventing one.
   */
  describe('waiting for a service that was just installed', () => {
    it('stops the moment the daemon is up', async () => {
      const home = tempHome();
      let asked = 0;
      const comingUp = async (): Promise<Liveness> =>
        ++asked < 3 ? { state: 'stopped' } : { state: 'running', pid: 7 };
      const slept: number[] = [];

      await expect(
        awaitDaemon(
          5000,
          home,
          async (ms) => {
            slept.push(ms);
          },
          comingUp,
        ),
      ).resolves.toEqual({ state: 'running', pid: 7 });
      expect(slept).toHaveLength(2);
    });

    it('reports what it actually found rather than waiting forever', async () => {
      // The honest report when a service was installed and the process behind
      // it never appeared — which is the whole reason `share` stopped simply
      // announcing that the avatar was live.
      const home = tempHome();
      const never = async (): Promise<Liveness> => ({ state: 'stopped' });

      await expect(awaitDaemon(0, home, async () => {}, never)).resolves.toEqual({
        state: 'stopped',
      });
    });
  });

  it('clears its own claim on the way out, and only its own', () => {
    const home = tempHome();
    writePidfile(home);
    clearPidfile(home);
    expect(readPidfile(home)).toBeNull();

    // Somebody else's daemon: not ours to retract.
    writeFileSync(pidPath(home), '4194303\n');
    clearPidfile(home);
    expect(readPidfile(home)).toBe(4194303);
  });
});
