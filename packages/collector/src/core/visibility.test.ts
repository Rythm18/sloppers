import type { SessionSnapshot } from '@sloppers/protocol';
import { defaultVisibility, encodeMinutes } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import { applyVisibility } from './visibility.js';

const full: SessionSnapshot = {
  id: 's1',
  harness: 'claude-code',
  state: 'working',
  title: 'Fixing the build',
  project: 'myapp',
  branch: 'main',
  model: 'claude-fable-5',
  tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  usage: [
    {
      day: '2026-08-19',
      model: 'claude-fable-5',
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    },
  ],
  activeMinutes: [{ day: '2026-08-19', minutes: encodeMinutes([61, 62]) }],
  startedAt: 1,
  lastActivityAt: 2,
};

describe('applyVisibility', () => {
  it('passes everything through with default settings', () => {
    expect(applyVisibility(full, defaultVisibility)).toEqual(full);
  });

  it('strips exactly the hidden fields', () => {
    const out = applyVisibility(full, {
      title: false,
      project: false,
      branch: true,
      model: true,
      tokens: false,
    });
    expect(out).toEqual({
      id: 's1',
      harness: 'claude-code',
      state: 'working',
      branch: 'main',
      model: 'claude-fable-5',
      startedAt: 1,
      lastActivityAt: 2,
    });
  });

  it('carries the bucketed usage and minute maps through when tokens are shared', () => {
    // These are what the server's ledger actually banks; dropping them here
    // silently reduces a sharing member to zero.
    const out = applyVisibility(full, defaultVisibility);
    expect(out.usage).toEqual(full.usage);
    expect(out.activeMinutes).toEqual(full.activeMinutes);
  });

  it('withholds the bucketed usage and minute maps when tokens are hidden', () => {
    // `usage` is the same spend as `tokens`, only broken out, and
    // `activeMinutes` is minute-resolution presence derived from the same
    // stream. Turning tokens off has to close all three doors or the setting
    // leaks through the newest one.
    const out = applyVisibility(full, { ...defaultVisibility, tokens: false });
    expect(out.tokens).toBeUndefined();
    expect(out.usage).toBeUndefined();
    expect(out.activeMinutes).toBeUndefined();
  });

  it('never invents fields that were absent', () => {
    const bare: SessionSnapshot = {
      id: 's2',
      harness: 'codex',
      state: 'idle',
      startedAt: 1,
      lastActivityAt: 2,
    };
    expect(applyVisibility(bare, defaultVisibility)).toEqual(bare);
  });
});
