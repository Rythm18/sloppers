import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultVisibility, visibilitySchema } from '@sloppers/protocol';
import { z } from 'zod';

/**
 * `~/.sloppers/config.json` — written by `sloppers share`, read by the
 * daemon. Contains the device key, so it is chmod 600.
 */

export const configSchema = z.object({
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
export type CollectorConfig = z.infer<typeof configSchema>;

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
    return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
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

export function newConfig(init: {
  httpUrl: string;
  wsUrl: string;
  deviceKey: string;
  memberId: string;
  displayName: string;
  roomCode: string;
}): CollectorConfig {
  return {
    version: 1,
    server: { httpUrl: init.httpUrl, wsUrl: init.wsUrl },
    deviceKey: init.deviceKey,
    memberId: init.memberId,
    displayName: init.displayName,
    roomCode: init.roomCode,
    visibility: { ...defaultVisibility },
    paused: false,
  };
}
