import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, newConfig, saveConfig } from './config.js';

describe('collector config', () => {
  it('round-trips through disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-config-'));
    const config = newConfig({
      httpUrl: 'https://office.example.com',
      wsUrl: 'wss://office.example.com',
      deviceKey: 'k'.repeat(32),
      memberId: 'm1',
      displayName: 'Ridham',
      roomCode: 'the-lab',
    });
    saveConfig(config, home);
    expect(loadConfig(home)).toEqual(config);
  });

  it('returns null for a missing or corrupt file', () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-config-'));
    expect(loadConfig(home)).toBeNull();
  });

  it('new configs share everything and are not paused', () => {
    const config = newConfig({
      httpUrl: 'x',
      wsUrl: 'y',
      deviceKey: 'k',
      memberId: 'm',
      displayName: 'd',
      roomCode: 'r',
    });
    expect(config.paused).toBe(false);
    expect(Object.values(config.visibility).every(Boolean)).toBe(true);
  });
});
