import { execFile } from 'node:child_process';

/**
 * Seconds since the last human input on this machine, or undefined when the
 * platform can't tell us (presence derivation then falls back to agent-event
 * recency server-side).
 *
 * macOS: IOHIDSystem publishes HIDIdleTime in nanoseconds.
 */
export function machineIdleSeconds(): Promise<number | undefined> {
  if (process.platform !== 'darwin') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout);
      if (!match?.[1]) return resolve(undefined);
      resolve(Number(match[1]) / 1e9);
    });
  });
}
