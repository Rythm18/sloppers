import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { pidPath } from '../config.js';
import { LAUNCHD_LABEL, SYSTEMD_UNIT, serviceSupported } from './install.js';

const execFileAsync = promisify(execFile);

/**
 * Whether the collector daemon is actually running.
 *
 * Everything the collector said about itself used to come from the config
 * file: `share` printed "your avatar is live from now on" the instant the
 * plist was written, and `status` printed `sharing on` off a boolean nobody
 * had checked against a process. Both were true about the *intention* and
 * silent about the outcome, which is the one thing somebody running a
 * diagnostic is asking for.
 *
 * `unknown` is a first-class answer and not a rounding of "no". There are
 * paths where liveness genuinely cannot be established — no service manager
 * on this platform, a `launchctl` that will not answer — and printing a
 * confident "not running" there would be the same failure over again, in the
 * other direction.
 */
export type Liveness =
  | { state: 'running'; pid?: number }
  | { state: 'stopped' }
  | { state: 'unknown'; why: string };

/**
 * A pid that a process is answering to. Signal 0 performs the permission and
 * existence checks without delivering anything.
 *
 * Not proof of *this* program: pids are recycled, and a long-dead daemon's
 * number can belong to somebody's editor by the time anyone asks. It is the
 * cheap check that catches the case that actually happens — a crashed daemon
 * leaving its pidfile behind — and being wrong costs an over-optimistic line
 * in `status`, which the office itself then contradicts.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means somebody else's process holds that pid — alive, just not
    // ours to signal. ESRCH is the real "nothing there".
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The daemon's own claim about itself, or null when it has made none. */
export function readPidfile(home?: string): number | null {
  try {
    const raw = readFileSync(pidPath(home), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Called by the daemon on the way up. Best effort — never fatal. */
export function writePidfile(home?: string): void {
  try {
    writeFileSync(pidPath(home), `${process.pid}\n`);
  } catch {
    // A home directory we cannot write to is not a reason to refuse to share.
  }
}

/** Called by the daemon on the way down, so the next read is not a ghost. */
export function clearPidfile(home?: string): void {
  try {
    if (readPidfile(home) === process.pid) rmSync(pidPath(home));
  } catch {
    // Already gone, or never ours to remove.
  }
}

/**
 * `launchctl list <label>`'s answer, which is a plist-ish dict when the job
 * is loaded and a non-zero exit when it is not. A loaded job that is not
 * currently running has no `PID` key at all — that is `KeepAlive` waiting to
 * relaunch it, or a job that exited clean and was left alone, and either way
 * nothing is sharing.
 */
export function readLaunchctlList(stdout: string): Liveness {
  const pid = /"PID"\s*=\s*(\d+)/.exec(stdout);
  if (!pid?.[1]) return { state: 'stopped' };
  return { state: 'running', pid: Number.parseInt(pid[1], 10) };
}

/**
 * `systemctl --user is-active <unit>`, which prints one word and exits
 * non-zero for most of them. `activating` is a unit on its way up — true
 * either way within a second or two, and reported as running rather than as
 * a failure somebody should go and investigate.
 */
export function readSystemctlIsActive(stdout: string): Liveness {
  const word = stdout.trim();
  if (word === 'active' || word === 'activating' || word === 'reloading') {
    return { state: 'running' };
  }
  if (word === '') return { state: 'unknown', why: 'systemctl said nothing' };
  return { state: 'stopped' };
}

/** What the platform's service manager says about the installed auto-start. */
export async function serviceLiveness(): Promise<Liveness> {
  if (!serviceSupported()) {
    return { state: 'unknown', why: `no auto-start on ${process.platform}` };
  }
  if (process.platform === 'darwin') {
    // `launchctl list` exits non-zero when the label is not loaded at all,
    // which is a real answer: nothing installed, nothing running.
    const listed = await execFileAsync('launchctl', ['list', LAUNCHD_LABEL]).catch(() => null);
    if (!listed) return { state: 'stopped' };
    return readLaunchctlList(listed.stdout);
  }
  // systemd exits 3 for an inactive unit and still prints the word, so the
  // rejection carries the answer and has to be read rather than discarded.
  const active = await execFileAsync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]).catch(
    (error: { stdout?: string; code?: string }) =>
      typeof error.stdout === 'string' ? { stdout: error.stdout } : null,
  );
  if (!active) return { state: 'unknown', why: 'systemctl did not answer' };
  return readSystemctlIsActive(active.stdout);
}

/**
 * Whether a daemon is running, asked of the daemon first and of the service
 * manager second.
 *
 * The order matters. The pidfile is written by the process that is actually
 * doing the sharing, whether it was started by launchd, by systemd, or by
 * somebody typing `sloppers run` — and that last one is invisible to every
 * service manager there is. The service manager is the fallback for the one
 * case the pidfile cannot cover: a daemon from a build old enough not to
 * write one, still running under the auto-start it was installed with.
 */
export async function daemonLiveness(
  home?: string,
  /** Injected so tests never interrogate the machine they are running on. */
  askService: () => Promise<Liveness> = serviceLiveness,
): Promise<Liveness> {
  const pid = readPidfile(home);
  if (pid !== null && pidAlive(pid)) return { state: 'running', pid };
  const service = await askService();
  if (service.state === 'running') return service;
  // A stale pidfile beside a service manager that says nothing useful is
  // still evidence: something wrote it and is no longer answering.
  if (pid !== null || existsSync(pidPath(home))) return { state: 'stopped' };
  return service;
}

/**
 * Wait for the daemon to come up, for as long as it is reasonable to keep
 * somebody's terminal. Returns whatever the last answer was — including
 * `stopped`, which is the honest report when a service was installed and the
 * process behind it never appeared.
 */
export async function awaitDaemon(
  timeoutMs: number,
  home?: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
  askService: () => Promise<Liveness> = serviceLiveness,
): Promise<Liveness> {
  const deadline = Date.now() + timeoutMs;
  let last = await daemonLiveness(home, askService);
  while (last.state !== 'running' && Date.now() < deadline) {
    await sleep(200);
    last = await daemonLiveness(home, askService);
  }
  return last;
}
