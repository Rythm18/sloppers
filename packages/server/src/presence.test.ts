import type { SessionSnapshot } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import { COLLECTOR_TIMEOUT_MS, derivePresence } from './presence.js';

const NOW = 1_755_400_000_000;

function s(state: SessionSnapshot['state']): SessionSnapshot {
  return { id: 'x', harness: 'claude-code', state, startedAt: 1, lastActivityAt: 1 };
}

const base = {
  browserPresent: false,
  browserConnected: false,
  machineIdleSeconds: undefined,
  collectorSeenAt: NOW - 1000,
  sessions: [] as SessionSnapshot[],
  now: NOW,
};

describe('derivePresence', () => {
  it('offline when nothing is connected', () => {
    expect(derivePresence({ ...base, collectorSeenAt: undefined })).toBe('offline');
    expect(derivePresence({ ...base, collectorSeenAt: NOW - COLLECTOR_TIMEOUT_MS - 1 })).toBe(
      'offline',
    );
  });

  it('a blocked agent outranks everything', () => {
    expect(
      derivePresence({ ...base, browserPresent: true, sessions: [s('working'), s('waiting')] }),
    ).toBe('needs-attention');
  });

  it('active when human present and agents working', () => {
    expect(derivePresence({ ...base, browserPresent: true, sessions: [s('working')] })).toBe(
      'active',
    );
    expect(derivePresence({ ...base, machineIdleSeconds: 30, sessions: [s('working')] })).toBe(
      'active',
    );
  });

  it('grinding when agents work but the human is away', () => {
    expect(derivePresence({ ...base, machineIdleSeconds: 900, sessions: [s('working')] })).toBe(
      'grinding',
    );
    // No idle signal and no browser → assume away.
    expect(derivePresence({ ...base, sessions: [s('working')] })).toBe('grinding');
  });

  it('afk when nobody and nothing is doing anything', () => {
    expect(derivePresence({ ...base, machineIdleSeconds: 900 })).toBe('afk');
    expect(derivePresence({ ...base, sessions: [s('idle')] })).toBe('afk');
  });

  it('a live browser tab alone means active, even with no collector', () => {
    expect(
      derivePresence({
        ...base,
        collectorSeenAt: undefined,
        browserConnected: true,
        browserPresent: true,
      }),
    ).toBe('active');
  });

  it('a dead collector cannot leave ghost sessions', () => {
    expect(
      derivePresence({
        ...base,
        browserConnected: true,
        browserPresent: true,
        collectorSeenAt: NOW - COLLECTOR_TIMEOUT_MS - 1,
        sessions: [s('waiting')],
      }),
    ).toBe('active');
  });
});
